/**
 * Unit tests for Splash (incoai/splash MLX engine) detection and metrics.
 */
import { test, mock } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";
import { readServerGenerationTokens } from "../LlmStreaming.js";

function modelsOnlyFetch(ownedBy) {
  return async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "ornith-122b", owned_by: ownedBy }] }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test("_detectServerType: owned_by splash → splash, not the vLLM default", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._fetch = modelsOnlyFetch("splash");
  await probe._detectServerType();
  assert.equal(probe.backendType, "splash");
});

// Real `GET /metrics` lines from a Splash 1.3 lane (Ornith 122B), trimmed to
// the series the probe reads. Counters are lifetime totals; the *_p95_ / acceptance
// series are the engine's own rolling gauges.
const SPLASH_METRICS = `splash_ready 1
splash_requests_submitted_total 2
splash_scheduler_queued 0
splash_scheduler_prefilling 0
splash_scheduler_decoding 0
splash_cache_reused_tokens_total 0
splash_ttft_p95_milliseconds 29944.68192
splash_itl_p95_milliseconds 11.49579167
splash_prefill_input_tokens_total 35120
splash_prefill_wall_milliseconds_total 22982.37621
splash_prefill_tokens_per_second 1528.127452
splash_decode_output_tokens_total 21
splash_decode_tokens_per_second 131.8337417
splash_draft_acceptance_ratio 0.64
`;

function advance(txt, changes) {
  let out = txt;
  for (const [name, value] of Object.entries(changes)) {
    out = out.replace(new RegExp(`^${name} .*$`, "m"), `${name} ${value}`);
  }
  return out;
}

test("_applySplashMetrics: live rates are counter deltas over the interval, idle reads 0", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  // The first sample only seeds the baseline: no earlier poll exists (the probe
  // clock starts at 0, so the interval is enormous) and lifetime totals are not one interval's work.
  probe._applySplashMetrics(SPLASH_METRICS, 1_700_000_000);
  assert.equal(probe.totalOutputTokens, 21);
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.prefillTps, 0);

  probe._applySplashMetrics(
    advance(SPLASH_METRICS, {
      splash_decode_output_tokens_total: 221,
      splash_prefill_input_tokens_total: 35520,
    }),
    2
  );
  assert.equal(probe.generationTps, 100); // (221-21)/2
  assert.equal(probe.prefillTps, 200); // (35520-35120)/2
  assert.equal(probe.totalOutputTokens, 221);

  // Nothing moved since the last sample: the panel returns to 0.
  probe._applySplashMetrics(
    advance(SPLASH_METRICS, {
      splash_decode_output_tokens_total: 221,
      splash_prefill_input_tokens_total: 35520,
    }),
    2
  );
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.prefillTps, 0);
});

test("_applySplashMetrics: prefix-cache hits are the cached share, not computed prefill", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  const seeded = advance(SPLASH_METRICS, { splash_cache_reused_tokens_total: 5000 });
  probe._applySplashMetrics(seeded, 1_700_000_000);
  // The ledger wants the whole prompt: computed 35120 + reused 5000.
  assert.equal(probe.totalPromptTokens, 40120);
  assert.equal(probe.totalCachedTokens, 5000);
  assert.equal(probe.prefixCacheHitRate, 0.1246); // 5000 / 40120

  // 600 more tokens reused, 400 more computed over 2 s.
  probe._applySplashMetrics(
    advance(seeded, {
      splash_cache_reused_tokens_total: 5600,
      splash_prefill_input_tokens_total: 35520,
    }),
    2
  );
  assert.equal(probe.cachedPrefillTps, 300); // 600 / 2
  assert.equal(probe.uncachedPrefillTps, 200); // 400 / 2
  assert.equal(probe.prefillTps, 200);

  // A cache hit alone must not inflate the main prefill tile.
  probe._applySplashMetrics(
    advance(seeded, {
      splash_cache_reused_tokens_total: 9600,
      splash_prefill_input_tokens_total: 35520,
    }),
    2
  );
  assert.equal(probe.prefillTps, 0);
  assert.equal(probe.cachedPrefillTps, 2000); // 4000 / 2
});

