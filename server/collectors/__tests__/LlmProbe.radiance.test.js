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

/** Radiance 1.6.0 live gauges and engine-step counters. */
function liveMetrics({ prompt, gen, decodeRate, prefillRate, prefillSteps, decodeSteps, running }) {
  return metrics({ prompt, gen, ttftSum: 1, ttftCount: 1, running }) + [
    `radiance:decode_tokens_per_second${L} ${decodeRate}`,
    `radiance:prefill_tokens_per_second${L} ${prefillRate}`,
    `radiance:engine_steps_prefill_total${L} ${prefillSteps}`,
    `radiance:engine_steps_mixed_total${L} 16`,
    `radiance:engine_steps_decode_total${L} ${decodeSteps}`,
    "",
  ].join("\n");
}

function radianceProbe(bodyRef) {
  const probe = new LlmProbe({ lanIp: "10.0.0.2" }, 18983);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) return jsonRes(MODELS);
    if (u.endsWith("/metrics")) return textRes(bodyRef.body);
    if (u.endsWith("/health")) return jsonRes({ status: "ok", model: "Swift1.5-Qwen3.8-Flash-Next" });
    return notFound();
  };
  return probe;
}

async function pollAfter(probe, ms) {
  probe.lastProbeTime = Date.now() - ms;
  await probe.probe();
}

test("probe: radiance live gauges give decode tok/s mid-request, while the token counters are frozen", async () => {
  const ref = { body: liveMetrics({ prompt: 980210, gen: 6997, decodeRate: 0, prefillRate: 0, prefillSteps: 215, decodeSteps: 2880, running: 0 }) };
  const probe = radianceProbe(ref);
  await probe.probe();
  ref.body = liveMetrics({ prompt: 980210, gen: 6997, decodeRate: 142.06, prefillRate: 0.8, prefillSteps: 215, decodeSteps: 3015, running: 1 });
  await pollAfter(probe, 2000);
  assert.equal(probe.backendType, "radiance");
  assert.equal(probe.generationTps, 142.06);
  assert.equal(probe.prefillTps, 0, "decaying prefill gauge is ignored when no prefill step ran");
  assert.equal(probe.prefillActive, false);
});

test("probe: radiance prefill gauge is live while prefill steps advance; completion spike is suppressed", async () => {
  const ref = { body: liveMetrics({ prompt: 1000, gen: 100, decodeRate: 0, prefillRate: 0, prefillSteps: 218, decodeSteps: 3165, running: 1 }) };
  const probe = radianceProbe(ref);
  await probe.probe();
  ref.body = liveMetrics({ prompt: 1000, gen: 100, decodeRate: 0, prefillRate: 12769.34, prefillSteps: 222, decodeSteps: 3165, running: 1 });
  await pollAfter(probe, 1000);
  assert.equal(probe.prefillTps, 12769.34);
  assert.equal(probe.prefillActive, true);
  assert.equal(probe.generationTps, 0);
  // Request finishes: counters jump by 700 generated tokens in one poll, engine is idle.
  ref.body = liveMetrics({ prompt: 21632, gen: 800, decodeRate: 3.1, prefillRate: 900, prefillSteps: 222, decodeSteps: 3165, running: 0 });
  await pollAfter(probe, 1000);
  assert.equal(probe.generationTps, 0, "no 700 tok/s spike from the completion counter jump");
  assert.equal(probe.prefillTps, 0);
  assert.equal(probe.totalOutputTokens, 800, "lifetime counters still advance");
});
