import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UnitHistory } from "../UnitHistory.js";
import { BUCKET_TIERS, HISTORY_RANGES, coarsen, llmKey, mergeStat } from "../historyTiers.js";
import { extractSample, memoryReading, networkRates } from "../historySample.js";
import { atomicWriteAsync } from "../../util/atomicWrite.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// A fixed, bucket-aligned epoch so every expectation is exact.
const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-unithist-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function store(opts = {}) {
  let clock = opts.at ?? T0;
  const s = new UnitHistory({ logError: () => {}, ...opts, now: () => clock });
  s.setNow = (v) => {
    clock = v;
  };
  return s;
}

function rec(s, at, values, { id = "a", llmPorts } = {}) {
  s.setNow(at);
  s.recordSample([{ id, values, llmPorts }], at);
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
      llm: [{ available: true, generationTps: 41.2, prefillTps: 1_800, kvCacheUsage: 0.05 }],
    },
    ...overrides,
  };
}

test("extractSample reads every series from a GB10 snapshot", () => {
  assert.deepEqual(extractSample(gb10Snapshot()), {
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

test("extractSample matches LLM readings to ports by the port they carry, not by position", () => {
  // Ports were reordered and one removed; metrics.llm still has the old order until the next poll.
  const snap = gb10Snapshot({ llmPorts: [9000, 8888] });
  snap.metrics.llm = [
    { port: 8888, available: true, generationTps: 10, prefillTps: 20 },
    { port: 7777, available: true, generationTps: 99, prefillTps: 99 },
    { port: 9000, available: true, generationTps: 30, prefillTps: 40 },
  ];
  const v = extractSample(snap);
  assert.equal(v[llmKey(8888, "genTps")], 10);
  assert.equal(v[llmKey(9000, "genTps")], 30);
  assert.equal(v[llmKey(7777, "genTps")], undefined, "a port the unit no longer has");
});

test("an offline unit is a gap, not zeros", () => {
  assert.equal(extractSample(gb10Snapshot({ online: false })), null);
});

test("an LLM poll whose stats could not be read is a gap, not a zero rate", () => {
  const snap = gb10Snapshot();
  snap.metrics.llm = [{ available: true, measurementValid: false, generationTps: 0, prefillTps: 0, kvCacheUsage: 0.4 }];
  const v = extractSample(snap);
  assert.equal(v[llmKey(8888, "genTps")], undefined);
  assert.equal(v[llmKey(8888, "prefillTps")], undefined);
  assert.equal(v[llmKey(8888, "kvUsage")], undefined);
  snap.metrics.llm[0].measurementValid = true;
  assert.equal(extractSample(snap)[llmKey(8888, "genTps")], 0, "a readable idle engine is a real zero");
});

test("failed, stale or unavailable readings are skipped, never recorded as zero", () => {
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

  const host = gb10Snapshot({ kind: "host" });
  host.metrics.gpu.metricAvailability = { usage: true, temperature: false, powerDraw: false };
  const h = extractSample(host);
  assert.equal(h.gpuUtil, 87);
  assert.equal(h.gpuTemp, undefined, "a sensor the vendor tool does not expose");
  assert.equal(h.gpuPower, undefined);
  assert.equal(h.ramUsedMB, 20_000, "hosts chart their own RAM");
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
  assert.deepEqual(mergeStat(undefined, { sum: 1, max: 1, min: 1, n: 1 }), { sum: 1, max: 1, min: 1, n: 1 });
});

test("15-minute buckets are fed from the same samples", () => {
  const s = store();
  for (let i = 0; i < 30; i++) rec(s, T0 + i * MINUTE, { cpuUtil: i });
  const res = s.query("a", "7d", T0 + 30 * MINUTE);
  // 7d answers from the 15-minute tier in 30-minute steps: one point holding all 30 samples.
  assert.equal(res.stepMs, 30 * MINUTE);
  assert.deepEqual(res.points, [{ t: T0, cpuUtil: { avg: 14.5, max: 29 } }]);
});

test("each range picks the finest tier that covers it, in bounded points", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(HISTORY_RANGES).map(([k, v]) => [k, BUCKET_TIERS[v.tier].name])),
    { "1h": "1m", "6h": "1m", "24h": "1m", "7d": "15m", "30d": "15m" }
  );
  for (const spec of Object.values(HISTORY_RANGES)) {
    const tier = BUCKET_TIERS[spec.tier];
    assert.ok(tier.retentionMs >= spec.spanMs, "tier must cover the range");
    assert.ok(spec.spanMs / spec.stepMs <= 500, "bounded points per response");
    assert.equal(spec.stepMs % tier.stepMs, 0);
  }
  const s = store();
  rec(s, T0 + 2_000, { gpuUtil: 10 });
  rec(s, T0 + 4_000, { gpuUtil: 30 });
  rec(s, T0 + MINUTE + 2_000, { gpuUtil: 50 });
  assert.deepEqual(s.query("a", "1h", T0 + MINUTE + 3_000).points.map((p) => p.gpuUtil.avg), [20, 50]);
  assert.throws(() => s.query("a", "2h"), /unknown range/);
  assert.throws(() => s.query("a", "__proto__"), /unknown range/);
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

test("the tiers do not touch the GPU raw tier, and remove() forgets both", () => {
  const s = store();
  s.record("a", T0, 10, 50, 20);
  rec(s, T0, { gpuUtil: 10 });
  assert.equal(s.get("a").t.length, 1);
  s.remove("a");
  assert.deepEqual(s.get("a").t, []);
  assert.deepEqual(s.query("a", "1h", T0).points, []);
});

// ─── Persistence ──────────────────────────────────────────

test("retention: 1-minute buckets leave after 48 h, 15-minute buckets after 30 days", (t) => {
  const tiersFile = path.join(tmpDir(t), "metrics-history.json");
  const s = store({ tiersFile });
  rec(s, T0, { gpuUtil: 10 });
  rec(s, T0 + 49 * HOUR, { gpuUtil: 20 });
  s.flush();
  let saved = JSON.parse(fs.readFileSync(tiersFile, "utf8"));
  assert.deepEqual(saved.units.a["1m"].t, [T0 + 49 * HOUR]);
  assert.deepEqual(saved.units.a["15m"].t, [T0, T0 + 49 * HOUR]);
  assert.deepEqual(s.query("a", "24h", T0 + 49 * HOUR).points.map((p) => p.gpuUtil.avg), [20]);

  rec(s, T0 + 31 * DAY, { gpuUtil: 30 });
  s.flush();
  saved = JSON.parse(fs.readFileSync(tiersFile, "utf8"));
  assert.deepEqual(saved.units.a["15m"].t, [T0 + 49 * HOUR, T0 + 31 * DAY]);
  assert.deepEqual(s.query("a", "30d", T0 + 31 * DAY).points.map((p) => p.gpuUtil.avg), [20, 30]);
});

test("save() round-trips the tiers asynchronously, open buckets included, mode 0600", async (t) => {
  const tiersFile = path.join(tmpDir(t), "metrics-history.json");
  const a = store({ tiersFile });
  rec(a, T0 + 1_000, { gpuUtil: 10, memFreeMB: 8_000, [llmKey(8888, "genTps")]: 30 }, { llmPorts: [8888] });
  rec(a, T0 + 31_000, { gpuUtil: 30, memFreeMB: 4_000, [llmKey(8888, "genTps")]: 50 }, { llmPorts: [8888] });
  await a.save();
  assert.equal(fs.statSync(tiersFile).mode & 0o777, 0o600);
  const mtime = fs.statSync(tiersFile).mtimeMs;
  await a.save();
  assert.equal(fs.statSync(tiersFile).mtimeMs, mtime, "nothing new: no rewrite");
  assert.equal(a.flush(), false, "the async save counts as written");

  // Restart mid-minute: the loaded partial bucket merges with new samples.
  const b = store({ tiersFile, at: T0 + 45_000 });
  rec(b, T0 + 45_000, { gpuUtil: 50, memFreeMB: 6_000 }, { llmPorts: [8888] });
  const res = b.query("a", "6h", T0 + 45_000);
  assert.deepEqual(res.points, [
    { t: T0, gpuUtil: { avg: 30, max: 50 }, memFreeMB: { avg: 6_000, max: 8_000, min: 4_000 } },
  ]);
  assert.deepEqual(res.llm, [{ port: 8888, points: [{ t: T0, genTps: { avg: 40, max: 50 } }] }]);
});

test("unit ids like __proto__, constructor and toString round-trip through save and load", async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, "gpu-history.json");
  const tiersFile = path.join(dir, "metrics-history.json");
  const ids = ["__proto__", "constructor", "toString", "spark-1"];
  const a = store({ file, tiersFile, minGapMs: 1 });
  a.recordSample(ids.map((id, i) => ({ id, values: { gpuUtil: 10 + i } })), T0);
  ids.forEach((id, i) => a.record(id, T0, 10 + i, 40, 20));
  await a.save();

  const saved = JSON.parse(fs.readFileSync(tiersFile, "utf8"));
  assert.deepEqual(Object.keys(saved.units).sort(), [...ids].sort());
  assert.equal(Object.getPrototypeOf(saved.units), Object.prototype, "the key did not become a prototype");

  const b = store({ file, tiersFile, minGapMs: 1 });
  for (const [i, id] of ids.entries()) {
    assert.deepEqual(b.query(id, "1h", T0).points, [{ t: T0, gpuUtil: { avg: 10 + i, max: 10 + i } }], id);
    assert.deepEqual(b.get(id).u, [10 + i], id);
  }
  // And the sync (shutdown) path writes them too.
  b.record("__proto__", T0 + 2_000, 99, 40, 20);
  b.stop();
  const c = store({ file, minGapMs: 1 });
  assert.deepEqual(c.get("__proto__").u, [10, 99]);
});

test("saves are coalesced: one write in flight, callers share it", async (t) => {
  const tiersFile = path.join(tmpDir(t), "metrics-history.json");
  let writes = 0;
  let release;
  let writing;
  const gate = new Promise((r) => (release = r));
  const started = new Promise((r) => (writing = r));
  const s = store({
    tiersFile,
    writeAsync: async (...args) => {
      writes += 1;
      writing();
      await gate;
      return atomicWriteAsync(...args);
    },
  });
  rec(s, T0, { gpuUtil: 1 });
  const first = s.save();
  const second = s.save();
  assert.equal(first, second);
  await started;
  rec(s, T0 + 2_000, { gpuUtil: 2 }); // arrives after the first save serialized
  release();
  await first;
  assert.equal(writes, 1);
  await s.save();
  assert.equal(writes, 2, "the sample that arrived mid-save is written next time");
  await s.save();
  assert.equal(writes, 2);
});

test("a shutdown flush supersedes an async save in flight; the stale one never renames", async (t) => {
  const tiersFile = path.join(tmpDir(t), "metrics-history.json");
  let release;
  const gate = new Promise((r) => (release = r));
  const s = store({
    tiersFile,
    writeAsync: async (file, text, mode, opts) => {
      await gate;
      return atomicWriteAsync(file, text, mode, opts);
    },
  });
  rec(s, T0, { gpuUtil: 1 });
  const pending = s.save();
  rec(s, T0 + 2_000, { gpuUtil: 3 });
  s.stop(); // sync, writes both samples
  release();
  await pending;
  const saved = JSON.parse(fs.readFileSync(tiersFile, "utf8"));
  assert.deepEqual(saved.units.a["1m"].series.gpuUtil.avg, [2]);
  assert.deepEqual(fs.readdirSync(path.dirname(tiersFile)), ["metrics-history.json"], "no temp file left behind");
});

test("save() yields between units instead of serializing the fleet in one turn", async (t) => {
  const tiersFile = path.join(tmpDir(t), "metrics-history.json");
  let yields = 0;
  const s = store({
    tiersFile,
    yieldFn: () => {
      yields += 1;
      return Promise.resolve();
    },
  });
  s.recordSample(["a", "b", "c"].map((id) => ({ id, values: { gpuUtil: 1 } })), T0);
  await s.save();
  assert.equal(yields, 3);
});

test("removed units and LLM ports are dropped on the next save", (t) => {
  const tiersFile = path.join(tmpDir(t), "metrics-history.json");
  const s = store({ tiersFile });
  s.recordSample(
    [
      { id: "a", llmPorts: [8888, 9000], values: { gpuUtil: 1, [llmKey(8888, "genTps")]: 2, [llmKey(9000, "genTps")]: 3 } },
      { id: "b", values: { gpuUtil: 4 } },
    ],
    T0
  );
  s.flush();
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(tiersFile, "utf8")).units).sort(), ["a", "b"]);

  // b removed, a lost port 9000 — and a is offline, so nothing new is recorded.
  s.setNow(T0 + 2_000);
  s.recordSample([{ id: "a", llmPorts: [8888], values: null }], T0 + 2_000);
  assert.equal(s.flush(), true, "membership change alone is worth a write");
  const saved = JSON.parse(fs.readFileSync(tiersFile, "utf8"));
  assert.deepEqual(Object.keys(saved.units), ["a"]);
  assert.deepEqual(Object.keys(saved.units.a["1m"].series).sort(), ["gpuUtil", llmKey(8888, "genTps")]);
});

