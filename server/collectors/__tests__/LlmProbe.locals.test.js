/**
 * Unit tests for Locals (Generated-Computers/Locals, an MLX server on Macs) detection and metrics.
 */
import { test, mock } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";
import { readServerGenerationTokens } from "../LlmStreaming.js";

// Trimmed from a real Locals 0.2.1 `GET /stats` (Qwen3.5-4B, one request decoding).
// tokens_out / prefill_tokens move while a request runs; the other counters move when it finishes.
const STATS = {
  model: "mlx-community/Qwen3.5-4B-MLX-4bit",
  uptime_s: 1089.07,
  requests: 76,
  errors: 19,
  active: [],
  engines: {
    locals: {
      requests: 75,
      prompt_tokens: 1031752,
      cached_tokens: 919017,
      completion_tokens: 33764,
      loaded: true,
      active: 0,
      tokens_out: 34103,
      prefill_tokens: 104889,
      prefill_s: 234.56,
    },
  },
};

function withStats(patch, active) {
  const engine = { ...STATS.engines.locals, ...patch };
  return { ...STATS, active: active ?? STATS.active, engines: { locals: engine } };
}

function localsServerFetch(stats) {
  return async (url) => {
    const u = String(url);
    const json = (payload) => ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) });
    if (u.endsWith("/v1/models")) {
      return json({ data: [{ id: "locals/qwen3.5-4b", owned_by: "locals", max_model_len: 32768 }] });
    }
    // Locals also answers Ollama's /api/tags, which is what made it read as "ollama".
    if (u.endsWith("/api/tags")) return json({ models: [{ name: "qwen3.5-4b:latest" }] });
    if (u.endsWith("/stats")) {
      const s = stats();
      return s == null ? { ok: false, status: 500, json: async () => ({}), text: async () => "" } : json(s);
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
}

test("_detectServerType: owned_by locals is locals even though it answers Ollama's /api/tags", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8030);
  probe._fetch = localsServerFetch(() => STATS);
  await probe._detectServerType();
  assert.equal(probe.backendType, "locals");
});

test("_applyLocalsStats: decode and prefill are counter deltas over the interval, idle reads 0", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8030);
  // The first sample only seeds the baseline: the probe clock starts at 0, so the interval is enormous.
  probe._applyLocalsStats(STATS, 1_700_000_000);
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.prefillTps, 0);
  assert.equal(probe.totalOutputTokens, 34103);

  probe._applyLocalsStats(withStats({ tokens_out: 34303, prefill_tokens: 105289 }), 2);
  assert.equal(probe.generationTps, 100); // (34303-34103)/2
  assert.equal(probe.prefillTps, 200); // (105289-104889)/2
  assert.equal(probe.totalOutputTokens, 34303);

  probe._applyLocalsStats(withStats({ tokens_out: 34303, prefill_tokens: 105289 }), 2);
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.prefillTps, 0);
});

test("_applyLocalsStats: prefix-cache hits are the cached share, not computed prefill", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8030);
  probe._applyLocalsStats(STATS, 1_700_000_000);
  assert.equal(probe.totalPromptTokens, 1031752);
  assert.equal(probe.totalCachedTokens, 919017);
  assert.equal(probe.prefixCacheHitRate, 0.8976); // 919017 / (919017 + 104889) = 0.89756

  probe._applyLocalsStats(withStats({ cached_tokens: 919617, prefill_tokens: 105289 }), 2);
  assert.equal(probe.cachedPrefillTps, 300); // 600 / 2
  assert.equal(probe.uncachedPrefillTps, 200); // 400 / 2

  // A cache hit alone must not inflate the main prefill tile.
  probe._applyLocalsStats(withStats({ cached_tokens: 923617, prefill_tokens: 105289 }), 2);
  assert.equal(probe.prefillTps, 0);
  assert.equal(probe.cachedPrefillTps, 2000);
});

test("_applyLocalsStats: running requests are the active list; the engine has no wait queue", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8030);
  const running = [
    { engine: "locals", prompt_tokens: 9311, tokens: 339, started: 1792685940.3 },
    { engine: "locals", prompt_tokens: 100, tokens: 0, started: 1792685941.3 },
  ];
  probe._applyLocalsStats(withStats({}, running), 1_700_000_000);
  assert.equal(probe.requestsRunning, 2);
  assert.equal(probe.requestsWaiting, null);
  probe._applyLocalsStats(STATS, 2);
  assert.equal(probe.requestsRunning, 0);
});

