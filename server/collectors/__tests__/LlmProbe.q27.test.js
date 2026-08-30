/**
 * Unit tests for q27 (signalnine/q27 engine) detection and metrics.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

// Realistic q27 /metrics exposition: q27_* series, api= labels (the probe
// sums across label sets). +Inf == _count by construction.
const Q27_METRICS = `# TYPE q27_requests_total counter
q27_requests_total{api="chat"} 3
q27_requests_total{api="messages"} 1
# TYPE q27_requests_errors_total counter
q27_requests_errors_total{api="chat"} 0
# TYPE q27_prompt_tokens_total counter
q27_prompt_tokens_total{api="chat"} 200
q27_prompt_tokens_total{api="messages"} 50
# TYPE q27_prefill_computed_tokens_total counter
q27_prefill_computed_tokens_total{api="chat"} 150
q27_prefill_computed_tokens_total{api="messages"} 50
# TYPE q27_prefill_cached_tokens_total counter
q27_prefill_cached_tokens_total{api="chat"} 50
# TYPE q27_decode_tokens_total counter
q27_decode_tokens_total{api="chat"} 400
q27_decode_tokens_total{api="messages"} 100
# TYPE q27_requests_inflight gauge
q27_requests_inflight 2
# TYPE q27_slots_total gauge
q27_slots_total 4
# TYPE q27_kv_usage_perc gauge
q27_kv_usage_perc 0.42
# TYPE q27_spec_accept_ratio gauge
q27_spec_accept_ratio 0.87
# TYPE q27_preemptions_total counter
q27_preemptions_total 0
# TYPE q27_ttft_seconds histogram
q27_ttft_seconds_bucket{api="chat",le="0.010"} 0
q27_ttft_seconds_bucket{api="chat",le="0.050"} 0
q27_ttft_seconds_bucket{api="chat",le="0.100"} 0
q27_ttft_seconds_bucket{api="chat",le="0.250"} 0
q27_ttft_seconds_bucket{api="chat",le="0.500"} 2
q27_ttft_seconds_bucket{api="chat",le="1.000"} 2
q27_ttft_seconds_bucket{api="chat",le="2.500"} 2
q27_ttft_seconds_bucket{api="chat",le="5.000"} 2
q27_ttft_seconds_bucket{api="chat",le="+Inf"} 2
q27_ttft_seconds_sum{api="chat"} 0.9
q27_ttft_seconds_count{api="chat"} 2
`;

test("_metricsLookLikeQ27: true for q27 exposition", () => {
  assert.equal(LlmProbe._metricsLookLikeQ27(Q27_METRICS), true);
});

test("_metricsLookLikeQ27: false for vLLM exposition", () => {
  assert.equal(
    LlmProbe._metricsLookLikeQ27("vllm:generation_tokens_total 10.0\n"),
    false
  );
});

test("_detectServerType: owned_by q27 → q27", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (u.endsWith("/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "qwen38-27b-mtp", owned_by: "q27", max_model_len: 262144 }],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await probe._detectServerType();
  assert.equal(probe.serverIsOpenAI, true);
  assert.equal(probe.backendType, "q27");
});

test("_detectServerType: OpenAI models + q27 /metrics → q27", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (u.endsWith("/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "qwen38-27b-mtp" }],
        }),
      };
    }
    if (u.endsWith("/metrics")) {
      return { ok: true, status: 200, text: async () => Q27_METRICS };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await probe._detectServerType();
  assert.equal(probe.backendType, "q27");
});

test("_applyQ27Metrics: gauges + counters + split + histograms", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  // First sample seeds counters (no rate yet — needs a prior baseline)
  probe._applyQ27Metrics(Q27_METRICS, 2);
  assert.equal(probe.totalOutputTokens, 500); // chat 400 + messages 100
  assert.equal(probe.slotsActive, 2);
  assert.equal(probe.slotsTotal, 4);
  assert.equal(probe.kvCacheUsage, 0.42);
  assert.equal(probe.mtpAcceptanceRate, 0.87);
  assert.equal(probe.preemptionsTotal, 0);
  assert.equal(probe.gpuMemoryUtilization, 1); // weights resident → Active
  assert.equal(probe.prefixCacheHitRate, 0.2); // cached 50 / (50 + computed 200)
  // Histograms parsed (all TTFT observations in the le=0.5 bucket → p95 ≈ 0.488)
  assert.ok(
    probe.ttftP95Seconds != null && probe.ttftP95Seconds > 0 && probe.ttftP95Seconds <= 0.5,
    `ttft p95=${probe.ttftP95Seconds}`
  );

  // Second sample with same counters → idle → 0 tok/s
  probe._applyQ27Metrics(Q27_METRICS, 2);
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.prefillTps, 0);

  // Counter advanced → live rate from Δ / Δt (computed-only prefill, ds4-style)
  const active = Q27_METRICS
    .replace("q27_decode_tokens_total{api=\"chat\"} 400", "q27_decode_tokens_total{api=\"chat\"} 550")
    .replace(
      "q27_prefill_computed_tokens_total{api=\"chat\"} 150",
      "q27_prefill_computed_tokens_total{api=\"chat\"} 250"
    )
    .replace(
      "q27_prefill_cached_tokens_total{api=\"chat\"} 50",
      "q27_prefill_cached_tokens_total{api=\"chat\"} 60"
    );
  probe._applyQ27Metrics(active, 2);
  assert.equal(probe.generationTps, 75); // (550-400)/2
  assert.equal(probe.prefillTps, 50); // computed (250-150)/2
  assert.equal(probe.uncachedPrefillTps, 50);
  assert.equal(probe.cachedPrefillTps, 5); // (60-50)/2

  // Cached tokens jumping must not inflate the main prefill tile
  const cachedJump = active.replace(
    "q27_prefill_cached_tokens_total{api=\"chat\"} 60",
    "q27_prefill_cached_tokens_total{api=\"chat\"} 600"
  );
  probe._applyQ27Metrics(cachedJump, 2);
  assert.equal(probe.prefillTps, 0);
  assert.equal(probe.uncachedPrefillTps, 0);
  assert.equal(probe.cachedPrefillTps, 270); // (600-60)/2
});

test("_applyQ27Metrics: +Inf != _count refuses the quantile", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  const broken = Q27_METRICS.replace(
    "q27_ttft_seconds_count{api=\"chat\"} 2",
    "q27_ttft_seconds_count{api=\"chat\"} 1"
  );
  probe._applyQ27Metrics(broken, 2);
  assert.equal(probe.ttftP95Seconds, null);
});

test("probe: q27 path does not mislabel as vllm", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe.serverIsOpenAI = true;
  probe.backendType = "q27";
  probe.authOpen = true;
  probe._lastDetectAt = Date.now();
  probe.lastProbeTime = Date.now() - 2000;
  probe.lastTokenCounts = { input: 200, output: 500 };
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "qwen38-27b-mtp", owned_by: "q27", max_model_len: 262144 }],
        }),
      };
    }
    if (u.endsWith("/metrics")) {
      return { ok: true, status: 200, text: async () => Q27_METRICS };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const snap = await probe.probe();
  assert.equal(snap.backend, "q27");
  assert.equal(snap.available, true);
  assert.equal(snap.generationTps, 0); // no delta vs seeded baseline
  assert.equal(snap.contextLength, 262144); // from /v1/models max_model_len
});
