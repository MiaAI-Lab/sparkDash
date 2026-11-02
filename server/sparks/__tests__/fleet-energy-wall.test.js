// GPU/CPU parts and wall power in the fleet-energy tracker and monthly archive.
// Everything here is a pure addition: fleet-energy.test.js and fleet-energy-monthly.test.js
// guard the estimate itself and must keep passing unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FleetEnergyTracker, estimateNodeParts, estimateNodeWatts } from "../../energy/FleetEnergyTracker.js";
import { MonthlyEnergyArchive } from "../../energy/FleetEnergyMonthly.js";
import { runFleetEnergySamplerTick } from "../../energy/FleetEnergyRuntime.js";
import { wallHour, wallMinute } from "../../energy/wallMinute.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// A fixed, minute-aligned "now" well inside a month.
const T0 = Date.parse("2026-10-20T12:00:00Z");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "energy-wall-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function snap(id, { gpu = 50, cpuUsage = 50, wallWatts } = {}) {
  return {
    id,
    online: true,
    telemetryFresh: true,
    role: "worker",
    metrics: { gpu: { power: { draw: gpu } }, cpu: { usage: cpuUsage } },
    ...(wallWatts !== undefined ? { wallWatts } : {}),
  };
}

function makeTracker({ now = T0, nodeIds = ["a", "b"], ...options } = {}) {
  let clock = now;
  const tracker = new FleetEnergyTracker({
    nodeIds,
    now: () => clock,
    load: options.filePath != null,
    setIntervalFn: null,
    ...options,
  });
  return { tracker, setNow: (ms) => (clock = ms), at: () => clock };
}

/** One sample every 2 s over [from, to]. */
function feed(tracker, setNow, from, to, nodes) {
  for (let at = from; at <= to; at += 2000) {
    setNow(at);
    tracker.record(nodes(at), at);
  }
}