test("probe(): a Locals lane reports live prefill and decode instead of the Ollama label and zeros", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  try {
    let stats = STATS;
    const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8030);
    probe._fetch = localsServerFetch(() => stats);

    const first = await probe.probe();
    assert.equal(first.backend, "locals");
    assert.equal(first.modelId, "locals/qwen3.5-4b");
    assert.equal(first.generationTps, 0); // seeds the baseline

    mock.timers.tick(2000);
    stats = withStats({ tokens_out: 34303, prefill_tokens: 105289 });
    const second = await probe.probe();
    assert.equal(second.backend, "locals");
    assert.equal(second.generationTps, 100);
    assert.equal(second.prefillTps, 200);
  } finally {
    mock.timers.reset();
  }
});

test("probe(): when /stats stops answering, the last rates do not stay on the panel", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  try {
    let stats = STATS;
    const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8030);
    probe._fetch = localsServerFetch(() => stats);
    await probe.probe();
    mock.timers.tick(2000);
    stats = withStats({ tokens_out: 34303, prefill_tokens: 105289, cached_tokens: 919617 }, [{ engine: "locals" }]);
    assert.equal((await probe.probe()).generationTps, 100);

    stats = null; // /stats answers 500
    mock.timers.tick(2000);
    const snap = await probe.probe();
    assert.equal(snap.generationTps, 0);
    assert.equal(snap.prefillTps, 0);
    assert.equal(snap.cachedPrefillTps, null);
    assert.equal(snap.uncachedPrefillTps, null);
    assert.equal(snap.requestsRunning, null);
  } finally {
    mock.timers.reset();
  }
});

test("_detectServerType: a known Locals lane is not re-probed for llama.cpp /slots", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8030);
  probe.backendType = "locals";
  const requested = [];
  const inner = localsServerFetch(() => STATS);
  probe._fetch = async (url, ...rest) => {
    requested.push(String(url));
    return inner(url, ...rest);
  };
  await probe._detectServerType();
  assert.equal(probe.backendType, "locals");
  assert.equal(requested.some((u) => u.endsWith("/slots")), false);
});

test("readServerGenerationTokens: Locals reads its live decoded-token counter from /stats", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/stats")) {
      return { ok: true, status: 200, json: async () => STATS, text: async () => JSON.stringify(STATS) };
    }
    return { ok: false, status: 404 };
  };
  try {
    assert.equal(await readServerGenerationTokens("http://127.0.0.1:8030"), 34103);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("_applyLocalsStats: the cache hit rate counts only engines that report computed prefill", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8030);
  // The stock mlx engine reports prompt and cached tokens but has no prefill_tokens counter.
  const both = {
    ...STATS,
    engines: {
      locals: { ...STATS.engines.locals, cached_tokens: 900, prefill_tokens: 100 },
      mlx: { loaded: true, prompt_tokens: 5000, cached_tokens: 4000, completion_tokens: 10 },
    },
  };
  probe._applyLocalsStats(both, 1_700_000_000);
  assert.equal(probe.prefixCacheHitRate, 0.9); // 900 / (900 + 100), not (900 + 4000) / (4900 + 100)
});

test("_applyLocalsStats: a prefill that lands in one poll reads at the engine's own prefill speed", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8030);
  probe._applyLocalsStats(STATS, 1_700_000_000);
  // A 9000-token prompt prefilled in 10 s is counted once, when it finishes; the poll interval is 5 s.
  probe._applyLocalsStats(withStats({ prefill_tokens: 104889 + 9000, prefill_s: 234.56 + 10 }), 5);
  assert.equal(probe.prefillTps, 900); // 9000 / 10 s of prefill, not 9000 / 5 s
  assert.equal(probe.uncachedPrefillTps, 900); // the uncached tile agrees with the main one
  // Prompt tokens counted during mixed passes carry no prefill time: fall back to the window average.
  probe._applyLocalsStats(withStats({ prefill_tokens: 104889 + 9000 + 500, prefill_s: 234.56 + 10 }), 5);
  assert.equal(probe.prefillTps, 100); // 500 / 5 s
});

