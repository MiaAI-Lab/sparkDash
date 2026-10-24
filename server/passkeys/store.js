/**
 * Persistent passkey authority: credentials, hashed sessions, single-use
 * challenges and token binding share one SQLite transaction boundary. The host
 * recovery CLI opens the same database, so a reset cannot be overwritten by a
 * concurrent request. No library database or collector needs to be healthy to
 * sign in. Requires Node 22.13+ (the supported Node 22 runtime includes SQLite).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { passkeysDbPath } from "../config.js";
import {
  CHALLENGE_TTL_MS,
  LOGIN_ATTEMPT_LIMIT,
  LOGIN_ATTEMPT_WINDOW_MS,
  MAX_LOGIN_BACKOFF_MS,
  ORIGIN_VAR,
} from "./settings.js";

export const MAX_LIVE_CHALLENGES = 64;
export const LABEL_MAX = 64;
export const RECOVERY_HINT =
  "docker exec sparkDash node server/passkeyAdmin.js reset (or, with the container stopped: " +
  "docker compose run --rm sparkdash node server/passkeyAdmin.js reset)";
export class DuplicateCredentialError extends Error {}
export class AuthorityExpiredError extends Error {}
class StoreDataError extends Error {}

const require = createRequire(import.meta.url);
const BINDING = "sparkdash-passkey-binding";
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY, credentialId TEXT NOT NULL UNIQUE, publicKey TEXT NOT NULL,
    counter INTEGER NOT NULL CHECK(counter >= 0), transports TEXT NOT NULL,
    label TEXT NOT NULL, createdAt TEXT NOT NULL, lastUsedAt TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS sessions (
    tokenHash TEXT PRIMARY KEY,
    credentialId TEXT REFERENCES credentials(id) ON DELETE CASCADE,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL CHECK(expiresAt > createdAt)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expiresAt);
  CREATE TABLE IF NOT EXISTS challenges (
    challenge TEXT PRIMARY KEY,
    purpose TEXT NOT NULL CHECK(purpose IN ('registration', 'authentication')),
    expiresAt INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS challenges_expiry ON challenges(expiresAt);
  CREATE TABLE IF NOT EXISTS loginAttempts (
    id INTEGER PRIMARY KEY CHECK(id = 1), windowStart INTEGER NOT NULL,
    failures INTEGER NOT NULL CHECK(failures >= 0)
  ) STRICT;
`;
let connection = null;
let connectionPath = null;
let readFailureLogged = false;
let lastReset = null;

function db() {
  const file = passkeysDbPath();
  if (connection && connectionPath === file) return connection;
  connection?.close();
  connection = null;
  connectionPath = null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Load only when armed or explicitly invoked by the admin CLI: an older Node
  // install with passkeys off does not suddenly depend on node:sqlite.
  const { DatabaseSync } = require("node:sqlite");
  const next = new DatabaseSync(file);
  try {
    fs.chmodSync(file, 0o600);
    next.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    next.exec(SCHEMA);
    next.prepare("INSERT OR IGNORE INTO meta VALUES ('generation', ?)").run(crypto.randomUUID());
  } catch (err) {
    next.close();
    throw err;
  }
  connection = next;
  connectionPath = file;
  return next;
}

function meta(conn, key) {
  return conn.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}
function setMeta(conn, key, value) {
  conn.prepare("INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}
function noticeReset(conn) {
  const generation = meta(conn, "generation");
  if (lastReset && generation !== lastReset) console.warn("[passkeys] enrolment was reset on the host; every passkey and session is gone");
  lastReset = generation;
}
/** A brief SQLite lock is retryable; a broken authority store needs host repair. */
function storeFailed(err) {
  const sqliteFailure = err.code === "ERR_SQLITE_ERROR" && ![5, 6].includes(err.errcode & 0xff);
  const fileFailure = ["EACCES", "EPERM", "EROFS", "ENOSPC", "ENOENT", "EIO"].includes(err.code);
  if (sqliteFailure || fileFailure || err instanceof StoreDataError) unavailable = true;
}
function read(fallback, fn) {
  try {
    const conn = db();
    noticeReset(conn);
    return fn(conn);
  } catch (err) {
    storeFailed(err);
    if (!readFailureLogged) {
      readFailureLogged = true;
      console.error(`[passkeys] store read failed (${err.message}); treating sparkDash as un-enrolled. The access token still works. Recovery: ${RECOVERY_HINT}`);
    }
    return fallback;
  }
}

