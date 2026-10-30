import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { registerApiKeysRoutes, createApiKeysService, backoffMs, BACKOFF_BASE_MS, BACKOFF_MAX_MS } from "../routes.js";
import { bridgeGet, isBridgeCall } from "../bridgeClient.js";
import { normalizeKey } from "../normalize.js";

const ID = "a".repeat(64);
const TOKEN = "test-bridge-token-not-a-real-secret";

/** Fake bridge on a unix socket inside a temp dir; records every request. */
async function fakeBridge(handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-apikeys-"));
  const socketPath = path.join(dir, "bridge.sock");
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const [status, body, headers] = handler(req);
    res.writeHead(status, { "Content-Type": "application/json", ...(headers || {}) });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(socketPath, r));
  return { socketPath, seen, close: () => new Promise((r) => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); r(); })) };
}

async function startApp(settings, opts) {
  const app = express();
  registerApiKeysRoutes(app, { getSettings: () => settings, ...opts });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

const okBridge = (req) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return [401, { error: "admin token required" }];
  if (req.url === "/v1/health") return [200, { version: "1", upstream: "ok" }];
  if (req.url === "/v1/keys") return [200, { keys: [{ id: ID, alias: "team-a", state: "active", spend: 1.5, models: ["m"] }, { id: "b".repeat(64), alias: "no-spend" }, { id: "not-hex", alias: "dropped" }] }];
  if (req.url === `/v1/keys/${ID}`) return [200, { key: { id: ID, alias: "team-a", spend: "oops" } }];
  return [404, { error: "not found" }];
};

test("while apiKeysEnabled is off every route is 404 and the bridge is never called", async () => {
  const b = await fakeBridge(okBridge);
  const a = await startApp({ apiKeysEnabled: false }, { env: { SPARKDASH_APIKEYS_BRIDGE_SOCKET: b.socketPath, SPARKDASH_APIKEYS_BRIDGE_TOKEN: TOKEN } });
  for (const p of ["/api/apikeys/status", "/api/apikeys/keys", `/api/apikeys/keys/${ID}`]) {
    assert.equal((await fetch(a.base + p)).status, 404, p);
  }
  assert.equal(b.seen.length, 0);
  await a.close();
  await b.close();
});

test("enabled: lists keys, unreadable spend stays null (unknown), invalid ids are dropped", async () => {
  const b = await fakeBridge(okBridge);
  const a = await startApp({ apiKeysEnabled: true }, { env: { SPARKDASH_APIKEYS_BRIDGE_SOCKET: b.socketPath, SPARKDASH_APIKEYS_BRIDGE_TOKEN: TOKEN } });
  const res = await fetch(a.base + "/api/apikeys/keys");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const { keys } = await res.json();
  assert.equal(keys.length, 2);
  assert.equal(keys[0].spend, 1.5);
  assert.equal(keys[1].spend, null);
  assert.equal(keys[1].state, "unknown");
  const one = await (await fetch(a.base + `/api/apikeys/keys/${ID}`)).json();
  assert.equal(one.key.spend, null);
  const st = await (await fetch(a.base + "/api/apikeys/status")).json();
  assert.deepEqual([st.configured, st.bridge, st.upstream], [true, "ok", "ok"]);
  assert.ok(b.seen.every((r) => r.method === "GET" && r.auth === `Bearer ${TOKEN}`));
  await a.close();
  await b.close();
});

test("a malformed key id is refused without a bridge call", async () => {
  const b = await fakeBridge(okBridge);
  const a = await startApp({ apiKeysEnabled: true }, { env: { SPARKDASH_APIKEYS_BRIDGE_SOCKET: b.socketPath, SPARKDASH_APIKEYS_BRIDGE_TOKEN: TOKEN } });
  for (const id of ["ABC", "a".repeat(63), "..%2F..%2Fhealth"]) assert.equal((await fetch(a.base + "/api/apikeys/keys/" + id)).status, 404);
  assert.equal(b.seen.length, 0);
  await a.close();
  await b.close();
});

