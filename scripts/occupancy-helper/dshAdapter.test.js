import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDsh, mapDshSession } from "./dshAdapter.js";

function response(body, ok = true) {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
}

test("an unreachable DSH web API is unavailable", async () => {
  const failed = await loadDsh({
    webUrl: "http://127.0.0.1:9",
    readProfiles: false,
    fetchFn: async () => { throw new Error("connect refused"); },
  });
  assert.equal(failed.coverage, "unavailable");
  assert.equal(failed.rows.length, 0);
  assert.match(failed.error, /connect refused/);
});

test("running is the only generating signal and a models failure keeps the session", async () => {
  const calls = [];
  const loaded = await loadDsh({
    webUrl: "http://127.0.0.1:3080",
    readProfiles: false,
    fetchFn: async (url) => {
      calls.push(url);
      if (String(url).endsWith("/api/session/list")) {
        return response({
          result: {
            ok: true,
            value: {
              items: [
                { sessionId: "blank", blank: true },
                {
                  sessionId: "live",
                  running: true,
                  updatedAt: 1_700_000_000,
                  projections: { values: { title: "Live", contextPressure: { pressureTokens: 1200, contextWindow: 8000 } } },
                },
                { sessionId: "idle", running: false, updatedAt: 1_700_000_000_000 },
              ],
            },
          },
        });
      }
      return response({ result: { ok: false } }, true);
    },
  });
  assert.equal(loaded.coverage, "supported");
  assert.equal(loaded.rows.length, 2);
  const live = loaded.rows.find((row) => row.sessionId === "live");
  assert.equal(live.activity, "generating");
  assert.equal(live.activityProvenance, "native");
  assert.equal(live.contextUsed, 1200);
  assert.equal(live.updatedAt, new Date(1_700_000_000 * 1000).toISOString());
  const idle = loaded.rows.find((row) => row.sessionId === "idle");
  assert.equal(idle.activity, "unknown");
  assert.equal(idle.updatedAt, new Date(1_700_000_000_000).toISOString());
  assert.equal(calls.some((url) => String(url).includes("session/models")), true);
});

test("a provider base URL becomes a native origin", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-dsh-"));
  fs.mkdirSync(path.join(dir, "work"));
  fs.writeFileSync(
    path.join(dir, "work", "cordis.patch.yml"),
    "providers:\n  deepseek:\n    baseURL: http://10.0.0.8:8000/v1\n"
  );
  const row = mapDshSession(
    { sessionId: "s", running: false, updatedAt: 10, projections: { values: { title: "S" } } },
    { provider: "deepseek", model: "chat" },
    new Map([["deepseek", { host: "10.0.0.8", port: 8000 }]])
  );
  assert.equal(row.originProvenance, "native");
  assert.deepEqual(row.origin, { host: "10.0.0.8", port: 8000 });
  assert.equal(row.activity, "unknown");
  const loaded = loadDsh({ webUrl: "not a url", profileDir: dir });
  return loaded.then((result) => assert.equal(result.coverage, "unavailable"));
});

test("DSH aborts stalled headers and bodies within its total refresh budget", { timeout: 1500 }, async () => {
  for (const body of [false, true]) {
    let signal;
    const pending = loadDsh({ readProfiles: false, timeoutMs: 30, fetchFn: async (_url, opts) => {
      signal = opts.signal;
      if (!body) return new Promise(() => {});
      return new Response(new ReadableStream({ start() {} }));
    } });
    const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve(null), 150))]);
    assert.ok(result, "DSH refresh must settle despite a silent endpoint");
    assert.equal(result.coverage, "unavailable");
    assert.equal(signal.aborted, true);
  }
});

test("DSH rejects oversized streamed JSON and cancels the reader", async () => {
  let cancelled = false;
  const result = await loadDsh({ readProfiles: false, maxBytes: 32, fetchFn: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(64))); },
    cancel() { cancelled = true; },
  })) });
  assert.equal(result.coverage, "unavailable");
  assert.match(result.error, /size cap/);
  assert.equal(cancelled, true);
});

test("real DSH stalled sockets close on deadline and a later list succeeds", async (t) => {
  const http = await import('node:http');
  const sockets = new Set();
  let stall = true;
  let stalledSocket;
  const server = http.createServer((_req, res) => {
    if (stall) { stalledSocket = res.socket; res.writeHead(200); res.write('{'); }
    else res.end(JSON.stringify({ result: { ok: true, value: { items: [] } } }));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const webUrl = `http://127.0.0.1:${server.address().port}`;
  const result = await loadDsh({ webUrl, readProfiles: false, timeoutMs: 100 });
  assert.equal(result.coverage, 'unavailable');
  assert.match(result.error, /timed out/);
  for (let i = 0; i < 100 && !stalledSocket.destroyed; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(stalledSocket.destroyed, true, 'deadline must close the stalled response socket');
  stall = false;
  assert.equal((await loadDsh({ webUrl, readProfiles: false })).coverage, 'supported');
});

test("optional model lookups share the list deadline instead of restarting it", async () => {
  let signal;
  const result = await loadDsh({ readProfiles: false, timeoutMs: 30, fetchFn: async (url, opts) => {
    signal = opts.signal;
    if (url.endsWith('session/list')) return response({ result: { ok: true, value: { items: [{ sessionId: 'one' }] } } });
    return new Promise(() => {});
  } });
  assert.equal(result.coverage, 'unavailable');
  assert.equal(signal.aborted, true);
});
