/**
 * Passkey sign-in end to end: real Express routes, the real gate, and real
 * WebAuthn ceremonies from a software authenticator — the verifier is never
 * mocked. Each test follows the path a browser takes: after sign-in it carries
 * only the session cookie, never an Authorization header.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer as createNetServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import express from "express";
import WebSocket from "ws";
import { DatabaseSync } from "node:sqlite";
import { authStatus, authorizeUpgrade, createAuthMiddleware, createHostGuardMiddleware } from "../auth.js";
import { EXEMPT_ROUTES, registerPasskeyRoutes } from "../passkeys/routes.js";
import { passkeyPreflightProblem } from "../passkeys/preflight.js";
import { passkeyOrigin } from "../passkeys/settings.js";
import * as store from "../passkeys/store.js";
import { passkeysDbPath } from "../config.js";
import { isolatedConfigEnv } from "./isolatedEnv.js";
import { SoftAuthenticator } from "./softAuthenticator.js";

const ORIGIN = "http://localhost:5555";
const TOKEN = "correct-horse-battery";
const REPO = path.resolve(import.meta.dirname, "../..");
const ENV_KEYS = [
  "SPARKDASH_TOKEN",
  "DASHBOARD_TOKEN",
  "BIND_HOST",
  "SPARKDASH_PASSKEY_ORIGIN",
  "SPARKDASH_PASSKEY_ONLY",
  "SPARKDASH_SESSION_TTL_DAYS",
  "PASSKEYS_DB_PATH",
  "SPARKDASH_ALLOWED_HOSTS",
];

/** Independent fixture writes (expiry/corruption) use a separate connection. */
function sql(statement) {
  const conn = new DatabaseSync(passkeysDbPath());
  try { return conn.prepare(statement).all(); } finally { conn.close(); }
}

/** A server like index.js builds it, on an ephemeral port, with a fresh store. */
async function harness(t, env = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sparkdash-passkeys-"));
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const next = {
    SPARKDASH_TOKEN: TOKEN,
    BIND_HOST: "127.0.0.1",
    SPARKDASH_PASSKEY_ORIGIN: ORIGIN,
    PASSKEYS_DB_PATH: path.join(dir, "passkeys.sqlite"),
    ...env,
  };
  for (const k of ENV_KEYS) {
    if (next[k] == null) delete process.env[k];
    else process.env[k] = next[k];
  }
  store._resetForTests();
  if (next.SPARKDASH_TOKEN && next.SPARKDASH_PASSKEY_ORIGIN) store.armStore(next.SPARKDASH_TOKEN);

  const app = express();
  app.use(express.json());
  app.get("/api/auth/status", createHostGuardMiddleware(), (req, res) => res.json(authStatus(req)));
  registerPasskeyRoutes(app);
  app.use(createAuthMiddleware());
  app.post("/api/probe", (_req, res) => res.json({ ok: true }));
  app.get("/metrics", (_req, res) => res.type("text").send("up 1\n"));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    server.close();
    store._resetForTests();
    for (const k of ENV_KEYS) {
      if (saved[k] == null) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dir, { recursive: true, force: true });
  });

  /** fetch as a same-origin browser page: Origin set, optional cookie or bearer. */
  async function call(method, route, { body, cookie, bearer, origin = ORIGIN } = {}) {
    const headers = { "content-type": "application/json" };
    if (origin) headers.origin = origin;
    if (cookie) headers.cookie = cookie;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const res = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    const setCookie = res.headers.getSetCookie();
    return { status: res.status, json, setCookie, cookie: setCookie[0]?.split(";")[0] ?? null };
  }

  async function tokenSignIn() {
    const r = await call("POST", "/api/auth/session/token", { body: {}, bearer: TOKEN });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.cookie;
  }

  /** Full registration ceremony carrying only `auth` (a cookie or the bearer). */
  async function enrol(authenticator, auth, label = "laptop") {
    const opts = await call("POST", "/api/auth/passkey/register/options", { body: {}, ...auth });
    if (opts.status !== 200) return opts;
    const response = authenticator.register(opts.json.options, { origin: ORIGIN });
    return call("POST", "/api/auth/passkey/register/verify", { body: { response, label }, ...auth });
  }

  async function passkeySignIn(authenticator, { origin = ORIGIN, advance = true } = {}) {
    const opts = await call("POST", "/api/auth/passkey/login/options", { body: {} });
    assert.equal(opts.status, 200);
    const response = authenticator.authenticate(opts.json.options, { origin, advance });
    return { ...(await call("POST", "/api/auth/passkey/login/verify", { body: { response } })), response };
  }

  return { call, tokenSignIn, enrol, passkeySignIn, dir };
}

