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
  const probe = new LlmProbe({ lanIp: "192.0.2.10" }, 8888);
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
  const probe = new LlmProbe({ lanIp: "192.0.2.10" }, 8888);
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
  const probe = new LlmProbe({ lanIp: "192.0.2.10" }, 8888);
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

test("_applyTensorFoldHealth: open requests do not count queued work as occupied slots", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._applyTensorFoldHealth({
    ok: true, busy: true, requests_running: 10,
    streams: { decoding: 8, prefilling: 0, max: 8, filling: 0, paused: 0 },
  }, 2);
  assert.equal(probe.slotsActive, 8);
  assert.equal(probe.slotsTotal, 8);
  assert.equal(probe.requestsRunning, 8);
  assert.equal(probe.requestsWaiting, null); // Not an inferred queue of 10 - 8.
});

test("_applyTensorFoldHealth: paused lanes occupy slots and filling aliases prefilling", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  for (const prefill of [{ prefilling: 2, filling: 2 }, { filling: 2 }, { prefilling: null, filling: 2 }]) {
    probe._applyTensorFoldHealth({ requests_running: 10,
      streams: { decoding: 3, paused: 1, max: 8, ...prefill } }, 2);
    assert.equal(probe.slotsActive, 6);
    assert.equal(probe.requestsRunning, 6);
    assert.equal(probe.prefillActive, true);
  }
});

test("_applyTensorFoldHealth: missing counts remain unknown, measured idle stays zero", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  for (const health of [null, {}, { requests_running: null },
    { requests_running: 10, streams: { max: 8, decoding: null, prefilling: null, filling: null, paused: null } }]) {
    probe._applyTensorFoldHealth(health, 2);
    assert.equal(probe.requestsRunning, null);
    assert.equal(probe.slotsActive, null);
    assert.equal(probe.requestsWaiting, null);
  }
  probe._applyTensorFoldHealth({ requests_running: 10,
    streams: { max: 8, decoding: 0, prefilling: 0, filling: 2, paused: 0 } }, 2);
  assert.equal(probe.slotsActive, 0); // Measured prefilling=0 wins over its alias.
  assert.equal(probe.requestsRunning, 0);
});

test("_applyTensorFoldLive: connections do not overwrite measured idle streams", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._applyTensorFoldHealth({ streams: { max: 8, decoding: 0, prefilling: 0 } }, 2);
  probe._applyTensorFoldLive({ live: { connections: 10, waiting: 2 } });
  assert.equal(probe.requestsRunning, 0);
  assert.equal(probe.slotsActive, 0);
  assert.equal(probe.requestsWaiting, 2);
});

test("_applyTensorFoldLive: missing queue stays unknown, explicit queue values survive", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  for (const waiting of [undefined, null, 0, 2]) {
    probe._applyTensorFoldHealth({}, 2);
    probe._applyTensorFoldLive({ live: { connections: 1, waiting } });
    assert.equal(probe.requestsWaiting, waiting == null ? null : waiting);
    assert.equal(probe.requestsRunning, 1);
  }
});

test("_applyTensorFoldMetrics: scheduler gauges override health/live without inferring queue", async () => {
  for (const waiting of [0, 2]) {
    const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
    probe._applyTensorFoldHealth({ requests_running: 10, streams: { decoding: 8, max: 8 } }, 2);
    probe._applyTensorFoldLive({ live: { connections: 10, waiting: 3 } });
    probe._fetch = async () => ({ ok: true, text: async () =>
      `tensorfold:requests_running 7\ntensorfold:requests_waiting ${waiting}` });
    await probe._applyTensorFoldMetrics();
    assert.equal(probe.requestsRunning, 7);
    assert.equal(probe.slotsActive, 7);
    assert.equal(probe.slotsTotal, 8);
    assert.equal(probe.requestsWaiting, waiting);
  }
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

test("_applyTensorFoldHealth: prefix-cache hits do not inflate prefill tok/s (real totals from a CUDA unit)", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  const health = (over) => ({
    ok: true,
    busy: false,
    backend: "tensorfold",
    requests_running: 0,
    prompt_tokens_total: 2_684_155,
    completion_tokens_total: 58_903,
    prefill_seconds_total: 450.1822,
    cached_tokens_total: 1_560_000,
    ...over,
  });
  probe._applyTensorFoldHealth(health(), 2); // baseline
  // An agent turn: 56,180 prompt tokens in, 53,504 of them cache hits, 1.1455 s of prefill.
  probe._applyTensorFoldHealth(
    health({ prompt_tokens_total: 2_740_335, prefill_seconds_total: 451.3277, cached_tokens_total: 1_613_504 }),
    2
  );
  // Computed tokens only: (56,180 - 53,504) / 1.1455 s, not 56,180 / 1.1455 s = 49,000.
  assert.ok(Math.abs(probe.prefillTps - 2336.1) < 1, `prefillTps ${probe.prefillTps}`);

  // A fully cached prompt computes nothing: no absurd rate, the last real one is held.
  probe._applyTensorFoldHealth(
    health({ prompt_tokens_total: 2_800_000, prefill_seconds_total: 451.4, cached_tokens_total: 1_673_169 }),
    2
  );
  assert.ok(probe.prefillTps < 3000, `prefillTps ${probe.prefillTps}`);
});

test("_applyTensorFoldHealth: without a cached total (older builds) the whole prompt is the best available basis", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  const base = { ok: true, backend: "tensorfold", prompt_tokens_total: 0, completion_tokens_total: 0, prefill_seconds_total: 0, requests_running: 0 };
  probe._applyTensorFoldHealth(base, 2);
  probe._applyTensorFoldHealth({ ...base, prompt_tokens_total: 1000, prefill_seconds_total: 0.5 }, 2);
  assert.equal(probe.prefillTps, 2000);
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
  const probe = new LlmProbe({ lanIp: "192.0.2.10" }, 8888);
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

test("probe: a decode rate reported in /health is not replaced by the /metrics counter diff", async () => {
  const probe = new LlmProbe({ lanIp: "192.0.2.10" }, 8888);
  const health = { status: "ok", max_batch_size: 4, live: { connections: 1, waiting: 0, decode_tokens_per_second: 33.5 } };
  let total = 1000;
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) return notFound();
    if (u.endsWith("/v1/models")) return jsonRes(CUDA_MODELS);
    if (u.endsWith("/health")) return jsonRes(health);
    if (u.endsWith("/metrics")) {
      const txt = `tensorfold:generation_tokens_total ${total}\ntensorfold:generation_tokens_running 0\ntensorfold:prompt_tokens_total 10`;
      return { ok: true, status: 200, text: async () => txt, json: async () => ({}) };
    }
    return notFound();
  };
  await probe.probe();
  total = 5000;
  probe.lastProbeTime = Date.now() - 2000;
  const snap = await probe.probe();
  assert.equal(snap.totalOutputTokens, 5000);
  assert.equal(snap.generationTps, 33.5);
});

