/**
 * CacheHistory: exactly-once counter deltas, epoch/reset/gap handling, weighted reuse,
 * histogram-derived quantiles, bounded retention and the sidecar round trip.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CacheHistory, quantileFromCounts } from "../CacheHistory.js";

const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);

function endpoint(overrides = {}) {
  const pool = {
    capacityPositions: 8_388_608,
    activeReservedPositions: 1_048_576,
    retainedPrefixPositions: 2_097_152,
    retainedGrowthPositions: 524_288,
    unclaimedPositions: 4_718_592,
    validStates: 7,
    invalidationsTotal: 3,
    placementBlocksTotal: 11,
  };
  const promptState = {
    enabled: true,
    budgetBytes: 536_870_912,
    heldBytes: 268_435_456,
    spareBytes: 268_435_456,
    entries: 7,
    hitsTotal: 120,
    missesTotal: 30,
    evictionsTotal: 4,
    refusalsTotal: 1,
    failuresTotal: 3,
    failuresKeepTotal: 1,
    failuresRestoreTotal: 1,
    failuresPeerForgetTotal: 1,
  };
  const hist = (total) => ({
    edges: [1, 5, Infinity],
    counts: [0, Math.round(total * 0.4), total],
  });
  return {
    port: 8888,
    available: true,
    measurementValid: true,
    requestsRunning: 2,
    requestsWaiting: 0,
    totalPromptTokens: 10_000,
    totalCachedTokens: 9_000,
    cache: {
      status: "full",
      source: "health",
      schemaVersion: 1,
      engineEpoch: "1000",
      observedAt: T0,
      contextLimitPositions: 1_048_576,
      streamCapacity: 16,
      pool: { ...pool },
      promptState: { ...promptState },
      missing: [],
      ...(overrides.cache ?? {}),
    },
    cacheHistograms: { ttft: hist(10), latency: hist(10) },
    ...overrides.entry,
  };
}

function snapshot(entry, id = "spark-1") {
  return { id, llmPorts: [8888], metrics: { llm: [entry] } };
}

function store() {
  return new CacheHistory({ file: null, now: () => T0 });
}

/** Advance the endpoint's cumulative counters by `add` and its observation stamp by `ms`. */
function advance(entry, { add = {}, obsMs = 60_000, ...rest } = {}) {
  const next = endpoint(rest);
  next.cache.observedAt = entry.cache.observedAt + obsMs;
  next.totalPromptTokens = entry.totalPromptTokens + (add.prompt ?? 0);
  next.totalCachedTokens = entry.totalCachedTokens + (add.cached ?? 0);
  next.cache.pool.invalidationsTotal = entry.cache.pool.invalidationsTotal + (add.invalidations ?? 0);
  next.cache.promptState.hitsTotal = entry.cache.promptState.hitsTotal + (add.hits ?? 0);
  const bumpHist = (hist, by) => ({
    ...hist,
    // Put the added observations above the largest finite edge: only +Inf grows.
    counts: hist.counts.map((c, i) => c + (i === hist.counts.length - 1 ? by : 0)),
  });
  next.cacheHistograms = {
    ttft: bumpHist(entry.cacheHistograms.ttft, add.completions ?? 0),
    latency: bumpHist(entry.cacheHistograms.latency, add.completions ?? 0),
  };
  return next;
}

test("quantileFromCounts interpolates within a finite bucket and marks the +Inf bucket open", () => {
  const q = quantileFromCounts([1000, 10, 10], [1, 5, Infinity], 0.95);
  assert.ok(q);
  assert.equal(q.exact, false);
  assert.ok(q.value > 0.9 && q.value <= 1, `in the (0,1] bucket: ${JSON.stringify(q)}`);
  const open = quantileFromCounts([0, 40, 100], [1, 5, Infinity], 0.95);
  assert.equal(open.value, null);
  assert.equal(open.open, true);
  assert.equal(open.lowerBound, 5);
  assert.equal(quantileFromCounts([0, 0, 0], [1, 5, Infinity]), null);
});

