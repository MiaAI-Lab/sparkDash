import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-dashboard-decode-"));
for (const key of ["BENCH_HISTORY_PATH", "BENCH_ACTIVE_PATH", "PREFILL_BENCH_HISTORY_PATH", "PREFILL_BENCH_ACTIVE_PATH", "QUALITY_BENCH_HISTORY_PATH", "QUALITY_BENCH_ACTIVE_PATH", "QUALITY_BENCH_REFERENCES_PATH", "SHOWCASE_HISTORY_PATH"]) {
  process.env[key] = path.join(fixtureDir, `${key}.json`);
}
const { DecodeBenchManager } = await import("../DecodeBench.js");
const { ShowcaseManager } = await import("../ShowcaseManager.js");
const { LlmProbe } = await import("../LlmProbe.js");
after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

async function until(predicate) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "timed out waiting for stream state");
    await delay(25);
  }
}

async function engine(t) {
  const streams = new Set();
  const server = http.createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ data: [{ id: "fixture", owned_by: "dsgb10" }] }));
    }
    if (req.url !== "/v1/chat/completions") { res.writeHead(404); return res.end(); }
    let body = "";
    for await (const part of req) body += part;
    const maxTokens = JSON.parse(body).max_tokens;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    let count = 0;
    const token = () => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "word " } }] })}\n\n`);
    const finish = () => {
      clearInterval(timer);
      streams.delete(finish);
      res.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: count } })}\n\ndata: [DONE]\n\n`);
    };
    const timer = setInterval(() => { count++; token(); if (maxTokens === 32) finish(); }, 15);
    streams.add(finish);
    res.on("close", () => { clearInterval(timer); streams.delete(finish); });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const finish of streams) finish(); server.closeAllConnections(); server.close(); });
  return { port: server.address().port, finish: () => { for (const finish of streams) finish(); } };
}

for (const kind of ["benchmark", "showcase"]) {
  test(`${kind} feeds Pico live decode and clears on completion or cancellation`, async (t) => {
    const { port, finish } = await engine(t);
    const manager = kind === "benchmark"
      ? new DecodeBenchManager(path.join(fixtureDir, "decode-history.json"), path.join(fixtureDir, "decode-active.json"))
      : new ShowcaseManager(path.join(fixtureDir, "showcase.json"));
    if (manager._heartbeatTimer) t.after(() => clearInterval(manager._heartbeatTimer));
    for (const ending of ["completed", "cancelled"]) {
      const sparkId = `${kind}-${ending}`;
      const job = manager.start({ sparkId, lanIp: "127.0.0.1", port, modelId: "fixture", concurrencies: [1], maxTokens: 512, prompts: ["Tell a story."] });
      const id = job.benchId || job.sessionId;
      t.after(() => manager.cancel(sparkId, id));
      const probe = new LlmProbe({ lanIp: "127.0.0.1" }, port, {
        streamSampleEnabled: () => false,
        liveDecodeTps: p => manager.getLiveDecodeTps(sparkId, p),
      });
      await until(() => manager.getLiveDecodeTps(sparkId, port) > 0);
      const active = await probe.probe();
      assert.equal(active.backend, "pico");
      assert.ok(active.generationTps > 0);
      assert.equal(active.generationTpsSource, "dashboard-stream");
      assert.equal(active.decodeActive, true);
      assert.equal(manager.getLiveDecodeTps(sparkId, port + 1), null);
      assert.equal(manager.getLiveDecodeTps("other-unit", port), null);
      if (ending === "completed") finish();
      else manager.cancel(sparkId, id);
      await until(() => manager.getLiveDecodeTps(sparkId, port) == null);
      const idle = await probe.probe();
      assert.equal(idle.generationTps, 0);
      assert.equal(idle.decodeActive, false);
      assert.equal(idle.generationTpsSource, "dashboard-stream");
      // Wait for cancelled requests to settle before fixture cleanup.
      await until(() => !manager.activeBySpark.has(sparkId));
    }
  });
}

test("custom remote benchmarks never feed a configured unit's live rate", () => {
  const manager = Object.create(DecodeBenchManager.prototype);
  manager.activeBySpark = new Map([["unit", "job"]]);
  manager.jobs = new Map([["job", { status: "running", config: { port: 8888, host: "remote.example" }, progress: { liveTps: 95 } }]]);
  assert.equal(manager.getLiveDecodeTps("unit", 8888), null);
});
