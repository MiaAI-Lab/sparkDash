import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MetricsHistory,
  BUCKET_TIERS,
  HISTORY_RANGES,
  RAW_RETENTION_MS,
  coarsen,
  extractSample,
  llmKey,
  mergeStat,
  memoryReading,
  networkRates,
} from "../MetricsHistory.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// A fixed, bucket-aligned epoch so every expectation is exact.
const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-history-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "metrics-history.json");
}

function store(opts = {}) {
  let clock = opts.at ?? T0;
  const s = new MetricsHistory({ logWarn: () => {}, ...opts, now: () => clock });
  s.setNow = (v) => {
    clock = v;
  };
  return s;
}

function rec(s, at, values, { id = "a", llmPorts } = {}) {
  s.setNow(at);
  s.record([{ id, values, llmPorts }], at);
}

// ─── Extraction ───────────────────────────────────────────

function gb10Snapshot(overrides = {}) {
  return {
    id: "spark-1",
    kind: "spark",
    online: true,
    llmPorts: [8888],
    metrics: {
      gpu: {
        temperature: 51,
        usage: 87,
        power: { draw: 62.5, limit: 100 },
        vram: { used: 98_000, total: 124_610, percentage: 78, available: 9_000 },
      },
      cpu: { usage: 12.5, temperature: 48, draw: 10, tdp: 65 },
      ram: { used: 20_000, total: 124_610, percentage: 16 },
      unifiedMemory: { total: 124_610, gpuUsed: 98_000, cpuUsed: 16_000, available: 7_400 },
      network: {
        primaryInterface: "enP7s7",
        interfaces: [
          { name: "enP7s7", rxSpeed: 1_000, txSpeed: 2_000, ip: null, operstate: "up" },
          { name: "wlan0", rxSpeed: 50, txSpeed: 60, ip: null, operstate: "up" },
        ],
      },
      llm: [
        { available: true, generationTps: 41.2, prefillTps: 1_800, kvCacheUsage: 0.05 },
      ],
    },
    ...overrides,
  };
}

test("extractSample reads every series from a GB10 snapshot", () => {
  const v = extractSample(gb10Snapshot());
  assert.deepEqual(v, {
    gpuUtil: 87,
    gpuTemp: 51,
    gpuPower: 62.5,
    memUsedMB: 114_000,
    memFreeMB: 7_400,
    cpuUtil: 12.5,
    cpuTemp: 48,
    netRx: 1_000,
    netTx: 2_000,
    [llmKey(8888, "genTps")]: 41.2,
    [llmKey(8888, "prefillTps")]: 1_800,
    [llmKey(8888, "kvUsage")]: 0.05,
  });
});

test("an offline unit is a gap, not zeros", () => {
  assert.equal(extractSample(gb10Snapshot({ online: false })), null);
});

test("failed or stale domains are skipped, never recorded as zero", () => {
  const snap = gb10Snapshot();
  snap.metrics.gpu = { temperature: 0, usage: 0, power: { draw: 0, limit: 0 }, vram: { used: 0, total: 0 } };
  snap.metrics.cpu = { usage: 9, temperature: 0, draw: 5, tdp: 65 };
  snap.metrics.llm = [{ available: false, generationTps: 0, prefillTps: 0 }];
  const v = extractSample(snap, (domain) => domain !== "network");
  assert.equal(v.gpuUtil, undefined);
  assert.equal(v.gpuTemp, undefined);
  assert.equal(v.cpuUtil, 9);
  assert.equal(v.cpuTemp, undefined, "0 °C means no sensor");
  assert.equal(v.netRx, undefined, "stale domain");
  assert.equal(v[llmKey(8888, "genTps")], undefined, "endpoint down");
  assert.equal(v.memFreeMB, 7_400, "the unified pool is its own domain");
});

test("memory headroom follows the VRAM breakdown semantics", () => {
  // Discrete card: free = total − used, ignoring the host's `available` (system RAM).
  assert.deepEqual(
    memoryReading({
      kind: "host",
      metrics: { gpu: { temperature: 40, usage: 1, power: { draw: 30 }, vram: { used: 90_000, total: 97_887, available: 500_000 } } },
    }),
    { usedMB: 90_000, freeMB: 7_887 }
  );
  // GB10 without unifiedMemory falls back to the GPU's view.
  assert.deepEqual(
    memoryReading({
      kind: "spark",
      metrics: { gpu: { temperature: 40, usage: 1, power: { draw: 30 }, vram: { used: 10, total: 100, available: 70 } } },
    }),
    { usedMB: 10, freeMB: 70 }
  );
});