/** Serializes read/check/write against both requests and the separate host CLI. */
function transaction(fn) {
  let conn;
  let began = false;
  try {
    conn = db();
    conn.exec("BEGIN IMMEDIATE");
    began = true;
    const result = fn(conn);
    conn.exec("COMMIT");
    return result;
  } catch (err) {
    storeFailed(err);
    if (began) {
      try { conn.exec("ROLLBACK"); } catch (rollbackError) {
        console.error(`[passkeys] rollback also failed: ${rollbackError.message}`);
      }
    }
    throw err;
  }
}
const digest = (token) => crypto.createHash("sha256").update(token).digest("hex");

// ─── Startup and token rotation ──────────────────────────

export function storeLocationProblem() {
  const file = passkeysDbPath();
  const disarm = `or unset ${ORIGIN_VAR} to serve without passkey sign-in`;
  if (!path.isAbsolute(file)) return `PASSKEYS_DB_PATH must be an absolute path (got ${JSON.stringify(file)}) — fix it, ${disarm}.`;
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    if (fs.existsSync(file)) {
      if (!fs.statSync(file).isFile()) throw new Error(`${file} is not a file`);
      fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
    }
  } catch (err) {
    return `The passkey store at ${file} cannot be created or opened (${err.message}) — fix PASSKEYS_DB_PATH or the config volume, ${disarm}.`;
  }
  return null;
}

function fingerprint(token, salt) {
  const purposeSalt = crypto.createHash("sha256").update(BINDING).update(salt).digest();
  return crypto.scryptSync(token, purposeSalt, 32, { N: 2 ** 14, r: 8, p: 1 }).toString("base64url");
}
function reset(conn) {
  const removed = conn.prepare("SELECT COUNT(*) AS n FROM credentials").get().n;
  conn.exec("DELETE FROM sessions; DELETE FROM credentials; DELETE FROM challenges; DELETE FROM loginAttempts;");
  setMeta(conn, "generation", crypto.randomUUID());
  return removed;
}

/** A missing or mismatched token fingerprint cannot preserve previous authority. */
export function armStore(token) {
  try {
    transaction((conn) => {
      let old = null;
      try { old = JSON.parse(meta(conn, "keyFingerprint")); } catch { /* invalid binding means rotation */ }
      let matches = false;
      if (typeof old?.salt === "string" && typeof old?.hash === "string") {
        const a = Buffer.from(fingerprint(token, old.salt));
        const b = Buffer.from(old.hash);
        matches = a.length === b.length && crypto.timingSafeEqual(a, b);
      }
      if (!matches) {
        const removed = reset(conn);
        const salt = crypto.randomBytes(16).toString("base64url");
        setMeta(conn, "keyFingerprint", JSON.stringify({ salt, hash: fingerprint(token, salt) }));
        if (old || removed) console.warn(`[passkeys] SPARKDASH_TOKEN changed or its binding was lost — removed ${removed} passkey(s) and every session. Enrol again with the current token.`);
      }
      lastReset = meta(conn, "generation");
    });
    unavailable = false;
    return true;
  } catch (err) {
    // Do not trust sessions from a database whose binding could not be checked.
    connection?.close();
    connection = null;
    connectionPath = null;
    console.error(`[passkeys] cannot arm store (${err.message}); passkey operations will fail closed and the access token remains available. Recovery: ${RECOVERY_HINT}`);
    unavailable = true;
    return false;
  }
}
let unavailable = false;

export function passkeyStoreAvailable() {
  return !unavailable;
}

function publicView(c) {
  return { id: c.id, label: c.label, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt ?? null };
}
export function hasCredentials() {
  return !unavailable && read(false, (conn) => Boolean(conn.prepare("SELECT 1 FROM credentials LIMIT 1").get()));
}
/** Inventory is strict: a failed read is not an empty credential list. */
export function listCredentials() {
  try {
    const conn = db();
    noticeReset(conn);
    return conn.prepare("SELECT id, label, createdAt, lastUsedAt FROM credentials ORDER BY createdAt, id").all().map(publicView);
  } catch (err) {
    storeFailed(err);
    throw err;
  }
}
function storedTransports(value) {
  let transports;
  try { transports = JSON.parse(value); } catch (cause) {
    throw new StoreDataError("Stored credential transports contain invalid JSON", { cause });
  }
  if (!Array.isArray(transports) || transports.some((item) => typeof item !== "string")) {
    throw new StoreDataError("Stored credential transports must be a list of strings");
  }
  return transports;
}

