/**
 * Encrypted secret store — survives process/Docker restarts.
 *
 * SSH passwords, session-source tokens, and LLM API keys are NEVER written to
 * sparks.json / session-sources.json and NEVER returned by GET APIs.
 * They live in:
 *   - memory (Maps) for SSH collectors / LLM probes
 *   - config/sparks-secrets.json (AES-256-GCM ciphertext, volume-mounted)
 *
 * File shape (v2, backward compatible):
 *   {
 *     version: 2,
 *     secrets: { [sparkId]: "<encrypted ssh password>" },
 *     llmApiKeys?: { [sparkId]: "<encrypted JSON { \"8000\": \"sk-…\" }>" },
 *     sessionSourceTokens?: { [attachId]: "<encrypted token>" },
 *     sessionSourceDevices?: { [attachId]: "<encrypted device identity JSON>" }
 *   }
 *
 * v1 files (secrets + optional sessionSourceTokens/Devices) still load;
 * rewritten as v2 on next save.
 *
 * Encryption key:
 *   - SPARKDASH_SECRETS_KEY env (passphrase or 64-char hex), or
 *   - auto-generated config/.secrets-key (persists with ./config volume)
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { SPARKS_SECRETS_PATH, SECRETS_KEY_PATH } from "./config.js";
import { atomicWrite } from "./util/atomicWrite.js";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
/** Cached key so we never regenerate mid-process. */
let _cachedKey = null;

/** Test helper: drop the in-process key cache. Does not rotate the key file. */
export function resetSecretsKeyCache() {
  _cachedKey = null;
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function keyFromString(s) {
  const t = String(s).trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, "hex");
  return crypto.createHash("sha256").update(t, "utf8").digest();
}

/**
 * Resolve a 32-byte key.
 * NEVER overwrites an existing key file (that would orphan encrypted secrets).
 * @returns {Buffer}
 */