test("probe: TensorFold with cumulative counters in /health reads only the queue from /metrics", async () => {
  const probe = new LlmProbe({ lanIp: "192.0.2.10" }, 8888);
  const seen = [];
  probe._fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.endsWith("/slots")) return notFound();
    if (u.endsWith("/v1/models")) return jsonRes(CUDA_MODELS);
    if (u.endsWith("/health")) return jsonRes({ prompt_tokens_total: 10, completion_tokens_total: 20, busy: false });
    if (u.endsWith("/metrics")) {
      const txt = [
        "tensorfold:requests_running 9",
        "tensorfold:requests_waiting 2",
        "tensorfold:generation_tokens_total 999",
        "tensorfold:mtp_drafted_total 9",
        "tensorfold:mtp_accepted_total 9",
        "",
      ].join("\n");
      return { ok: true, status: 200, text: async () => txt, json: async () => ({}) };
    }
    return notFound();
  };
  const snap = await probe.probe();
  assert.equal(seen.some((u) => u.endsWith("/metrics")), true); // the queue needs this poll
  assert.equal(snap.requestsWaiting, 2); // the queue is /metrics-only for this /health shape
  assert.equal(snap.totalOutputTokens, 20); // /health totals stay authoritative (999 not applied)
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
  const probe = new LlmProbe({ lanIp: "192.0.2.10" }, 8888);
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

test("_applyTensorFoldHealth: prefillActive follows streams.prefilling and the last finished rate is held", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  const h = (prompt, sec, prefilling) => ({
    prompt_tokens_total: prompt,
    completion_tokens_total: 10,
    prefill_seconds_total: sec,
    streams: { prefilling, decoding: 0, max: 8 },
  });
  probe._applyTensorFoldHealth(h(1000, 10, 0), 2); // seeds
  probe._applyTensorFoldHealth(h(3000, 12, 0), 2); // 2000 tokens in 2 s
  assert.equal(probe.prefillTps, 1000);
  assert.equal(probe.prefillActive, false);
  probe._applyTensorFoldHealth(h(3000, 12, 1), 2); // a new long prefill: totals do not move
  assert.equal(probe.prefillActive, true);
  assert.equal(probe.prefillTps, 1000); // held, not 0
  probe._tensorfoldLastPrefill.at -= 60_000;
  probe._applyTensorFoldHealth(h(3000, 12, 1), 2);
  assert.equal(probe.prefillTps, 0);
});

test("_applyTensorFoldMetrics: /metrics-only builds get decode tok/s from total + running tokens", async () => {
  // tensorfold-native (Zig engine): /health is only {"status": "ok"}, every counter is on /metrics.
  const probe = new LlmProbe({ lanIp: "192.0.2.10" }, 8888);
  let sample = { total: 1000, running: 0 };
  probe._fetch = async (url) => {
    if (!String(url).endsWith("/metrics")) return notFound();
    const txt = [
      `tensorfold:generation_tokens_total ${sample.total}`,
      `tensorfold:generation_tokens_running ${sample.running}`,
      "tensorfold:prompt_tokens_total 5000",
      `tensorfold:requests_running ${sample.running > 0 ? 1 : 0}`,
    ].join("\n");
    return { ok: true, status: 200, text: async () => txt };
  };

  // First sample seeds the baseline: a lifetime total is not a rate.
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.totalOutputTokens, 1000);

  // A request is decoding; the finished total has not moved yet.
  sample = { total: 1000, running: 100 };
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.generationTps, 50);
  assert.equal(probe.slotsActive, 1);

  // It finishes: its 150 tokens move into the total, no spike from the handover.
  sample = { total: 1150, running: 0 };
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.generationTps, 25);
  assert.equal(probe.totalOutputTokens, 1150);

  // Idle again.
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.generationTps, 0);
});