test("probe(): a failed /stats read is an unmeasured poll, not zero throughput, and recovery does not spike", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  try {
    let stats = STATS;
    const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8030);
    probe._fetch = localsServerFetch(() => stats);
    const first = await probe.probe();
    assert.equal(first.measurementValid, false, "the first poll has no earlier sample to measure against");
    assert.match(first.measurementError, /earlier sample/);

    mock.timers.tick(2000);
    stats = withStats({ tokens_out: 34303, prefill_tokens: 105289 }, [{ engine: "locals" }]);
    const healthy = await probe.probe();
    assert.equal(healthy.measurementValid, true);
    assert.equal(healthy.measurementError, null);
    assert.equal(healthy.generationTps, 100);

    stats = null; // /stats answers 500 while /v1/models still answers
    mock.timers.tick(2000);
    const failed = await probe.probe();
    assert.equal(failed.available, true); // the endpoint is reachable
    assert.equal(failed.measurementValid, false); // its stats are not
    assert.match(failed.measurementError, /500/);
    assert.equal(failed.generationTps, 0);
    assert.equal(failed.prefillTps, 0);
    assert.equal(failed.requestsRunning, null);
    assert.equal(failed.prefixCacheHitRate, null);

    // 5000 tokens were generated while the stats were unreadable. The first good poll after it only
    // re-seeds the counters: reading the whole outage as one interval would show 2500 tok/s.
    stats = withStats({ tokens_out: 39303, prefill_tokens: 105289 });
    mock.timers.tick(2000);
    const recovered = await probe.probe();
    assert.equal(recovered.measurementValid, false, "the re-seeding poll has no rate to show");
    assert.match(recovered.measurementError, /re-seeding/);
    assert.equal(recovered.generationTps, 0);

    stats = withStats({ tokens_out: 39503, prefill_tokens: 105289 });
    mock.timers.tick(2000);
    const next = await probe.probe();
    assert.equal(next.measurementValid, true);
    assert.equal(next.generationTps, 100);
  } finally {
    mock.timers.reset();
  }
});

test("probe(): a /stats body without token counters is an unmeasured poll", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  try {
    const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8030);
    probe._fetch = localsServerFetch(() => ({ model: "m", engines: {} }));
    const snap = await probe.probe();
    assert.equal(snap.available, true);
    assert.equal(snap.measurementValid, false);
    assert.match(snap.measurementError, /counters/);
  } finally {
    mock.timers.reset();
  }
});

test("probe(): after the endpoint itself was unreachable, recovery re-seeds instead of reading the outage as one interval", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  try {
    let stats = STATS;
    let down = false;
    const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8030);
    const inner = localsServerFetch(() => stats);
    probe._fetch = async (url, ...rest) => {
      if (down) throw new Error("connect ECONNREFUSED");
      return inner(url, ...rest);
    };
    await probe.probe();
    mock.timers.tick(2000);
    stats = withStats({ tokens_out: 34303, prefill_tokens: 105289 });
    assert.equal((await probe.probe()).generationTps, 100);

    down = true;
    for (let i = 0; i < 2; i++) {
      mock.timers.tick(2000);
      assert.equal((await probe.probe()).available, false);
    }

    // 5000 tokens were generated while the endpoint could not be reached: 2500 tok/s if read as one 2 s interval.
    down = false;
    stats = withStats({ tokens_out: 39303, prefill_tokens: 105289 });
    mock.timers.tick(2000);
    const recovered = await probe.probe();
    assert.equal(recovered.available, true);
    assert.equal(recovered.generationTps, 0);
    assert.equal(recovered.measurementValid, false);

    stats = withStats({ tokens_out: 39503, prefill_tokens: 105289 });
    mock.timers.tick(2000);
    assert.equal((await probe.probe()).generationTps, 100);
  } finally {
    mock.timers.reset();
  }
});

// Sample sequences for _applyLocalsStats: the first call has no earlier sample, later ones are 2 s apart.
const FIRST = 1_700_000_000;
function seeded(probe, stats = STATS) {
  probe._applyLocalsStats(stats, FIRST);
  return probe;
}
const engine = (patch) => ({ ...STATS.engines.locals, ...patch });
const stats = (engines, active = []) => ({ ...STATS, active, engines });

