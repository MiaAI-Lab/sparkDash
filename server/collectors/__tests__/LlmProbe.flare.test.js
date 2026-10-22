/**
 * Unit tests for Flare (NVIDIA Flare, `flare run`) detection and metrics.
 * Fixture: a real idle /metrics scrape (flare_* series, all counters 0).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { LlmProbe } from "../LlmProbe.js";
import { readServerGenerationTokens } from "../LlmStreaming.js";

const FLARE_IDLE = readFileSync(
  new URL("./fixtures/flare-metrics.txt", import.meta.url),
  "utf8"
);

/** Replace the value of one exact series line (name + labels) in a scrape. */
function setSeries(body, series, value) {
  const re = new RegExp(`^(${series.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}) \\S+$`, "m");
  assert.ok(re.test(body), `series ${series} not in fixture`);
  return body.replace(re, `$1 ${value}`);
}

const MODELS = {
  data: [{ id: "flare", object: "model", owned_by: "local", root: "org/Some-Model-NVFP4", max_model_len: 262144 }],
};

function flareFetch(metricsBody) {
  return async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) {
      return { ok: true, status: 200, json: async () => MODELS };
    }
    if (u.endsWith("/metrics")) {
      return { ok: true, status: 200, text: async () => metricsBody };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
}

test("_metricsLookLikeFlare: true for flare exposition, false for others", () => {
  assert.equal(LlmProbe._metricsLookLikeFlare(FLARE_IDLE), true);
  assert.equal(LlmProbe._metricsLookLikeFlare("vllm:generation_tokens_total 10.0\n"), false);
  assert.equal(LlmProbe._metricsLookLikeFlare("q27_decode_tokens_total 4\n"), false);
  assert.equal(LlmProbe._metricsLookLikeFlare("ds4_tokens_decoded_total 4\n"), false);
  assert.equal(LlmProbe._metricsLookLikeFlare("sglang:num_running_reqs 1\n"), false);
  // a name that merely contains the prefix must not match
  assert.equal(LlmProbe._metricsLookLikeFlare("myflare_generated_tokens_total 4\n"), false);
});

test("_detectServerType: owned_by local + flare /metrics → flare", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8001);
  probe._fetch = flareFetch(FLARE_IDLE);
  await probe._detectServerType();
  assert.equal(probe.serverIsOpenAI, true);
  assert.equal(probe.backendType, "flare");
});

test("_detectServerType: vLLM metrics still → vllm (flare does not misfire)", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8001);
  probe._fetch = flareFetch("vllm:generation_tokens_total 10.0\n");
  await probe._detectServerType();
  assert.equal(probe.backendType, "vllm");
});

test("_applyFlareMetrics: idle fixture → zero rates, KV empty, no draft data", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8001);
  probe._applyFlareMetrics(FLARE_IDLE, 2);
  probe._applyFlareMetrics(FLARE_IDLE, 2);
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.prefillTps, 0);
  assert.equal(probe.requestsRunning, 0);
  assert.equal(probe.requestsWaiting, 0);
  assert.equal(probe.slotsActive, 0);
  assert.equal(probe.slotsTotal, 10);
  assert.equal(probe.kvCacheUsage, 0);
  assert.equal(probe.kvCacheTokens, 2359296);
  assert.equal(probe.kvCacheTokensAvailable, 2359296);
  assert.equal(probe.mtpAcceptanceRate, null); // nothing offered yet
  assert.equal(probe.gpuMemoryUtilization, 1);
});

test("_applyFlareMetrics: rates come from counter diffs and fall to 0 when idle", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8001);
  let body = setSeries(FLARE_IDLE, "flare_generated_tokens_total", 1000);
  body = setSeries(body, "flare_prefill_tokens_total", 400);
  body = setSeries(body, "flare_cache_reused_tokens_total", 100);
  probe._applyFlareMetrics(body, 2); // seeds the baseline
  assert.equal(probe.totalOutputTokens, 1000);
  assert.equal(probe.totalPromptTokens, 500); // computed 400 + reused 100
  assert.equal(probe.totalCachedTokens, 100);

  // Unchanged counters → idle → 0
  probe._applyFlareMetrics(body, 2);
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.prefillTps, 0);
  assert.equal(probe.cachedPrefillTps, 0);

  // Counters advance → Δ / Δt
  let live = setSeries(body, "flare_generated_tokens_total", 1300);
  live = setSeries(live, "flare_prefill_tokens_total", 600);
  live = setSeries(live, "flare_cache_reused_tokens_total", 110);
  probe._applyFlareMetrics(live, 2);
  assert.equal(probe.generationTps, 150); // (1300-1000)/2
  assert.equal(probe.prefillTps, 100); // computed (600-400)/2
  assert.equal(probe.uncachedPrefillTps, 100);
  assert.equal(probe.cachedPrefillTps, 5); // (110-100)/2
  assert.equal(probe.prefixCacheHitRate, 0.1549); // 110 / (110 + 600)

  // Back to idle → 0 again
  probe._applyFlareMetrics(live, 2);
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.prefillTps, 0);
});

test("_applyFlareMetrics: the one-minute gauge does not drive live tok/s", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8001);
  const body = setSeries(FLARE_IDLE, "flare_generated_tokens_last_minute", 5000);
  probe._applyFlareMetrics(body, 2);
  probe._applyFlareMetrics(body, 2);
  assert.equal(probe.generationTps, 0);
});

test("_applyFlareMetrics: running, waiting and slots", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8001);
  let body = setSeries(FLARE_IDLE, "flare_active_requests", 3);
  body = setSeries(body, "flare_free_request_slots", 7);
  body = setSeries(body, "flare_pending_requests", 2);
  probe._applyFlareMetrics(body, 2);
  assert.equal(probe.requestsRunning, 3);
  assert.equal(probe.slotsActive, 3);
  assert.equal(probe.slotsTotal, 10);
  assert.equal(probe.requestsWaiting, 2);
});