test("_applyTensorFoldMetrics reads latency histograms and cache counters", async () => {
  const probe = new LlmProbe({ lanIp: "192.0.2.10" }, 8888);
  const metrics = [
    'tensorfold:time_to_first_token_seconds_bucket{le="0.1"} 5',
    'tensorfold:time_to_first_token_seconds_bucket{le="0.2"} 10',
    'tensorfold:time_to_first_token_seconds_bucket{le="+Inf"} 10',
    "tensorfold:time_to_first_token_seconds_sum 1.5",
    "tensorfold:time_to_first_token_seconds_count 10",
    'tensorfold:request_latency_seconds_bucket{le="0.5"} 8',
    'tensorfold:request_latency_seconds_bucket{le="1"} 10',
    'tensorfold:request_latency_seconds_bucket{le="+Inf"} 10',
    "tensorfold:request_latency_seconds_count 10",
    'tensorfold:request_time_per_output_token_seconds_bucket{le="0.01"} 10',
    'tensorfold:request_time_per_output_token_seconds_bucket{le="+Inf"} 10',
    "tensorfold:request_time_per_output_token_seconds_count 10",
    "tensorfold:prefix_cache_queries_total 100",
    "tensorfold:prefix_cache_hits_total 25",
    "tensorfold:preemptions_total 3",
  ].join("\n");
  probe._fetch = async () => ({ ok: true, status: 200, text: async () => metrics });
  await probe._applyTensorFoldMetrics(2);

  assert.equal(probe.ttftP95Seconds, 0.19);
  assert.equal(probe.ttftSeconds, 0.15);
  assert.equal(probe.e2eP95Seconds, 0.875);
  assert.equal(probe.itlP95Seconds, 0.01);
  assert.equal(probe.prefixCacheHitRate, 0.25);
  assert.equal(probe.preemptionsTotal, 3);
});

test("_applyTensorFoldMetrics: prompt_tokens_cached_total feeds the token ledger", async () => {
  const lines = (extra) =>
    [
      "tensorfold:prompt_tokens_total 1000",
      "tensorfold:generation_tokens_total 100",
      ...extra,
    ].join("\n");

  const direct = metricsProbe(() => lines(["tensorfold:prompt_tokens_cached_total 640"]));
  await direct._applyTensorFoldMetrics(2);
  assert.equal(direct.totalPromptTokens, 1000);
  assert.equal(direct.totalCachedTokens, 640);

  // vLLM's hit counter carries the same split on builds that do not publish the
  // TensorFold name; use it only when the dedicated counter is absent.
  const fallback = metricsProbe(() =>
    lines([
      "tensorfold:prefix_cache_queries_total 1000",
      "tensorfold:prefix_cache_hits_total 250",
    ])
  );
  await fallback._applyTensorFoldMetrics(2);
  assert.equal(fallback.totalCachedTokens, 250);

  // The cached count belongs to this scrape's prompt total and cannot exceed it.
  const clamped = metricsProbe(() =>
    [
      "tensorfold:prompt_tokens_total 100",
      "tensorfold:generation_tokens_total 10",
      "tensorfold:prompt_tokens_cached_total 150",
    ].join("\n")
  );
  await clamped._applyTensorFoldMetrics(2);
  assert.equal(clamped.totalCachedTokens, 100);

  // No cached counter at all: keep whatever /health or an earlier scrape reported.
  const absent = metricsProbe(() => lines([]));
  await absent._applyTensorFoldMetrics(2);
  assert.equal(absent.totalCachedTokens, null);

  const kept = metricsProbe(() => lines([]));
  kept.totalCachedTokens = 321;
  await kept._applyTensorFoldMetrics(2);
  assert.equal(kept.totalCachedTokens, 321);

  // A queue-only poll reads no totals, so it must not clear the cached counter.
  const queueOnly = metricsProbe(() =>
    lines(["tensorfold:prompt_tokens_cached_total 640"])
  );
  queueOnly.totalCachedTokens = 42;
  await queueOnly._applyTensorFoldMetrics(undefined, true);
  assert.equal(queueOnly.totalCachedTokens, 42);
});

