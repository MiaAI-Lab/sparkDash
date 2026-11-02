/** Native gauges are sampled every two seconds; completion counters are ledgers. */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

function metrics(overrides = {}, omit = []) {
  const values = {
    "vllm:prompt_tokens_total": 1000,
    "vllm:generation_tokens_total": 100,
    "vllm:num_requests_running": 1,
    "vllm:num_requests_waiting": 0,
    "vllm:request_success_total": 2,
    "vllm:prefix_cache_queries_total": 10,
    "vllm:prefix_cache_hits_total": 3,
    "mlx_serve:prefix_cache_tokens_total": 700,
    "mlx_serve:prefill_tokens_total": 300,
    "mlx_serve:prefill_tokens_live": 100,
    "mlx_serve:requests_prefilling": 1,
    "mlx_serve:prefill_tokens_expected": 10000,
    "mlx_serve:request_failed_total": 0,
    "mlx_serve:generation_tokens_live": 100,
    "vllm:request_cancelled_total": 0,
    "mlx_serve:process_start_time_seconds": 100,
    ...overrides,
  };
  return Object.entries(values).filter(([name]) => !omit.includes(name))
    .map(([name, value]) => `${name} ${value}`).join("\n");
}

function directProbe() {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8010);
  probe.backendType = "mlx-serve";
  probe.modelId = "synthetic-model";
  return probe;
}

function sample(probe, overrides = {}, omit = [], dt = 2) {
  probe._applyMlxServeMetrics(metrics(overrides, omit), dt);
  probe._noteFreshTelemetry();
  return probe._getSnapshot();
}

function endpoint(t, { owner = "mlx-serve", backend = null } = {}) {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8010);
  if (backend) {
    probe.backendType = backend;
    probe.serverIsOpenAI = true;
    probe._lastDetectAt = now;
  }
  let body = metrics();
  let metricsStatus = 200;
  let modelsStatus = 200;
  let modelId = "synthetic-model";
  const paths = [];
  probe._fetch = async (url) => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path === "/v1/models") return {
      ok: modelsStatus === 200, status: modelsStatus,
      json: async () => ({ data: [{ id: modelId, owned_by: owner, max_model_len: 8192 }] }),
    };
    if (path === "/metrics") return { ok: metricsStatus === 200, status: metricsStatus, text: async () => body };
    // A model-switch proxy also speaks Ollama. Explicit native ownership wins.
    if (path === "/api/tags") return { ok: true, status: 200, json: async () => ({ models: [] }) };
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  return {
    probe, paths,
    async poll(overrides = {}, options = {}) {
      now += options.elapsed ?? 2000;
      body = options.body ?? metrics(overrides, options.omit);
      metricsStatus = options.metricsStatus ?? 200;
      modelsStatus = options.modelsStatus ?? 200;
      modelId = options.modelId ?? modelId;
      return probe.probe();
    },
  };
}

test("native ownership wins over Ollama and bypasses /slots on redetection", async (t) => {
  const e = endpoint(t);
  let snap = await e.poll();
  assert.equal(snap.backend, "mlx-serve");
  assert.equal(snap.modelId, "synthetic-model");
  e.paths.length = 0;
  snap = await e.poll({}, { elapsed: 61_000 });
  assert.equal(snap.backend, "mlx-serve");
  assert.ok(!e.paths.includes("/slots"));
});

test("native metric signature upgrades a generic vLLM card", async (t) => {
  const e = endpoint(t, { owner: "local", backend: "vllm" });
  const snap = await e.poll();
  assert.equal(snap.backend, "mlx-serve");
  assert.equal(snap.totalCachedTokens, 700);
});

test("live prefill ends before completion: no completion replay", () => {
  const p = directProbe();
  let snap = sample(p);
  assert.equal(snap.prefillTps, null);
  snap = sample(p, { "mlx_serve:prefill_tokens_live": 2100 });
  assert.equal(snap.prefillTps, 1000);
  assert.equal(snap.uncachedPrefillTps, 1000);
  assert.equal(snap.cachedPrefillTps, null);
  snap = sample(p, { "mlx_serve:prefill_tokens_live": 0, "mlx_serve:requests_prefilling": 0, "mlx_serve:generation_tokens_live": 160 });
  assert.equal(snap.prefillTps, null);
  assert.equal(snap.generationTps, 30);
  assert.equal(snap.totalOutputTokens, 100);
  snap = sample(p, { "mlx_serve:prefill_tokens_live": 0, "mlx_serve:requests_prefilling": 0, "mlx_serve:generation_tokens_live": 200 });
  assert.equal(snap.prefillTps, 0);
  snap = sample(p, {
    "mlx_serve:prefill_tokens_live": 0, "mlx_serve:requests_prefilling": 0, "mlx_serve:prefill_tokens_total": 2500,
    "mlx_serve:generation_tokens_live": 220, "vllm:generation_tokens_total": 220,
    "vllm:prompt_tokens_total": 4000, "mlx_serve:prefix_cache_tokens_total": 1500,
    "vllm:request_success_total": 3, "vllm:num_requests_running": 0,
  });
  assert.equal(snap.prefillTps, 0);
  assert.equal(snap.generationTps, 10);
  assert.equal(snap.totalOutputTokens, 220);
  assert.equal(snap.totalCachedTokens, 1500);
  assert.equal(snap.cachedPrefillTps, null);
});