test("_applyFlareMetrics: KV fill excludes free and checkpoint-retained tokens", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8001);
  // total 2,359,296; free 1,769,472 (75%); cached checkpoints 294,912 (12.5%) → 12.5% held by requests
  let body = setSeries(FLARE_IDLE, "flare_free_kv_tokens", 1769472);
  body = setSeries(body, "flare_cached_kv_tokens", 294912);
  probe._applyFlareMetrics(body, 2);
  assert.equal(probe.kvCacheUsage, 0.125);
  assert.equal(probe.kvCacheTokens, 2359296);
  assert.equal(probe.kvCacheTokensAvailable, 2064384); // free + cached
});

test("_applyFlareMetrics: MTP acceptance = accepted / offered draft tokens", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8001);
  let body = setSeries(FLARE_IDLE, 'flare_speculative_offered_drafts_total{batch="1",width="3"}', 400);
  body = setSeries(body, 'flare_speculative_offered_drafts_total{batch="2",width="3"}', 100);
  body = setSeries(body, 'flare_speculative_accepted_drafts_total{batch="1",width="3"}', 300);
  body = setSeries(body, 'flare_speculative_accepted_drafts_total{batch="2",width="3"}', 50);
  // The per-round mean-length counters must not be mistaken for the rate.
  body = setSeries(body, "flare_accepted_draft_tokens_total", 350);
  body = setSeries(body, "flare_draft_request_rounds_total", 100);
  probe._applyFlareMetrics(body, 2);
  assert.equal(probe.mtpAcceptanceRate, 0.7); // 350 / 500
});

test("_probeOpenAICompatible: flare end to end (model name from root, rates)", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8001);
  probe._fetch = flareFetch(FLARE_IDLE);
  await probe._detectServerType();
  const snap = await probe._probeOpenAICompatible();
  assert.equal(snap.backend, "flare");
  // Shows the real checkpoint (`root`), not the served alias "flare".
  assert.equal(snap.modelId, "org/Some-Model-NVFP4");
  assert.equal(snap.modelPath, null);
  assert.deepEqual(probe.models, ["org/Some-Model-NVFP4"]);
  assert.deepEqual(snap.models, ["org/Some-Model-NVFP4"]);
  assert.equal(snap.generationTps, 0);
});

test("readServerGenerationTokens: flare_generated_tokens_total", async () => {
  const body = setSeries(FLARE_IDLE, "flare_generated_tokens_total", 4242);
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) =>
    String(url).endsWith("/metrics")
      ? { ok: true, status: 200, text: async () => body }
      : { ok: false, status: 404, text: async () => "", json: async () => ({}) };
  try {
    assert.equal(await readServerGenerationTokens("http://127.0.0.1:8001"), 4242);
  } finally {
    globalThis.fetch = orig;
  }
});

test("_probeOpenAICompatible: flare without root keeps the served id", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8001);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: "flare", owned_by: "local" }] }) };
    }
    if (u.endsWith("/metrics")) return { ok: true, status: 200, text: async () => FLARE_IDLE };
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  await probe._detectServerType();
  const snap = await probe._probeOpenAICompatible();
  assert.equal(snap.modelId, "flare");
});

test("_probeOpenAICompatible: flare model name follows root on every probe; local path root falls back to id", async () => {
  let root = "org/First-Model";
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8001);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: "flare", owned_by: "local", root }] }) };
    }
    if (u.endsWith("/metrics")) return { ok: true, status: 200, text: async () => FLARE_IDLE };
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  await probe._detectServerType();
  assert.equal((await probe._probeOpenAICompatible()).modelId, "org/First-Model");
  root = "org/Second-Model";
  assert.equal((await probe._probeOpenAICompatible()).modelId, "org/Second-Model");
  root = "/data/models/my-checkpoint";
  assert.equal((await probe._probeOpenAICompatible()).modelId, "flare");
});

test("_probeOpenAICompatible: flare models[] is the root name for an HF id, the alias for a path or missing root", async () => {
  let root = "org/Some-Model";
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8001);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) {
      const rec = { id: "flare", owned_by: "local" };
      if (root != null) rec.root = root;
      return { ok: true, status: 200, json: async () => ({ data: [rec] }) };
    }
    if (u.endsWith("/metrics")) return { ok: true, status: 200, text: async () => FLARE_IDLE };
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  await probe._detectServerType();
  assert.deepEqual((await probe._probeOpenAICompatible()).models, ["org/Some-Model"]);
  root = "/data/models/my-checkpoint";
  assert.deepEqual((await probe._probeOpenAICompatible()).models, ["flare"]);
  root = null;
  assert.deepEqual((await probe._probeOpenAICompatible()).models, ["flare"]);
});

test("_applyFlareMetrics: prefill tok/s latches through decode polls and clears when idle", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8001);
  probe._applyFlareMetrics(FLARE_IDLE, 2); // seed
  let body = setSeries(FLARE_IDLE, "flare_prefill_tokens_total", 1000);
  body = setSeries(body, "flare_active_requests", 1);
  probe._applyFlareMetrics(body, 2);
  assert.equal(probe.prefillTps, 500);
  // decode only: no new prompt tokens, request still active
  body = setSeries(body, "flare_generated_tokens_total", 200);
  probe._applyFlareMetrics(body, 2);
  assert.equal(probe.prefillTps, 500);
  // idle
  body = setSeries(body, "flare_active_requests", 0);
  probe._applyFlareMetrics(body, 2);
  assert.equal(probe.prefillTps, 0);
});