// ─── Enrolment requires the token's authority ────────────

test("an anonymous caller cannot enrol, before or after a passkey exists", async (t) => {
  const h = await harness(t);
  const key = new SoftAuthenticator();
  const refused = await h.enrol(key, {});
  assert.equal(refused.status, 401);
  assert.equal(store.listCredentials().length, 0);

  assert.equal((await h.enrol(new SoftAuthenticator(), { bearer: TOKEN })).status, 200);
  assert.equal((await h.enrol(key, {})).status, 401);
  assert.equal(store.listCredentials().length, 1);
});

test("signing in with the token yields a session that can enrol, carrying only the cookie", async (t) => {
  const h = await harness(t);
  const cookie = await h.tokenSignIn();
  assert.match(cookie, /^sparkdash_session=/);

  const status = await h.call("GET", "/api/auth/status", { cookie });
  assert.deepEqual(status.json.session, { method: "token", canManage: true });
  assert.equal(status.json.authenticated, true);

  const key = new SoftAuthenticator();
  const enrolled = await h.enrol(key, { cookie }, "desk key");
  assert.equal(enrolled.status, 200, JSON.stringify(enrolled.json));
  assert.equal(enrolled.json.passkey.label, "desk key");

  const login = await h.passkeySignIn(key);
  assert.equal(login.status, 200, JSON.stringify(login.json));
  assert.equal((await h.call("POST", "/api/probe", { cookie: login.cookie })).status, 200);
});