const close = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} ≈ ${expected}`);

// ─── Parts ──────────────────────────────────────────────────────────────

test("the estimate is unchanged and now reports its GPU and CPU parts", () => {
  const s = snap("a", { gpu: 50, cpuUsage: 50 });
  const parts = estimateNodeParts(s);
  close(parts.cpuWatts, 5.2 + 59.8 / 2);
  assert.equal(parts.gpuWatts, 50);
  assert.equal(parts.watts, estimateNodeWatts(s));
  close(parts.watts, 50 + 35.1 + 23);
  // The clamp applies to the estimate only; the parts stay as measured / modelled.
  const big = estimateNodeParts(snap("a", { gpu: 600, cpuUsage: 100 }));
  assert.equal(big.watts, 240);
  assert.equal(big.gpuWatts, 600);
  assert.equal(estimateNodeParts({ ...s, telemetryFresh: false }), null);
});

test("parts are recorded on the same samples as the estimate and appear in history", () => {
  const { tracker, setNow } = makeTracker();
  feed(tracker, setNow, T0, T0 + 60_000, () => [snap("a"), snap("b", { gpu: 20, cpuUsage: 0 })]);
  const [row] = tracker.history(T0 + 60_000).hourly;
  close(row.nodeWh.a, ((50 + 35.1 + 23) * 60) / 3600, 1e-3);
  close(row.nodeGpuWh.a, (50 * 60) / 3600, 1e-3);
  close(row.nodeCpuWh.a, (35.1 * 60) / 3600, 1e-3);
  close(row.nodeGpuWh.b, (20 * 60) / 3600, 1e-3);
  close(row.nodeCpuWh.b, (5.2 * 60) / 3600, 1e-3);
  assert.equal(row.nodePartsCoverageMs.a, row.nodeCoverageMs.a);
  assert.equal(row.nodePartsCoverageMs.b, 60_000);
});

test("without meters nothing about the estimate's payloads changes", () => {
  const { tracker, setNow } = makeTracker();
  feed(tracker, setNow, T0, T0 + 10_000, () => [snap("a"), snap("b")]);
  const snapshot = tracker.snapshot(T0 + 10_000);
  assert.equal("wall" in snapshot, false);
  const history = tracker.history(T0 + 10_000);
  assert.equal("wallNodeIds" in history, false);
  for (const key of ["nodeWallWh", "fleetWallWh", "avgWallWatts"]) assert.equal(key in history.hourly[0], false, key);
  assert.equal(tracker.applyWallPeriods("a", [{ startMs: T0 - 5 * MINUTE, endMs: T0, meanW: 60 }]), 0);
});

test("old files without parts load, and a corrupt optional entry never costs the bucket", (t) => {
  const dir = tempDir(t);
  const filePath = path.join(dir, "fleet-energy.json");
  const base = (minuteStartMs, extra) => ({
    minuteStartMs,
    nodeWh: { a: 2, b: 2 },
    nodeCoverageMs: { a: MINUTE, b: MINUTE },
    fleetWattMs: 4 * 3_600_000,
    fleetCoverageMs: MINUTE,
    outputTokens: 0,
    coveredOutputTokens: 0,
    ...extra,
  });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      version: 1,
      nodeIds: ["a", "b"],
      savedAt: T0,
      integrationHighWaterMs: T0 - 2 * MINUTE,
      tokensTrackedSinceMs: null,
      buckets: [
        base(T0 - 4 * MINUTE),
        base(T0 - 3 * MINUTE, { parts: { a: [1, 0.5, MINUTE], b: [1, 0.5, 2 * MINUTE] } }),
        base(T0 - 2 * MINUTE, { wall: { a: [1e9, MINUTE, 0], b: [2.5, MINUTE, MINUTE] } }),
      ],
    })
  );
  const { tracker } = makeTracker({ filePath });
  tracker.configureWall({ nodeIds: ["a", "b"] });
  const [row] = tracker.history(T0).hourly;
  close(row.nodeWh.a, 6);
  // b's parts entry claims two minutes of coverage in one: dropped, a's kept.
  assert.equal(row.nodeGpuWh.a, 1);
  assert.equal(row.nodeGpuWh.b, 0);
  // a's wall entry is implausible (1 GWh in a minute): dropped, b's kept.
  assert.equal(row.nodeWallWh.a, 0);
  assert.equal(row.nodeWallWh.b, 2.5);
});

// ─── Wall power ─────────────────────────────────────────────────────────

test("live wall readings are integrated beside the estimate; missing ones are gaps", () => {
  const { tracker, setNow } = makeTracker();
  tracker.configureWall({ nodeIds: ["a", "b", "not-tracked"] });
  assert.deepEqual(tracker.wallNodeIds, ["a", "b"]);
  feed(tracker, setNow, T0, T0 + 60_000, (at) => [
    snap("a", { wallWatts: 120 }),
    snap("b", { wallWatts: at < T0 + 30_000 ? 60 : null }),
  ]);
  const [row] = tracker.history(T0 + 60_000).hourly;
  close(row.nodeWallWh.a, (120 * 60) / 3600, 1e-6);
  assert.equal(row.nodeWallCoverageMs.a, 60_000);
  assert.equal(row.nodeWallMeteredMs.a, 0);
  assert.equal(row.nodeWallCoverageMs.b, 28_000);
  assert.equal(row.fleetWallCoverageMs, 28_000);
  close(row.fleetWallWh, (120 * 28 + 60 * 28) / 3600, 1e-6);
  assert.equal(row.avgWallWatts, 180);

  const wall = tracker.snapshot(T0 + 60_000).wall;
  assert.deepEqual(wall.nodeIds, ["a", "b"]);
  assert.deepEqual(wall.freshNodeIds, ["a"]);
  assert.deepEqual(wall.staleNodeIds, ["b"]);
  assert.equal(wall.currentWatts30s, null, "no full-fleet wall sample while b is stale");
  close(wall.energy24hKwh, (120 * 60 + 60 * 28) / 3600 / 1000, 1e-9);
  assert.equal(wall.coverage24hMs, 28_000);
  assert.equal(wall.hourlyWatts24h.length, 24);
});

test("the meter's 5-minute record replaces live minutes; hourly only fills unconfirmed ones", () => {
  const start = T0 - HOUR;
  const { tracker, setNow } = makeTracker();
  tracker.configureWall({ nodeIds: ["a", "b"] });
  // Live readings for the first 5 minutes of the hour.
  feed(tracker, setNow, start, start + 5 * MINUTE, () => [snap("a", { wallWatts: 100 }), snap("b", { wallWatts: 100 })]);
  setNow(T0);
  const applied = tracker.applyWallPeriods("a", [
    { startMs: start, endMs: start + 5 * MINUTE, meanW: 90 },
    { startMs: start, endMs: start + HOUR, meanW: 70 },
    { startMs: start + 1000, endMs: start + 1000 + 5 * MINUTE, meanW: 1 }, // unaligned
    { startMs: T0, endMs: T0 + 5 * MINUTE, meanW: 1 }, // unfinished
    { startMs: T0 - 40 * DAY, endMs: T0 - 40 * DAY + HOUR, meanW: 1 }, // outside the window
  ]);
  assert.equal(applied, 2);
  const [row] = tracker.history(T0).hourly;
  // 5 minutes at 90 W from the 5-minute row, 55 minutes at 70 W from the hourly one.
  close(row.nodeWallWh.a, (90 * 5 + 70 * 55) / 60, 1e-3);
  assert.equal(row.nodeWallMeteredMs.a, HOUR);
  assert.equal(row.nodeWallCoverageMs.a, HOUR);
  // b only has its live readings.
  close(row.nodeWallWh.b, (100 * 5) / 60, 1e-3);
  assert.equal(row.nodeWallMeteredMs.b, 0);

  // A later live reading never overwrites a confirmed minute.
  feed(tracker, setNow, start + 10_000, start + 20_000, () => [snap("a", { wallWatts: 5000 }), snap("b", { wallWatts: 100 })]);
  close(tracker.history(T0).hourly[0].nodeWallWh.a, (90 * 5 + 70 * 55) / 60, 1e-3);
  // A newer 5-minute row does replace the hourly fill.
  setNow(T0);
  tracker.applyWallPeriods("a", [{ startMs: start + 30 * MINUTE, endMs: start + 35 * MINUTE, meanW: 10 }]);
  close(tracker.history(T0).hourly[0].nodeWallWh.a, (90 * 5 + 10 * 5 + 70 * 50) / 60, 1e-3);
});

test("since excludes the outlet's earlier readings, and wall-only hours still appear", () => {
  const { tracker } = makeTracker();
  tracker.configureWall({ nodeIds: ["a", "b"] });
  const hour = (startMs, meanW) => ({ startMs, endMs: startMs + HOUR, meanW });
  tracker.applyWallPeriods("a", [hour(T0 - 3 * HOUR, 5), hour(T0 - 2 * HOUR, 60)], { sinceMs: T0 - 2 * HOUR });
  const rows = tracker.history(T0).hourly;
  assert.deepEqual(rows.map((r) => r.t), [T0 - 2 * HOUR]);
  assert.equal(rows[0].nodeWallWh.a, 60);
  assert.equal(rows[0].nodeWh.a, 0, "no estimate was recorded for that hour");
  assert.equal(rows[0].fleetWallCoverageMs, 0, "b was not metered then");
});

test("clearWall forgets one node's wall minutes and keeps everything else", () => {
  const { tracker } = makeTracker();
  tracker.configureWall({ nodeIds: ["a", "b"] });
  const p = { startMs: T0 - HOUR, endMs: T0, meanW: 60 };
  tracker.applyWallPeriods("a", [p]);
  tracker.applyWallPeriods("b", [p]);
  assert.equal(tracker.clearWall("a"), 60);
  const [row] = tracker.history(T0).hourly;
  assert.equal(row.nodeWallWh.a, 0);
  assert.equal(row.nodeWallWh.b, 60);
});

test("wall bookkeeping and minutes persist with the tracker file", (t) => {
  const dir = tempDir(t);
  const filePath = path.join(dir, "fleet-energy.json");
  const { tracker } = makeTracker({ filePath });
  tracker.configureWall({ nodeIds: ["a", "b"] });
  tracker.applyWallPeriods("a", [{ startMs: T0 - 5 * MINUTE, endMs: T0, meanW: 60 }]);
  tracker.setWallState("a", { key: "ha|homeassistant|sensor.p3", marks: { "5minute": T0 }, backfill: "k" });
  tracker.setWallState("zzz", { key: "ignored" });
  tracker.flush();
  const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.deepEqual(Object.keys(saved.wallMeter), ["a"]);

  const { tracker: reloaded } = makeTracker({ filePath });
  reloaded.configureWall({ nodeIds: ["a", "b"] });
  assert.deepEqual(reloaded.wallState("a"), { key: "ha|homeassistant|sensor.p3", marks: { "5minute": T0 }, backfill: "k" });
  close(reloaded.history(T0).hourly[0].nodeWallWh.a, 5, 1e-9);
});

test("the sampler hands cached wall readings to the tracker", () => {
  const recorded = [];
  const tracker = { record: (inputs) => recorded.push(inputs) };
  const snapshots = [{ id: "a" }, { id: "b" }];
  runFleetEnergySamplerTick({
    tracker,
    orderedSnapshots: () => snapshots,
    monitors: new Map(),
    now: () => T0,
    wallReadings: () => new Map([["a", 55]]),
  });
  assert.deepEqual(recorded[0].map((s) => s.wallWatts), [55, null]);
  runFleetEnergySamplerTick({ tracker, orderedSnapshots: () => snapshots, monitors: new Map(), now: () => T0 });
  assert.equal("wallWatts" in recorded[1][0], false);
});

// ─── Monthly archive ────────────────────────────────────────────────────

test("parts fold into months with the estimate", () => {
  const { tracker, setNow } = makeTracker();
  feed(tracker, setNow, T0, T0 + 2 * MINUTE, () => [snap("a"), snap("b")]);
  setNow(T0 + 3 * MINUTE);
  const [month] = tracker.monthlySnapshot().months;
  assert.ok(month.nodes.a.gpuWh > 0);
  assert.ok(month.nodes.a.cpuWh > 0);
  assert.equal(month.nodes.a.partsCoverageMs, month.nodes.a.coverageMs);
  assert.equal("totalWallWh" in month, false);
});

test("wall minutes fold into months only once the meter has settled them, and only once", () => {
  let settled = -Infinity;
  const { tracker, setNow } = makeTracker();
  tracker.configureWall({ nodeIds: ["a", "b"], settledBefore: () => settled });
  feed(tracker, setNow, T0, T0 + 3 * MINUTE, () => [snap("a", { wallWatts: 100 }), snap("b", { wallWatts: 50 })]);
  setNow(T0 + 4 * MINUTE);
  let [month] = tracker.monthlySnapshot().months;
  assert.equal("totalWallWh" in month, false, "nothing settled yet");

  // The meter confirms the first minute; only then does the archive take it.
  tracker.applyWallPeriods("a", [{ startMs: T0 - 5 * MINUTE, endMs: T0, meanW: 1 }]);
  settled = T0 + MINUTE;
  setNow(T0 + 5 * MINUTE);
  [month] = tracker.monthlySnapshot().months;
  close(month.nodes.a.wallWh, 1 * (5 / 60) + 100 / 60, 1e-3);
  close(month.fleetWallWh, 150 / 60, 1e-3);
  assert.equal(month.fleetWallCoverageMs, MINUTE);

  // Settling further takes the rest; asking again adds nothing.
  settled = Infinity;
  setNow(T0 + 6 * MINUTE);
  [month] = tracker.monthlySnapshot().months;
  const total = month.totalWallWh;
  setNow(T0 + 7 * MINUTE);
  assert.equal(tracker.monthlySnapshot().months[0].totalWallWh, total);
  // 5 confirmed minutes at 1 W for a, plus three live minutes at 100 W (a) and 50 W (b).
  close(total, 5 / 60 + (3 * 150) / 60, 1e-3);
});

test("older meter history is imported into months once, with fleet totals", (t) => {
  const dir = tempDir(t);
  const filePath = path.join(dir, "fleet-energy-monthly.json");
  const archive = new MonthlyEnergyArchive({ filePath, now: () => T0 });
  const sep = Date.parse("2026-09-10T00:00:00Z");
  const hours = (n, meanW) => Array.from({ length: n }, (_, i) => ({ startMs: sep + i * HOUR, endMs: sep + (i + 1) * HOUR, meanW }));
  const byNode = new Map([
    ["a", hours(3, 60)],
    ["b", hours(2, 40)],
  ]);
  assert.equal(archive.importWallHours(byNode, { nodeIds: ["a", "b"], beforeMs: sep + 10 * HOUR }), 5);
  // Importing the same hours again adds nothing.
  assert.equal(archive.importWallHours(byNode, { nodeIds: ["a", "b"], beforeMs: sep + 10 * HOUR }), 0);
  // Hours at or after beforeMs belong to the tracker's window, not here.
  const fresh = new MonthlyEnergyArchive({ now: () => T0 });
  assert.equal(fresh.importWallHours(byNode, { nodeIds: ["a", "b"], beforeMs: sep + 2 * HOUR }), 4);
  archive.flush();

  const reloaded = new MonthlyEnergyArchive({ filePath, now: () => T0 });
  const [month] = reloaded.snapshot(T0).months;
  assert.equal(month.month, "2026-09");
  assert.equal(month.nodes.a.wallWh, 180);
  assert.equal(month.nodes.b.wallWh, 80);
  assert.equal(month.totalWallWh, 260);
  assert.equal(month.fleetWallWh, 200, "only the two hours both nodes reported");
  assert.equal(month.fleetWallCoverageMs, 2 * HOUR);
  assert.equal(month.totalWh, 0, "no estimate existed then");
  assert.equal(reloaded.importWallHours(byNode, { nodeIds: ["a", "b"], beforeMs: sep + 10 * HOUR }), 0, "the import mark persists");
});

// ─── The wall boundary ──────────────────────────────────────────────────

test("configuring wall power fixes one boundary: hours before it are imported, minutes from it on recorded", () => {
  const { tracker, setNow } = makeTracker();
  tracker.configureWall({ nodeIds: ["a", "b"] });
  const start = tracker.wallStartMs;
  assert.equal(start, T0 - DAY, "the hour a day before the meters were configured");
  setNow(T0 + 3 * HOUR);
  tracker.configureWall({ nodeIds: ["a", "b"] });
  assert.equal(tracker.wallStartMs, start, "later starts keep it");
  const p = (startMs) => ({ startMs, endMs: startMs + HOUR, meanW: 10 });
  assert.equal(tracker.applyWallPeriods("a", [p(start - HOUR), p(start)]), 1, "minutes never take figures from before it");
  const imported = tracker.importWallHistory(
    new Map([
      ["a", [p(start - 2 * HOUR), p(start - HOUR), p(start)]],
      ["x", [p(start - HOUR)]],
    ])
  );
  assert.equal(imported, 2, "months never take hours from after it (nor units without a meter)");
});

test("every hour of the meter's record reaches Monthly exactly once, however often it is fetched", (t) => {
  const dir = tempDir(t);
  const files = { filePath: path.join(dir, "fleet-energy.json"), monthlyFilePath: path.join(dir, "fleet-energy-monthly.json") };
  const { tracker, setNow } = makeTracker(files);
  tracker.configureWall({ nodeIds: ["a", "b"] });
  const start = tracker.wallStartMs;
  const hours = (from, n, meanW) => Array.from({ length: n }, (_, i) => ({ startMs: from + i * HOUR, endMs: from + (i + 1) * HOUR, meanW }));
  const before = hours(start - 6 * HOUR, 6, 60);
  const after = hours(start, 6, 60);
  for (let pass = 0; pass < 3; pass += 1) {
    tracker.importWallHistory(new Map([["a", [...before, ...after]], ["b", [...before, ...after]]]));
    tracker.applyWallPeriods("a", [...before, ...after]);
    tracker.applyWallPeriods("b", [...before, ...after]);
  }
  tracker.close();
  // A restart fetches it all again.
  setNow(T0 + HOUR);
  const { tracker: again } = makeTracker({ ...files, now: T0 + HOUR });
  again.configureWall({ nodeIds: ["a", "b"] });
  again.importWallHistory(new Map([["a", [...before, ...after]], ["b", [...before, ...after]]]));
  again.applyWallPeriods("a", after);
  again.applyWallPeriods("b", after);
  const [month] = again.monthlySnapshot(T0 + HOUR).months;
  close(month.nodes.a.wallWh, 12 * 60, 1e-6);
  close(month.nodes.b.wallWh, 12 * 60, 1e-6);
  assert.equal(month.nodes.a.wallCoverageMs, 12 * HOUR);
  close(month.fleetWallWh, 2 * 12 * 60, 1e-6);
  assert.equal(month.fleetWallCoverageMs, 12 * HOUR);
});

test("wallHour: a metered node's hourly figure stands for the whole hour; others are filled from their minutes", () => {
  const ids = ["a", "b"];
  const metered = new Set(ids);
  // Estimate: a 60 W, b 30 W; ratios a 1.5, b 2.
  const buckets = Array.from({ length: 60 }, (_, i) => ({
    minuteStartMs: T0 + i * MINUTE,
    nodeWh: { a: 1, b: 0.5 },
    nodeCoverageMs: { a: MINUTE, b: MINUTE },
    outputTokens: 2,
  }));
  const ratios = new Map([["a", 1.5], ["b", 2]]);
  const hour = wallHour(buckets, ids, metered, ratios, new Map([["a", 100]]));
  assert.deepEqual(hour.nodes.a, { wh: 100, coverageMs: HOUR, meteredMs: HOUR, filledWh: 0, filledMs: 0 }, "not filled on top");
  close(hour.nodes.b.filledWh, 60);
  assert.equal(hour.nodes.b.filledMs, HOUR);
  close(hour.fleet.wh, 160);
  close(hour.fleet.filledWh, 60);
  assert.deepEqual([hour.fleet.coverageMs, hour.fleet.full, hour.outputTokens], [HOUR, true, 120]);
  // Half an hour of estimate for b: the fleet covers what every node covered, pro rata.
  const half = wallHour(buckets.slice(0, 30), ids, metered, ratios, new Map([["a", 100]]));
  assert.equal(half.fleet.coverageMs, 30 * MINUTE);
  close(half.fleet.wh, 100 / 2 + 30);
  assert.equal(half.fleet.full, false);
  // Every node measured: the minutes add nothing but their tokens.
  const both = wallHour(buckets, ids, metered, ratios, new Map([["a", 100], ["b", 50]]));
  assert.deepEqual([both.nodes.b.wh, both.nodes.b.filledWh, both.fleet.wh, both.fleet.filledWh, both.outputTokens], [50, 0, 150, 0, 120]);
  // An unmetered node's figure is ignored; nothing at all gives null.
  assert.equal(wallHour([], ids, new Set(["b"]), ratios, new Map([["a", 100]])), null);
});

test("before the boundary the views show the meter's hourly figures: what Monthly imported, never filled on top", () => {
  const { tracker, setNow } = makeTracker({ now: T0 - 2 * DAY });
  // An hour of estimate before meters existed.
  feed(tracker, setNow, T0 - 2 * DAY, T0 - 2 * DAY + HOUR, () => [snap("a"), snap("b")]);
  setNow(T0);
  tracker.configureWall({ nodeIds: ["a", "b"] });
  const start = tracker.wallStartMs;
  const hours = Array.from({ length: 30 }, (_, i) => ({ startMs: start - (i + 1) * HOUR, endMs: start - i * HOUR, meanW: 100 }));
  assert.equal(tracker.snapshot(T0).wall.energy31dKwh, null, "nothing yet (and the sums are cached now)");
  tracker.importWallHistory(new Map([["a", hours]]));
  const rows = tracker.history(T0).hourly.filter((r) => r.nodeWallWh);
  assert.equal(rows.length, 30);
  for (const r of rows) {
    assert.ok(r.t < start);
    assert.deepEqual([r.nodeWallWh.a, r.nodeWallMeteredMs.a, r.nodeWallFilledWh.a], [100, HOUR, 0], new Date(r.t).toISOString());
  }
  const withEstimate = rows.find((r) => r.t === T0 - 2 * DAY);
  assert.ok(withEstimate.nodeCoverageMs.a > 0 && withEstimate.nodeWallWh.a === 100, "the hour's estimate does not add to it");
  const [month] = tracker.monthlySnapshot(T0).months;
  assert.equal(month.nodes.a.wallWh, 30 * 100, "the same hours, the same figures as Monthly");
  // The snapshot counts them too; an hour cut by the 24 h edge counts pro rata.
  close(tracker.snapshot(T0).wall.energy31dKwh, 3);
  assert.equal(tracker.snapshot(T0).wall.energy24hKwh, null, "the boundary is exactly 24 h back");
  close(tracker.snapshot(T0 - 30 * MINUTE).wall.energy24hKwh, 0.05);
});

test("the hourly figures are saved, leave with the window, and go with wall power", (t) => {
  const dir = tempDir(t);
  const files = { filePath: path.join(dir, "fleet-energy.json"), monthlyFilePath: path.join(dir, "fleet-energy-monthly.json") };
  const { tracker } = makeTracker(files);
  tracker.configureWall({ nodeIds: ["a", "b"] });
  const start = tracker.wallStartMs;
  const hours = (id, n) => [id, Array.from({ length: n }, (_, i) => ({ startMs: start - (i + 1) * HOUR, endMs: start - i * HOUR, meanW: 50 }))];
  tracker.importWallHistory(new Map([hours("a", 3), hours("b", 2)]));
  tracker.close();
  const load = (now = T0) => {
    const { tracker: again } = makeTracker({ ...files, now });
    again.configureWall({ nodeIds: ["a", "b"] });
    return again;
  };
  const walled = (tr, at = T0) => tr.history(at).hourly.filter((r) => r.nodeWallWh).map((r) => [r.nodeWallWh.a, r.nodeWallWh.b]);
  assert.deepEqual(walled(load()), [[50, 0], [50, 50], [50, 50]]);
  const outlet = load();
  outlet.clearWall("b");
  assert.deepEqual(walled(outlet), [[50, 0], [50, 0], [50, 0]]);
  const dropped = load();
  dropped.dropWall();
  assert.deepEqual(walled(dropped), []);
  const reset = load();
  reset.clear();
  assert.deepEqual(walled(reset), []);
  // Thirty-one days on, they have left the window.
  assert.deepEqual(walled(load(T0 + 31 * DAY), T0 + 31 * DAY), []);
});

test("an hour listed twice in one import counts once", () => {
  const archive = new MonthlyEnergyArchive({ now: () => T0 });
  const hour = { startMs: T0 - 5 * HOUR, endMs: T0 - 4 * HOUR, meanW: 60 };
  assert.equal(archive.importWallHours(new Map([["a", [hour, { ...hour }]]]), { nodeIds: ["a"], beforeMs: T0 }), 1);
  assert.equal(archive.snapshot(T0).months[0].nodes.a.wallWh, 60);
});

// ─── Dropping wall power ────────────────────────────────────────────────

test("dropWall removes every wall figure, keeps the estimate, and starts over", (t) => {
  const dir = tempDir(t);
  const files = { filePath: path.join(dir, "fleet-energy.json"), monthlyFilePath: path.join(dir, "fleet-energy-monthly.json") };
  const { tracker, setNow } = makeTracker(files);
  tracker.configureWall({ nodeIds: ["a", "b"] });
  // A month that only exists through imported history, a live hour, and a meter record.
  const aug = Date.parse("2026-08-14T00:00:00Z");
  tracker.importWallHistory(new Map([["a", [{ startMs: aug, endMs: aug + HOUR, meanW: 80 }]]]));
  feed(tracker, setNow, T0, T0 + HOUR, () => [snap("a", { wallWatts: 120 }), snap("b", { wallWatts: 100 })]);
  tracker.applyWallPeriods("a", [{ startMs: T0 - 2 * HOUR, endMs: T0 - HOUR, meanW: 90 }]);
  tracker.setWallState("a", { key: "k", marks: { "5minute": T0 }, backfill: "k" });
  setNow(T0 + 2 * HOUR);
  const strip = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !/wall/i.test(k))));
  const estimateRows = strip(tracker.history(T0 + 2 * HOUR).hourly.filter((r) => r.nodeCoverageMs.a > 0));
  const octBefore = tracker.monthlySnapshot(T0 + 2 * HOUR).months.find((m) => m.month === "2026-10");

  const result = tracker.dropWall();
  assert.ok(result.minutes > 60 && result.months === 2, JSON.stringify(result));
  assert.equal(tracker.wallState("a"), null);
  assert.equal(tracker.wallStartMs, Math.floor((T0 + 2 * HOUR - DAY) / HOUR) * HOUR, "a new boundary from now");
  const check = (tr) => {
    const rows = tr.history(T0 + 2 * HOUR).hourly;
    assert.ok(rows.every((r) => r.nodeWallWh === undefined || Object.values(r.nodeWallWh).every((v) => v === 0)));
    assert.deepEqual(strip(rows.filter((r) => r.nodeCoverageMs.a > 0)), estimateRows, "the estimate rows are unchanged");
    const months = tr.monthlySnapshot(T0 + 2 * HOUR).months;
    assert.deepEqual(months.map((m) => m.month), ["2026-10"], "the month that only held wall power is gone");
    const [oct] = months;
    assert.equal(oct.totalWallWh, undefined);
    assert.equal(Object.values(oct.nodes).some((n) => "wallWh" in n), false);
    assert.equal(oct.totalWh, octBefore.totalWh);
    assert.deepEqual(oct.nodes.a.gpuWh, octBefore.nodes.a.gpuWh, "the GPU/CPU parts stay");
  };
  check(tracker);
  // It is on disk too, and nothing comes back on a restart.
  tracker.close();
  const { tracker: reloaded } = makeTracker({ ...files, now: T0 + 2 * HOUR });
  reloaded.configureWall({ nodeIds: ["a", "b"] });
  check(reloaded);
});

test("DELETE /api/fleet-energy/wall needs an explicit confirmation", async (t) => {
  const { default: express } = await import("express");
  const { registerFleetEnergyRoute } = await import("../../energy/FleetEnergyRuntime.js");
  let dropped = 0;
  const app = express();
  registerFleetEnergyRoute(app, { dropWall: () => ((dropped += 1), { minutes: 3, months: 1 }) });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/fleet-energy/wall`;
  assert.equal((await fetch(url, { method: "DELETE" })).status, 400);
  assert.equal(dropped, 0);
  const ok = await fetch(`${url}?confirm=delete-wall-power`, { method: "DELETE" });
  assert.deepEqual(await ok.json(), { minutes: 3, months: 1 });
  assert.equal(dropped, 1);
});

