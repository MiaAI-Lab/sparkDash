/**
 * Unit tests for TensorFold (ashhart/TensorFold) detection and /health tok/s.
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

function notFound() {
  return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
}

/** Shape captured from a CUDA `tensorfold serve` on a Spark. */
const CUDA_MODELS = {
  object: "list",
  data: [{ id: "Qwen3.8-Flash-Next-MLX-4bit-MTP", object: "model", owned_by: "tensorfold" }],
};

test("_detectServerType: owned_by tensorfold → tensorfold (not vllm)", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8888);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) return jsonRes(CUDA_MODELS);
    return notFound();
  };
  await probe._detectServerType();
  assert.equal(probe.serverIsOpenAI, true);
  assert.equal(probe.backendType, "tensorfold");
});

test("_detectServerType: known tensorfold skips the /slots probe", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8888);
  probe.backendType = "tensorfold";
  const seen = [];
  probe._fetch = async (url) => {
    seen.push(String(url));
    if (String(url).endsWith("/v1/models")) return jsonRes(CUDA_MODELS);
    return notFound();
  };
  await probe._detectServerType();
  assert.equal(seen.some((u) => u.endsWith("/slots")), false);
  assert.equal(probe.backendType, "tensorfold");
});

test("probe: tensorfold CUDA {ok:true} health → labeled, 0 tok/s, no crash", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8888);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) return notFound();
    if (u.endsWith("/v1/models")) return jsonRes(CUDA_MODELS);
    if (u.endsWith("/health")) return jsonRes({ ok: true });
    return notFound();
  };
  const snap = await probe.probe();
  assert.equal(snap.backend, "tensorfold");
  assert.equal(snap.modelId, "Qwen3.8-Flash-Next-MLX-4bit-MTP");
  assert.equal(snap.generationTps, 0);
  assert.equal(snap.prefillTps, 0);
});

test("_applyTensorFoldHealth: counter diffs → tok/s; idle → 0", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._applyTensorFoldHealth(
    { ok: true, busy: true, backend: "tensorfold", prompt_tokens_total: 100, completion_tokens_total: 50 },
    2
  );
  assert.equal(probe.generationTps, 0);
  probe._applyTensorFoldHealth(
    { ok: true, busy: true, backend: "tensorfold", prompt_tokens_total: 100, completion_tokens_total: 150 },
    2
  );
  assert.equal(probe.generationTps, 50);
  probe._applyTensorFoldHealth(
    { ok: true, busy: false, backend: "tensorfold", prompt_tokens_total: 100, completion_tokens_total: 150 },
    2
  );
  assert.equal(probe.generationTps, 0);
  // No cached_tokens_total → the cached counter stays null (pre-0.5.0 build).
  assert.equal(probe.totalCachedTokens, null);
});

test("_applyTensorFoldHealth: 0.5.0 health maps cached_tokens_total", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._applyTensorFoldHealth(
    {
      ok: true, busy: true, backend: "tensorfold",
      prompt_tokens_total: 1000, completion_tokens_total: 200, cached_tokens_total: 640,
      context_length: 262144,
    },
    2
  );
  assert.equal(probe.totalPromptTokens, 1000);
  assert.equal(probe.totalCachedTokens, 640);
  assert.equal(probe.contextLength, 262144);
  // Cumulative counters are sticky across cycles: a health body without the
  // fields (e.g. the MLX shape, or a transient gap) leaves them untouched.
  probe._applyTensorFoldHealth({ ok: true }, 2);
  assert.equal(probe.totalCachedTokens, 640);
  assert.equal(probe.totalPromptTokens, 1000);
});

test("_applyTensorFoldHealth: prefill tok/s uses prefill time, not the poll window", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  const base = {
    ok: true,
    busy: true,
    backend: "tensorfold",
    prompt_tokens_total: 0,
    completion_tokens_total: 0,
    prefill_seconds_total: 0,
    requests_running: 0,
  };
  probe._applyTensorFoldHealth(base, 2);
  probe._applyTensorFoldHealth(
    {
      ...base,
      prompt_tokens_total: 1000,
      completion_tokens_total: 10,
      prefill_seconds_total: 0.25,
      requests_running: 2,
    },
    2
  );
  assert.equal(probe.prefillTps, 4000);
  assert.equal(probe.generationTps, 5);
  assert.equal(probe.requestsRunning, 2);
  assert.equal(probe.slotsActive, 2);
});

test("_applyTensorFoldHealth: MLX health sizes the slot tile; null health is safe", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._applyTensorFoldHealth({ status: "ok", model: "m", max_batch_size: 8, warming: false }, 2);
  assert.equal(probe.slotsTotal, 8);
  assert.doesNotThrow(() => probe._applyTensorFoldHealth(null, 2));
  assert.equal(probe.generationTps, 0);
});