test("the session cookie is HttpOnly, SameSite=Strict, path / and fixed-lifetime", async (t) => {
  const h = await harness(t, { SPARKDASH_SESSION_TTL_DAYS: "2" });
  const r = await h.call("POST", "/api/auth/session/token", { body: {}, bearer: TOKEN });
  const attrs = r.setCookie[0];
  assert.match(attrs, /; HttpOnly/);
  assert.match(attrs, /; SameSite=Strict/);
  assert.match(attrs, /; Path=\//);
  const maxAge = Number(/Max-Age=(\d+)/.exec(attrs)[1]);
  assert.ok(Math.abs(maxAge - 2 * 86400) <= 2, `Max-Age ${maxAge}`);
});

test("an https origin gets a Secure, __Host- cookie", async (t) => {
  const h = await harness(t, { SPARKDASH_PASSKEY_ORIGIN: "https://spark.example.ts.net" });
  const r = await h.call("POST", "/api/auth/session/token", { body: {}, bearer: TOKEN, origin: null });
  assert.match(r.setCookie[0], /^__Host-sparkdash_session=.*; Secure$/);
});

test("a passkey session may list but not enrol or revoke; a token session may revoke", async (t) => {
  const h = await harness(t);
  const key = new SoftAuthenticator();
  const enrolled = await h.enrol(key, { bearer: TOKEN });
  const passkeyCookie = (await h.passkeySignIn(key)).cookie;

  const list = await h.call("GET", "/api/auth/passkeys", { cookie: passkeyCookie });
  assert.equal(list.status, 200);
  assert.equal(list.json.canManage, false);
  assert.deepEqual(Object.keys(list.json.passkeys[0]).sort(), ["createdAt", "id", "label", "lastUsedAt"]);

  assert.equal((await h.enrol(new SoftAuthenticator(), { cookie: passkeyCookie })).status, 403);
  const id = enrolled.json.passkey.id;
  assert.equal((await h.call("DELETE", `/api/auth/passkeys/${id}`, { cookie: passkeyCookie })).status, 403);
  assert.equal(store.listCredentials().length, 1);

  const tokenCookie = await h.tokenSignIn();
  assert.equal((await h.call("DELETE", `/api/auth/passkeys/${id}`, { cookie: tokenCookie })).status, 200);
  // Revoking a credential ends the sessions it granted, and only those.
  assert.equal((await h.call("POST", "/api/probe", { cookie: passkeyCookie })).status, 401);
  assert.equal((await h.call("POST", "/api/probe", { cookie: tokenCookie })).status, 200);
  assert.equal((await h.passkeySignIn(key)).status, 401);
});

test("two passkeys both sign in; revoking one leaves the other", async (t) => {
  const h = await harness(t);
  const a = new SoftAuthenticator();
  const b = new SoftAuthenticator();
  const ea = await h.enrol(a, { bearer: TOKEN }, "a");
  await h.enrol(b, { bearer: TOKEN }, "b");
  assert.equal((await h.passkeySignIn(a)).status, 200);
  assert.equal((await h.passkeySignIn(b)).status, 200);
  await h.call("DELETE", `/api/auth/passkeys/${ea.json.passkey.id}`, { bearer: TOKEN });
  assert.equal((await h.passkeySignIn(a)).status, 401);
  assert.equal((await h.passkeySignIn(b)).status, 200);
});

test("the same authenticator cannot be enrolled twice", async (t) => {
  const h = await harness(t);
  const key = new SoftAuthenticator();
  assert.equal((await h.enrol(key, { bearer: TOKEN })).status, 200);
  assert.equal((await h.enrol(key, { bearer: TOKEN })).status, 409);
});

test("enrolment cannot commit after its token session ends or a host reset invalidates its ceremony", async (t) => {
  const h = await harness(t);
  const cookie = await h.tokenSignIn();
  const sessionToken = cookie.split("=")[1];
  const key = new SoftAuthenticator();
  const candidate = { credentialId: key.id, publicKey: key.coseKey().toString("base64url"), counter: 0, transports: ["internal"], label: "pending" };
  store.issueChallenge("registration", "pending-session");
  const generation = store.consumeChallenge("pending-session", "registration");
  store.destroySession(sessionToken);
  assert.throws(() => store.addCredential(candidate, { generation, sessionToken }), store.AuthorityExpiredError);

  store.issueChallenge("registration", "pending-reset");
  const beforeReset = store.consumeChallenge("pending-reset", "registration");
  store.resetAll();
  assert.throws(() => store.addCredential(candidate, { generation: beforeReset, sessionToken: null }), store.AuthorityExpiredError);
  assert.equal(store.hasCredentials(), false);
});

// ─── Ceremonies ──────────────────────────────────────────

test("a response signed for another origin is refused, at enrolment and sign-in", async (t) => {
  const h = await harness(t);
  const key = new SoftAuthenticator();
  const opts = await h.call("POST", "/api/auth/passkey/register/options", { body: {}, bearer: TOKEN });
  const forged = key.register(opts.json.options, { origin: "https://evil.example" });
  assert.equal((await h.call("POST", "/api/auth/passkey/register/verify", { body: { response: forged }, bearer: TOKEN })).status, 400);
  assert.equal(store.listCredentials().length, 0);

  await h.enrol(key, { bearer: TOKEN });
  const login = await h.passkeySignIn(key, { origin: "https://evil.example" });
  assert.equal(login.status, 401);
  assert.equal(login.cookie, null);
});

test("a replayed assertion is refused because its challenge is spent", async (t) => {
  const h = await harness(t);
  const key = new SoftAuthenticator();
  await h.enrol(key, { bearer: TOKEN });
  const first = await h.passkeySignIn(key);
  assert.equal(first.status, 200);
  const replay = await h.call("POST", "/api/auth/passkey/login/verify", { body: { response: first.response } });
  assert.equal(replay.status, 400);
});

test("an assertion for an expired challenge is refused", async (t) => {
  const h = await harness(t);
  const key = new SoftAuthenticator();
  await h.enrol(key, { bearer: TOKEN });
  const opts = await h.call("POST", "/api/auth/passkey/login/options", { body: {} });
  sql("UPDATE challenges SET expiresAt=1");
  const response = key.authenticate(opts.json.options, { origin: ORIGIN });
  assert.equal((await h.call("POST", "/api/auth/passkey/login/verify", { body: { response } })).status, 400);
});

test("a signature counter that does not advance is refused; the baseline moves on success", async (t) => {
  const h = await harness(t);
  const key = new SoftAuthenticator({ counterStep: 1 });
  await h.enrol(key, { bearer: TOKEN });
  assert.equal((await h.passkeySignIn(key)).status, 200); // counter 1
  assert.equal(store.findCredential(key.id).counter, 1);
  assert.equal((await h.passkeySignIn(key, { advance: false })).status, 401); // still 1: a clone
  assert.equal((await h.passkeySignIn(key)).status, 200); // 2
});

test("concurrent assertions cannot commit the same nonzero signature counter twice", async (t) => {
  const h = await harness(t);
  const key = new SoftAuthenticator();
  await h.enrol(key, { bearer: TOKEN });
  const first = await h.call("POST", "/api/auth/passkey/login/options", { body: {} });
  const second = await h.call("POST", "/api/auth/passkey/login/options", { body: {} });
  const a = key.authenticate(first.json.options, { origin: ORIGIN });
  const b = key.authenticate(second.json.options, { origin: ORIGIN, advance: false });
  const results = await Promise.all([a, b].map((response) =>
    h.call("POST", "/api/auth/passkey/login/verify", { body: { response } })
  ));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
  assert.equal(store.findCredential(key.id).counter, 1);
});

test("revocation during signature verification cannot grant a new session", async (t) => {
  const h = await harness(t);
  const key = new SoftAuthenticator();
  const enrolled = await h.enrol(key, { bearer: TOKEN });
  store.issueChallenge("authentication", "revocation-race");
  const generation = store.consumeChallenge("revocation-race", "authentication");
  store.removeCredential(enrolled.json.passkey.id);
  assert.equal(store.completeAuthentication(enrolled.json.passkey.id, 1, 60_000, generation), null);
});

test("a synced passkey that always reports counter 0 keeps working", async (t) => {
  const h = await harness(t);
  const key = new SoftAuthenticator({ counterStep: 0 });
  await h.enrol(key, { bearer: TOKEN });
  for (let i = 0; i < 3; i++) assert.equal((await h.passkeySignIn(key)).status, 200);
});

test("sign-in options look the same whether or not anything is enrolled", async (t) => {
  const h = await harness(t);
  const before = await h.call("POST", "/api/auth/passkey/login/options", { body: {} });
  const statusBefore = await h.call("GET", "/api/auth/status", {});
  await h.enrol(new SoftAuthenticator(), { bearer: TOKEN });
  const after = await h.call("POST", "/api/auth/passkey/login/options", { body: {} });
  const statusAfter = await h.call("GET", "/api/auth/status", {});
  assert.equal(before.status, after.status);
  assert.deepEqual(Object.keys(before.json.options).sort(), Object.keys(after.json.options).sort());
  assert.deepEqual(after.json.options.allowCredentials, []);
  assert.deepEqual(statusBefore.json, statusAfter.json);
  // Listing needs a credential.
  assert.equal((await h.call("GET", "/api/auth/passkeys", {})).status, 401);
});

test("garbage verify bodies are refused cheaply and never drive the sign-in delay", async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 30; i++) {
    const r = await h.call("POST", "/api/auth/passkey/login/verify", { body: { response: { id: "x", response: {} } } });
    assert.equal(r.status, 400);
  }
  assert.equal(store.loginBackoffMs(), 0);
});