// ─── Cached sums ────────────────────────────────────────────────────────

/** The wall windows computed plainly, minute by minute, as a reference for the cached ones. */
function plainWallWindows(tracker, atMs) {
  const ratios = tracker._ratios(atMs).byNode;
  const metered = new Set(tracker.wallNodeIds);
  const minuteStart = Math.floor(atMs / MINUTE) * MINUTE;
  const cutoff = (windowMs) => Math.floor((atMs - windowMs) / MINUTE) * MINUTE;
  const sum = (windowMs) => {
    let energyWh = 0;
    let fleetCoverageMs = 0;
    for (const bucket of tracker._buckets.values()) {
      if (bucket.minuteStartMs < cutoff(windowMs) || bucket.minuteStartMs > atMs) continue;
      const minute = wallMinute(bucket, tracker.nodeIds, metered, ratios);
      if (!minute) continue;
      for (const id of tracker.nodeIds) energyWh += minute.nodes[id].wh + minute.nodes[id].filledWh;
      fleetCoverageMs += minute.fleet?.coverageMs ?? 0;
    }
    return { energyWh, fleetCoverageMs };
  };
  const hours = Array.from({ length: 24 }, () => ({ wh: 0, ms: 0 }));
  for (const bucket of tracker._buckets.values()) {
    const start = bucket.minuteStartMs;
    if (start < minuteStart - DAY || start >= minuteStart) continue;
    const fleet = wallMinute(bucket, tracker.nodeIds, metered, ratios)?.fleet;
    if (!fleet) continue;
    const slot = hours[Math.floor((start - (minuteStart - DAY)) / HOUR)];
    slot.wh += fleet.wh;
    slot.ms += fleet.coverageMs;
  }
  return { last24h: sum(DAY), last31d: sum(31 * DAY), hourly: hours.map((h) => (h.ms > 0 ? (h.wh * 3_600_000) / h.ms : null)) };
}

