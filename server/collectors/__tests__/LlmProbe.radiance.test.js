/**
 * Unit tests for Radiance detection and its vLLM-format /metrics.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textRes(body) {
  return { ok: true, status: 200, json: async () => ({}), text: async () => body };
}

function notFound() {
  return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
}

/** Shapes captured from Radiance 1.6.0 serving a Qwen3.8 Flash Next container. */
const MODELS = {
  object: "list",
  data: [{ id: "Swift1.5-Qwen3.8-Flash-Next", object: "model", owned_by: "radiance", max_model_len: 200000 }],
};

const L = '{model_name="Swift1.5-Qwen3.8-Flash-Next",engine="0"}';
function metrics({ prompt, gen, ttftSum, ttftCount, running = 0, kv = 0 }) {
  return [
    `vllm:num_requests_running${L} ${running}`,
    `vllm:kv_cache_usage_perc${L} ${kv}`,
    `radiance:kv_cache_max_tokens${L} 1087768`,
    `radiance:kv_cache_max_bytes${L} 9071210144`,
    `vllm:prompt_tokens_total${L} ${prompt}`,
    `vllm:generation_tokens_total${L} ${gen}`,
    `vllm:time_to_first_token_seconds_bucket{model_name="Swift1.5-Qwen3.8-Flash-Next",engine="0",le="+Inf"} ${ttftCount}`,
    `vllm:time_to_first_token_seconds_sum${L} ${ttftSum}`,
    `vllm:time_to_first_token_seconds_count${L} ${ttftCount}`,
    "",
  ].join("\n");
}

test("_detectServerType: owned_by radiance → radiance (not vllm)", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.2" }, 18983);
  probe._fetch = async (url) => (String(url).endsWith("/v1/models") ? jsonRes(MODELS) : notFound());
  await probe._detectServerType();
  assert.equal(probe.serverIsOpenAI, true);
  assert.equal(probe.backendType, "radiance");
});

test("_detectServerType: known radiance skips the /slots probe", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.2" }, 18983);
  probe.backendType = "radiance";
  const seen = [];
  probe._fetch = async (url) => {
    seen.push(String(url));
    return String(url).endsWith("/v1/models") ? jsonRes(MODELS) : notFound();
  };
  await probe._detectServerType();
  assert.equal(seen.some((u) => u.endsWith("/slots")), false);
  assert.equal(probe.backendType, "radiance");
});

test("probe: radiance /metrics → decode and prefill tok/s, KV pool, label kept", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.2" }, 18983);
  let body = metrics({ prompt: 1000, gen: 100, ttftSum: 1, ttftCount: 1 });
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) return jsonRes(MODELS);
    if (u.endsWith("/metrics")) return textRes(body);
    if (u.endsWith("/health")) return jsonRes({ status: "ok", model: "Swift1.5-Qwen3.8-Flash-Next", in_flight: 0 });
    return notFound();
  };
  await probe.probe();
  // Next poll 2 s later: 300 decode tokens, one request whose 4000-token prompt took 0.5 s to first token.
  body = metrics({ prompt: 5000, gen: 400, ttftSum: 1.5, ttftCount: 2, running: 1, kv: 0.25 });
  probe.lastProbeTime = Date.now() - 2000;
  const snap = await probe.probe();
  assert.equal(snap.backend, "radiance");
  assert.equal(snap.modelId, "Swift1.5-Qwen3.8-Flash-Next");
  assert.equal(snap.contextLength, 200000);
  assert.ok(Math.abs(snap.generationTps - 150) < 5, `decode ${snap.generationTps}`);
  assert.ok(Math.abs(snap.prefillTps - 8000) < 1, `prefill ${snap.prefillTps}`);
  assert.equal(snap.ttftSeconds, 0.5);
  assert.equal(snap.requestsRunning, 1);
  assert.equal(snap.kvCacheTokens, 1087768);
  assert.equal(snap.kvCacheTokensAvailable, Math.round(1087768 * 0.75));
});

test("probe: radiance /metrics 401 without a key keeps the radiance label", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.2" }, 18983);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) return jsonRes(MODELS);
    if (u.endsWith("/metrics")) return { ok: false, status: 401, json: async () => ({}), text: async () => "" };
    return notFound();
  };
  const snap = await probe.probe();
  assert.equal(snap.backend, "radiance");
});
