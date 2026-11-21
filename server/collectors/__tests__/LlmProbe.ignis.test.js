/**
 * Unit tests for ignis (gpillon/ignis) detection and metrics.
 */
import { test, mock } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";
import { readServerGenerationTokens } from "../LlmStreaming.js";

// Real `GET /ui/metrics` lines from ignis 0.10.0 serving Qwen3.8-Flash-Next (8 decode
// lanes, MTP draft 3) on an RTX PRO 5000, trimmed to the series the probe reads.
const IGNIS_METRICS = `ignis_build_info{version="0.10.0"} 1
ignis_scheduler_requests{state="waiting"} 0
ignis_scheduler_requests{state="running"} 0
ignis_requests_accepted_total 1609
ignis_requests_completed_total 1608
ignis_generated_tokens_total 540578
ignis_decoded_tokens_total 542558
ignis_vram_reserved_bytes{line="weights"} 6540772352
ignis_kv_pool_pages 91998
ignis_kv_page_bytes 239616
ignis_kv_pool_used_pages 166
ignis_request_ttft_seconds_bucket{le="0.05"} 16
ignis_request_ttft_seconds_bucket{le="0.1"} 145
ignis_request_ttft_seconds_bucket{le="0.25"} 1381
ignis_request_ttft_seconds_bucket{le="0.5"} 1569
ignis_request_ttft_seconds_bucket{le="1"} 1585
ignis_request_ttft_seconds_bucket{le="2.5"} 1593
ignis_request_ttft_seconds_bucket{le="5"} 1596
ignis_request_ttft_seconds_bucket{le="10"} 1599
ignis_request_ttft_seconds_bucket{le="30"} 1605
ignis_request_ttft_seconds_bucket{le="60"} 1609
ignis_request_ttft_seconds_bucket{le="120"} 1609
ignis_request_ttft_seconds_bucket{le="300"} 1609
ignis_request_ttft_seconds_bucket{le="+Inf"} 1609
ignis_request_ttft_seconds_sum 631.797
ignis_request_ttft_seconds_count 1609
ignis_request_duration_seconds_bucket{le="0.1"} 19
ignis_request_duration_seconds_bucket{le="0.25"} 125
ignis_request_duration_seconds_bucket{le="0.5"} 305
ignis_request_duration_seconds_bucket{le="1"} 599
ignis_request_duration_seconds_bucket{le="2.5"} 980
ignis_request_duration_seconds_bucket{le="5"} 1307
ignis_request_duration_seconds_bucket{le="10"} 1487
ignis_request_duration_seconds_bucket{le="30"} 1571
ignis_request_duration_seconds_bucket{le="60"} 1595
ignis_request_duration_seconds_bucket{le="120"} 1608
ignis_request_duration_seconds_bucket{le="300"} 1608
ignis_request_duration_seconds_bucket{le="600"} 1608
ignis_request_duration_seconds_bucket{le="+Inf"} 1608
ignis_request_duration_seconds_sum 6735.878
ignis_request_duration_seconds_count 1608
ignis_speculative_rounds_total 250884
ignis_speculative_drafted_tokens_total 374562
ignis_speculative_accepted_tokens_total 290768
`;

// The model card of the same server (`GET /v1/models`), trimmed.
const IGNIS_MODEL = {
  id: "qwen3.8-flash-next",
  object: "model",
  owned_by: "ignis",
  active: true,
  kind: "text",
  max_model_len: 262144,
  decode_lanes: 8,
};