test("unconfigured (no env): status says so, data routes are 503, nothing is fabricated", async () => {
  const a = await startApp({ apiKeysEnabled: true }, { env: {} });
  const st = await (await fetch(a.base + "/api/apikeys/status")).json();
  assert.deepEqual([st.configured, st.bridge, st.upstream], [false, "unconfigured", "unknown"]);
  const res = await fetch(a.base + "/api/apikeys/keys");
  assert.equal(res.status, 503);
  await a.close();
});

test("a rejected token backs off: no bridge calls until the window ends, doubling to the cap", async () => {
  let clock = 1_000_000;
  const b = await fakeBridge(() => [401, { error: "admin token required" }]);
  const svc = createApiKeysService({ socketPath: b.socketPath, token: "wrong", now: () => clock });
  const r1 = await svc.list();
  assert.equal(r1.status, 503);
  assert.equal(r1.retryAfterSec, BACKOFF_BASE_MS / 1000);
  assert.equal(b.seen.length, 1);
  const r2 = await svc.list();
  assert.equal(r2.status, 503);
  assert.equal(b.seen.length, 1, "no call during backoff");
  clock += BACKOFF_BASE_MS;
  const r3 = await svc.list();
  assert.equal(b.seen.length, 2);
  assert.equal(r3.retryAfterSec, (2 * BACKOFF_BASE_MS) / 1000);
  assert.equal(backoffMs(1), BACKOFF_BASE_MS);
  assert.equal(backoffMs(50), BACKOFF_MAX_MS);
  await b.close();
});

test("a successful call clears the backoff counter", async () => {
  let clock = 0;
  let accept = false;
  const b = await fakeBridge((req) => (accept ? okBridge(req) : [403, {}]));
  const svc = createApiKeysService({ socketPath: b.socketPath, token: TOKEN, now: () => clock });
  await svc.list();
  assert.equal(svc.state().rejections, 1);
  clock += BACKOFF_BASE_MS;
  accept = true;
  assert.equal((await svc.list()).ok, true);
  assert.deepEqual(svc.state(), { rejections: 0, blockedUntil: 0 });
  await b.close();
});

test("bridge 429 is honoured with its Retry-After; unreachable socket is 503", async () => {
  let clock = 0;
  const b = await fakeBridge(() => [429, { error: "slow down" }, { "Retry-After": "120" }]);
  const svc = createApiKeysService({ socketPath: b.socketPath, token: TOKEN, now: () => clock });
  assert.equal((await svc.list()).retryAfterSec, 120);
  await svc.list();
  assert.equal(b.seen.length, 1);
  await b.close();
  const gone = createApiKeysService({ socketPath: path.join(os.tmpdir(), "sparkdash-no-such.sock"), token: TOKEN });
  const r = await gone.list();
  assert.equal(r.status, 503);
});

test("the client refuses anything outside the fixed read-only call list", async () => {
  assert.equal(isBridgeCall("/v1/keys"), true);
  assert.equal(isBridgeCall(`/v1/keys/${ID}`), true);
  for (const p of ["/v1/keys/x", "/v1/keys?all=1", `/v1/keys/${ID}/block`, "/key/generate", "/v1/audit"]) assert.equal(isBridgeCall(p), false, p);
  const r = await bridgeGet({ socketPath: "/nonexistent", path: "/key/delete", token: TOKEN });
  assert.equal(r.error, "call not allowed");
});

test("normalizeKey drops unknown fields so key material cannot pass through", () => {
  const k = normalizeKey({ id: ID, key: "sk-should-not-pass", token: "x", spend: -1, maxBudget: "10" });
  assert.equal("key" in k || "token" in k, false);
  assert.equal(k.spend, null);
  assert.equal(k.maxBudget, 10);
});