test("_applyTensorFoldMetrics: a prompt-cache-tier build reports its cached split", async () => {
  // A build whose prompt-cache tier comes from a recipe patch rather than from
  // upstream publishes prompt_cache_cached_tokens / prompt_cache_computed_tokens
  // and neither upstream name, so the ledger used to record no cached tokens at
  // all and Cost compare priced every prompt token as computed.
  const tier = metricsProbe(() =>
    [
      "tensorfold:prompt_tokens_total 532701765",
      "tensorfold:generation_tokens_total 1000",
      "tensorfold:prompt_cache_cached_tokens 519106560",
      "tensorfold:prompt_cache_computed_tokens 10564859",
    ].join("\n")
  );
  await tier._applyTensorFoldMetrics(2);
  assert.equal(tier.totalPromptTokens, 532701765);
  assert.equal(tier.totalCachedTokens, 519106560);

  // Upstream's own counter still wins where a build publishes both.
  const both = metricsProbe(() =>
    [
      "tensorfold:prompt_tokens_total 1000",
      "tensorfold:generation_tokens_total 100",
      "tensorfold:prompt_tokens_cached_total 700",
      "tensorfold:prompt_cache_cached_tokens 600",
    ].join("\n")
  );
  await both._applyTensorFoldMetrics(2);
  assert.equal(both.totalCachedTokens, 700);

  // The tier name is preferred over vLLM's hit counter, and still clamped to
  // this scrape's prompt total.
  const overPrompt = metricsProbe(() =>
    [
      "tensorfold:prompt_tokens_total 100",
      "tensorfold:generation_tokens_total 10",
      "tensorfold:prompt_cache_cached_tokens 150",
      "tensorfold:prefix_cache_hits_total 20",
    ].join("\n")
  );
  await overPrompt._applyTensorFoldMetrics(2);
  assert.equal(overPrompt.totalCachedTokens, 100);
});

test("_applyTensorFoldMetrics reads the TensorFold 1.1 KV occupancy ratio", async () => {
  const probe = new LlmProbe({ lanIp: "192.0.2.10" }, 8888);
  probe._fetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      [
        "tensorfold:requests_running 1",
        "tensorfold:requests_waiting 2",
        "tensorfold:kv_cache_usage_ratio 0.42",
      ].join("\n"),
  });
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.kvCacheUsage, 0.42);
  assert.equal(probe.requestsWaiting, 2);
  assert.equal(probe.requestsRunning, 1);
});

for (const [name, buckets, sum] of [
  ["missing infinite bucket", [["0.1", 10]], 1],
  ["mismatched infinite count", [["0.1", 10], ["+Inf", 0]], 1],
  ["decreasing cumulative counts", [["0.1", 10], ["0.2", 5], ["+Inf", 10]], 1],
  ["negative count", [["0.1", -1], ["+Inf", 10]], 1],
  ["negative boundary", [["-1", 10], ["+Inf", 10]], 1],
  ["negative latency sum", [["0.1", 10], ["+Inf", 10]], -1],
]) {
  test(`TensorFold rejects ${name}`, async () => {
    const probe = new LlmProbe({ lanIp: "192.0.2.10" }, 8888);
    const text = buckets.map(([le, count]) => `tensorfold:time_to_first_token_seconds_bucket{le="${le}"} ${count}`).join("\n") +
      `\ntensorfold:time_to_first_token_seconds_count 10\ntensorfold:time_to_first_token_seconds_sum ${sum}`;
    probe._fetch = async () => ({ ok: true, status: 200, text: async () => text });
    await probe._applyTensorFoldMetrics(2);
    if (sum < 0) assert.equal(probe.ttftSeconds, null);
    else assert.equal(probe.ttftP95Seconds, null);
  });
}

test("TensorFold aggregates valid histogram labels and leaves infinite-tail percentiles unknown", async () => {
  const probe = new LlmProbe({ lanIp: "192.0.2.10" }, 8888);
  let finite = 5;
  probe._fetch = async () => ({ ok: true, status: 200, text: async () => [
    ...["a", "b"].flatMap((model) => [
      `tensorfold:time_to_first_token_seconds_bucket{model="${model}",le="0.1"} ${finite}`,
      `tensorfold:time_to_first_token_seconds_bucket{model="${model}",le="+Inf"} 5`,
      `tensorfold:time_to_first_token_seconds_count{model="${model}"} 5`,
    ]),
  ].join("\n") });
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.ttftP95Seconds, 0.095);
  finite = 1;
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.ttftP95Seconds, null);
});

/** Build a `tensorfold:*` Prometheus payload for the /metrics applier. */
function tfMetrics(o) {
  const { gen, running = 0, prompt = 0, reqRunning = 0, reqWaiting = 0, tpotCount = null, tpotSum = null } = o;
  const lines = [
    `tensorfold:generation_tokens_total ${gen}`,
    `tensorfold:generation_tokens_running ${running}`,
    `tensorfold:prompt_tokens_total ${prompt}`,
    `tensorfold:requests_running ${reqRunning}`,
    `tensorfold:requests_waiting ${reqWaiting}`,
  ];
  if (tpotCount != null) lines.push(`tensorfold:request_time_per_output_token_seconds_count ${tpotCount}`);
  if (tpotSum != null) lines.push(`tensorfold:request_time_per_output_token_seconds_sum ${tpotSum}`);
  if (o.prefillSum != null) lines.push(`tensorfold:request_prefill_seconds_sum ${o.prefillSum}`);
  if (o.prefillCount != null) lines.push(`tensorfold:request_prefill_seconds_count ${o.prefillCount}`);
  if (o.numRunning != null) lines.push(`tensorfold:num_requests_running ${o.numRunning}`);
  return lines.join("\n") + "\n";
}

