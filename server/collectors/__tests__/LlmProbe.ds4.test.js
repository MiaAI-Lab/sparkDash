/**
 * Unit tests for ds4-server (Entrpi/ds4-on-spark) detection and metrics.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

const DS4_METRICS = `# TYPE ds4_tokens_prefilled_total counter
ds4_tokens_prefilled_total{kind="computed"} 100.0
ds4_tokens_prefilled_total{kind="cached"} 300.0
# TYPE ds4_tokens_decoded_total counter
ds4_tokens_decoded_total 50.0
# TYPE ds4_decode_tok_s gauge
ds4_decode_tok_s 13.17
# TYPE ds4_prefill_tok_s gauge
ds4_prefill_tok_s 197.78
# TYPE ds4_requests_inflight gauge
ds4_requests_inflight 2
# TYPE ds4_banks_total gauge
ds4_banks_total 12
# TYPE ds4_spec_accept_ratio gauge
ds4_spec_accept_ratio 0.7736
`;

test("_metricsLookLikeDs4: true for ds4 exposition", () => {
  assert.equal(LlmProbe._metricsLookLikeDs4(DS4_METRICS), true);
});

test("_metricsLookLikeDs4: false for vLLM exposition", () => {
  assert.equal(
    LlmProbe._metricsLookLikeDs4("vllm:generation_tokens_total 10.0\n"),
    false
  );
});

test("_detectServerType: owned_by ds4.c → ds4", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8888);
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
          data: [
            {
              id: "deepseek-v4-flash",
              owned_by: "ds4.c",
              context_length: 1000000,
            },
          ],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await probe._detectServerType();
  assert.equal(probe.serverIsOpenAI, true);
  assert.equal(probe.backendType, "ds4");
});

test("_detectServerType: OpenAI models + ds4 /metrics → ds4", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8888);
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
          data: [{ id: "deepseek-v4-flash" }],
        }),
      };
    }
    if (u.endsWith("/metrics")) {
      return {
        ok: true,
        status: 200,
        text: async () => DS4_METRICS,
        json: async () => ({}),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await probe._detectServerType();
  assert.equal(probe.backendType, "ds4");
});

test("_applyDs4Metrics: gauges + counters + prefix hit rate", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  // First sample seeds counters (no rate yet — needs a prior baseline)
  probe._applyDs4Metrics(DS4_METRICS, 2);
  assert.equal(probe.totalOutputTokens, 50);
  assert.equal(probe.slotsActive, 2);
  assert.equal(probe.slotsTotal, 12);
  assert.equal(probe.mtpAcceptanceRate, 0.7736);
  assert.equal(probe.prefixCacheHitRate, 0.75);
  assert.equal(probe.kvCacheUsage, null);

  // Second sample with same counters → idle → 0 tok/s (not the 60s window gauge)
  probe._applyDs4Metrics(DS4_METRICS, 2);
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.prefillTps, 0);

  // Counter advanced → live rate from Δ / Δt
  const active = DS4_METRICS
    .replace("ds4_tokens_decoded_total 50.0", "ds4_tokens_decoded_total 90.0")
    .replace(
      'ds4_tokens_prefilled_total{kind="computed"} 100.0',
      'ds4_tokens_prefilled_total{kind="computed"} 180.0'
    );
  probe._applyDs4Metrics(active, 2);
  assert.equal(probe.generationTps, 20); // (90-50)/2
  assert.equal(probe.prefillTps, 40); // computed only (180-100)/2
  assert.equal(probe.uncachedPrefillTps, 40);
  assert.equal(probe.cachedPrefillTps, 0);

  // Cached tokens jumping must not inflate prefill
  const cachedJump = active.replace(
    'ds4_tokens_prefilled_total{kind="cached"} 300.0',
    'ds4_tokens_prefilled_total{kind="cached"} 3000.0'
  );
  probe._applyDs4Metrics(cachedJump, 2);
  assert.equal(probe.prefillTps, 0);
  assert.equal(probe.uncachedPrefillTps, 0);
  assert.equal(probe.cachedPrefillTps, 1350); // (3000-300)/2
});

test("probe: ds4 path reads context_length and does not mislabel as vllm", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe.serverIsOpenAI = true;
  probe.backendType = "ds4";
  probe.authOpen = true;
  probe._lastDetectAt = Date.now();
  probe.lastProbeTime = Date.now() - 2000;
  probe.lastTokenCounts = { input: 100, output: 50 };
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: "deepseek-v4-flash",
              owned_by: "ds4.c",
              context_length: 1000000,
            },
          ],
        }),
      };
    }
    if (u.endsWith("/metrics")) {
      return {
        ok: true,
        status: 200,
        text: async () => DS4_METRICS,
        json: async () => ({}),
      };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };

  const snap = await probe.probe();
  assert.equal(snap.backend, "ds4");
  assert.equal(snap.modelId, "deepseek-v4-flash");
  assert.equal(snap.contextLength, 1000000);
  // Idle relative to seeded counters (same totals) → 0, not window gauge
  assert.equal(snap.generationTps, 0);
  assert.equal(snap.prefillTps, 0);
  assert.equal(snap.available, true);
});
