/**
 * Regression for #384: on vLLM builds that publish the per-request prefill
 * histograms, the completed-window prefill rate used to latch forever — the
 * engine idles, but prefillTps stayed at the last completion's rate, so
 * SparkMonitor._stampLlmLastActive re-stamped lastActiveAt on every poll and
 * the card never went Idle. The completed-window rate now holds for the same
 * 20 s the TensorFold window holds a finished-request rate, then clears.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

const VLLM_METRICS = `vllm:prompt_tokens_total{engine="0"} 1000.0
vllm:generation_tokens_total{engine="0"} 500.0
vllm:num_requests_running{engine="0"} 0.0
vllm:num_requests_waiting{engine="0"} 0.0
vllm:kv_cache_usage_perc{engine="0"} 0.42
vllm:prefix_cache_hits_total{engine="0"} 10.0
vllm:prefix_cache_queries_total{engine="0"} 20.0
`;

function jsonRes(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function textRes(txt, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => txt,
    json: async () => ({}),
  };
}

test("vLLM per-request prefill: the completed-window rate holds, then expires instead of latching", async (t) => {
  let clock = 10_000;
  t.mock.method(Date, "now", () => clock);

  const metricsAt = (count, sum, kv) =>
    `${VLLM_METRICS}
vllm:request_prefill_time_seconds_count{engine="0"} ${count}
vllm:request_prefill_time_seconds_sum{engine="0"} ${sum}
vllm:request_prefill_kv_computed_tokens_sum{engine="0"} ${kv}
`;

  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  probe.serverIsOpenAI = true;
  probe.backendType = "vllm";
  probe.authOpen = true;
  probe._lastDetectAt = clock;
  probe.lastProbeTime = clock - 2000;
  probe.lastTokenCounts = { input: 1000, output: 500 };
  probe._tokenCountsSeeded = true;

  let counters = { count: 1, sum: 2.0, kv: 1000 };
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) {
      return jsonRes({ data: [{ id: "meta-llama/Llama-3.1-8B", max_model_len: 8192 }] });
    }
    if (u.endsWith("/metrics")) return textRes(metricsAt(counters.count, counters.sum, counters.kv));
    if (u.endsWith("/slots")) return jsonRes({}, 404);
    return jsonRes({}, 404);
  };

  // Poll 1 seeds the per-request totals baseline; nothing has finished yet.
  await probe.probe();
  assert.equal(probe.prefillTps, 0);

  // Poll 2: one request finished between polls → the completed-window rate.
  clock = 15_000;
  counters = { count: 2, sum: 3.5, kv: 2500 };
  const snap = await probe.probe();
  assert.equal(probe._vllmPrefillCompletedAt, 15_000);
  assert.ok(Math.abs(snap.prefillTps - 1000) < 1, `prefillTps ${snap.prefillTps}`);
  assert.equal(snap.uncachedPrefillTps, 1000);

  // Poll 3, 15 s later with frozen counters (engine idle): inside the hold.
  clock = 30_000;
  await probe.probe();
  assert.equal(probe._vllmPrefillCompletedAt, 15_000);
  assert.ok(Math.abs(probe.prefillTps - 1000) < 1, `prefillTps ${probe.prefillTps}`);

  // Poll 4, 25 s after the completion: the hold expired, the rate clears so
  // the engine can read Idle again.
  clock = 40_000;
  const idle = await probe.probe();
  assert.equal(probe._vllmPrefillCompletedAt, null);
  assert.equal(idle.prefillTps, 0);
  assert.equal(idle.uncachedPrefillTps, null);
  assert.equal(idle.cachedPrefillTps, null);
});

test("vLLM per-request prefill: a new completion refreshes the hold", async (t) => {
  let clock = 10_000;
  t.mock.method(Date, "now", () => clock);

  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  probe.serverIsOpenAI = true;
  probe.backendType = "vllm";
  probe.authOpen = true;
  probe._lastDetectAt = clock;
  probe.lastProbeTime = clock - 2000;
  probe.lastTokenCounts = { input: 1000, output: 500 };
  probe._tokenCountsSeeded = true;

  let counters = { count: 1, sum: 2.0, kv: 1000 };
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) {
      return jsonRes({ data: [{ id: "meta-llama/Llama-3.1-8B", max_model_len: 8192 }] });
    }
    if (u.endsWith("/metrics")) {
      return textRes(`${VLLM_METRICS}
vllm:request_prefill_time_seconds_count{engine="0"} ${counters.count}
vllm:request_prefill_time_seconds_sum{engine="0"} ${counters.sum}
vllm:request_prefill_kv_computed_tokens_sum{engine="0"} ${counters.kv}
`);
    }
    if (u.endsWith("/slots")) return jsonRes({}, 404);
    return jsonRes({}, 404);
  };

  await probe.probe();

  clock = 15_000;
  counters = { count: 2, sum: 3.5, kv: 2500 };
  await probe.probe();

  // A second completion 20+ s after the first restarts the hold instead of
  // inheriting the expired deadline.
  clock = 36_000;
  counters = { count: 3, sum: 4.5, kv: 3400 };
  const snap = await probe.probe();
  assert.equal(probe._vllmPrefillCompletedAt, 36_000);
  assert.ok(Math.abs(snap.prefillTps - 900) < 1, `prefillTps ${snap.prefillTps}`);
  assert.ok(snap.prefillTps > 0, "a fresh completion is still published");
});

test("vLLM decode/prefill flags follow running requests and new output", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  probe.lastTokenCounts = { input: 1000, output: 500 };
  probe._tokenCountsSeeded = true;
  const metrics = (running, out) => `vllm:prompt_tokens_total{engine="0"} 1000
vllm:generation_tokens_total{engine="0"} ${out}
vllm:num_requests_running{engine="0"} ${running}
vllm:num_requests_waiting{engine="0"} 0
`;

  // New output with running requests: decoding, not prefilling.
  probe._applyVllmMetrics(metrics(2, 600), 2);
  assert.equal(probe.decodeActive, true);
  assert.equal(probe.prefillActive, false);

  // Open requests with no new output: prefilling, not decoding.
  probe._applyVllmMetrics(metrics(2, 600), 2);
  assert.equal(probe.decodeActive, false);
  assert.equal(probe.prefillActive, true);

  // No running requests: neither.
  probe._applyVllmMetrics(metrics(0, 600), 2);
  assert.equal(probe.decodeActive, false);
  assert.equal(probe.prefillActive, false);
});

test("vLLM optional cumulative counters clear when a scrape omits them", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  const fields = {
    prefillSecondsTotal: 1,
    prefillCountTotal: 2,
    decodeSecondsTotal: 3,
    decodeCountTotal: 4,
    ttftSecondsTotal: 5,
    ttftCountTotal: 6,
    latencySecondsTotal: 7,
    latencyCountTotal: 8,
    tpotSecondsTotal: 9,
    tpotCountTotal: 10,
    decodeRoundsTotal: 11,
    prefixCacheQueriesTotal: 12,
    prefixCacheHitsTotal: 13,
    mtpDraftedTotal: 14,
    mtpAcceptedTotal: 15,
    deviceMemoryBytes: 16,
    deviceMemoryPeakBytes: 17,
    clientDisconnectionsTotal: 18,
    requestLatencySeconds: 19,
    prefillP95Seconds: 20,
    decodeP95Seconds: 21,
  };
  Object.assign(probe, fields);
  probe._applyVllmMetrics('vllm:num_requests_running{engine="0"} 1\n', 2);
  for (const name of Object.keys(fields)) {
    assert.equal(probe[name], null, `${name} must be unknown, not the previous scrape`);
  }
});