test("failed sign-ins that spent a real challenge are delayed past the limit, never refused", async (t) => {
  const h = await harness(t);
  const enrolled = new SoftAuthenticator();
  await h.enrol(enrolled, { bearer: TOKEN });
  for (let i = 0; i < 11; i++) assert.equal((await h.passkeySignIn(new SoftAuthenticator())).status, 401);
  assert.ok(store.loginBackoffMs() > 0);
  // The genuine assertion is still processed — after the delay — and resets the window.
  assert.equal((await h.passkeySignIn(enrolled)).status, 200);
  assert.equal(store.loginBackoffMs(), 0);
});

test("filling the anonymous challenge pool does not deny new login or authenticated enrolment", async (t) => {
  const h = await harness(t);
  const key = new SoftAuthenticator();
  await h.enrol(key, { bearer: TOKEN });
  const registration = await h.call("POST", "/api/auth/passkey/register/options", { body: {}, bearer: TOKEN });
  for (let i = 0; i < store.MAX_LIVE_CHALLENGES + 1; i++) {
    assert.equal((await h.call("POST", "/api/auth/passkey/login/options", { body: {} })).status, 200);
  }
  assert.equal(sql("SELECT COUNT(*) AS n FROM challenges WHERE purpose='authentication'")[0].n, store.MAX_LIVE_CHALLENGES);
  assert.equal((await h.passkeySignIn(key)).status, 200);
  const other = new SoftAuthenticator();
  const response = other.register(registration.json.options, { origin: ORIGIN });
  assert.equal((await h.call("POST", "/api/auth/passkey/register/verify", { body: { response }, bearer: TOKEN })).status, 200);
});