test("history quantiles convert cumulative bucket deltas before interpolation", () => {
  const s = store();
  const first = endpoint();
  const edges = [0.1, 1, 2.5, 5, 300, Infinity];
  first.cacheHistograms = {
    ttft: { edges, counts: [0, 0, 0, 0, 0, 0] },
    latency: { edges, counts: [0, 0, 0, 0, 0, 0] },
  };
  s.record(snapshot(first), T0);
  const next = structuredClone(first);
  next.cache.observedAt += 60_000;
  next.cacheHistograms.ttft.counts = [0, 5, 10, 10, 10, 10];
  next.cacheHistograms.latency.counts = [0, 5, 10, 10, 10, 10];
  s.record(snapshot(next), T0 + 60_000);
  const last = s.query("spark-1", "1h", T0 + 120_000).endpoints[0].points.at(-1);
  assert.equal(last.ttftP95.value, 2.35);
  assert.equal(last.latencyP95.value, 2.35);
});

test("one observation is consumed once; a repeat adds nothing", () => {
  const s = store();
  const first = endpoint();
  s.record(snapshot(first), T0);
  const second = advance(first, { add: { prompt: 500, cached: 400 } });
  s.record(snapshot(second), T0 + 60_000);
  s.record(snapshot(second), T0 + 62_000); // same engine observation, second tick
  const out = s.query("spark-1", "1h", T0 + 120_000);
  const points = out.endpoints[0].points;
  assert.equal(points.length, 2);
  // 400 of 500 prompt tokens reused in the second minute; the repeat did not double it.
  assert.equal(points[1].reusePct, 80);
  assert.equal(points[1].promptTokens, 500);
  assert.equal(points[1].cachedTokens, 400);
});

test("a new engine epoch rebaselines instead of subtracting a restarted counter", () => {
  const s = store();
  const first = endpoint();
  s.record(snapshot(first), T0);
  const restart = advance(first, { add: { prompt: 500, cached: 400 }, obsMs: 60_000 });
  restart.cache.engineEpoch = "2000";
  restart.totalPromptTokens = 50; // restarted counters
  restart.totalCachedTokens = 5;
  s.record(snapshot(restart), T0 + 60_000);
  const out = s.query("spark-1", "1h", T0 + 120_000);
  assert.ok(out.events.some((e) => e.kind === "engine_restart"));
  const last = out.endpoints[0].points.at(-1);
  // The new epoch's first observation seeds the baseline: no pre-restart counter is subtracted,
  // and no reuse share is claimed for tokens whose prompt window spans the restart.
  assert.equal(last.reusePct, undefined);
  assert.equal(last.pool.capacity, 8_388_608);
});

test("observation identity includes epoch even when the source timestamp repeats", () => {
  const s = store();
  const a = endpoint();
  s.record(snapshot(a), T0);
  const b = structuredClone(a);
  b.cache.engineEpoch = "new-epoch";
  s.record(snapshot(b), T0 + 1000);
  const out = s.query("spark-1", "1h", T0 + 2000);
  assert.equal(out.endpoints[0].engineEpoch, "new-epoch");
  assert.ok(out.events.some((e) => e.kind === "engine_restart"));
});

test("counters that go backwards on the same epoch are a reset, not negative churn", () => {
  const s = store();
  const first = endpoint();
  s.record(snapshot(first), T0);
  const back = advance(first, { obsMs: 60_000 });
  back.cache.pool.invalidationsTotal = 1; // was 3
  s.record(snapshot(back), T0 + 60_000);
  const out = s.query("spark-1", "1h", T0 + 120_000);
  assert.ok(out.events.some((e) => e.kind === "counter_reset"));
  const churn = out.endpoints[0].points.at(-1).churn ?? {};
  assert.ok((churn.invalidations ?? 0) >= 0);
});