test("network uses the primary interface, else the sum of shown interfaces", () => {
  assert.deepEqual(
    networkRates({
      primaryInterface: null,
      interfaces: [
        { name: "a", rxSpeed: 1, txSpeed: 2 },
        { name: "b", rxSpeed: 10, txSpeed: 20 },
        { name: "c", rxSpeed: 100, txSpeed: 200, disabled: true },
        { name: "lo", rxSpeed: 1_000, txSpeed: 1_000 },
      ],
    }),
    { rx: 11, tx: 22 }
  );
  assert.equal(networkRates({ interfaces: [] }), null);
});

// ─── Bucket math ──────────────────────────────────────────

test("1-minute buckets keep avg, max, min (headroom only) and count", () => {
  const s = store();
  rec(s, T0 + 1_000, { gpuUtil: 10, memFreeMB: 9_000 });
  rec(s, T0 + 21_000, { gpuUtil: 40, memFreeMB: 3_000 });
  rec(s, T0 + 41_000, { gpuUtil: 70, memFreeMB: 6_000 });
  rec(s, T0 + MINUTE + 1_000, { gpuUtil: 100 });
  const res = s.query("a", "6h", T0 + MINUTE + 2_000);
  assert.equal(res.stepMs, MINUTE);
  assert.deepEqual(res.points[0], {
    t: T0,
    gpuUtil: { avg: 40, max: 70 },
    memFreeMB: { avg: 6_000, max: 9_000, min: 3_000 },
  });
  // The still-open minute is included.
  assert.deepEqual(res.points[1], { t: T0 + MINUTE, gpuUtil: { avg: 100, max: 100 } });
});

test("rollup merges are weighted by sample count", () => {
  const merged = coarsen(
    [
      { t: 0, stats: new Map([["gpuUtil", { sum: 30, max: 20, min: 10, n: 2 }]]) },
      { t: MINUTE, stats: new Map([["gpuUtil", { sum: 60, max: 60, min: 60, n: 1 }]]) },
      { t: 3 * MINUTE, stats: new Map([["gpuUtil", { sum: 5, max: 5, min: 5, n: 1 }]]) },
    ],
    3 * MINUTE
  );
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].stats.get("gpuUtil"), { sum: 90, max: 60, min: 10, n: 3 });
  assert.equal(merged[0].stats.get("gpuUtil").sum / merged[0].stats.get("gpuUtil").n, 30);
  assert.deepEqual(mergeStat(undefined, { sum: 1, max: 1, min: 1, n: 1 }), { sum: 1, max: 1, min: 1, n: 1 });
});

test("15-minute buckets are fed from the same samples", () => {
  const s = store();
  for (let i = 0; i < 30; i++) rec(s, T0 + i * MINUTE, { cpuUtil: i });
  const res = s.query("a", "7d", T0 + 30 * MINUTE);
  // 7d answers from tier 2 in 30-minute steps: one point holding all 30 samples.
  assert.equal(res.stepMs, 30 * MINUTE);
  assert.deepEqual(res.points, [{ t: T0, cpuUtil: { avg: 14.5, max: 29 } }]);
});

test("each range picks the finest tier that covers it", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(HISTORY_RANGES).map(([k, v]) => [k, v.tier])),
    { "1h": 0, "6h": 1, "24h": 1, "7d": 2, "30d": 2 }
  );
  for (const spec of Object.values(HISTORY_RANGES)) {
    const reach = spec.tier === 0 ? RAW_RETENTION_MS : BUCKET_TIERS[spec.tier - 1].retentionMs;
    assert.ok(reach >= spec.spanMs, "tier must cover the range");
    assert.ok(spec.spanMs / spec.stepMs <= 500, "bounded points per response");
    if (spec.tier > 0) assert.equal(spec.stepMs % BUCKET_TIERS[spec.tier - 1].stepMs, 0);
  }

  // 1h comes from raw samples (10 s steps); 6h from 1-minute buckets.
  const s = store();
  rec(s, T0 + 2_000, { gpuUtil: 10 });
  rec(s, T0 + 4_000, { gpuUtil: 30 });
  rec(s, T0 + 12_000, { gpuUtil: 50 });
  const oneHour = s.query("a", "1h", T0 + 13_000);
  assert.equal(oneHour.stepMs, 10_000);
  assert.deepEqual(oneHour.points.map((p) => p.gpuUtil.avg), [20, 50]);
  assert.deepEqual(s.query("a", "6h", T0 + 13_000).points.map((p) => p.gpuUtil.avg), [30]);
  assert.throws(() => s.query("a", "2h"), /unknown range/);
});