test("_applyLocalsStats: a counter that is not a non-negative number is not a counter", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8030);
  // null, "" and false all become 0 under Number(); a string or a negative is not a count either.
  probe._applyLocalsStats(stats({ locals: engine({ tokens_out: null, completion_tokens: 500, prefill_tokens: "12", cached_tokens: -5 }) }), FIRST);
  assert.equal(probe.totalOutputTokens, 500, "null tokens_out falls back to completion_tokens, not 0");
  assert.equal(probe.cachedPrefillTps, null, "no usable prefill counter: no split, not a 0/0 split");
  assert.equal(probe.totalCachedTokens, null, "a negative cached_tokens is dropped");

  const none = new LlmProbe({ lanIp: "127.0.0.1" }, 8030);
  none._applyLocalsStats(stats({ locals: engine({ tokens_out: "7", completion_tokens: false }) }), FIRST);
  assert.equal(none.measurementValid, false);
  assert.match(none.measurementError, /counters/);
});

test("_applyLocalsStats: each engine contributes its own decode counter, and a change in which engines report re-seeds", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8030);
  const mlx = (out) => ({ loaded: true, completion_tokens: out, prompt_tokens: 50, cached_tokens: 0 });
  seeded(probe, stats({ locals: engine({ tokens_out: 1000 }), mlx: mlx(500) }));
  assert.equal(probe.totalOutputTokens, 1500, "locals' tokens_out plus mlx's completion_tokens");

  probe._applyLocalsStats(stats({ locals: engine({ tokens_out: 1200 }), mlx: mlx(700) }), 2);
  assert.equal(probe.measurementValid, true);
  assert.equal(probe.generationTps, 200); // (200 + 200) / 2

  // mlx stops reporting: 700 tokens vanish from the sum. That is a change of engines, not negative throughput.
  probe._applyLocalsStats(stats({ locals: engine({ tokens_out: 1400 }) }), 2);
  assert.equal(probe.measurementValid, false);
  assert.match(probe.measurementError, /engines/);
  assert.equal(probe.generationTps, 0);

  probe._applyLocalsStats(stats({ locals: engine({ tokens_out: 1600 }) }), 2);
  assert.equal(probe.measurementValid, true);
  assert.equal(probe.generationTps, 100);
});

test("_applyLocalsStats: a sample with no usable interval to the last one has no rate and keeps no old one", () => {
  const first = new LlmProbe({ lanIp: "127.0.0.1" }, 8030);
  first._applyLocalsStats(STATS, 2); // a short interval but nothing earlier to measure against: must not throw or invent a rate
  assert.equal(first.measurementValid, false);
  assert.equal(first.generationTps, 0);

  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8030);
  seeded(probe);
  assert.equal(probe.measurementValid, false, "the first sample has nothing to measure against");
  assert.match(probe.measurementError, /earlier sample/);

  probe._applyLocalsStats(withStats({ tokens_out: 34303, prefill_tokens: 105289 }), 2);
  assert.equal(probe.generationTps, 100);
  assert.equal(probe.prefillTps, 200);

  // 12 s since the last poll: the old 100 tok/s must not stay on the panel, and 1200 tokens over 12 s is not a 2 s rate.
  probe._applyLocalsStats(withStats({ tokens_out: 35503, prefill_tokens: 105289 }), 12);
  assert.equal(probe.measurementValid, false);
  assert.match(probe.measurementError, /10 s/);
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.prefillTps, 0);

  probe._applyLocalsStats(withStats({ tokens_out: 35703, prefill_tokens: 105289 }), 2);
  assert.equal(probe.measurementValid, true);
  assert.equal(probe.generationTps, 100);
  // a clock that went backwards or stood still is no interval either
  probe._applyLocalsStats(withStats({ tokens_out: 35903, prefill_tokens: 105289 }), 0);
  assert.equal(probe.measurementValid, false);
});

test("_applyLocalsStats: counters that went backwards (an engine restart) re-seed instead of reading as an idle poll", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8030);
  seeded(probe);
  probe._applyLocalsStats(withStats({ tokens_out: 34303, prefill_tokens: 105289 }), 2);
  assert.equal(probe.generationTps, 100);

  probe._applyLocalsStats(withStats({ tokens_out: 40, prefill_tokens: 12 }), 2); // serve() restarted: counters begin at 0
  assert.equal(probe.measurementValid, false);
  assert.match(probe.measurementError, /restarted/);
  assert.equal(probe.generationTps, 0);

  probe._applyLocalsStats(withStats({ tokens_out: 240, prefill_tokens: 412 }), 2);
  assert.equal(probe.measurementValid, true);
  assert.equal(probe.generationTps, 100);
  assert.equal(probe.prefillTps, 200);
});