test("_applySplashMetrics: scheduler load, latency percentiles and draft acceptance", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  const busy = advance(SPLASH_METRICS, {
    splash_scheduler_prefilling: 1,
    splash_scheduler_decoding: 2,
    splash_scheduler_queued: 3,
  });
  probe._applySplashMetrics(busy, 1_700_000_000);
  assert.equal(probe.requestsRunning, 3); // prefilling 1 + decoding 2
  assert.equal(probe.requestsWaiting, 3);
  assert.equal(probe.ttftP95Seconds, 29.945); // engine reports milliseconds
  assert.equal(probe.itlP95Seconds, 0.011);
  assert.equal(probe.mtpAcceptanceRate, 0.64);
  assert.equal(probe.gpuMemoryUtilization, 1); // splash_ready 1 → engine Active

  probe._applySplashMetrics(SPLASH_METRICS, 2);
  assert.equal(probe.requestsRunning, 0);
  assert.equal(probe.requestsWaiting, 0);
});

function splashServerFetch({ ownedBy, metrics }) {
  return async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "ornith-122b", owned_by: ownedBy, max_model_len: 262144 }],
        }),
      };
    }
    if (u.endsWith("/metrics")) {
      return { ok: true, status: 200, text: async () => metrics() };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
}

test("probe(): a Splash lane reports live prefill and decode instead of the vLLM zeros", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  try {
    let metrics = SPLASH_METRICS;
    const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
    probe._fetch = splashServerFetch({ ownedBy: "splash", metrics: () => metrics });

    const first = await probe.probe();
    assert.equal(first.backend, "splash");
    assert.equal(first.generationTps, 0); // seeds the baseline

    mock.timers.tick(2000);
    metrics = advance(SPLASH_METRICS, {
      splash_decode_output_tokens_total: 221,
      splash_prefill_input_tokens_total: 35520,
    });
    const second = await probe.probe();
    assert.equal(second.backend, "splash");
    assert.equal(second.generationTps, 100);
    assert.equal(second.prefillTps, 200);
    assert.equal(second.modelId, "ornith-122b");
  } finally {
    mock.timers.reset();
  }
});

test("probe(): a lane first labelled vLLM is re-labelled once its /metrics is Splash's", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  try {
    const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
    // No owned_by to go on, so detection falls through to the vLLM default.
    probe._fetch = splashServerFetch({ ownedBy: undefined, metrics: () => SPLASH_METRICS });
    const snap = await probe.probe();
    assert.equal(snap.backend, "splash");
    assert.equal(snap.totalOutputTokens, 21);
  } finally {
    mock.timers.reset();
  }
});

test("_detectServerType: a known Splash lane is not re-probed for llama.cpp /slots", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe.backendType = "splash";
  const requested = [];
  const inner = splashServerFetch({ ownedBy: "splash", metrics: () => SPLASH_METRICS });
  probe._fetch = async (url, ...rest) => {
    requested.push(String(url));
    return inner(url, ...rest);
  };
  await probe._detectServerType();
  assert.equal(probe.backendType, "splash");
  assert.equal(requested.some((u) => u.endsWith("/slots")), false);
});