function resolveKey() {
  if (_cachedKey) return _cachedKey;

  const fromEnv = process.env.SPARKDASH_SECRETS_KEY;
  if (fromEnv && String(fromEnv).trim()) {
    _cachedKey = keyFromString(fromEnv);
    return _cachedKey;
  }

  if (fs.existsSync(SECRETS_KEY_PATH)) {
    try {
      const raw = fs.readFileSync(SECRETS_KEY_PATH, "utf8").trim();
      if (!raw) throw new Error("key file is empty");
      _cachedKey = keyFromString(raw);
      return _cachedKey;
    } catch (err) {
      throw new Error(
        `Cannot read secrets key at ${SECRETS_KEY_PATH}: ${err.message}. ` +
          `Fix permissions or set SPARKDASH_SECRETS_KEY.`
      );
    }
  }

  if (fs.existsSync(SPARKS_SECRETS_PATH)) {
    throw new Error(
      `Encrypted secrets exist at ${SPARKS_SECRETS_PATH} but key file is missing (${SECRETS_KEY_PATH}). ` +
        `Restore .secrets-key or re-enter passwords after deleting sparks-secrets.json.`
    );
  }

  const key = crypto.randomBytes(KEY_LEN);
  ensureDir(SECRETS_KEY_PATH);
  try {
    fs.writeFileSync(SECRETS_KEY_PATH, key.toString("hex") + "\n", { mode: 0o600 });
    try {
      fs.chmodSync(SECRETS_KEY_PATH, 0o600);
    } catch {
      /* best-effort */
    }
    console.log(`[secretsStore] Generated encryption key at ${SECRETS_KEY_PATH}`);
  } catch (err) {
    throw new Error(`Failed to write secrets key: ${err.message}`);
  }
  _cachedKey = key;
  return key;
}

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decrypt(blobB64, key) {
  const buf = Buffer.from(blobB64, "base64");
  if (buf.length < IV_LEN + TAG_LEN + 1) throw new Error("ciphertext too short");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function asBlobMap(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value;
}

function readRawStore() {
  const empty = { version: 2, secrets: {}, llmApiKeys: {}, sessionSourceTokens: {}, sessionSourceDevices: {} };
  if (!fs.existsSync(SPARKS_SECRETS_PATH)) return empty;
  const data = JSON.parse(fs.readFileSync(SPARKS_SECRETS_PATH, "utf8"));
  return {
    version: 2,
    secrets: asBlobMap(data?.secrets),
    llmApiKeys: asBlobMap(data?.llmApiKeys),
    sessionSourceTokens: asBlobMap(data?.sessionSourceTokens),
    sessionSourceDevices: asBlobMap(data?.sessionSourceDevices),
  };
}

function nonEmptyBlobs(blobs) {
  const out = {};
  for (const [id, blob] of Object.entries(blobs || {})) {
    if (id && typeof blob === "string" && blob) out[id] = blob;
  }
  return out;
}

function hasBlobMap(blobs) {
  return Object.keys(nonEmptyBlobs(blobs)).length > 0;
}

function unlinkStoreFile() {
  if (!fs.existsSync(SPARKS_SECRETS_PATH)) return;
  try {
    fs.accessSync(SPARKS_SECRETS_PATH, fs.constants.W_OK);
    fs.unlinkSync(SPARKS_SECRETS_PATH);
  } catch (err) {
    throw new Error(
      `Failed to clear secrets file (permission?): ${err.message}. ` +
        `Run: sudo chown -R $(id -u):$(id -g) config/sparks-secrets.json`
    );
  }
}

function persistStore({ secrets: secretBlobs, llmApiKeys: llmKeyBlobs, sessionSourceTokens: tokenBlobs, sessionSourceDevices: deviceBlobs }) {
  const secrets = asBlobMap(secretBlobs);
  const llmApiKeys = nonEmptyBlobs(llmKeyBlobs);
  const sessionSourceTokens = nonEmptyBlobs(tokenBlobs);
  const sessionSourceDevices = nonEmptyBlobs(deviceBlobs);
  const hasSecrets = Object.keys(secrets).length > 0;
  if (!hasSecrets && !hasBlobMap(llmApiKeys) && !hasBlobMap(sessionSourceTokens) && !hasBlobMap(sessionSourceDevices)) {
    unlinkStoreFile();
    return;
  }
  const payload = { version: 2, secrets };
  if (hasBlobMap(llmApiKeys)) payload.llmApiKeys = llmApiKeys;
  if (hasBlobMap(sessionSourceTokens)) payload.sessionSourceTokens = sessionSourceTokens;
  if (hasBlobMap(sessionSourceDevices)) payload.sessionSourceDevices = sessionSourceDevices;
  atomicWrite(SPARKS_SECRETS_PATH, JSON.stringify(payload, null, 2) + "\n", 0o644);
}

function decryptEntries(entries, key, kind) {
  const map = new Map();
  let failed = 0;
  for (const [id, blob] of Object.entries(entries)) {
    if (!id || typeof blob !== "string") continue;
    try {
      const value = decrypt(blob, key);
      if (value) map.set(id, value);
    } catch {
      failed += 1;
      console.error(`[secretsStore] Failed to decrypt ${kind} for ${id} (wrong/missing key?)`);
    }
  }
  return { map, failed };
}

/**
 * @returns {{
 *   passwords: Map<string, string>,
 *   llmApiKeys: Map<string, Record<string, string>>,
 * }}
 */
export function loadSecrets() {
  /** @type {Map<string, string>} */
  const passwords = new Map();
  /** @type {Map<string, Record<string, string>>} */
  const llmApiKeys = new Map();

  if (!fs.existsSync(SPARKS_SECRETS_PATH)) {
    return { passwords, llmApiKeys };
  }

  try {
    const key = resolveKey();
    const raw = readRawStore();
    const { map: loaded, failed } = decryptEntries(raw.secrets, key, "password");
    for (const [id, pw] of loaded) passwords.set(id, pw);
    if (passwords.size > 0) {
      console.log(`[secretsStore] Loaded ${passwords.size} SSH password(s) from encrypted store`);
    }
    if (failed > 0) {
      console.warn(
        `[secretsStore] ${failed} password(s) could not be decrypted — re-enter via Edit Spark`
      );
    }

    const keyEntries = raw.llmApiKeys || {};
    if (typeof keyEntries === "object" && keyEntries !== null) {
      let failedKeys = 0;
      let portCount = 0;
      for (const [id, blob] of Object.entries(keyEntries)) {
        if (!id || typeof blob !== "string") continue;
        try {
          const json = decrypt(blob, key);
          const parsed = JSON.parse(json);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
          /** @type {Record<string, string>} */
          const ports = {};
          for (const [port, apiKey] of Object.entries(parsed)) {
            if (!apiKey || typeof apiKey !== "string") continue;
            ports[String(port)] = apiKey;
            portCount += 1;
          }
          if (Object.keys(ports).length > 0) llmApiKeys.set(id, ports);
        } catch {
          failedKeys += 1;
          console.error(
            `[secretsStore] Failed to decrypt LLM API keys for ${id} (wrong/missing key?)`
          );
        }
      }
      if (portCount > 0) {
        console.log(`[secretsStore] Loaded ${portCount} LLM API key(s) from encrypted store`);
      }
      if (failedKeys > 0) {
        console.warn(
          `[secretsStore] ${failedKeys} LLM API key bundle(s) could not be decrypted — re-enter via LLM Settings`
        );
      }
    }
  } catch (err) {
    console.error(`[secretsStore] Failed to load secrets: ${err.message}`);
  }

  return { passwords, llmApiKeys };
}

/**
 * Persist SSH passwords + per-port LLM API keys (encrypted). Empty passwords
 * remove those slots; the file is deleted only when passwords, LLM keys, AND
 * session tokens/devices are all gone. Throws on failure so callers can
 * surface errors to the UI.
 *
 * Encrypted file mode is 0o644 so bind-mounted volumes stay usable across
 * root/non-root container users (contents are ciphertext, not plaintext).
 *
 * @param {Map<string, string>} passwords
 * @param {Map<string, Record<string, string>>} [llmApiKeys]
 */
export function saveSecrets(passwords, llmApiKeys = new Map()) {
  const raw = readRawStore();
  const hasPasswords = passwords && passwords.size > 0;
  let hasKeys = false;
  if (llmApiKeys) {
    for (const ports of llmApiKeys.values()) {
      if (ports && Object.keys(ports).length > 0) {
        hasKeys = true;
        break;
      }
    }
  }

  if (!hasPasswords && !hasKeys) {
    persistStore({ secrets: {}, llmApiKeys: raw.llmApiKeys, sessionSourceTokens: raw.sessionSourceTokens, sessionSourceDevices: raw.sessionSourceDevices });
    return;
  }

  const key = resolveKey();
  const secrets = {};
  if (passwords) {
    for (const [id, pw] of passwords.entries()) {
      if (pw) secrets[id] = encrypt(pw, key);
    }
  }

  /** @type {Record<string, string>} */
  const llmOut = {};
  if (llmApiKeys) {
    for (const [id, ports] of llmApiKeys.entries()) {
      if (!ports || typeof ports !== "object") continue;
      const clean = {};
      for (const [port, apiKey] of Object.entries(ports)) {
        if (apiKey) clean[String(port)] = String(apiKey);
      }
      if (Object.keys(clean).length === 0) continue;
      llmOut[id] = encrypt(JSON.stringify(clean), key);
    }
  }

  persistStore({ secrets, llmApiKeys: llmOut, sessionSourceTokens: raw.sessionSourceTokens, sessionSourceDevices: raw.sessionSourceDevices });
  const keyCount = Object.keys(llmOut).length;
  console.log(
    `[secretsStore] Saved ${Object.keys(secrets).length} SSH password(s)` +
      (keyCount ? `, ${keyCount} LLM API key bundle(s)` : "")
  );
}

function decryptTokenMap(blobs, key) {
  const { map } = decryptEntries(blobs, key, "session source token");
  /** @type {Record<string, string>} */
  const out = {};
  for (const [id, value] of map) {
    if (value) out[id] = value;
  }
  return out;
}

/** @returns {Record<string, string>} plaintext tokens keyed by attach id */
export function loadSessionSourceTokens() {
  try {
    const raw = readRawStore();
    if (!hasBlobMap(raw.sessionSourceTokens)) return {};
    return decryptTokenMap(raw.sessionSourceTokens, resolveKey());
  } catch (err) {
    console.error(`[secretsStore] Failed to load session source tokens: ${err.message}`);
    return {};
  }
}

/**
 * Merge session-source token slots. Omitted keys leave the stored token;
 * empty string clears that slot. Keys are attach ids.
 * @param {Record<string, string>} patch
 * @returns {Record<string, string>}
 */
export function patchSessionSourceTokens(patch) {
  const raw = readRawStore();
  const key = resolveKey();
  const current = decryptTokenMap(raw.sessionSourceTokens, key);
  const body = patch && typeof patch === "object" ? patch : {};
  for (const id of Object.keys(body)) {
    if (!id) continue;
    const value = body[id];
    if (value == null) continue;
    if (value === "") delete current[id];
    else current[id] = String(value);
  }
  /** @type {Record<string, string>} */
  const tokenBlobs = {};
  for (const [id, value] of Object.entries(current)) {
    if (value) tokenBlobs[id] = encrypt(value, key);
  }
  persistStore({ secrets: raw.secrets, llmApiKeys: raw.llmApiKeys, sessionSourceTokens: tokenBlobs, sessionSourceDevices: raw.sessionSourceDevices });
  return current;
}

/** @returns {{ deviceId: string, publicKey: string, privateKeyPem: string } | null} */
export function loadSessionSourceDevice(id) {
  if (!id) return null;
  try {
    const raw = readRawStore();
    const blob = raw.sessionSourceDevices?.[id];
    if (typeof blob !== "string" || !blob) return null;
    const parsed = JSON.parse(decrypt(blob, resolveKey()));
    if (parsed?.deviceId && parsed?.publicKey && parsed?.privateKeyPem) return parsed;
  } catch (err) {
    console.error(`[secretsStore] Failed to load session source device for ${id}: ${err.message}`);
  }
  return null;
}

/** Persist OpenClaw gateway device identity for one attach id. */
export function saveSessionSourceDevice(id, identity) {
  if (!id || !identity) return;
  const raw = readRawStore();
  const devices = { ...raw.sessionSourceDevices };
  devices[id] = encrypt(JSON.stringify(identity), resolveKey());
  persistStore({ secrets: raw.secrets, llmApiKeys: raw.llmApiKeys, sessionSourceTokens: raw.sessionSourceTokens, sessionSourceDevices: devices });
}

/** Drop device identities whose attach ids are no longer present. */
export function dropSessionSourceDevices(keepIds) {
  const keep = new Set(Array.isArray(keepIds) ? keepIds : []);
  const raw = readRawStore();
  const devices = {};
  for (const [id, blob] of Object.entries(raw.sessionSourceDevices || {})) {
    if (keep.has(id) && typeof blob === "string" && blob) devices[id] = blob;
  }
  persistStore({ secrets: raw.secrets, llmApiKeys: raw.llmApiKeys, sessionSourceTokens: raw.sessionSourceTokens, sessionSourceDevices: devices });
}