function metricsProbe(txtFn) {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe.backendType = "tensorfold";
  probe._fetch = async (url) =>
    String(url).endsWith("/metrics")
      ? { ok: true, status: 200, json: async () => ({}), text: async () => txtFn() }
      : notFound();
  return probe;
}

test("_applyTensorFoldMetrics: TPOT histogram window gives per-stream decode tok/s", async () => {
  let txt = tfMetrics({ gen: 1000, tpotCount: 100, tpotSum: 5 });
  const probe = metricsProbe(() => txt);
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.perStreamTps, null); // the first sample only seeds the baseline
  txt = tfMetrics({ gen: 1200, tpotCount: 150, tpotSum: 7.5 });
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.generationTps, 100); // (1200 + 0) - (1000 + 0) over 2 s
  assert.equal(probe.perStreamTps, 20); // 50 finished tokens over 2.5 s of per-token time
});

test("_applyTensorFoldMetrics: per-stream holds while no request finishes (histogram freezes)", async () => {
  let txt = tfMetrics({ gen: 1000, running: 100, tpotCount: 100, tpotSum: 5 });
  const probe = metricsProbe(() => txt);
  await probe._applyTensorFoldMetrics(2);
  txt = tfMetrics({ gen: 1200, running: 300, tpotCount: 100, tpotSum: 5 });
  await probe._applyTensorFoldMetrics(2); // aggregate lives on generation_tokens_running
  assert.equal(probe.generationTps, 200);
  assert.equal(probe.perStreamTps, null); // nothing measured yet — honest null, not 0
  txt = tfMetrics({ gen: 1500, running: 300, tpotCount: 150, tpotSum: 7.5 });
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.perStreamTps, 20);
  txt = tfMetrics({ gen: 1600, running: 500, tpotCount: 150, tpotSum: 7.5 });
  await probe._applyTensorFoldMetrics(2); // no completion this window
  assert.equal(probe.perStreamTps, 20); // held, not flashed to 0
});

test("_applyTensorFoldMetrics: no histogram → aggregate ÷ running, null when idle", async () => {
  let txt = tfMetrics({ gen: 0, reqRunning: 2 });
  const probe = metricsProbe(() => txt);
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.perStreamTps, null);
  txt = tfMetrics({ gen: 100, running: 2, reqRunning: 2 });
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.generationTps, 51); // (100 + 2) / 2
  assert.equal(probe.perStreamTps, 25.5); // fallback: aggregate ÷ active streams
  txt = tfMetrics({ gen: 100, running: 0, reqRunning: 0 });
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.perStreamTps, null); // idle with no measured rate → null again
});

test("_applyTensorFoldMetrics: queueOnly poll does not disturb the per-stream baseline", async () => {
  let txt = tfMetrics({ gen: 1000, tpotCount: 100, tpotSum: 5 });
  const probe = metricsProbe(() => txt);
  await probe._applyTensorFoldMetrics(2);
  txt = tfMetrics({ gen: 1200, tpotCount: 150, tpotSum: 7.5, reqWaiting: 3 });
  await probe._applyTensorFoldMetrics(undefined, true);
  assert.equal(probe.requestsWaiting, 3);
  assert.equal(probe.perStreamTps, null); // queueOnly never consumes the histogram window
  txt = tfMetrics({ gen: 1400, tpotCount: 200, tpotSum: 10 });
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.perStreamTps, 20); // 100 tokens / 5 s — measured from the FIRST sample, proving the queueOnly poll consumed nothing
});

test("snapshot: perStreamTps exposed, null by default", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  assert.equal(probe._defaultLlm().perStreamTps, null);
  probe.backendType = "tensorfold";
  let txt = tfMetrics({ gen: 1000, tpotCount: 100, tpotSum: 5 });
  probe._fetch = async (url) =>
    String(url).endsWith("/metrics")
      ? { ok: true, status: 200, json: async () => ({}), text: async () => txt }
      : notFound();
  await probe._applyTensorFoldMetrics(2);
  txt = tfMetrics({ gen: 1200, tpotCount: 150, tpotSum: 7.5 });
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe._getSnapshot().perStreamTps, 20);
});

test("_applyTensorFoldMetrics: running count has ONE source — aliases never sum", async () => {
  // Live TensorFold exports requests_running AND num_requests_running with the
  // same value; a naive reader that adds them reports 2 streams for 1.
  const txt = tfMetrics({ gen: 0, reqRunning: 1, numRunning: 1 });
  const probe = metricsProbe(() => txt);
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.requestsRunning, 1);
  assert.equal(probe.slotsActive, 1);
  // Canonical name absent → the alias is used, not ignored.
  const only = "tensorfold:num_requests_running 3\ntensorfold:num_requests_waiting 2\n";
  const p2 = metricsProbe(() => only);
  await p2._applyTensorFoldMetrics(2);
  assert.equal(p2.requestsRunning, 3);
  assert.equal(p2.requestsWaiting, 2);
});