test("cache request hits are distinct from cached tokens and unsupported timing never supplies rates", () => {
  const p = directProbe();
  const extra = {
    "vllm:time_to_first_token_seconds_sum": 2,
    "vllm:time_to_first_token_seconds_count": 2,
    "vllm:request_prefill_time_seconds_count": 2,
    "vllm:request_prefill_time_seconds_sum": 1,
    "vllm:request_prefill_kv_computed_tokens_sum": 300,
  };
  sample(p, extra);
  const snap = sample(p, { ...extra, "vllm:prompt_tokens_total": 100_000,
    "vllm:generation_tokens_total": 500, "vllm:prefix_cache_hits_total": 4 },
  ["mlx_serve:prefix_cache_tokens_total", "mlx_serve:generation_tokens_live", "mlx_serve:prefill_tokens_live"]);
  assert.equal(snap.totalCachedTokens, null);
  assert.equal(snap.prefixCacheHitRate, 0.4);
  assert.equal(snap.generationTps, null);
  assert.equal(snap.prefillTps, null);
  assert.equal(snap.cachedPrefillTps, null);
});

test("aggregate decode remains valid with concurrent requests; prefill attribution is unknown", () => {
  const p = directProbe();
  sample(p, { "vllm:num_requests_running": 2 });
  const snap = sample(p, { "vllm:num_requests_running": 2,
    "mlx_serve:generation_tokens_live": 200, "mlx_serve:prefill_tokens_live": 4000 });
  assert.equal(snap.generationTps, 50);
  assert.equal(snap.prefillTps, null);
});

for (const [name, change] of Object.entries({
  completion: { "vllm:request_success_total": 3 },
  cancellation: { "vllm:request_cancelled_total": 1 },
  "prefill credit": { "mlx_serve:prefill_tokens_total": 2300 },
  "running handoff": { "vllm:num_requests_running": 2 },
})) {
  test(`prefill ${name} does not attribute an aggregate handoff to the same request`, () => {
    const p = directProbe();
    sample(p);
    const snap = sample(p, { ...change, "mlx_serve:prefill_tokens_live": 5000 });
    assert.equal(snap.prefillTps, null);
  });
}

for (const [name, change] of Object.entries({
  restart: { "mlx_serve:process_start_time_seconds": 200 },
  "prompt reset": { "vllm:prompt_tokens_total": 0 },
  "completed output reset": { "vllm:generation_tokens_total": 0 },
  "cache reset": { "mlx_serve:prefix_cache_tokens_total": 0 },
  "completed prefill reset": { "mlx_serve:prefill_tokens_total": 0 },
  "live decode reset": { "mlx_serve:generation_tokens_live": 0 },
})) {
  test(`${name} seeds both rates without a burst`, () => {
    const p = directProbe();
    sample(p);
    const snap = sample(p, { "mlx_serve:prefill_tokens_live": 5000,
      "mlx_serve:generation_tokens_live": 200, ...change });
    assert.equal(snap.generationTps, null);
    assert.equal(snap.prefillTps, null);
  });
}

test("missing live series, missing restart guard and long gaps break continuity", () => {
  const p = directProbe();
  sample(p);
  for (const omit of [["mlx_serve:generation_tokens_live", "mlx_serve:prefill_tokens_live"],
    ["mlx_serve:process_start_time_seconds"]]) {
    sample(p, {}, omit);
    const snap = sample(p, { "mlx_serve:prefill_tokens_live": 5000, "mlx_serve:generation_tokens_live": 500 });
    assert.equal(snap.generationTps, null);
    assert.equal(snap.prefillTps, null);
  }
  const snap = sample(p, { "mlx_serve:prefill_tokens_live": 6000, "mlx_serve:generation_tokens_live": 600 }, [], 31);
  assert.equal(snap.generationTps, null);
  assert.equal(snap.prefillTps, null);
});

