import { test } from "node:test";
import { strict as assert } from "node:assert";
import http from "node:http";
import { LlmProbe } from "../LlmProbe.js";

const remote = (extra = {}) => ({
  id: "customer",
  isLocal: false,
  lanIp: "127.0.0.1", // nothing listens on the "direct" port below
  ssh: { host: "127.0.0.1", user: "me", auth: "key" },
  ...extra,
});

// A minimal vLLM-ish server standing in for the engine behind SSH.
async function engine(t) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/v1/models")) {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ data: [{ id: "GLM-5.3-Flash-Mia", owned_by: "tensorfold" }] }));
    }
    if (req.url.startsWith("/health")) {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: true, busy: false, completion_tokens_total: 1, prompt_tokens_total: 1 }));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  return server.address().port;
}

test("an engine that only SSH reaches is probed through a tunnel after repeated direct failures", async (t) => {
  const enginePort = await engine(t);
  const directPort = 1; // closed
  const probe = new LlmProbe(remote(), directPort);
  let opened = 0;
  let closed = 0;
  probe._openTunnel = async (_spark, port) => {
    opened += 1;
    assert.equal(port, directPort);
    return { host: "127.0.0.1", port: enginePort, via: "ssh-tunnel", close: () => (closed += 1) };
  };

  let snap = await probe.probe(); // failure 1: no tunnel yet
  assert.equal(snap.available, false);
  assert.equal(opened, 0);
  snap = await probe.probe(); // failure 2: tunnel opens and the same poll retries through it
  assert.equal(opened, 1);
  assert.equal(snap.available, true);
  assert.equal(snap.via, "ssh-tunnel");
  assert.equal(snap.modelId, "GLM-5.3-Flash-Mia");

  probe.dispose();
  assert.equal(closed, 1);
});

test("a pinned llmHost, a local unit and a unit without SSH never tunnel", async () => {
  for (const spark of [remote({ llmHost: "10.9.9.9" }), remote({ isLocal: true }), { id: "x", isLocal: false, lanIp: "127.0.0.1" }]) {
    const probe = new LlmProbe(spark, 1);
    let opened = 0;
    probe._openTunnel = async () => (opened += 1, { port: 1, close() {} });
    for (let i = 0; i < 4; i++) await probe.probe();
    assert.equal(opened, 0, JSON.stringify(spark));
  }
});

test("a tunnel that keeps failing is dropped, retried later with backoff, and the direct path restored", async () => {
  const probe = new LlmProbe(remote(), 1);
  let closed = 0;
  let opened = 0;
  probe._openTunnel = async () => {
    opened += 1;
    return { host: "127.0.0.1", port: 1, via: "ssh-tunnel", close: () => (closed += 1) }; // forward to nothing
  };
  for (let i = 0; i < 12; i++) await probe.probe();
  assert.equal(opened, 1); // not reopened every poll: the retry is backed off
  assert.equal(closed, 1);
  assert.equal(probe.baseUrl, "http://127.0.0.1:1");
  assert.ok(probe._tunnelRetryAt > Date.now());
});

test("failing to open the tunnel backs off instead of retrying every poll", async () => {
  const probe = new LlmProbe(remote(), 1);
  let attempts = 0;
  probe._openTunnel = async () => {
    attempts += 1;
    throw new Error("ssh: connection refused");
  };
  for (let i = 0; i < 10; i++) await probe.probe();
  assert.equal(attempts, 1);
  assert.equal((await probe.probe()).available, false);
});