// ─── Sessions ────────────────────────────────────────────

test("signing out destroys the session server-side; a forged cookie is refused", async (t) => {
  const h = await harness(t);
  const cookie = await h.tokenSignIn();
  assert.equal((await h.call("POST", "/api/probe", { cookie })).status, 200);
  const out = await h.call("POST", "/api/auth/logout", { body: {}, cookie });
  assert.match(out.setCookie[0], /Max-Age=0/);
  assert.equal((await h.call("POST", "/api/probe", { cookie })).status, 401);
  assert.equal((await h.call("POST", "/api/probe", { cookie: "sparkdash_session=forged" })).status, 401);
});

test("a session survives a restart: state is on disk, not in memory", async (t) => {
  const h = await harness(t);
  const cookie = await h.tokenSignIn();
  store._resetForTests();
  store.armStore(TOKEN);
  assert.equal((await h.call("POST", "/api/probe", { cookie })).status, 200);
});

test("an expired session is refused", async (t) => {
  const h = await harness(t);
  const cookie = await h.tokenSignIn();
  sql("UPDATE sessions SET createdAt=0, expiresAt=1");
  assert.equal((await h.call("POST", "/api/probe", { cookie })).status, 401);
});

test("a cookie-authenticated mutation or WebSocket must come from the configured origin", async (t) => {
  const h = await harness(t);
  const cookie = await h.tokenSignIn();
  assert.equal((await h.call("POST", "/api/probe", { cookie, origin: "http://localhost:5173" })).status, 403);
  assert.equal((await h.call("POST", "/api/probe", { cookie, origin: null })).status, 403);
  const upgrade = (origin) => ({ method: "GET", url: "/ws", headers: { host: "localhost:5555", upgrade: "websocket", origin, cookie } });
  assert.equal(authorizeUpgrade(upgrade(ORIGIN)), true);
  assert.equal(authorizeUpgrade(upgrade("http://localhost:5173")), false);
});

test("the session token is not stored: the file holds only its digest", async (t) => {
  const h = await harness(t);
  const cookie = await h.tokenSignIn();
  const raw = fs.readFileSync(passkeysDbPath());
  assert.ok(!raw.includes(cookie.split("=")[1]));
  assert.ok(!raw.includes(TOKEN));
  assert.equal(fs.statSync(passkeysDbPath()).mode & 0o777, 0o600);
});

test("a lost token binding cannot preserve credentials or sessions under a new token", async (t) => {
  const h = await harness(t);
  await h.enrol(new SoftAuthenticator(), { bearer: TOKEN });
  const cookie = await h.tokenSignIn();
  sql("DELETE FROM meta WHERE key='keyFingerprint'");
  store._resetForTests();
  store.armStore("new-token");
  process.env.SPARKDASH_TOKEN = "new-token";
  assert.equal(store.hasCredentials(), false);
  assert.equal((await h.call("POST", "/api/probe", { cookie })).status, 401);
});

// ─── Token rotation ──────────────────────────────────────

test("rotating SPARKDASH_TOKEN invalidates every passkey and session; keeping it preserves them", async (t) => {
  const h = await harness(t);
  const key = new SoftAuthenticator();
  await h.enrol(key, { bearer: TOKEN });
  const cookie = await h.tokenSignIn();

  store._resetForTests();
  store.armStore(TOKEN); // same token: a restart
  assert.equal(store.listCredentials().length, 1);
  assert.equal((await h.call("POST", "/api/probe", { cookie })).status, 200);

  process.env.SPARKDASH_TOKEN = "rotated-token";
  store._resetForTests();
  store.armStore("rotated-token");
  assert.equal(store.listCredentials().length, 0);
  assert.equal((await h.call("POST", "/api/probe", { cookie })).status, 401);
  assert.equal((await h.enrol(new SoftAuthenticator(), { bearer: "rotated-token" })).status, 200);
});

test("a token-established session dies with a rotation even when nothing was ever enrolled", async (t) => {
  const h = await harness(t);
  const cookie = await h.tokenSignIn();
  process.env.SPARKDASH_TOKEN = "rotated-token";
  store._resetForTests();
  store.armStore("rotated-token");
  assert.equal((await h.call("POST", "/api/probe", { cookie })).status, 401);
});