function prefillTxt({ prompt, prefillSum, prefillCount, gen = 0, running = 0, reqRunning = 0, genRunning = 0 }) {
  return tfMetrics({ gen, running, prompt, reqRunning, tpotCount: 1, tpotSum: 1, prefillSum, prefillCount }) +
    `tensorfold:generation_tokens_running ${genRunning}\n`;
}

test("_applyTensorFoldMetrics: prefill measured only at completion; held while frozen; prefillActive live", async () => {
  // Mirrors the captured live session: a 98,854-token prompt computing for
  // 35.14 s during which EVERY counter is frozen, then one completion poll.
  let txt = prefillTxt({ prompt: 50000, prefillSum: 100, prefillCount: 5, genRunning: 0 });
  const probe = metricsProbe(() => txt);
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.perStreamPrefillTps, null); // first sample seeds only

  // Mid-prefill: request open, nothing produced yet.
  txt = prefillTxt({ prompt: 50000, prefillSum: 100, prefillCount: 5, reqRunning: 1, genRunning: 0 });
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.prefillActive, true);
  assert.equal(probe.perStreamPrefillTps, null); // honest null, no invented rate

  // Decode started: the prefill indicator must go away.
  txt = prefillTxt({ prompt: 50000, prefillSum: 100, prefillCount: 5, reqRunning: 1, genRunning: 40 });
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.prefillActive, false);

  // Completion poll: prompt +98,854 over +35.14 prefill-seconds → ≈2,813 tok/s.
  txt = prefillTxt({ prompt: 148854, prefillSum: 135.14, prefillCount: 6 });
  await probe._applyTensorFoldMetrics(2);
  assert.ok(Math.abs(probe.prefillTps - 98854 / 35.14) < 0.02, `prefillTps=${probe.prefillTps}`);
  assert.equal(probe.perStreamPrefillTps, probe.prefillTps);

  // Idle polls zero prefillTps via the counterless /health; the applier must
  // re-state the held rate while nothing new finished.
  probe.prefillTps = 0; // simulate _applyExl3Health's zeroing between polls
  txt = prefillTxt({ prompt: 148854, prefillSum: 135.14, prefillCount: 6 });
  await probe._applyTensorFoldMetrics(2);
  assert.ok(probe.prefillTps > 0); // held, not 0
});

test("_applyTensorFoldMetrics: prefill counter reset re-seeds without inventing a rate", async () => {
  let txt = prefillTxt({ prompt: 10000, prefillSum: 4, prefillCount: 2 });
  const probe = metricsProbe(() => txt);
  await probe._applyTensorFoldMetrics(2);
  txt = prefillTxt({ prompt: 11000, prefillSum: 4.5, prefillCount: 3 });
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.perStreamPrefillTps, 2000); // 1000 / 0.5
  // Server restarts: totals drop below the baseline.
  txt = prefillTxt({ prompt: 100, prefillSum: 0.1, prefillCount: 1 });
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.perStreamPrefillTps, 2000); // held while the new baseline accrues
  txt = prefillTxt({ prompt: 1100, prefillSum: 0.6, prefillCount: 2 });
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.perStreamPrefillTps, 2000); // 1000 / 0.5 again — re-seeded correctly
});

test("_applyTensorFoldMetrics: no prefill histogram → perStreamPrefillTps stays null; dtSec-less (live-rate) poll writes nothing", async () => {
  const probe = metricsProbe(() =>
    `tensorfold:prompt_tokens_total 1000\ntensorfold:generation_tokens_total 5\ntensorfold:requests_running 0\n`);
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.perStreamPrefillTps, null);
  assert.equal(probe.prefillTps, 0);
  // hasLiveDecode caller passes dtSec=undefined: prefill must not be touched.
  const p2 = metricsProbe(() => prefillTxt({ prompt: 20000, prefillSum: 10, prefillCount: 1 }));
  await p2._applyTensorFoldMetrics(undefined);
  assert.equal(p2.perStreamPrefillTps, null);
});

test("_applyTensorFoldMetrics: noise/cache-style prefill windows are rejected; hold expires", async () => {
  // Ground-truth-style valid window first: 2000 tokens over 0.8 s = 2500 tok/s.
  let txt = prefillTxt({ prompt: 10000, prefillSum: 10, prefillCount: 1 });
  const probe = metricsProbe(() => txt);
  await probe._applyTensorFoldMetrics(2);
  txt = prefillTxt({ prompt: 12000, prefillSum: 10.8, prefillCount: 2 });
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.perStreamPrefillTps, 2500);

  // Tiny-prompt completion: 60 tokens in 0.4 ms → 150k tok/s. Physically
  // impossible (observed live as 109k-313k); the window must be REJECTED and
  // the last valid rate held.
  txt = prefillTxt({ prompt: 12060, prefillSum: 10.8004, prefillCount: 3 });
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.perStreamPrefillTps, 2500); // held, not 150000
  assert.equal(probe.prefillTps, 2500);

  // Expired hold behaves like upstream's /health path: no rate after 20 s of
  // nothing valid.
  probe._tensorfoldPrefillMeasuredAt = Date.now() - 21_000;
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.perStreamPrefillTps, null);
  assert.equal(probe.prefillTps, 0);


});