test("readServerGenerationTokens: Splash decode counter", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/metrics")) {
      return { ok: true, status: 200, text: async () => SPLASH_METRICS };
    }
    return { ok: false, status: 404 };
  };
  try {
    assert.equal(await readServerGenerationTokens("http://127.0.0.1:1245"), 21);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probe(): a failed /metrics scrape is an unmeasured poll, not zero or the previous reading, and recovery does not spike", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  try {
    let metrics = SPLASH_METRICS;
    let status = 200;
    const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
    const inner = splashServerFetch({ ownedBy: "splash", metrics: () => metrics });
    probe._fetch = async (url, ...rest) =>
      status !== 200 && String(url).endsWith("/metrics")
        ? { ok: false, status, text: async () => "", json: async () => ({}) }
        : inner(url, ...rest);

    const first = await probe.probe();
    assert.equal(first.measurementValid, false, "the first scrape has no earlier sample to measure against");
    assert.match(first.measurementError, /earlier sample/);

    mock.timers.tick(2000);
    metrics = advance(SPLASH_METRICS, {
      splash_decode_output_tokens_total: 221,
      splash_prefill_input_tokens_total: 35520,
      splash_scheduler_decoding: 1,
      splash_scheduler_queued: 2,
    });
    const live = await probe.probe();
    assert.equal(live.measurementValid, true);
    assert.equal(live.measurementError, null);
    assert.equal(live.generationTps, 100);
    assert.equal(live.requestsRunning, 1);

    status = 500;
    mock.timers.tick(2000);
    const failed = await probe.probe();
    assert.equal(failed.available, true); // the endpoint is reachable
    assert.equal(failed.measurementValid, false); // its stats are not
    assert.match(failed.measurementError, /500/);
    assert.equal(failed.generationTps, 0);
    assert.equal(failed.prefillTps, 0);
    assert.equal(failed.requestsRunning, null);
    assert.equal(failed.requestsWaiting, null);
    assert.equal(failed.ttftP95Seconds, null);

    // 5000 tokens were decoded while the scrape failed: the first good poll only re-seeds.
    status = 200;
    metrics = advance(SPLASH_METRICS, { splash_decode_output_tokens_total: 5221, splash_prefill_input_tokens_total: 35520 });
    mock.timers.tick(2000);
    const recovered = await probe.probe();
    assert.equal(recovered.measurementValid, false, "the re-seeding poll has no rate to show");
    assert.match(recovered.measurementError, /re-seeding/);
    assert.equal(recovered.generationTps, 0);

    metrics = advance(SPLASH_METRICS, { splash_decode_output_tokens_total: 5421, splash_prefill_input_tokens_total: 35520 });
    mock.timers.tick(2000);
    const next = await probe.probe();
    assert.equal(next.measurementValid, true);
    assert.equal(next.generationTps, 100);
  } finally {
    mock.timers.reset();
  }
});

test("probe(): a scrape without Splash's token counters is an unmeasured poll", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  try {
    let metrics = SPLASH_METRICS;
    const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
    probe._fetch = splashServerFetch({ ownedBy: "splash", metrics: () => metrics });
    await probe.probe();
    mock.timers.tick(2000);
    metrics = advance(SPLASH_METRICS, { splash_decode_output_tokens_total: 221, splash_scheduler_decoding: 1 });
    assert.equal((await probe.probe()).generationTps, 100);

    metrics = "splash_ready 1\n"; // a truncated or foreign body
    mock.timers.tick(2000);
    const snap = await probe.probe();
    assert.equal(snap.available, true);
    assert.equal(snap.measurementValid, false);
    assert.match(snap.measurementError, /counters/);
    assert.equal(snap.generationTps, 0);
    assert.equal(snap.requestsRunning, null);
  } finally {
    mock.timers.reset();
  }
});

test("probe(): a /metrics request that errors out is an unmeasured poll while /v1/models still answers", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  try {
    let broken = false;
    const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
    const inner = splashServerFetch({ ownedBy: "splash", metrics: () => SPLASH_METRICS });
    probe._fetch = async (url, ...rest) => {
      if (broken && String(url).endsWith("/metrics")) throw new Error("socket hang up");
      return inner(url, ...rest);
    };
    await probe.probe();
    broken = true;
    mock.timers.tick(2000);
    const snap = await probe.probe();
    assert.equal(snap.available, true);
    assert.equal(snap.measurementValid, false);
    assert.match(snap.measurementError, /request failed/);
  } finally {
    mock.timers.reset();
  }
});

test("probe(): after the endpoint itself was unreachable, recovery re-seeds instead of reading the outage as one interval", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  try {
    let metrics = SPLASH_METRICS;
    let down = false;
    const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
    const inner = splashServerFetch({ ownedBy: "splash", metrics: () => metrics });
    probe._fetch = async (url, ...rest) => {
      if (down) throw new Error("connect ECONNREFUSED");
      return inner(url, ...rest);
    };
    await probe.probe();
    mock.timers.tick(2000);
    metrics = advance(SPLASH_METRICS, { splash_decode_output_tokens_total: 221, splash_prefill_input_tokens_total: 35520 });
    assert.equal((await probe.probe()).generationTps, 100);

    down = true;
    for (let i = 0; i < 2; i++) {
      mock.timers.tick(2000);
      assert.equal((await probe.probe()).available, false);
    }

    // 5000 tokens were decoded while the endpoint could not be reached: 2500 tok/s if read as one 2 s interval.
    down = false;
    metrics = advance(SPLASH_METRICS, { splash_decode_output_tokens_total: 5221, splash_prefill_input_tokens_total: 35520 });
    mock.timers.tick(2000);
    const recovered = await probe.probe();
    assert.equal(recovered.available, true);
    assert.equal(recovered.generationTps, 0);
    assert.equal(recovered.measurementValid, false);

    metrics = advance(SPLASH_METRICS, { splash_decode_output_tokens_total: 5421, splash_prefill_input_tokens_total: 35520 });
    mock.timers.tick(2000);
    assert.equal((await probe.probe()).generationTps, 100);
  } finally {
    mock.timers.reset();
  }
});

