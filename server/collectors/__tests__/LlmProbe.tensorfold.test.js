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

test("_applyTensorFoldHealth: MLX health sizes the slot tile; null health is safe", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._applyTensorFoldHealth({ status: "ok", model: "m", max_batch_size: 8, warming: false }, 2);
  assert.equal(probe.slotsTotal, 8);
  assert.doesNotThrow(() => probe._applyTensorFoldHealth(null, 2));
  assert.equal(probe.generationTps, 0);
});

/** CUDA 0.5.0 /health with concurrency fields, captured from a 4-stream server. */
const CUDA_HEALTH = {
  ok: true, backend: "tensorfold", busy: false, requests_running: 0, requests_total: 308,
  prompt_tokens_total: 6061036, completion_tokens_total: 198107, cached_tokens_total: 5391872,
  streams: { decoding: 0, prefilling: 0, max: 4, filling: 0, paused: 0 },
  context_length: 1048576,
};

test("_applyTensorFoldHealth: CUDA stream pool sizes the slot tile, requests_running fills it", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._applyTensorFoldHealth({ ...CUDA_HEALTH, busy: true, requests_running: 3 }, 2);
  assert.equal(probe.slotsTotal, 4);
  assert.equal(probe.slotsActive, 3);
  assert.equal(probe.requestsRunning, 3);
  probe._applyTensorFoldHealth(CUDA_HEALTH, 2);
  assert.equal(probe.slotsActive, 0);
  assert.equal(probe.requestsRunning, 0);
});

test("_applyTensorFoldHealth: more running requests than streams caps active slots at the pool", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._applyTensorFoldHealth({ ...CUDA_HEALTH, busy: true, requests_running: 6 }, 2);
  assert.equal(probe.slotsActive, 4);
  assert.equal(probe.requestsRunning, 6);
});

test("_applyTensorFoldHealth: health without concurrency fields keeps the busy flag", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._applyTensorFoldHealth({ ok: true, busy: true, prompt_tokens_total: 1, completion_tokens_total: 1 }, 2);
  assert.equal(probe.slotsTotal, 1);
  assert.equal(probe.slotsActive, 1);
  assert.equal(probe.requestsRunning, 1);
});
