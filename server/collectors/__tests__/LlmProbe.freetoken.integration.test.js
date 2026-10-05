/** Real HTTP transport against a synthetic FreeToken API, not a GPU/model test. */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { LlmProbe } from "../LlmProbe.js";

test("FreeToken HTTP probe sends its configured key, clears failed telemetry, and recovers", async (t) => {
  let mode = "ok";
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ path: request.url, authorization: request.headers.authorization });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "example-model", owned_by: "FreeToken", context_length: 131072 }] }));
      return;
    }
    if (request.url !== "/v1/stats") {
      response.writeHead(404).end("{}");
      return;
    }
    if (mode === "http") {
      response.writeHead(503).end("{}");
      return;
    }
    if (mode === "auth") {
      response.writeHead(403).end("{}");
      return;
    }
    response.end(JSON.stringify({
      instance_id: mode === "restart" ? "instance-b" : "instance-a",
      model: { ctx: 131072 },
      throughput: { decode_tps: mode === "restart" ? 0 : 42.5, prefill_tps: 0 },
      requests: {
        active: 0,
        completed: mode === "restart" ? 0 : 1,
        prompt_tokens_total: mode === "restart" ? 0 : 100,
        completion_tokens_total: mode === "restart" ? 0 : 50,
        ttft_mean_ms: mode === "restart" ? 0 : 321,
        p95_ms: mode === "restart" ? 0 : 1234,
      },
      kv: null,
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const port = server.address().port;
  const probe = new LlmProbe({ lanIp: "127.0.0.1", llmApiKeys: { [port]: "synthetic-test-key" } }, port);
  const first = await probe.probe();
  assert.equal(first.available, true);
  assert.equal(first.backend, "freetoken");
  assert.equal(first.generationTps, 42.5);
  assert.equal(first.ttftSeconds, 0.321);
  assert.equal(first.ttftP95Seconds, null);
  assert.equal(first.slotsTotal, null);
  assert.equal(first.posture.auth, "keyed");
  assert.ok(seen.every((request) => request.authorization === "Bearer synthetic-test-key"));

  mode = "http";
  const failed = await probe.probe();
  assert.equal(failed.available, false);
  assert.equal(failed.generationTps, 0);
  assert.equal(failed.ttftSeconds, null);

  mode = "auth";
  const protectedSnapshot = await probe.probe();
  assert.equal(protectedSnapshot.available, false);
  assert.equal(protectedSnapshot.posture.auth, "protected");

  mode = "restart";
  const recovered = await probe.probe();
  assert.equal(recovered.available, true);
  assert.equal(recovered.posture.auth, "keyed");
  assert.equal(recovered.totalOutputTokens, 0);
  assert.equal(recovered.generationTps, 0);
  assert.equal(recovered.ttftSeconds, null);
});
