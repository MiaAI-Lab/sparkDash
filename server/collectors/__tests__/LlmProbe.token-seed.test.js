/**
 * Regression: a failed `/metrics` read must not turn lifetime token counters into one
 * interval's tok/s on the next poll (#326). The probe clock advances on every poll, so
 * the poll after a failed read has a usable interval but no seeded baseline.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

const VLLM_METRICS = [
  'vllm:num_requests_running{model_name="m"} 0.0',
  'vllm:num_requests_waiting{model_name="m"} 0.0',
  'vllm:prompt_tokens_total{model_name="m"} 26731792.0',
  'vllm:generation_tokens_total{model_name="m"} 1244726.0',
].join("\n");

const MODELS = {
  object: "list",
  data: [{ id: "m", object: "model", owned_by: "vllm", max_model_len: 32768 }],
};

test("vLLM: the poll after a failed /metrics read reports 0, not the lifetime total", async (t) => {
  let now = 10_000;
  t.mock.method(Date, "now", () => now);

  let poll = 0;
  let metrics = VLLM_METRICS;
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8000);
  probe._fetch = async (url) => {
    const path = new URL(url).pathname;
    // Every /metrics read of the first poll times out, as on a slow link.
    if (path === "/metrics" && poll === 0) {
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    }
    if (path === "/metrics") return new Response(metrics, { status: 200 });
    if (path === "/v1/models") return Response.json(MODELS);
    if (path === "/version") return Response.json({ version: "0.11.0" });
    return new Response("not found", { status: 404 });
  };

  const first = await probe.probe();
  assert.equal(first.generationTps, 0);
  assert.equal(first.prefillTps, 0);

  poll += 1;
  now += 2000;
  const second = await probe.probe();
  assert.equal(second.backend, "vllm");
  assert.equal(second.generationTps, 0, "lifetime counters are not a rate");
  assert.equal(second.prefillTps, 0, "lifetime counters are not a rate");

  // Once the baseline exists, a real movement is measured over the interval.
  metrics = VLLM_METRICS.replace(
    'vllm:generation_tokens_total{model_name="m"} 1244726.0',
    'vllm:generation_tokens_total{model_name="m"} 1244826.0'
  ).replace(
    'vllm:prompt_tokens_total{model_name="m"} 26731792.0',
    'vllm:prompt_tokens_total{model_name="m"} 26731892.0'
  );
  poll += 1;
  now += 2000;
  const third = await probe.probe();
  assert.equal(third.generationTps, 50);
  assert.equal(third.prefillTps, 50);
});

test("ds4: the first sample seeds the counters instead of reporting a rate", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8888);
  probe._applyDs4Metrics(
    'ds4_tokens_decoded_total 1244726\nds4_tokens_prefilled_total{kind="computed"} 26731792\n',
    2
  );
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.prefillTps, 0);

  probe._applyDs4Metrics(
    'ds4_tokens_decoded_total 1244826\nds4_tokens_prefilled_total{kind="computed"} 26731892\n',
    2
  );
  assert.equal(probe.generationTps, 50);
  assert.equal(probe.prefillTps, 50);
});

test("q27: the first sample seeds the counters instead of reporting a rate", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8888);
  probe._applyQ27Metrics("q27_decode_tokens_processed_total 1244726\n", 2);
  assert.equal(probe.generationTps, 0);

  probe._applyQ27Metrics("q27_decode_tokens_processed_total 1244826\n", 2);
  assert.equal(probe.generationTps, 50);
});

test("flare: the first sample seeds the counters instead of reporting a rate", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8888);
  probe._applyFlareMetrics("flare_generated_tokens_total 1244726\n", 2);
  assert.equal(probe.generationTps, 0);

  probe._applyFlareMetrics("flare_generated_tokens_total 1244826\n", 2);
  assert.equal(probe.generationTps, 50);
});

test("exl3: the first /health sample seeds the counters instead of reporting a rate", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8888);
  probe._applyExl3Health(
    { prompt_tokens_total: 26731792, completion_tokens_total: 1244726, busy: false },
    2
  );
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.prefillTps, 0);

  probe._applyExl3Health(
    { prompt_tokens_total: 26731892, completion_tokens_total: 1244826, busy: false },
    2
  );
  assert.equal(probe.generationTps, 50);
  assert.equal(probe.prefillTps, 50);
});

test("sglang server_info: the first sample seeds the counters instead of reporting a rate", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8888);
  probe._applySglangServerInfo({ total_input_tokens: 26731792, total_output_tokens: 1244726 }, 2);
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.prefillTps, 0);

  probe._applySglangServerInfo({ total_input_tokens: 26731892, total_output_tokens: 1244826 }, 2);
  assert.equal(probe.generationTps, 50);
  assert.equal(probe.prefillTps, 50);
});

test("a reset makes the next sample seed again", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8888);
  probe._applyDs4Metrics("ds4_tokens_decoded_total 1000\n", 2);
  probe._applyDs4Metrics("ds4_tokens_decoded_total 1100\n", 2);
  assert.equal(probe.generationTps, 50);

  probe._resetDetection();
  probe._applyDs4Metrics("ds4_tokens_decoded_total 999999\n", 2);
  assert.equal(probe.generationTps, 0, "a restart's lifetime total is not a rate");
});