function advance(txt, changes) {
  let out = txt;
  for (const [name, value] of Object.entries(changes)) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${esc} .*$`, "m");
    assert.ok(re.test(out), `fixture has no series ${name}`);
    out = out.replace(re, `${name} ${value}`);
  }
  return out;
}

/** A fake ignis: /v1/models and /ui/metrics answer; /metrics and /slots do not exist on the API port. */
function ignisServerFetch({ metrics, model = IGNIS_MODEL, requested = [] }) {
  return async (url) => {
    const u = String(url);
    requested.push(u);
    if (u.endsWith("/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ object: "list", data: [model] }) };
    }
    if (u.endsWith("/ui/metrics")) {
      const body = metrics();
      if (body == null) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
      return { ok: true, status: 200, text: async () => body };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
}

test("_detectServerType: owned_by ignis → ignis, not the vLLM default", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8892);
  probe._fetch = ignisServerFetch({ metrics: () => IGNIS_METRICS });
  await probe._detectServerType();
  assert.equal(probe.backendType, "ignis");
});

test("_detectServerType: a known ignis lane is not re-probed for llama.cpp /slots", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8892);
  probe.backendType = "ignis";
  const requested = [];
  probe._fetch = ignisServerFetch({ metrics: () => IGNIS_METRICS, requested });
  await probe._detectServerType();
  assert.equal(probe.backendType, "ignis");
  assert.equal(requested.some((u) => u.endsWith("/slots")), false);
});

test("_applyIgnisMetrics: decode tok/s is the emitted-token delta over the interval, idle reads 0", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8892);
  // The first sample only seeds the baseline: lifetime totals are not one interval's work.
  probe._applyIgnisMetrics(IGNIS_METRICS, 1_700_000_000);
  assert.equal(probe.totalOutputTokens, 542558);
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.measurementValid, false);

  probe._applyIgnisMetrics(advance(IGNIS_METRICS, { ignis_decoded_tokens_total: 542958 }), 2);
  assert.equal(probe.generationTps, 200); // (542958-542558)/2
  assert.equal(probe.measurementValid, true);
  assert.equal(probe.totalOutputTokens, 542958);

  probe._applyIgnisMetrics(advance(IGNIS_METRICS, { ignis_decoded_tokens_total: 542958 }), 2);
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.measurementValid, true); // a measured zero, not an unknown
});

test("_applyIgnisMetrics: a slow probe round (about 10 s) is still measured; a long gap is not", () => {
  // A stopped engine on another port of the same unit times out and stretches every round
  // to roughly 10 s. The delta over the real elapsed time is the true average rate.
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8892);
  probe._applyIgnisMetrics(IGNIS_METRICS, 1_700_000_000);
  probe._applyIgnisMetrics(advance(IGNIS_METRICS, { ignis_decoded_tokens_total: 545434 }), 10.02);
  assert.equal(probe.measurementValid, true);
  assert.equal(probe.generationTps, 287.03); // (545434-542558)/10.02

  // 30 s or more apart: too stale to call a current rate. It re-seeds and the next poll measures.
  probe._applyIgnisMetrics(advance(IGNIS_METRICS, { ignis_decoded_tokens_total: 550000 }), 31);
  assert.equal(probe.measurementValid, false);
  assert.equal(probe.generationTps, 0);
  assert.match(probe.measurementError, /within 30 s/);
  probe._applyIgnisMetrics(advance(IGNIS_METRICS, { ignis_decoded_tokens_total: 550400 }), 2);
  assert.equal(probe.generationTps, 200);
});

test("_applyIgnisMetrics: the live counter is read, not the completed-request one", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8892);
  probe._applyIgnisMetrics(IGNIS_METRICS, 1_700_000_000);
  // Mid-generation: tokens are being emitted, no request has completed yet.
  probe._applyIgnisMetrics(
    advance(IGNIS_METRICS, { ignis_decoded_tokens_total: 542758, ignis_generated_tokens_total: 540578 }),
    1
  );
  assert.equal(probe.generationTps, 200);
});

test("_applyIgnisMetrics: a restarted engine re-seeds instead of reporting a negative rate", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8892);
  probe._applyIgnisMetrics(IGNIS_METRICS, 1_700_000_000);
  probe._applyIgnisMetrics(advance(IGNIS_METRICS, { ignis_decoded_tokens_total: 120 }), 2);
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.measurementValid, false);
  assert.equal(probe.measurementError, "engine counters restarted");
  probe._applyIgnisMetrics(advance(IGNIS_METRICS, { ignis_decoded_tokens_total: 320 }), 2);
  assert.equal(probe.generationTps, 100);
});

test("_applyIgnisMetrics: scheduler, KV pool, weights, acceptance, latency and version", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8892);
  probe._applyIgnisMetrics(
    advance(IGNIS_METRICS, {
      'ignis_scheduler_requests{state="running"}': 3,
      'ignis_scheduler_requests{state="waiting"}': 2,
    }),
    1_700_000_000
  );
  assert.equal(probe.requestsRunning, 3);
  assert.equal(probe.requestsWaiting, 2);
  assert.equal(probe.engineVersion, "0.10.0");
  assert.equal(probe.kvCacheUsage, 166 / 91998);
  assert.equal(probe.kvCacheMemoryBytes, 91998 * 239616);
  assert.equal(probe.weightsGb, 6.54);
  assert.equal(probe.mtpAcceptanceRate, 0.7763); // 290768 / 374562
  // 95% of 1609 requests falls in the (0.25, 0.5] s bucket.
  assert.ok(probe.ttftP95Seconds > 0.25 && probe.ttftP95Seconds <= 0.5, `ttft p95 ${probe.ttftP95Seconds}`);
  assert.ok(probe.e2eP95Seconds > 0, `e2e p95 ${probe.e2eP95Seconds}`);
});

test("_applyIgnisMetrics: no prompt counters exist, so no prefill rate or input total is invented", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8892);
  probe._applyIgnisMetrics(IGNIS_METRICS, 1_700_000_000);
  probe._applyIgnisMetrics(advance(IGNIS_METRICS, { ignis_decoded_tokens_total: 542958 }), 2);
  assert.equal(probe.prefillTps, 0);
  assert.equal(probe.totalPromptTokens ?? null, null);
});

test("_applyIgnisMetrics: a body without the token counter is unmeasured, not zero", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8892);
  probe._applyIgnisMetrics('ignis_build_info{version="0.10.0"} 1\n', 2);
  assert.equal(probe.measurementValid, false);
  assert.equal(probe.measurementError, "metrics had no ignis token counters");
  assert.equal(probe.engineVersion, "0.10.0");
});

test("probe(): an ignis server reports its engine, lanes, queue and live decode", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  try {
    let metrics = IGNIS_METRICS;
    const requested = [];
    const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8892);
    probe._fetch = ignisServerFetch({ metrics: () => metrics, requested });

    const first = await probe.probe();
    assert.equal(first.backend, "ignis");
    assert.equal(first.modelId, "qwen3.8-flash-next");
    assert.equal(first.contextLength, 262144);
    assert.equal(first.engineVersion, "0.10.0");
    assert.equal(first.slotsTotal, 8);
    assert.equal(first.slotsActive, 0);
    assert.equal(first.generationTps, 0); // seeds the baseline

    mock.timers.tick(2000);
    metrics = advance(IGNIS_METRICS, {
      ignis_decoded_tokens_total: 542958,
      'ignis_scheduler_requests{state="running"}': 3,
      'ignis_scheduler_requests{state="waiting"}': 2,
    });
    const second = await probe.probe();
    assert.equal(second.backend, "ignis");
    assert.equal(second.generationTps, 200);
    assert.equal(second.slotsActive, 3);
    assert.equal(second.slotsTotal, 8);
    assert.equal(second.requestsRunning, 3);
    assert.equal(second.requestsWaiting, 2);
    assert.equal(second.totalOutputTokens, 542958);

    // ignis has no /metrics or /slots on the API port: neither is asked for once it is known.
    const afterFirst = requested.slice(requested.lastIndexOf(requested.find((u) => u.endsWith("/ui/metrics"))) + 1);
    assert.equal(afterFirst.some((u) => u.endsWith("/slots")), false);
    assert.equal(afterFirst.some((u) => /[^i]\/metrics$/.test(u)), false);
  } finally {
    mock.timers.reset();
  }
});

test("probe(): a failed /ui/metrics read is unmeasured and the server stays ignis", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  try {
    let metrics = IGNIS_METRICS;
    const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8892);
    probe._fetch = ignisServerFetch({ metrics: () => metrics });
    await probe.probe();
    mock.timers.tick(2000);
    metrics = null; // the Playground (and with it /ui/metrics) is off
    const failed = await probe.probe();
    assert.equal(failed.backend, "ignis");
    assert.equal(failed.generationTps, 0);
    assert.equal(failed.measurementValid, false);
    assert.equal(failed.slotsTotal, 8); // the lanes come from the model card, not the metrics

    // The next good scrape re-seeds; the one after measures.
    mock.timers.tick(2000);
    metrics = advance(IGNIS_METRICS, { ignis_decoded_tokens_total: 542958 });
    assert.equal((await probe.probe()).generationTps, 0);
    mock.timers.tick(2000);
    metrics = advance(IGNIS_METRICS, { ignis_decoded_tokens_total: 543358 });
    assert.equal((await probe.probe()).generationTps, 200);
  } finally {
    mock.timers.reset();
  }
});

test("readServerGenerationTokens: ignis emitted-token counter from /ui/metrics", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/ui/metrics")) return { ok: true, status: 200, text: async () => IGNIS_METRICS };
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  try {
    assert.equal(await readServerGenerationTokens("http://127.0.0.1:8892"), 542558);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("_applyIgnisMetrics: a missing used-pages gauge leaves KV use unmeasured, not 0%", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8892);
  const body = IGNIS_METRICS.split("\n").filter((line) => !line.startsWith("ignis_kv_pool_used_pages")).join("\n");
  probe._applyIgnisMetrics(body, 1_700_000_000);
  assert.equal(probe.kvCacheUsage, null);
  assert.equal(probe.kvCacheMemoryBytes, 91998 * 239616);
});