test("_applySplashMetrics: a scrape with counters but no scheduler gauges does not keep the previous running count", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._applySplashMetrics(advance(SPLASH_METRICS, { splash_scheduler_decoding: 1 }), 1_700_000_000);
  assert.equal(probe.requestsRunning, 1);
  const partial = SPLASH_METRICS.replace(/^splash_scheduler_(prefilling|decoding) .*\n/gm, "");
  probe._applySplashMetrics(partial, 2);
  assert.equal(probe.requestsRunning, null);
});

test("_applySplashMetrics: a sample with no usable interval to the last one has no rate and keeps no old one", () => {
  const first = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  first._applySplashMetrics(SPLASH_METRICS, 2); // a short interval, but nothing earlier to measure against
  assert.equal(first.measurementValid, false);
  assert.match(first.measurementError, /earlier sample/);
  assert.equal(first.generationTps, 0, "the lifetime total over 2 s would read as 10.5 tok/s");

  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._applySplashMetrics(SPLASH_METRICS, 1_700_000_000);
  probe._applySplashMetrics(advance(SPLASH_METRICS, { splash_decode_output_tokens_total: 221, splash_prefill_input_tokens_total: 35520 }), 2);
  assert.equal(probe.generationTps, 100);
  assert.equal(probe.measurementValid, true);

  // 12 s since the last poll: the old 100 tok/s must not stay, and 1200 tokens over 12 s is not a 2 s rate.
  probe._applySplashMetrics(advance(SPLASH_METRICS, { splash_decode_output_tokens_total: 1421, splash_prefill_input_tokens_total: 35520 }), 12);
  assert.equal(probe.measurementValid, false);
  assert.match(probe.measurementError, /10 s/);
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.prefillTps, 0);

  probe._applySplashMetrics(advance(SPLASH_METRICS, { splash_decode_output_tokens_total: 1621, splash_prefill_input_tokens_total: 35520 }), 2);
  assert.equal(probe.measurementValid, true);
  assert.equal(probe.generationTps, 100);
  probe._applySplashMetrics(advance(SPLASH_METRICS, { splash_decode_output_tokens_total: 1821, splash_prefill_input_tokens_total: 35520 }), 0);
  assert.equal(probe.measurementValid, false, "an interval of 0 is no interval");
});

test("_applySplashMetrics: counters that went backwards (an engine restart) re-seed instead of reading as an idle poll", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._applySplashMetrics(SPLASH_METRICS, 1_700_000_000);
  probe._applySplashMetrics(advance(SPLASH_METRICS, { splash_decode_output_tokens_total: 221, splash_prefill_input_tokens_total: 35520 }), 2);
  assert.equal(probe.generationTps, 100);

  probe._applySplashMetrics(advance(SPLASH_METRICS, { splash_decode_output_tokens_total: 40, splash_prefill_input_tokens_total: 12 }), 2);
  assert.equal(probe.measurementValid, false);
  assert.match(probe.measurementError, /restarted/);
  assert.equal(probe.generationTps, 0);

  probe._applySplashMetrics(advance(SPLASH_METRICS, { splash_decode_output_tokens_total: 240, splash_prefill_input_tokens_total: 412 }), 2);
  assert.equal(probe.measurementValid, true);
  assert.equal(probe.generationTps, 100);
  assert.equal(probe.prefillTps, 200);
});

test("_applySplashMetrics: a negative counter is not a counter", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._applySplashMetrics(advance(SPLASH_METRICS, { splash_decode_output_tokens_total: -5 }), 1_700_000_000);
  assert.equal(probe.measurementValid, false);
  assert.match(probe.measurementError, /counters/);
});
