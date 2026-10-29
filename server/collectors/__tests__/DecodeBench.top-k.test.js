import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-top-k-"));
process.env.BENCH_HISTORY_PATH = path.join(dir, "history.json");
process.env.BENCH_ACTIVE_PATH = path.join(dir, "active.json");
const { decodeBenchManager } = await import("../DecodeBench.js");

test("only detected TensorFold opts into top_k, consistently across warmup/prefill/decode", { timeout: 15000 }, async (t) => {
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "test response" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 2048, completion_tokens: body.max_tokens, total_tokens: 2048 + body.max_tokens } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (const backend of ["tensorfold", "vllm", null]) {
    requests.length = 0;
    const sparkId = `top-k-${backend}`;
    const started = decodeBenchManager.start({
      sparkId, lanIp: "127.0.0.1", port: server.address().port,
      modelId: "DeepSeek-V4.1-Flash-1017", backend,
      concurrencies: [1], maxTokens: 64, contextTokens: 2048,
      promptType: "prose", temperature: 0.7, thinking: false,
    });
    let job;
    for (let i = 0; i < 300; i += 1) {
      job = decodeBenchManager.getJob(started.benchId);
      if (job.status !== "running") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(job.status, "completed", job.error);
    assert.equal(requests.length, 3, "warmup, context fill, measured decode");
    for (const body of requests) {
      assert.equal(body.temperature, 0.7);
      assert.equal(body.top_k, backend === "tensorfold" ? 20 : undefined);
    }
    assert.equal(job.config.topK, backend === "tensorfold" ? 20 : undefined);
  }
});