test("_applyTensorFoldMetrics: toy-sized prompt windows never set the tile", async () => {
  // A showcase-sized 12-token prompt measured over 0.11 s would "compute" at
  // ~109 tok/s. Below 50 prompt tokens the window is noise; hold instead.
  let txt = prefillTxt({ prompt: 10000, prefillSum: 10, prefillCount: 1 });
  const probe = metricsProbe(() => txt);
  await probe._applyTensorFoldMetrics(2);
  txt = prefillTxt({ prompt: 12000, prefillSum: 10.8, prefillCount: 2 });
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.perStreamPrefillTps, 2500);
  txt = prefillTxt({ prompt: 12012, prefillSum: 10.91, prefillCount: 3 }); // 12 tokens / 0.11 s
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.perStreamPrefillTps, 2500); // held, not 109
});

test("_applyTensorFoldMetrics: effective prefill can exceed one host's cold-compute rate", async () => {
  let txt = prefillTxt({ prompt: 10000, prefillSum: 10, prefillCount: 1 });
  const probe = metricsProbe(() => txt);
  await probe._applyTensorFoldMetrics(2);
  txt = prefillTxt({ prompt: 13000, prefillSum: 10.1, prefillCount: 2 });
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.perStreamPrefillTps, 30000);
  assert.equal(probe.prefillTps, 30000);
});

// ── Prefill split and slot count on a /metrics-only build (health is just {"status": "ok"}) ──

/** A scrape with the prefill histogram and the cached-prompt counter, as the Spark's TensorFold 1.1 publishes them. */
function splitTxt({ prompt, cached, prefillSum, prefillCount, reqRunning = 0, cachedName = "prompt_tokens_cached_total" }) {
  return prefillTxt({ prompt, prefillSum, prefillCount, reqRunning }) +
    (cached == null ? "" : `tensorfold:${cachedName} ${cached}\n`);
}

test("_applyTensorFoldMetrics: the cached prompt counter is read by name in precedence order and clamped to the prompt", async () => {
  const read = async (lines) => {
    const probe = metricsProbe(() => lines.join("\n"));
    await probe._applyTensorFoldMetrics(2);
    return probe.totalCachedTokens;
  };
  assert.equal(await read(["tensorfold:prompt_tokens_total 1000", "tensorfold:generation_tokens_total 1",
    "tensorfold:prompt_tokens_cached_total 700", "tensorfold:prompt_cache_cached_tokens 600",
    "tensorfold:prefix_cache_hits_total 500"]), 700);
  // A build whose cache tier comes from a recipe patch publishes only its own name.
  assert.equal(await read(["tensorfold:prompt_tokens_total 1000", "tensorfold:generation_tokens_total 1",
    "tensorfold:prompt_cache_cached_tokens 600", "tensorfold:prefix_cache_hits_total 500"]), 600);
  assert.equal(await read(["tensorfold:prompt_tokens_total 1000", "tensorfold:generation_tokens_total 1",
    "tensorfold:prefix_cache_hits_total 500"]), 500);
  assert.equal(await read(["tensorfold:prompt_tokens_total 100", "tensorfold:generation_tokens_total 1",
    "tensorfold:prompt_tokens_cached_total 150"]), 100); // never above the prompt it belongs to
  assert.equal(await read(["tensorfold:prompt_tokens_total 100", "tensorfold:generation_tokens_total 1"]), null);
});

test("_applyTensorFoldMetrics: prefill counts computed tokens only, the cached share is its own rate", async () => {
  // Window of two finished requests: 52,000 prompt tokens, 50,150 of them restored from the
  // prompt cache, 1.6 s of prefill time. Counting every prompt token would read 32,500 tok/s.
  let txt = splitTxt({ prompt: 1_000_000, cached: 950_000, prefillSum: 100, prefillCount: 10 });
  const probe = metricsProbe(() => txt);
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.prefillTps, 0); // the first sample only seeds the baseline
  txt = splitTxt({ prompt: 1_052_000, cached: 1_000_150, prefillSum: 101.6, prefillCount: 12 });
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.uncachedPrefillTps, 1156.25); // 1,850 computed tokens / 1.6 s
  assert.equal(probe.prefillTps, 1156.25);
  assert.equal(probe.cachedPrefillTps, 31343.75); // 50,150 restored tokens / 1.6 s
  assert.equal(probe.perStreamPrefillTps, null); // no "effective, incl. cached" figure beside the split
  assert.equal(probe.totalCachedTokens, 1_000_150);
  const snap = probe._getSnapshot();
  assert.equal(snap.prefillTps, 1156.25);
  assert.equal(snap.cachedPrefillTps, 31343.75);
  assert.equal(snap.uncachedPrefillTps, 1156.25);
});