test("pool categories stay disjoint and a missed minute stays a gap", () => {
  const s = store();
  s.record(snapshot(endpoint()), T0);
  s.record(snapshot(advance(endpoint(), { obsMs: 120_000 })), T0 + 120_000);
  const out = s.query("spark-1", "1h", T0 + 180_000);
  const points = out.endpoints[0].points;
  assert.equal(points.length, 2); // the minute at +60 s has no observation
  assert.equal(points[0].pool.capacity, 8_388_608);
  const sum =
    points[0].pool.active + points[0].pool.prefix + points[0].pool.growth + points[0].pool.unclaimed;
  assert.equal(sum, points[0].pool.capacity);
  assert.equal(points[0].poolPrefix, undefined);
});

test("a disabled or absent cache group records an event and no fabricated point", () => {
  const s = store();
  s.record(snapshot({ ...endpoint(), cache: { status: "unavailable", source: "health", reason: "no cache group" } }), T0);
  const out = s.query("spark-1", "1h", T0 + 60_000);
  assert.equal(out.endpoints.length, 0);
  assert.equal(out.events[0].kind, "telemetry_lost");
  assert.equal(out.events.filter((e) => e.kind === "telemetry_lost").length, 1);
});

test("window p95 comes from summed histogram deltas, with a completion count", () => {
  const s = store();
  const first = endpoint();
  s.record(snapshot(first), T0);
  s.record(snapshot(advance(first, { add: { completions: 4 }, obsMs: 60_000 })), T0 + 60_000);
  s.record(
    snapshot(advance(advance(first, { add: { completions: 4 }, obsMs: 60_000 }), { add: { completions: 6 }, obsMs: 60_000 })),
    T0 + 120_000
  );
  const out = s.query("spark-1", "1h", T0 + 180_000);
  const last = out.endpoints[0].points.at(-1);
  assert.equal(last.completions, 6);
  // The fixture's p95 lands in the +Inf bucket, so the figure is reported as open, not clamped.
  assert.ok(last.ttftP95, "a p95 entry exists");
  assert.equal(last.ttftP95.value, null);
  assert.equal(last.ttftP95.open, true);
});