test("a store whose tiers never record never reads or writes the tiers file", (t) => {
  const tiersFile = path.join(tmpDir(t), "metrics-history.json");
  fs.writeFileSync(tiersFile, "untouched");
  let reads = 0;
  const s = store({
    tiersFile,
    readFileSync: (...args) => ((reads += 1), fs.readFileSync(...args)),
  });
  s.record("a", T0, 1, 1, 1); // the GPU tier keeps working
  assert.equal(s.flush(), false);
  s.stop();
  assert.equal(reads, 0);
  assert.equal(fs.readFileSync(tiersFile, "utf8"), "untouched");
});

test("an unreadable tiers file is quarantined, not overwritten", (t) => {
  const dir = tmpDir(t);
  const tiersFile = path.join(dir, "metrics-history.json");
  fs.writeFileSync(tiersFile, "{not json");
  const s = store({ tiersFile });
  rec(s, T0, { gpuUtil: 1 });
  const aside = fs.readdirSync(dir).filter((f) => f.startsWith("metrics-history.json.corrupt-"));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), "utf8"), "{not json");
  s.flush();
  assert.ok(JSON.parse(fs.readFileSync(tiersFile, "utf8")).units.a);
});

test("the GPU file is saved asynchronously too, in its unchanged format", async (t) => {
  const file = path.join(tmpDir(t), "gpu-history.json");
  const s = store({ file, minGapMs: 1 });
  s.record("a", T0, 10, 50, 20);
  await s.save();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    version: 1,
    sparks: { a: { t: [T0], u: [10], c: [50], p: [20], g: {} } },
  });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("the worst-case tiers stay within the documented size", () => {
  // Every bucket of both tiers filled, realistic magnitudes, one LLM endpoint.
  const s = store();
  const values = {
    gpuUtil: 87.25, gpuTemp: 61.5, gpuPower: 72.31, memUsedMB: 114_532, memFreeMB: 7_412,
    cpuUtil: 13.75, cpuTemp: 58.5, ramUsedMB: 20_481, netRx: 1_234_567, netTx: 987_654,
    [llmKey(8888, "genTps")]: 41.37, [llmKey(8888, "prefillTps")]: 1_803.2, [llmKey(8888, "kvUsage")]: 0.0513,
  };
  const unit = { id: "a", llmPorts: [8888], values };
  for (let at = T0; at < T0 + 30 * DAY - 48 * HOUR; at += 15 * MINUTE) {
    s.setNow(at);
    s.recordSample([unit], at);
  }
  for (let at = T0 + 30 * DAY - 48 * HOUR; at < T0 + 30 * DAY; at += MINUTE) {
    s.setNow(at);
    s.recordSample([unit], at);
  }
  const bytes = Buffer.byteLength(JSON.stringify(s.serializeTiers(T0 + 30 * DAY)));
  // Documented in UnitHistory.js: ~1 MB per unit + ~0.3 MB per endpoint on disk.
  assert.ok(bytes < 1.4 * 1024 * 1024, `worst case ${bytes} bytes`);
});

test("turning the setting off stops tier writes, buckets still pending included", async (t) => {
  const tiersFile = path.join(tmpDir(t), "metrics-history.json");
  let enabled = true;
  const s = store({ tiersFile, tiersEnabled: () => enabled });
  rec(s, T0, { gpuUtil: 10 });
  enabled = false;
  await s.save();
  assert.equal(s.flush(), false);
  s.stop();
  assert.equal(fs.existsSync(tiersFile), false, "nothing written after the setting went off");
  enabled = true;
  assert.equal(s.flush(), true, "turned on again before a restart: the pending buckets are written");
  assert.deepEqual(JSON.parse(fs.readFileSync(tiersFile, "utf8")).units.a["1m"].t, [T0]);
});