export function credentialDescriptors() {
  return unavailable ? [] : read([], (conn) => conn.prepare("SELECT credentialId AS id, transports FROM credentials").all().map((c) => ({ id: c.id, transports: storedTransports(c.transports) })));
}
export function findCredential(credentialId) {
  if (unavailable || typeof credentialId !== "string") return null;
  return read(null, (conn) => {
    const c = conn.prepare("SELECT * FROM credentials WHERE credentialId = ?").get(credentialId);
    return c ? { ...c, transports: storedTransports(c.transports) } : null;
  });
}
export function sanitizeLabel(label) {
  return String(label ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, LABEL_MAX);
}

/** Commit-time authority: reset generation plus a still-live token-derived session, if used. */
function authorityLive(conn, { generation, sessionToken } = {}) {
  if (!generation || generation !== meta(conn, "generation")) return false;
  if (sessionToken == null) return true; // caller presented the bearer token directly
  return Boolean(conn.prepare("SELECT 1 FROM sessions WHERE tokenHash=? AND credentialId IS NULL AND expiresAt>?").get(digest(sessionToken), Date.now()));
}
export function addCredential({ credentialId, publicKey, counter, transports, label }, authority) {
  if (unavailable) throw new Error("Passkey store unavailable; use host recovery before enrolling.");
  return transaction((conn) => {
    if (!authorityLive(conn, authority)) throw new AuthorityExpiredError("Your enrolment authority ended. Sign in again and start a new ceremony.");
    if (conn.prepare("SELECT 1 FROM credentials WHERE credentialId=?").get(credentialId)) throw new DuplicateCredentialError("That authenticator is already enrolled.");
    const record = { id: crypto.randomUUID(), label: sanitizeLabel(label), createdAt: new Date().toISOString(), lastUsedAt: null };
    const safeTransports = Array.isArray(transports) ? transports.filter((t) => typeof t === "string") : [];
    conn.prepare("INSERT INTO credentials VALUES (?, ?, ?, ?, ?, ?, ?, NULL)").run(record.id, credentialId, publicKey, counter, JSON.stringify(safeTransports), record.label, record.createdAt);
    return record;
  });
}
export function removeCredential(id) {
  return transaction((conn) => conn.prepare("DELETE FROM credentials WHERE id=?").run(id).changes > 0);
}

// ─── Sessions ────────────────────────────────────────────
function grantSession(conn, credentialId, ttlMs) {
  const token = crypto.randomBytes(32).toString("base64url");
  const t = Date.now();
  conn.prepare("DELETE FROM sessions WHERE expiresAt <= ?").run(t);
  conn.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(digest(token), credentialId, t, t + ttlMs);
  return { token, expiresAt: t + ttlMs };
}
export function createTokenSession(ttlMs) {
  if (unavailable) throw new Error("Passkey store unavailable; use host recovery before signing in.");
  return transaction((conn) => grantSession(conn, null, ttlMs));
}

/** Recheck the counter and generation after asynchronous signature verification. */
export function completeAuthentication(id, counter, ttlMs, generation) {
  if (unavailable) return null;
  return transaction((conn) => {
    if (generation !== meta(conn, "generation")) return null;
    const c = conn.prepare("SELECT counter FROM credentials WHERE id=?").get(id);
    if (!c || ((counter > 0 || c.counter > 0) && counter <= c.counter)) return null;
    conn.prepare("UPDATE credentials SET counter=?, lastUsedAt=? WHERE id=?").run(counter, new Date().toISOString(), id);
    conn.exec("DELETE FROM loginAttempts");
    return grantSession(conn, id, ttlMs);
  });
}
export function findSession(token) {
  if (unavailable || typeof token !== "string" || !token) return null;
  return read(null, (conn) => conn.prepare("SELECT * FROM sessions WHERE tokenHash=? AND expiresAt>?").get(digest(token), Date.now()) ?? null);
}
export function destroySession(token) {
  if (typeof token !== "string" || !token) return;
  transaction((conn) => conn.prepare("DELETE FROM sessions WHERE tokenHash=?").run(digest(token)));
}
export function destroyAllSessions() {
  return transaction((conn) => conn.prepare("DELETE FROM sessions").run().changes);
}

