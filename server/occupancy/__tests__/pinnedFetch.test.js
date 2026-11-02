// fetchPinned is shared: occupancy helpers use its defaults, power meters name themselves
// and read non-2xx answers. The defaults must not change.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchPinned } from "../pinnedFetch.js";

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://pinned.test:${server.address().port}`;
}

test("by default a non-2xx answer is an error worded for the occupancy helper", async (t) => {
  const base = await serve(t, (_req, res) => res.writeHead(404).end("{}"));
  await assert.rejects(fetchPinned(`${base}/x`, { addresses: ["127.0.0.1"] }), { status: 502, message: "Helper answered HTTP 404" });
});

test("a caller can name itself and read non-2xx answers", async (t) => {
  const base = await serve(t, (req, res) => {
    if (req.url === "/slow") return; // never answers
    res.writeHead(401, { "content-type": "application/json" }).end('{"message":"no"}');
  });
  const opts = { addresses: ["127.0.0.1"], label: "Home Assistant", allowErrorStatus: true };
  assert.deepEqual(await fetchPinned(`${base}/x`, opts), { status: 401, body: '{"message":"no"}' });
  await assert.rejects(fetchPinned(`${base}/slow`, { ...opts, timeoutMs: 100 }), { status: 504, message: "Home Assistant request timed out" });
});

test("a connection failure keeps its cause", async () => {
  // Nothing listens on port 9 here.
  const err = await fetchPinned("http://pinned.test:9/x", { addresses: ["127.0.0.1"], label: "Home Assistant" }).catch((e) => e);
  assert.equal(err.message, "Home Assistant request failed");
  assert.equal(err.cause?.code, "ECONNREFUSED");
});