test("_applyTensorFoldHealth: CUDA 0.6.0 streams size the slot tile and count busy slots", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8000);
  // Shape captured from TensorFold 0.6.0 CUDA (GLM-5.3-Flash-EXL3, TP=2), 3 of 4 streams busy.
  probe._applyTensorFoldHealth(
    {
      ok: true,
      backend: "tensorfold",
      busy: true,
      requests_running: 3,
      prompt_tokens_total: 398995528,
      completion_tokens_total: 3872412,
      cached_tokens_total: 384257664,
      streams: { decoding: 3, prefilling: 0, max: 4, filling: 0, paused: 0 },
      context_length: 1048576,
    },
    2
  );
  assert.equal(probe.slotsTotal, 4);
  assert.equal(probe.slotsActive, 3);
  assert.equal(probe.requestsRunning, 3);

  // Without requests_running, fall back to decoding + prefilling.
  probe._applyTensorFoldHealth(
    { ok: true, busy: true, streams: { decoding: 1, prefilling: 1, max: 4 } },
    2
  );
  assert.equal(probe.slotsTotal, 4);
  assert.equal(probe.slotsActive, 2);

  // A null requests_running is missing, not 0 busy.
  probe._applyTensorFoldHealth(
    { ok: true, busy: true, requests_running: null, streams: { decoding: 2, max: 4 } },
    2
  );
  assert.equal(probe.slotsActive, 2);

  // Idle server: 0 of 4, not 0 of 1.
  probe._applyTensorFoldHealth(
    {
      ok: true,
      busy: false,
      requests_running: 0,
      streams: { decoding: 0, prefilling: 0, max: 4 },
    },
    2
  );
  assert.equal(probe.slotsTotal, 4);
  assert.equal(probe.slotsActive, 0);
});

test("probe: newer TensorFold (live rates in /health, totals on /metrics) → real tok/s and totals", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8888);
  const health = {
    status: "ok",
    max_batch_size: 4,
    live: { connections: 1, waiting: 0, decode_tokens_per_second: 33.5, prefill_tokens_per_second: 410.25 },
  };
  const metrics = [
    "# TYPE tensorfold:requests_running gauge",
    "tensorfold:requests_running 1",
    "tensorfold:requests_waiting 0",
    "tensorfold:prompt_tokens_total 2412",
    "tensorfold:generation_tokens_total 7077",
    "tensorfold:mtp_drafted_total 5000",
    "tensorfold:mtp_accepted_total 3500",
  ].join("\n");
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) return notFound();
    if (u.endsWith("/v1/models")) return jsonRes(CUDA_MODELS);
    if (u.endsWith("/health")) return jsonRes(health);
    if (u.endsWith("/metrics")) return { ok: true, status: 200, text: async () => metrics, json: async () => ({}) };
    return notFound();
  };
  const snap = await probe.probe();
  assert.equal(snap.backend, "tensorfold");
  assert.equal(snap.generationTps, 33.5);
  assert.equal(snap.prefillTps, 410.25);
  assert.equal(snap.totalOutputTokens, 7077);
  assert.equal(snap.totalPromptTokens, 2412);
  assert.equal(snap.requestsRunning, 1);
  assert.equal(snap.requestsWaiting, 0);
  assert.equal(snap.mtpAcceptanceRate, 0.7);
});

test("probe: TensorFold with cumulative counters in /health does not touch /metrics", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8888);
  const seen = [];
  probe._fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.endsWith("/slots")) return notFound();
    if (u.endsWith("/v1/models")) return jsonRes(CUDA_MODELS);
    if (u.endsWith("/health")) return jsonRes({ prompt_tokens_total: 10, completion_tokens_total: 20, busy: false });
    return notFound();
  };
  await probe.probe();
  assert.equal(seen.some((u) => u.endsWith("/metrics")), false);
});

test("_applyTensorFoldHealth: CUDA 0.6.0 KV pool tokens give the KV fill", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  // spark-1, TensorFold 0.6.0 CUDA, idle with 32 kept prompts.
  probe._applyTensorFoldHealth(
    {
      ok: true,
      backend: "tensorfold",
      busy: false,
      requests_running: 0,
      streams: { decoding: 0, prefilling: 0, max: 4, filling: 0, paused: 0 },
      pool_tokens: 2387968,
      pool_free_tokens: 2256896,
      kept_prompts: 32,
    },
    2
  );
  assert.equal(probe.kvCacheUsage, 0.0549); // 1 − 2256896 / 2387968
  assert.equal(probe.kvCacheGb, null); // no GB split from TensorFold
  assert.equal(probe.weightsGb, null);

  // No pool fields (MLX / older CUDA): unknown, not 0 %.
  probe._applyTensorFoldHealth({ ok: true, busy: false }, 2);
  assert.equal(probe.kvCacheUsage, null);
  // A null pool_free_tokens is missing, not a full pool.
  probe._applyTensorFoldHealth({ ok: true, pool_tokens: 1000, pool_free_tokens: null }, 2);
  assert.equal(probe.kvCacheUsage, null);
});

test("probe: tensorfold snapshot carries kvCacheUsage and null pool sizes", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8888);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) return jsonRes(CUDA_MODELS);
    if (u.endsWith("/health")) {
      return jsonRes({ ok: true, pool_tokens: 2387968, pool_free_tokens: 2256896 });
    }
    return notFound();
  };
  const snap = await probe.probe();
  assert.equal(snap.backend, "tensorfold");
  assert.equal(snap.kvCacheUsage, 0.0549);
  assert.equal(snap.kvCacheGb, null);
  assert.equal(snap.weightsGb, null);
});