test("a JSON-round-tripped infinite edge preserves the first histogram delta, not a false change", () => {
  const dir = mkdtempSync(join(tmpdir(), "cachehistory-edge-"));
  let b;
  try {
    const file = join(dir, "cache-history.json");
    const first = endpoint();
    const a = new CacheHistory({ file, now: () => T0 });
    a.record(snapshot(first), T0);
    assert.equal(a.save(), true);
    b = new CacheHistory({ file, now: () => T0 + 120_000 });
    b.start();
    const next = advance(first, { add: { completions: 4 } });
    b.record(snapshot(next), T0 + 60_000);
    const out = b.query("spark-1", "1h", T0 + 120_000);
    assert.ok(out.endpoints[0].points.at(-1).ttftP95);
    assert.ok(!out.events.some((e) => e.kind === "histogram_edges_changed"));
    const changed = advance(next, { add: { completions: 1 } });
    changed.cacheHistograms.ttft.edges = [1, 6, Infinity];
    b.record(snapshot(changed), T0 + 120_000);
    assert.ok(b.query("spark-1", "1h", T0 + 180_000).events.some((e) => e.kind === "histogram_edges_changed"));
  } finally {
    b?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the sidecar round-trips through JSON and stays bounded", () => {
  const dir = mkdtempSync(join(tmpdir(), "cachehistory-"));
  try {
    const file = join(dir, "cache-history.json");
    const a = new CacheHistory({ file, now: () => T0 });
    a.record(snapshot(endpoint()), T0);
    a.record(snapshot(advance(endpoint(), { obsMs: 60_000 })), T0 + 60_000);
    assert.equal(a.save(), true);
    const b = new CacheHistory({ file, now: () => T0 + 120_000 });
    b.start();
    const out = b.query("spark-1", "1h", T0 + 120_000);
    b.stop();
    assert.equal(out.endpoints[0].points.length, 2);
    assert.equal(out.endpoints[0].engineEpoch, "1000");
    assert.equal(out.endpoints[0].firstAvailableAt, T0);
    assert.equal(out.endpoints[0].points[1].coveredMs, 60_000);
    assert.ok(out.endpoints[0].points[0].pool.capacity > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("coverage measures observed intervals, never a collection outage", () => {
  const s = store();
  const a = endpoint();
  const b = advance(a, { add: { prompt: 100, cached: 80 }, obsMs: 10_000 });
  s.record(snapshot(a), T0);
  s.record(snapshot(b), T0 + 10_000);
  const c = advance(b, { add: { prompt: 10_000, cached: 9_000 }, obsMs: 600_000 });
  s.record(snapshot(c), T0 + 610_000);
  const out = s.query("spark-1", "1h", T0 + 620_000);
  assert.equal(out.endpoints[0].points[0].coveredMs, 10_000);
  assert.equal(out.endpoints[0].points.at(-1).promptTokens, undefined);
  assert.equal(out.endpoints[0].points.at(-1).coveredMs, 0);
  assert.ok(out.events.some((e) => e.kind === "collection_gap"));
});

test("unavailable telemetry and same-epoch counter resets rebaseline all deltas", () => {
  const s = store();
  const a = endpoint();
  s.record(snapshot(a), T0);
  s.record(snapshot({ ...a, available: false }), T0 + 10_000);
  const b = advance(a, { add: { prompt: 1000, cached: 900 } });
  s.record(snapshot(b), T0 + 60_000);
  assert.equal(s.query("spark-1", "1h", T0 + 61_000).endpoints[0].points.at(-1).promptTokens, undefined);
  const c = advance(b, { add: { prompt: 100, cached: 80 } });
  c.cache.pool.invalidationsTotal = 0;
  s.record(snapshot(c), T0 + 120_000);
  const last = s.query("spark-1", "1h", T0 + 121_000).endpoints[0].points.at(-1);
  assert.equal(last.churn, undefined);
  assert.equal(last.reusePct, undefined);
});

test("invalid delta reuse is a gap, not a clamped healthy percentage", () => {
  const s = store();
  const a = endpoint();
  s.record(snapshot(a), T0);
  s.record(snapshot(advance(a, { add: { prompt: 10, cached: 100 } })), T0 + 60_000);
  const out = s.query("spark-1", "1h", T0 + 61_000);
  assert.equal(out.endpoints[0].points.at(-1).reusePct, undefined);
  assert.ok(out.events.some((e) => e.kind === "telemetry_invalid"));
});

test("pressure events coalesce and preserve numeric sums and zero completions", () => {
  const s = store();
  const a = endpoint();
  s.record(snapshot(a), T0);
  for (let i = 1; i <= 3; i++) {
    const b = advance(a, { obsMs: i * 10_000 });
    b.cache.promptState.evictionsTotal += i;
    s.record(snapshot(b), T0 + i * 10_000);
  }
  const out = s.query("spark-1", "1h", T0 + 40_000);
  const events = out.events.filter((e) => e.kind === "cache_pressure");
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.evictions, 3);
  assert.equal(out.endpoints[0].points[0].completions, 0);
  assert.deepEqual(out.endpoints[0].points[0].histogramSamples, { ttft: 0, latency: 0 });
});

test("counts above 2^32 stay exact, including after coarse rollup", () => {
  const s = store();
  const a = endpoint();
  s.record(snapshot(a), T0);
  const add = 2 ** 32 + 17;
  s.record(snapshot(advance(a, { add: { prompt: add, cached: add - 1 } })), T0 + 60_000);
  const p = s.query("spark-1", "7d", T0 + 120_000).endpoints[0].points.at(-1);
  assert.equal(p.promptTokens, add);
  assert.equal(p.cachedTokens, add - 1);
  assert.equal(p.coveredMs, 60_000);
});

test("legacy duration coverage remains unknown rather than inferred from sample count", () => {
  const a = store();
  a.record(snapshot(endpoint()), T0);
  const raw = a._serialize();
  for (const state of Object.values(raw.units["spark-1"].ports)) {
    delete state.firstAvailableAt;
    for (const tier of state.tiers) for (const bucket of tier) delete bucket.coveredMs;
  }
  const b = store();
  b._deserialize(raw);
  const out = b.query("spark-1", "1h", T0 + 60_000).endpoints[0];
  assert.equal(out.points[0].coveredMs, undefined);
  assert.equal(out.points[0].coveragePartial, true);
  assert.equal(out.firstAvailableAt, T0);
});

test("telemetry-only events dirty persistence and repeated gaps coalesce", () => {
  const s = store();
  s.record(snapshot(endpoint()), T0);
  s._dirty = false;
  const lost = { ...endpoint(), available: false };
  s.record(snapshot(lost), T0 + 10_000);
  assert.equal(s._dirty, true);
  s.record(snapshot(lost), T0 + 20_000);
  assert.equal(s.query("spark-1", "1h", T0 + 30_000).events.filter((e) => e.kind === "telemetry_lost").length, 1);
});

test("event persistence stores classifications, not free-form endpoint errors", () => {
  const s = store();
  s.record(snapshot({ ...endpoint(), available: false, measurementError: "private prompt or raw log" }), T0);
  s.record(snapshot({ ...endpoint(), cache: { status: "invalid", reason: "private prompt or raw log" } }), T0 + 1000);
  assert.ok(!JSON.stringify(s._serialize()).includes("private prompt or raw log"));
});

test("long ranges read the 15-minute tier and prune units that are gone", () => {
  const s = store();
  s.record(snapshot(endpoint()), T0);
  s.record(snapshot(advance(endpoint(), { obsMs: 30 * 60_000 })), T0 + 30 * 60_000);
  const week = s.query("spark-1", "7d", T0 + 31 * 60_000);
  assert.equal(week.stepMs, 30 * 60_000);
  assert.ok(week.endpoints[0].points.length >= 1);
  assert.equal(s.stats().units, 1);
  s.prune(new Set(["other"]));
  assert.equal(s.stats().units, 0);
});

test("histograms above 64 buckets are refused, recorded as invalid, and never stored", () => {
  const s = store();
  const big = (n) => ({
    edges: Array.from({ length: n }, (_, i) => (i === n - 1 ? Infinity : i + 1)),
    counts: Array.from({ length: n }, () => 0),
  });
  const first = endpoint();
  first.cacheHistograms = { ttft: big(200), latency: big(200) };
  s.record(snapshot(first), T0);
  const next = structuredClone(first);
  next.cache.observedAt += 60_000;
  next.cacheHistograms.ttft.counts[199] = 10;
  next.cacheHistograms.latency.counts[199] = 10;
  s.record(snapshot(next), T0 + 60_000);
  const out = s.query("spark-1", "1h", T0 + 120_000);
  assert.ok(
    out.events.some((e) => e.kind === "telemetry_invalid" && e.detail?.reason === "histogram_arity"),
    "the over-arity histogram is recorded as invalid telemetry"
  );
  const last = out.endpoints[0].points.at(-1);
  assert.equal(last.ttftP95, undefined, "no p95 is invented from a refused histogram");
  assert.equal(last.latencyP95, undefined);
});

test("histograms with mismatched counts and edges are refused instead of producing NaN quantiles", () => {
  const s = store();
  const first = endpoint();
  first.cacheHistograms = {
    ttft: { edges: [1, 5, Infinity], counts: [0, 1, 2, 3] },
    latency: { edges: [1, 5, Infinity], counts: [0, 1, 2, 3] },
  };
  s.record(snapshot(first), T0);
  const next = structuredClone(first);
  next.cache.observedAt += 60_000;
  next.cacheHistograms.ttft.counts = [0, 1, 2, 9];
  next.cacheHistograms.latency.counts = [0, 1, 2, 9];
  s.record(snapshot(next), T0 + 60_000);
  const out = s.query("spark-1", "1h", T0 + 120_000);
  const last = out.endpoints[0].points.at(-1);
  assert.equal(last.ttftP95, undefined);
  assert.equal(last.latencyP95, undefined);
});

test("a pathological engine epoch is clamped at ingest", () => {
  const s = store();
  const entry = endpoint({ cache: { engineEpoch: "9".repeat(10_000) } });
  s.record(snapshot(entry), T0);
  const out = s.query("spark-1", "1h", T0 + 60_000);
  assert.equal(out.endpoints[0].engineEpoch.length, 128);
});