// ─── Passkey-only ────────────────────────────────────────

test("passkey-only refuses the token once a passkey exists, except Prometheus on /metrics", async (t) => {
  const h = await harness(t, { SPARKDASH_PASSKEY_ONLY: "1" });
  // Nothing enrolled: the token still works, so the flag is never a one-way door.
  assert.equal((await h.call("POST", "/api/probe", { bearer: TOKEN })).status, 200);
  const keyCookie = await h.tokenSignIn();
  const key = new SoftAuthenticator();
  assert.equal((await h.enrol(key, { cookie: keyCookie })).status, 200);

  assert.equal((await h.call("POST", "/api/probe", { bearer: TOKEN })).status, 401);
  assert.equal((await h.call("POST", "/api/auth/session/token", { body: {}, bearer: TOKEN })).status, 403);
  assert.equal(authorizeUpgrade({ method: "GET", url: `/ws?token=${TOKEN}`, headers: { host: "localhost:5555" } }), false);
  assert.equal((await h.call("GET", "/metrics", { bearer: TOKEN })).status, 200);
  assert.equal((await h.passkeySignIn(key)).status, 200);
});

// ─── Route surface ───────────────────────────────────────

test("only the enumerated sign-in routes answer an anonymous caller; none resets enrolment", async (t) => {
  const h = await harness(t);
  await h.enrol(new SoftAuthenticator(), { bearer: TOKEN });
  const app = express();
  registerPasskeyRoutes(app);
  const routes = app.router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${layer.route.path}`));
  for (const route of EXEMPT_ROUTES) assert.ok(routes.includes(route), `${route} is not registered`);
  for (const route of routes.filter((r) => !EXEMPT_ROUTES.includes(r))) {
    const [method, pattern] = route.split(" ");
    const r = await h.call(method, pattern.replace(":id", "x"), { body: method === "GET" ? undefined : {} });
    assert.equal(r.status, 401, `${route} answered an anonymous caller with ${r.status}`);
  }
  assert.equal(store.listCredentials().length, 1);
});

// ─── Disarmed ────────────────────────────────────────────

test("with no passkey origin the routes are absent and the store is never created", async (t) => {
  const h = await harness(t, { SPARKDASH_PASSKEY_ORIGIN: "" });
  assert.equal((await h.call("POST", "/api/auth/session/token", { body: {}, bearer: TOKEN })).status, 404);
  assert.equal((await h.call("POST", "/api/auth/passkey/login/options", { body: {} })).status, 404);
  const status = await h.call("GET", "/api/auth/status", { bearer: TOKEN });
  assert.deepEqual(status.json, { tokenRequired: true, authenticated: true, passkeys: { enabled: false }, session: null });
  assert.equal(fs.existsSync(passkeysDbPath()), false);
});

// ─── Configuration ───────────────────────────────────────

test("the origin must be a secure context bound to a hostname", (t) => {
  const saved = process.env.SPARKDASH_PASSKEY_ORIGIN;
  t.after(() => (saved == null ? delete process.env.SPARKDASH_PASSKEY_ORIGIN : (process.env.SPARKDASH_PASSKEY_ORIGIN = saved)));
  const accepted = {
    "https://spark.example.ts.net": "https://spark.example.ts.net",
    "https://spark.example.ts.net/": "https://spark.example.ts.net",
    "http://localhost:5555": "http://localhost:5555",
    "  ": "",
    "": "",
  };
  for (const [raw, origin] of Object.entries(accepted)) {
    process.env.SPARKDASH_PASSKEY_ORIGIN = raw;
    assert.equal(passkeyOrigin(), origin, raw);
  }
  for (const raw of [
    "http://spark.lan:5555",
    "http://127.0.0.1:5555",
    "https://192.168.1.20",
    "https://[::1]",
    "https://spark.example/dash",
    "https://user:pw@spark.example",
    "ftp://spark.example",
    "spark.example",
  ]) {
    process.env.SPARKDASH_PASSKEY_ORIGIN = raw;
    assert.throws(() => passkeyOrigin(), /SPARKDASH_PASSKEY_ORIGIN/, raw);
  }
});

test("preflight refuses an origin without a token, and an unusable store location", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sparkdash-preflight-"));
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  t.after(async () => {
    for (const k of ENV_KEYS) saved[k] == null ? delete process.env[k] : (process.env[k] = saved[k]);
    await rm(dir, { recursive: true, force: true });
  });
  process.env.SPARKDASH_PASSKEY_ORIGIN = ORIGIN;
  process.env.PASSKEYS_DB_PATH = path.join(dir, "passkeys.sqlite");
  assert.match(passkeyPreflightProblem({ tokenConfigured: false }), /SPARKDASH_TOKEN/);
  assert.equal(passkeyPreflightProblem({ tokenConfigured: true }), null);

  process.env.PASSKEYS_DB_PATH = "config/passkeys.sqlite";
  assert.match(passkeyPreflightProblem({ tokenConfigured: true }), /PASSKEYS_DB_PATH must be an absolute path.*SPARKDASH_PASSKEY_ORIGIN/);

  const blocker = path.join(dir, "file");
  fs.writeFileSync(blocker, "");
  process.env.PASSKEYS_DB_PATH = path.join(blocker, "passkeys.sqlite");
  assert.match(passkeyPreflightProblem({ tokenConfigured: true }), /cannot be created or opened.*SPARKDASH_PASSKEY_ORIGIN/);

  // Compose passes the variable present and empty: that means the default, an absolute path.
  process.env.PASSKEYS_DB_PATH = "";
  assert.ok(path.isAbsolute(passkeysDbPath()));
  process.env.SPARKDASH_PASSKEY_ORIGIN = "http://spark.lan";
  assert.match(passkeyPreflightProblem({ tokenConfigured: true }), /not a secure context/);
});

for (const operation of ["login", "enrol"]) {
  test(`invalid stored credential metadata disarms strict mode during ${operation}`, async (t) => {
    const h = await harness(t, { SPARKDASH_PASSKEY_ONLY: "1" });
    const cookie = await h.tokenSignIn();
    const key = new SoftAuthenticator();
    await h.enrol(key, { cookie });
    sql("UPDATE credentials SET transports='['");
    if (operation === "login") {
      assert.equal((await h.passkeySignIn(key)).status, 401);
    } else {
      assert.equal((await h.call("POST", "/api/auth/passkey/register/options", { body: {}, cookie })).status, 500);
    }
    const status = await h.call("GET", "/api/auth/status", { bearer: TOKEN });
    assert.deepEqual(status.json.passkeys, { enabled: false });
    assert.equal((await h.call("POST", "/api/probe", { bearer: TOKEN })).status, 200);
    assert.equal((await h.call("POST", "/api/probe", { cookie })).status, 401);
  });
}

test("a store read failure after startup disarms passkeys and leaves legacy token access usable", async (t) => {
  const h = await harness(t);
  const cookie = await h.tokenSignIn();
  sql("DROP TABLE sessions");
  const status = await h.call("GET", "/api/auth/status", { cookie });
  assert.deepEqual(status.json.passkeys, { enabled: false });
  assert.equal(status.json.authenticated, false);
  assert.equal((await h.call("POST", "/api/probe", { cookie })).status, 401);
  assert.equal((await h.call("POST", "/api/probe", { bearer: TOKEN })).status, 200);
});

test("a corrupt store does not stop serving: it reads as un-enrolled and the token still works", async (t) => {
  const h = await harness(t);
  await h.enrol(new SoftAuthenticator(), { bearer: TOKEN });
  store._resetForTests();
  fs.writeFileSync(passkeysDbPath(), "not a database");
  const inventory = spawnSync(process.execPath, ["server/passkeyAdmin.js", "list"], { cwd: REPO, env: { ...process.env }, encoding: "utf8" });
  assert.equal(inventory.status, 1, "an unreadable inventory must not report successful empty enrolment");
  assert.doesNotMatch(inventory.stdout, /No passkeys enrolled/);
  store.armStore(TOKEN);
  assert.equal((await h.call("POST", "/api/probe", { bearer: TOKEN })).status, 200);
  assert.equal(store.hasCredentials(), false);
  assert.equal((await h.call("POST", "/api/auth/passkey/login/options", { body: {} })).status, 404);
  assert.deepEqual((await h.call("GET", "/api/auth/status")).json.passkeys, { enabled: false });
  const recovery = spawnSync(process.execPath, ["server/passkeyAdmin.js", "reset"], { cwd: REPO, env: { ...process.env }, encoding: "utf8" });
  assert.equal(recovery.status, 0, recovery.stderr);
  assert.ok(fs.readdirSync(h.dir).some((f) => f.startsWith("passkeys.sqlite.corrupt-")));
  store._resetForTests();
  store.armStore(TOKEN);
  assert.equal((await h.enrol(new SoftAuthenticator(), { bearer: TOKEN })).status, 200);
});

// ─── Host recovery and the shipped entry point ───────────

test("the host reset clears passkeys and sessions, and a running server sees it", async (t) => {
  const h = await harness(t);
  const key = new SoftAuthenticator();
  await h.enrol(key, { bearer: TOKEN });
  const cookie = (await h.passkeySignIn(key)).cookie;
  const run = spawnSync(process.execPath, ["server/passkeyAdmin.js", "reset"], {
    cwd: REPO,
    env: { ...process.env },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /removed 1 passkey/);
  assert.equal((await h.call("POST", "/api/probe", { cookie })).status, 401);
  assert.equal((await h.passkeySignIn(key)).status, 401);
  assert.equal((await h.enrol(key, { bearer: TOKEN })).status, 200);
});

async function freePort() {
  const probe = createNetServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

async function startServer(t, env) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-passkey-boot-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: REPO,
    env: { ...process.env, ...isolatedConfigEnv(tmp), BIND_HOST: "127.0.0.1", PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  return { child, output: () => output, tmp, port };
}

test("index.js refuses to start with a passkey origin but no token", async (t) => {
  const { child, output } = await startServer(t, { SPARKDASH_TOKEN: "", SPARKDASH_PASSKEY_ORIGIN: ORIGIN });
  let timer;
  const code = await Promise.race([
    once(child, "exit").then(([c]) => c),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`still running:\n${output()}`)), 10_000);
    }),
  ]).finally(() => clearTimeout(timer));
  assert.equal(code, 1);
  assert.match(output(), /SPARKDASH_PASSKEY_ORIGIN is set but SPARKDASH_TOKEN is not/);
});

test("index.js serves passkey routes and ends existing sockets on logout or store failure", { timeout: 25_000 }, async (t) => {
  const { output, tmp, port } = await startServer(t, { SPARKDASH_TOKEN: TOKEN, SPARKDASH_PASSKEY_ORIGIN: ORIGIN });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !/server listening on/.test(output())) await new Promise((r) => setTimeout(r, 100));
  assert.match(output(), /server listening on/);
  assert.match(output(), /passkey sign-in armed for http:\/\/localhost:5555/);
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/session/token`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 200);
  assert.ok(fs.existsSync(path.join(tmp, "passkeys_db_path.json")));

  const cookie = res.headers.getSetCookie()[0].split(";")[0];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: ORIGIN } });
  t.after(() => socket.terminate());
  const received = once(socket, "message");
  await once(socket, "open");
  const [payload] = await received;
  assert.equal(JSON.parse(payload.toString()).type, "snapshot");

  const ended = once(socket, "close");
  const logout = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, {
    method: "POST",
    headers: { cookie, origin: ORIGIN },
  });
  assert.equal(logout.status, 200);
  const [code] = await ended;
  assert.equal(code, 1008, "the existing socket must stop before sending telemetry after logout");

  const signedInAgain = await fetch(`http://127.0.0.1:${port}/api/auth/session/token`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: "{}",
  });
  const secondCookie = signedInAgain.headers.getSetCookie()[0].split(";")[0];
  const secondSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: secondCookie, origin: ORIGIN } });
  t.after(() => secondSocket.terminate());
  await once(secondSocket, "message");
  const afterFault = Promise.race([
    once(secondSocket, "close").then(([closeCode]) => closeCode),
    once(secondSocket, "message").then(() => 0),
  ]);
  const authorityDb = new DatabaseSync(path.join(tmp, "passkeys_db_path.json"));
  authorityDb.exec("DROP TABLE sessions");
  authorityDb.close();
  const status = await fetch(`http://127.0.0.1:${port}/api/auth/status`, { headers: { cookie: secondCookie } }).then((r) => r.json());
  assert.deepEqual(status.passkeys, { enabled: false });
  assert.equal(await afterFault, 1008, "a disarmed authority store must not leave a cookie-authenticated socket streaming");
});