test("cached wall sums always equal a plain recount, through samples, meter records, resets and clock steps", () => {
  const { tracker, setNow } = makeTracker({ now: T0 - 3 * HOUR });
  tracker.configureWall({ nodeIds: ["a", "b"] });
  let at = T0 - 3 * HOUR;
  let checks = 0;
  const check = (label, when = at) => {
    const wall = tracker.snapshot(when).wall;
    const plain = plainWallWindows(tracker, when);
    close(wall.energy24hKwh ?? 0, plain.last24h.energyWh / 1000, 1e-9);
    close(wall.energy31dKwh ?? 0, plain.last31d.energyWh / 1000, 1e-9);
    assert.equal(wall.coverage24hMs, plain.last24h.fleetCoverageMs, label);
    wall.hourlyWatts24h.forEach((w, i) => (w === null ? assert.equal(plain.hourly[i], null, label) : close(w, plain.hourly[i], 1e-9)));
    checks += 1;
  };
  // b's draw changes every hour against a steady estimate, so filling its minutes from the
  // estimate gives other hourly figures than its meter did.
  const step = (seconds, wallA, wallB) => {
    at += seconds * 1000;
    setNow(at);
    tracker.record([snap("a", { wallWatts: wallA }), snap("b", { gpu: 30, wallWatts: wallB })], at);
  };
  const live = (i) => step(2, 120 + (i % 7), i > 2000 && i < 2600 ? null : 100 + 25 * Math.floor(i / 1800));
  // Each change is made right after a snapshot filled the cache, and checked in the same minute.
  const around = (label, change) => {
    check(`before ${label}`);
    change();
    check(`after ${label}`);
  };
  // Three hours of live samples; b's meter drops out for twenty minutes.
  for (let i = 0; i < 5400; i += 1) {
    if (i % 97 === 0) around(`sample ${i}`, () => live(i));
    else live(i);
  }
  around("a meter record well inside the cached minutes", () =>
    tracker.applyWallPeriods("a", [{ startMs: T0 - 2 * HOUR, endMs: T0 - 2 * HOUR + 5 * MINUTE, meanW: 300 }])
  );
  around("clearWall", () => tracker.clearWall("b"));
  around("a partial reset", () => tracker.clear({ olderThanMs: HOUR }));
  // The clock steps back five minutes, and samples write into minutes counted before.
  at -= 5 * MINUTE;
  for (let i = 0; i < 60; i += 1) around(`a sample after the clock stepped back (${i})`, () => step(2, 500, 500));
  // Writers go through _bucket(); a write to a minute already counted drops the sums,
  // whichever writer it is (samples cannot reach one today, see _wallWindows).
  around("a write to a counted minute", () => {
    tracker._bucket(Math.floor(at / MINUTE) * MINUTE - 30 * MINUTE).wall.a[0] += 1;
  });
  assert.ok(checks > 100);
});
