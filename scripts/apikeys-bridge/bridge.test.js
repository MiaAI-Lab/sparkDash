import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createBridge, MAX_FAILURES, FAILURE_WINDOW_MS } from "./bridge.js";

const TOKEN = "fixture-bridge-token";
const SHA = crypto.createHash("sha256").update(TOKEN).digest("hex");
const ID = "c".repeat(64);
const MASTER = "fixture-master-value";

function fakeLitellm(calls) {
  return async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    const u = new URL(url);
    const body = u.pathname === "/health/readiness" ? { status: "healthy" }
      : u.pathname === "/key/list" ? { keys: [{ token: ID, key_alias: "a", spend: 2, key_name: "sk-...xyz" }, { token: "short" }], total_pages: 1 }
      : u.pathname === "/key/info" ? { info: { key_alias: "a" } } : null;
    return { status: body ? 200 : 404, json: async () => body };
  };
}

async function start(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apikeys-bridge-"));
  const socketPath = path.join(dir, "b.sock");
  const calls = [];
  const server = createBridge({ tokenSha256: SHA, litellmUrl: "http://litellm.test", masterKey: MASTER, fetchImpl: fakeLitellm(calls), ...opts });
  await new Promise((r) => server.listen(socketPath, r));
  const req = (method, p, token = TOKEN) => new Promise((resolve, reject) => {
    const r = http.request({ socketPath, method, path: p, headers: token ? { Authorization: `Bearer ${token}` } : {} }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(d) }));
    });
    r.on("error", reject);
    r.end();
  });
  return { req, calls, close: () => new Promise((r) => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); r(); })) };
}

test("answers the three read-only calls and maps LiteLLM fields", async () => {
  const b = await start();
  assert.deepEqual((await b.req("GET", "/v1/health")).json, { version: "1", upstream: "ok" });
  const list = (await b.req("GET", "/v1/keys")).json;
  assert.equal(list.keys.length, 1);
  assert.equal(list.keys[0].spend, 2);
  assert.equal(JSON.stringify(list).includes("sk-"), false);
  const one = (await b.req("GET", `/v1/keys/${ID}`)).json;
  assert.equal(one.key.spend, null, "missing spend stays null");
  assert.ok(b.calls.every((c) => c.auth === `Bearer ${MASTER}`));
  await b.close();
});

test("refuses writes and unknown paths without calling LiteLLM", async () => {
  const b = await start();
  for (const m of ["POST", "PATCH", "DELETE", "PUT"]) assert.equal((await b.req(m, "/v1/keys")).status, 405);
  for (const p of ["/v1/keys/abc", `/v1/keys/${ID}/block`, "/key/generate", "/v1/audit"]) assert.equal((await b.req("GET", p)).status, 404, p);
  assert.equal(b.calls.length, 0);
  await b.close();
});

test("locks out after repeated bad tokens, then recovers when the window passes", async () => {
  let clock = 5_000_000;
  const b = await start({ now: () => clock });
  for (let i = 0; i < MAX_FAILURES; i++) assert.equal((await b.req("GET", "/v1/health", "wrong")).status, 401);
  const locked = await b.req("GET", "/v1/health");
  assert.equal(locked.status, 429, "even the right token waits during lockout");
  assert.equal(Number(locked.headers["retry-after"]), FAILURE_WINDOW_MS / 1000);
  assert.equal((await b.req("GET", "/v1/health", "")).status, 429);
  clock += FAILURE_WINDOW_MS;
  assert.equal((await b.req("GET", "/v1/health")).status, 200);
  assert.equal(b.calls.length, 1);
  await b.close();
});

test("refuses to start without a valid token hash or master key", () => {
  assert.throws(() => createBridge({ tokenSha256: "abc", litellmUrl: "x", masterKey: "m" }), /sha256/);
  assert.throws(() => createBridge({ tokenSha256: SHA, litellmUrl: "x", masterKey: "" }), /master key/);
});