test("explicit idle zeros available rates while missing fields remain unavailable", () => {
  const p = directProbe();
  sample(p, { "vllm:num_requests_running": 0, "mlx_serve:prefill_tokens_live": 0, "mlx_serve:requests_prefilling": 0 });
  let snap = sample(p, { "vllm:num_requests_running": 0, "mlx_serve:prefill_tokens_live": 0, "mlx_serve:requests_prefilling": 0 });
  assert.equal(snap.status, "idle");
  assert.equal(snap.generationTps, 0);
  assert.equal(snap.prefillTps, 0);
  snap = sample(p, { "vllm:num_requests_running": 0 }, ["mlx_serve:prefill_tokens_live", "mlx_serve:generation_tokens_live"]);
  assert.equal(snap.generationTps, null);
  assert.equal(snap.prefillTps, null);
  assert.equal(snap.cachedPrefillTps, null);
});

test("native identity survives failed telemetry and recovery seeds before measuring", async (t) => {
  const e = endpoint(t);
  await e.poll();
  let snap = await e.poll({ "mlx_serve:generation_tokens_live": 160 });
  assert.equal(snap.generationTps, 30);
  snap = await e.poll({}, { metricsStatus: 503 });
  assert.equal(snap.backend, "mlx-serve");
  assert.equal(snap.available, false);
  assert.equal(snap.generationTps, null);
  snap = await e.poll({ "mlx_serve:generation_tokens_live": 1000 });
  assert.equal(snap.generationTps, null);
  snap = await e.poll({ "mlx_serve:generation_tokens_live": 1100 });
  assert.equal(snap.generationTps, 50);
  for (let i = 0; i < 3; i++) snap = await e.poll({}, { modelsStatus: 503 });
  assert.equal(snap.backend, "mlx-serve");
  assert.equal(snap.available, false);
  snap = await e.poll({ "mlx_serve:generation_tokens_live": 2000 });
  assert.equal(snap.backend, "mlx-serve");
  assert.equal(snap.generationTps, null);
});

test("model replacement seeds native accounting", async (t) => {
  const e = endpoint(t);
  await e.poll();
  const snap = await e.poll({ "mlx_serve:generation_tokens_live": 2000,
    "mlx_serve:prefill_tokens_live": 5000 }, { modelId: "replacement-model" });
  assert.equal(snap.generationTps, null);
  assert.equal(snap.prefillTps, null);
});

test("ordinary vLLM keeps its own token-granular cache behavior", () => {
  const p = new LlmProbe({ lanIp: "10.0.0.1" }, 8010);
  p.backendType = "vllm";
  const body = metrics({}, Object.keys({
    "mlx_serve:prefix_cache_tokens_total": 1, "mlx_serve:prefill_tokens_total": 1,
    "mlx_serve:prefill_tokens_live": 1, "mlx_serve:generation_tokens_live": 1,
  }));
  p._applyVllmMetrics(body, 2);
  assert.equal(p.totalCachedTokens, 3);
  p._applyVllmMetrics(body.replace("generation_tokens_total 100", "generation_tokens_total 160"), 2);
  assert.equal(p.generationTps, 30);
});

test("metric-only identity survives generic-card redetection", async (t) => {
  const e = endpoint(t, { owner: "local", backend: "vllm" });
  await e.poll();
  e.paths.length = 0;
  const snap = await e.poll({}, { elapsed: 61_000 });
  assert.equal(snap.backend, "mlx-serve");
  assert.ok(!e.paths.includes("/slots"));
  assert.ok(!e.paths.includes("/api/tags"));
});

test("a partial native signature cannot fall through to completed vLLM rates", async (t) => {
  const e = endpoint(t, { owner: "local", backend: "vllm" });
  const omit = ["mlx_serve:prefill_tokens_live"];
  await e.poll({}, { omit });
  const snap = await e.poll({ "vllm:prompt_tokens_total": 100000,
    "vllm:generation_tokens_total": 2000, "mlx_serve:generation_tokens_live": 100 }, { omit });
  assert.equal(snap.backend, "mlx-serve");
  assert.equal(snap.generationTps, 0);
  assert.equal(snap.prefillTps, null);
});

test("authentication denial breaks native rate continuity", async (t) => {
  const e = endpoint(t);
  await e.poll();
  let snap = await e.poll({}, { modelsStatus: 401 });
  assert.equal(snap.available, false);
  assert.equal(snap.statusReason, "model_catalog_auth_required");
  assert.equal(snap.totalCachedTokens, null);
  snap = await e.poll({ "mlx_serve:generation_tokens_live": 1000 });
  assert.equal(snap.generationTps, null);
});