test("_applyTensorFoldMetrics: prefill rates are totals over the last minute, so one cache-restoring request does not swing them", async () => {
  let txt = splitTxt({ prompt: 1_000_000, cached: 950_000, prefillSum: 100, prefillCount: 10 });
  const probe = metricsProbe(() => txt);
  await probe._applyTensorFoldMetrics(2);
  txt = splitTxt({ prompt: 1_020_000, cached: 968_000, prefillSum: 102, prefillCount: 11 }); // 2,000 computed in 2 s
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.uncachedPrefillTps, 1000);
  assert.equal(probe.cachedPrefillTps, 9000);
  // A request that restored 29,970 cached tokens and computed 30 spent 2 s in prefill: alone it would read 15 tok/s.
  txt = splitTxt({ prompt: 1_050_000, cached: 997_970, prefillSum: 104, prefillCount: 12 });
  probe.prefillTps = 0; // _applyExl3Health zeroes it between polls
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.uncachedPrefillTps, 507.5); // (2,000 + 30) computed / (2 + 2) s
  assert.equal(probe.cachedPrefillTps, 11992.5); // (18,000 + 29,970) restored / 4 s
  assert.equal(probe.prefillTps, 507.5);
  // Nothing finished for a minute: both rates fall to 0.
  for (const w of probe._tensorfoldPrefillWindow) w.at -= 61_000;
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.uncachedPrefillTps, 0);
  assert.equal(probe.cachedPrefillTps, 0);
  assert.equal(probe.prefillTps, 0);
});

test("_applyTensorFoldMetrics: a cached counter with no earlier value, or one that went back, never turns cached tokens into computed ones", async () => {
  // The counter shows up after the prefill baseline exists: that window cannot be split.
  let txt = splitTxt({ prompt: 1_000_000, cached: null, prefillSum: 100, prefillCount: 10 });
  const probe = metricsProbe(() => txt);
  await probe._applyTensorFoldMetrics(2);
  txt = splitTxt({ prompt: 1_052_000, cached: 1_000_150, prefillSum: 101.6, prefillCount: 12 });
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.uncachedPrefillTps, 0);
  assert.equal(probe.prefillTps, 0);
  // From the next window on it is split.
  txt = splitTxt({ prompt: 1_104_000, cached: 1_050_300, prefillSum: 103.2, prefillCount: 14 });
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.uncachedPrefillTps, 1156.25);
  // The counter alone goes back (a bad scrape): that window is skipped, the minute's rate stays.
  txt = splitTxt({ prompt: 1_156_000, cached: 1_000_000, prefillSum: 104.8, prefillCount: 16 });
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.uncachedPrefillTps, 1156.25); // not 32,500
});

test("_applyTensorFoldMetrics: a build with no cached counter keeps the effective per-request rate and no split", async () => {
  let txt = prefillTxt({ prompt: 10000, prefillSum: 10, prefillCount: 1 });
  const probe = metricsProbe(() => txt);
  await probe._applyTensorFoldMetrics(2);
  txt = prefillTxt({ prompt: 13000, prefillSum: 10.1, prefillCount: 2 });
  await probe._applyTensorFoldMetrics(2);
  assert.equal(probe.perStreamPrefillTps, 30000);
  assert.equal(probe.cachedPrefillTps, null);
  assert.equal(probe.uncachedPrefillTps, null);
});

test("TensorFold with no published stream count: running streams are shown, no total is invented", async () => {
  // The Spark's engine: /health is {"status": "ok"}, /metrics and /v1/models carry no stream count.
  const probe = new LlmProbe({ lanIp: "192.0.2.10" }, 8888);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) return notFound();
    if (u.endsWith("/v1/models")) return jsonRes({ object: "list", data: [{ id: "worker", owned_by: "tensorfold" }] });
    if (u.endsWith("/health")) return jsonRes({ status: "ok" });
    if (u.endsWith("/metrics")) {
      return { ok: true, status: 200, json: async () => ({}), text: async () =>
        tfMetrics({ gen: 1000, reqRunning: 3, reqWaiting: 1 }) };
    }
    return notFound();
  };
  const snap = await probe.probe();
  assert.equal(snap.backend, "tensorfold");
  assert.equal(snap.slotsActive, 3); // tensorfold:requests_running
  assert.equal(snap.requestsRunning, 3);
  assert.equal(snap.requestsWaiting, 1);
  assert.equal(snap.slotsTotal, 0); // was 1 (an EXL3 server's one slot)
});

test("_applyTensorFoldHealth: a stream count the build does publish still sizes the slots", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._applyTensorFoldHealth({ streams: { max: 4, decoding: 1 } }, 2);
  assert.equal(probe.slotsTotal, 4);
  probe._applyTensorFoldHealth({ max_batch_size: 8 }, 2);
  assert.equal(probe.slotsTotal, 8);
  probe._applyTensorFoldHealth({ status: "ok" }, 2);
  assert.equal(probe.slotsTotal, 0);
});