test("raw samples older than 60 minutes are pruned; buckets keep them", () => {
  const s = store();
  rec(s, T0, { gpuUtil: 10 });
  rec(s, T0 + RAW_RETENTION_MS + MINUTE, { gpuUtil: 20 });
  const at = T0 + RAW_RETENTION_MS + MINUTE;
  assert.deepEqual(s.query("a", "1h", at).points.map((p) => p.gpuUtil.avg), [20]);
  assert.deepEqual(s.query("a", "6h", at).points.map((p) => p.gpuUtil.avg), [10, 20]);
});

test("retention: 1-minute buckets leave after 48 h, 15-minute buckets after 30 days", (t) => {
  const file = tmpFile(t);
  const s = store({ filePath: file });
  rec(s, T0, { gpuUtil: 10 });
  rec(s, T0 + 49 * HOUR, { gpuUtil: 20 });
  s.flush();
  let saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(saved.units.a["1m"].t, [T0 + 49 * HOUR]);
  assert.deepEqual(saved.units.a["15m"].t, [T0, T0 + 49 * HOUR]);
  assert.deepEqual(s.query("a", "24h", T0 + 49 * HOUR).points.map((p) => p.gpuUtil.avg), [20]);

  rec(s, T0 + 31 * DAY, { gpuUtil: 30 });
  s.flush();
  saved = JSON.parse(fs.readFileSync(file, "utf8"));
  // T0 is past 30 days; the 49 h bucket is not.
  assert.deepEqual(saved.units.a["15m"].t, [T0 + 49 * HOUR, T0 + 31 * DAY]);
  assert.deepEqual(s.query("a", "30d", T0 + 31 * DAY).points.map((p) => p.gpuUtil.avg), [20, 30]);
});

test("an offline stretch is a gap: no points, no zeros", () => {
  const s = store();
  rec(s, T0, { gpuUtil: 10 });
  for (let i = 1; i < 5; i++) rec(s, T0 + i * MINUTE, null);
  rec(s, T0 + 5 * MINUTE, { gpuUtil: 30 });
  const points = s.query("a", "6h", T0 + 5 * MINUTE).points;
  assert.deepEqual(points.map((p) => p.t), [T0, T0 + 5 * MINUTE]);
  assert.ok(points.every((p) => p.gpuUtil.avg > 0));
});

test("a series the unit did not report is absent from that point", () => {
  const s = store();
  rec(s, T0, { gpuUtil: 10, cpuTemp: 45 });
  rec(s, T0 + MINUTE, { gpuUtil: 20 });
  const [first, second] = s.query("a", "6h", T0 + MINUTE).points;
  assert.ok(first.cpuTemp);
  assert.equal(second.cpuTemp, undefined);
});

test("LLM series are grouped per endpoint", () => {
  const s = store();
  rec(
    s,
    T0,
    { gpuUtil: 5, [llmKey(30000, "genTps")]: 80, [llmKey(8888, "genTps")]: 40, [llmKey(8888, "kvUsage")]: 0.25 },
    { llmPorts: [8888, 30000] }
  );
  const res = s.query("a", "1h", T0);
  assert.deepEqual(res.llm.map((e) => e.port), [8888, 30000]);
  assert.deepEqual(res.llm[0].points, [{ t: T0, genTps: { avg: 40, max: 40 }, kvUsage: { avg: 0.25, max: 0.25 } }]);
  assert.deepEqual(res.points, [{ t: T0, gpuUtil: { avg: 5, max: 5 } }]);
});

test("an unknown unit answers with empty series", () => {
  const res = store().query("nope", "24h", T0);
  assert.deepEqual(res.points, []);
  assert.deepEqual(res.llm, []);
  assert.equal(res.to - res.from, DAY);
});

// ─── Persistence ──────────────────────────────────────────