test("native histogram latency remains available without inventing memory or speculation", () => {
  const p = directProbe();
  p.kvCacheUsage = 0.9;
  p.kvCacheTokens = 1000;
  p.preemptionsTotal = 2;
  p.mtpAcceptanceRate = 0.9;
  const hist = {};
  for (const name of ["time_to_first_token_seconds", "e2e_request_latency_seconds", "inter_token_latency_seconds"]) {
    hist[`vllm:${name}_bucket{le="1"}`] = 1;
    hist[`vllm:${name}_bucket{le="+Inf"}`] = 1;
    hist[`vllm:${name}_count`] = 1;
    hist[`vllm:${name}_sum`] = 0.5;
  }
  sample(p, hist);
  const snap = sample(p, { ...hist,
    "vllm:time_to_first_token_seconds_count": 2,
    "vllm:time_to_first_token_seconds_sum": 1.2,
    'vllm:time_to_first_token_seconds_bucket{le="1"}': 2,
    'vllm:time_to_first_token_seconds_bucket{le="+Inf"}': 2,
  });
  assert.equal(snap.ttftSeconds, 0.7);
  assert.equal(snap.ttftP95Seconds, 0.95);
  assert.equal(snap.e2eP95Seconds, 0.95);
  assert.equal(snap.itlP95Seconds, 0.95);
  assert.equal(snap.kvCacheUsage, null);
  assert.equal(snap.kvCacheTokens, null);
  assert.equal(snap.preemptionsTotal, null);
  assert.equal(snap.mtpAcceptanceRate, null);
});

test("prefill target changes and missing phase metadata refuse continuity", () => {
  for (const [change, omit] of [
    [{ "mlx_serve:prefill_tokens_expected": 20000 }, []],
    [{}, ["mlx_serve:requests_prefilling"]],
    [{}, ["mlx_serve:prefill_tokens_expected"]],
  ]) {
    const p = directProbe();
    sample(p);
    const snap = sample(p, { ...change, "mlx_serve:prefill_tokens_live": 2000 }, omit);
    assert.equal(snap.prefillTps, null);
  }
});

test("cancellation or failure can mask aggregate decode even when its gauge increases", () => {
  for (const counter of ["vllm:request_cancelled_total", "mlx_serve:request_failed_total"]) {
    const p = directProbe();
    sample(p);
    const snap = sample(p, { [counter]: 1, "mlx_serve:generation_tokens_live": 200 });
    assert.equal(snap.generationTps, null);
  }
});

test("active turnover wholly between prefill samples stays unavailable", () => {
  const p = directProbe();
  const decoding = { "mlx_serve:requests_prefilling": 0, "mlx_serve:prefill_tokens_live": 0 };
  sample(p, decoding);
  const snap = sample(p, { ...decoding, "vllm:request_success_total": 3,
    "mlx_serve:prefill_tokens_total": 3000 });
  assert.equal(snap.status, "active");
  assert.equal(snap.prefillTps, null);
});

test("an empty native observation clears rates and cannot prove idleness", async (t) => {
  const e = endpoint(t);
  await e.poll();
  const snap = await e.poll({}, { body: "" });
  assert.equal(snap.status, "unknown");
  assert.equal(snap.generationTps, null);
  assert.equal(snap.prefillTps, null);
  assert.equal(snap.requestsRunning, null);
  assert.equal(snap.totalCachedTokens, null);
});

test("first-contact generic proxy card cannot hide native metrics behind Ollama tags", async (t) => {
  const e = endpoint(t, { owner: "local" });
  const snap = await e.poll();
  assert.equal(snap.backend, "mlx-serve");
});

test("positive engine reclassification clears native identity across detection resets", async (t) => {
  const e = endpoint(t);
  await e.poll();
  e.probe._probeIsOllama = async () => false;
  assert.equal(await e.probe._classifyOpenAIBackend("tensorfold"), "tensorfold");
  e.probe._resetDetection();
  assert.notEqual(e.probe.backendType, "mlx-serve");
});

test("a changed target must not inherit the previous endpoint's native identity", async (t) => {
  const e = endpoint(t);
  await e.poll();
  e.probe.setPort(9999);
  assert.notEqual(e.probe.backendType, "mlx-serve");
});

for (const missing of ["vllm:request_cancelled_total", "mlx_serve:request_failed_total"]) {
  for (const gen of [100, 300]) {
    test(`missing ${missing} cannot establish lossless decode at live ${gen}`, () => {
      const p = directProbe();
      sample(p, {}, [missing]);
      const snap = sample(p, { "mlx_serve:generation_tokens_live": gen }, [missing]);
      assert.equal(snap.generationTps, null);
    });
  }
}