// ─── Ceremony challenges ─────────────────────────────────
/**
 * Bound the pool by evicting its oldest entries, not refusing every browser for
 * two minutes when an anonymous caller fills it. Login and authenticated
 * registration have separate pools, so unauthenticated traffic cannot spend the
 * enrolment budget. Continuous flooding can still disrupt ceremonies, as it can
 * any public service; an HTTPS front door should rate-limit that traffic.
 */
export function issueChallenge(purpose, challenge) {
  if (unavailable) throw new Error("Passkey store unavailable; use host recovery.");
  transaction((conn) => {
    const t = Date.now();
    conn.prepare("DELETE FROM challenges WHERE expiresAt <= ?").run(t);
    conn.prepare(`DELETE FROM challenges WHERE challenge IN (
      SELECT challenge FROM challenges WHERE purpose=? ORDER BY expiresAt DESC, rowid DESC LIMIT -1 OFFSET ?
    )`).run(purpose, MAX_LIVE_CHALLENGES - 1);
    conn.prepare("INSERT INTO challenges VALUES (?, ?, ?)").run(challenge, purpose, t + CHALLENGE_TTL_MS);
  });
}
/** Spend the challenge once and return its reset generation, or null. */
export function consumeChallenge(challenge, purpose) {
  if (unavailable || typeof challenge !== "string" || !challenge) return null;
  return transaction((conn) => {
    const result = conn.prepare("DELETE FROM challenges WHERE challenge=? AND purpose=? AND expiresAt>? RETURNING challenge").get(challenge, purpose, Date.now());
    return result ? meta(conn, "generation") : null;
  });
}

// ─── Failed sign-in throttle: delay, never a global lockout ─
export function loginBackoffMs() {
  return read(MAX_LOGIN_BACKOFF_MS, (conn) => {
    const a = conn.prepare("SELECT * FROM loginAttempts WHERE id=1").get();
    if (!a || Date.now() - a.windowStart > LOGIN_ATTEMPT_WINDOW_MS) return 0;
    const over = a.failures - LOGIN_ATTEMPT_LIMIT;
    return over < 0 ? 0 : Math.min(1000 * 2 ** over, MAX_LOGIN_BACKOFF_MS);
  });
}
export function recordFailure() {
  transaction((conn) => {
    const t = Date.now();
    conn.prepare(`INSERT INTO loginAttempts VALUES (1, ?, 1) ON CONFLICT(id) DO UPDATE SET
      failures=CASE WHEN ? - windowStart > ? THEN 1 ELSE failures+1 END,
      windowStart=CASE WHEN ? - windowStart > ? THEN ? ELSE windowStart END
    `).run(t, t, LOGIN_ATTEMPT_WINDOW_MS, t, LOGIN_ATTEMPT_WINDOW_MS, t);
  });
}

/** Recovery is host-only, with the same transaction boundary as a serving request. */
export function resetAll() {
  try {
    return transaction(reset);
  } catch (err) {
    // SQLITE_CORRUPT / SQLITE_NOTADB: preserve the damaged file for inspection.
    // Permission, locking and disk-full errors must never be disguised as reset.
    if (err.errcode !== 11 && err.errcode !== 26) throw err;
    connection?.close();
    connection = null;
    connectionPath = null;
    const file = passkeysDbPath();
    const saved = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, saved);
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      try { fs.renameSync(`${file}${suffix}`, `${saved}${suffix}`); } catch (sidecarError) {
        if (sidecarError.code !== "ENOENT") throw sidecarError;
      }
    }
    console.warn(`[passkeys] preserved corrupt store at ${saved}; restart sparkDash after this reset.`);
    unavailable = false;
    return transaction(reset);
  }
}
export function _resetForTests() {
  connection?.close();
  connection = null;
  connectionPath = null;
  lastReset = null;
  readFailureLogged = false;
  unavailable = false;
}