test("flush and load round-trip tiers 1–2, open buckets included", (t) => {
  const file = tmpFile(t);
  const a = store({ filePath: file });
  rec(a, T0 + 1_000, { gpuUtil: 10, memFreeMB: 8_000, [llmKey(8888, "genTps")]: 30 }, { llmPorts: [8888] });
  rec(a, T0 + 31_000, { gpuUtil: 30, memFreeMB: 4_000, [llmKey(8888, "genTps")]: 50 }, { llmPorts: [8888] });
  assert.equal(a.flush(), true);
  assert.equal(a.flush(), false, "nothing new to write");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // Restart mid-minute: the loaded partial bucket merges with new samples.
  const b = store({ filePath: file, at: T0 + 45_000 });
  rec(b, T0 + 45_000, { gpuUtil: 50, memFreeMB: 6_000 }, { llmPorts: [8888] });
  const res = b.query("a", "6h", T0 + 45_000);
  assert.deepEqual(res.points, [
    { t: T0, gpuUtil: { avg: 30, max: 50 }, memFreeMB: { avg: 6_000, max: 8_000, min: 4_000 } },
  ]);
  assert.deepEqual(res.llm, [{ port: 8888, points: [{ t: T0, genTps: { avg: 40, max: 50 } }] }]);
  // Raw samples are memory only.
  assert.deepEqual(b.query("a", "1h", T0 + 45_000).points.map((p) => p.gpuUtil.avg), [50]);
});

test("removed units and LLM ports are dropped on the next flush", (t) => {
  const file = tmpFile(t);
  const s = store({ filePath: file });
  s.setNow(T0);
  s.record(
    [
      { id: "a", llmPorts: [8888, 9000], values: { gpuUtil: 1, [llmKey(8888, "genTps")]: 2, [llmKey(9000, "genTps")]: 3 } },
      { id: "b", values: { gpuUtil: 4 } },
    ],
    T0
  );
  s.flush();
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).units).sort(), ["a", "b"]);

  // b removed, a lost port 9000 — and every unit is offline, so nothing new is recorded.
  s.setNow(T0 + 2_000);
  s.record([{ id: "a", llmPorts: [8888], values: null }], T0 + 2_000);
  assert.equal(s.flush(), true, "membership change alone is worth a write");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(saved.units), ["a"]);
  assert.deepEqual(Object.keys(saved.units.a["1m"].series).sort(), ["gpuUtil", llmKey(8888, "genTps")]);
  assert.deepEqual(s.query("a", "1h", T0 + 2_000).llm.map((e) => e.port), [8888]);

  // A unit added later starts empty.
  assert.deepEqual(s.query("c", "1h", T0 + 2_000).points, []);
});

test("a store that never records never writes or reads a file", (t) => {
  const file = tmpFile(t);
  let reads = 0;
  const fileSystem = { ...fs, readFileSync: (...args) => ((reads += 1), fs.readFileSync(...args)) };
  const s = store({ filePath: file, fileSystem });
  assert.equal(s.flush(), false);
  assert.equal(s.close(), false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(reads, 0);
});

test("an unreadable file is moved aside, not overwritten", (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, "{not json");
  const s = store({ filePath: file });
  rec(s, T0, { gpuUtil: 1 });
  const aside = fs.readdirSync(path.dirname(file)).filter((f) => f.includes("unreadable"));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), aside[0]), "utf8"), "{not json");
});

test("the worst-case file stays within the documented size", () => {
  // Every bucket of both tiers filled, realistic magnitudes, one LLM endpoint.
  const s = store();
  const values = {
    gpuUtil: 87.25, gpuTemp: 61.5, gpuPower: 72.31, memUsedMB: 114_532, memFreeMB: 7_412,
    cpuUtil: 13.75, cpuTemp: 58.5, ramUsedMB: 20_481, netRx: 1_234_567, netTx: 987_654,
    [llmKey(8888, "genTps")]: 41.37, [llmKey(8888, "prefillTps")]: 1_803.2, [llmKey(8888, "kvUsage")]: 0.0513,
  };
  const unit = { id: "a", llmPorts: [8888], values };
  // 48 h at one sample a minute fills tier 1; 30 days at one per 15 min fills tier 2.
  for (let at = T0; at < T0 + 30 * DAY - 48 * HOUR; at += 15 * MINUTE) {
    s.setNow(at);
    s.record([unit], at);
  }
  for (let at = T0 + 30 * DAY - 48 * HOUR; at < T0 + 30 * DAY; at += MINUTE) {
    s.setNow(at);
    s.record([unit], at);
  }
  const bytes = Buffer.byteLength(JSON.stringify(s.serialize(T0 + 30 * DAY)));
  // Documented in MetricsHistory.js: ~0.9 MB per unit + ~0.25 MB per endpoint.
  assert.ok(bytes < 1.25 * 1024 * 1024, `worst case ${bytes} bytes`);
});
