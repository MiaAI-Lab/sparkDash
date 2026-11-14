import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createBridge, MAX_FAILURES, FAILURE_WINDOW_MS, MAX_UPSTREAM_BYTES } from "./bridge.js";

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
    return new Response(JSON.stringify(body), { status: body ? 200 : 404 });
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

test("a key list longer than the page cap is refused, not cut off", async () => {
  let calls = 0;
  const b = await start({
    fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ keys: [{ token: ID }], total_pages: 999 }), { status: 200 });
    },
  });
  const r = await b.req("GET", "/v1/keys");
  assert.equal(r.status, 502);
  assert.match(r.json.error, /more than/);
  assert.equal(calls, 1, "refused on the first page's total_pages");
  await b.close();
});

test("a key list page whose total_pages is not a positive whole number is refused, not cut off", async () => {
  let reply = "";
  const b = await start({ fetchImpl: async () => new Response(reply, { status: 200 }) });
  const key = { token: ID };
  for (const page of [
    { keys: [key] },
    { keys: [key], total_pages: null },
    { keys: [key], total_count: 1, total_pages: 0 },
    { keys: [], total_pages: 0 },
    { keys: [key], total_pages: -1 },
    { keys: [key], total_pages: 1.5 },
    { keys: [key], total_pages: "2" },
  ]) {
    reply = JSON.stringify(page);
    const r = await b.req("GET", "/v1/keys");
    assert.equal(r.status, 502, reply);
    assert.match(r.json.error, /total_pages/, reply);
  }
  // NaN and Infinity are not valid JSON, so such a reply does not parse; 1e999 parses as Infinity.
  for (const raw of ['{"keys":[],"total_pages":NaN}', '{"keys":[],"total_pages":Infinity}', '{"keys":[],"total_pages":1e999}']) {
    reply = raw;
    assert.equal((await b.req("GET", "/v1/keys")).status, 502, raw);
  }
  await b.close();
});

test("LiteLLM's reply for an empty key table (total_pages 0) is an empty list", async () => {
  const reply = { keys: [], total_count: 0, current_page: 1, total_pages: 0 };
  const b = await start({ fetchImpl: async () => new Response(JSON.stringify(reply), { status: 200 }) });
  const r = await b.req("GET", "/v1/keys");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { keys: [] });
  await b.close();
});

test("a multi-page key list is read page by page, with characters split across chunks", async () => {
  const ids = ["a", "b", "c"].map((ch) => ch.repeat(64));
  const pages = [];
  const fetchImpl = async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    pages.push(page);
    const reply = { keys: [{ token: ids[page - 1], key_alias: `clé €${page}` }], total_count: 3, current_page: page, total_pages: 3 };
    const bytes = new TextEncoder().encode(JSON.stringify(reply));
    let i = 0;
    // One byte per chunk, so every multi-byte character arrives split across reads.
    const body = new ReadableStream({
      pull(c) {
        if (i === bytes.length) return c.close();
        c.enqueue(bytes.slice(i, i + 1));
        i++;
      },
    });
    return new Response(body, { status: 200 });
  };
  const b = await start({ fetchImpl });
  const r = await b.req("GET", "/v1/keys");
  assert.equal(r.status, 200);
  assert.deepEqual(pages, [1, 2, 3]);
  assert.deepEqual(r.json.keys.map((k) => [k.id, k.alias]), ids.map((id, i) => [id, `clé €${i + 1}`]));
  await b.close();
});

// A body of `count` chunks of `size` bytes. highWaterMark 0: a chunk is pulled only when the bridge
// reads, so `seen.pulls` is what the bridge actually read; `seen.cancelled` counts cancel() calls.
function countedBody(count, size, seen) {
  return new ReadableStream(
    {
      pull(c) {
        if (seen.pulls === count) return c.close();
        seen.pulls++;
        c.enqueue(new Uint8Array(size).fill(0x20));
      },
      cancel() {
        seen.cancelled++;
      },
    },
    { highWaterMark: 0 },
  );
}

test("an oversized LiteLLM reply is cancelled once it passes the limit, not buffered whole", async () => {
  const CHUNK = 1024 * 1024;
  const seen = [];
  const b = await start({
    fetchImpl: async () => {
      const s = { pulls: 0, cancelled: 0 };
      seen.push(s);
      // Four times the limit: reading the whole body first would pull every chunk and never cancel.
      return new Response(countedBody((4 * MAX_UPSTREAM_BYTES) / CHUNK, CHUNK, s), { status: 200 });
    },
  });
  assert.equal((await b.req("GET", "/v1/keys")).status, 502);
  assert.equal((await b.req("GET", "/v1/health")).json.upstream, "down");
  assert.equal(seen.length, 2);
  for (const s of seen) {
    assert.ok(s.pulls <= MAX_UPSTREAM_BYTES / CHUNK + 1, `read ${s.pulls} chunks`);
    assert.equal(s.cancelled, 1);
  }
  await b.close();
});

test("a LiteLLM reply whose Content-Length is over the limit is refused before reading it", async () => {
  const seen = { pulls: 0, cancelled: 0 };
  const headers = { "Content-Length": String(MAX_UPSTREAM_BYTES + 1) };
  const b = await start({ fetchImpl: async () => new Response(countedBody(1, 16, seen), { status: 200, headers }) });
  assert.equal((await b.req("GET", "/v1/keys")).status, 502);
  assert.deepEqual(seen, { pulls: 0, cancelled: 1 });
  await b.close();
});

test("refuses to start without a valid token hash or master key", () => {
  assert.throws(() => createBridge({ tokenSha256: "abc", litellmUrl: "x", masterKey: "m" }), /sha256/);
  assert.throws(() => createBridge({ tokenSha256: SHA, litellmUrl: "x", masterKey: "" }), /master key/);
});
