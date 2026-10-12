import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { UnitHistory } from "../UnitHistory.js";
import {
  HISTORY_SAMPLE_INTERVAL_MS,
  createUnitHistoryRuntime,
  monitorFreshness,
  registerUnitHistoryRoutes,
  staleWindowMs,
} from "../UnitHistoryRuntime.js";
import { SparkMonitor } from "../../sparks/SparkMonitor.js";
import { COLLECTION_SUCCESS } from "../../collectors/SystemCollector.js";

const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-unithist-rt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tagged(result) {
  Object.defineProperty(result, COLLECTION_SUCCESS, { value: true, enumerable: false });
  return result;
}

function snapshot(id, { online = true, usage = 50 } = {}) {
  return {
    id,
    kind: "spark",
    online,
    llmPorts: [],
    metrics: {
      gpu: tagged({ temperature: 45, usage, power: { draw: 20, limit: 100 }, vram: { used: 1, total: 100, available: 50 } }),
      cpu: { usage: 10, temperature: 40, draw: 5, tdp: 65 },
      network: { interfaces: [] },
      llm: [],
    },
  };
}

/**
 * A monitor exposing only SparkMonitor's public freshness accessors: every domain was
 * collected at `collectedAt` and succeeded, polled every `intervalMs`.
 */
function fakeMonitor({ collectedAt, intervalMs = 2000, ok = true }) {
  return {
    lastCollectedAt: () => collectedAt,
    collectionOk: () => ok,
    pollIntervalMs: () => intervalMs,
  };
}

/** Fake timers: collect the callbacks so a test can fire them by hand. */
function fakeTimers() {
  const timers = [];
  return {
    setIntervalFn: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => {
      timer.cleared = true;
    },
    fire: () => timers.filter((t) => t.ms === HISTORY_SAMPLE_INTERVAL_MS && !t.cleared).forEach((t) => t.fn()),
    timers,
  };
}

function setup(t, { enabled = false, snapshots = [snapshot("a")], monitor } = {}) {
  const dir = tmpDir(t);
  let clock = T0;
  const state = { enabled, snapshots };
  const store = new UnitHistory({
    file: path.join(dir, "gpu-history.json"),
    tiersFile: path.join(dir, "metrics-history.json"),
    now: () => clock,
    logError: () => {},
  });
  t.after(() => store.stop());
  const timers = fakeTimers();
  const runtime = createUnitHistoryRuntime({
    store,
    orderedSnapshots: () => state.snapshots,
    monitors: { get: () => monitor ?? fakeMonitor({ collectedAt: clock }) },
    isEnabled: () => state.enabled,
    now: () => clock,
    ...timers,
    logError: () => {},
  });
  return {
    dir,
    state,
    store,
    runtime,
    timers,
    advance: (ms) => {
      clock += ms;
    },
  };
}

test("the stale window follows the monitor's current poll interval, never under 15 s", () => {
  assert.equal(staleWindowMs(fakeMonitor({ intervalMs: 2000 }), "gpu"), 15_000);
  assert.equal(staleWindowMs(fakeMonitor({ intervalMs: 10_000 }), "gpu"), 30_000);
  assert.equal(staleWindowMs(fakeMonitor({ intervalMs: 60_000 }), "gpu"), 180_000);
  assert.equal(staleWindowMs(fakeMonitor({ intervalMs: null }), "storage"), 15_000);
  assert.equal(staleWindowMs(null, "gpu"), 15_000);
});

test("freshness: recent real data only, judged by the user's poll interval", () => {
  const at = T0 + 25_000;
  // A 10 s poll interval: a reading 25 s old is within 3 × 10 s.
  assert.equal(monitorFreshness(fakeMonitor({ collectedAt: T0, intervalMs: 10_000 }), at)("gpu"), true);
  // At the default 2 s the same reading is stale (window floors at 15 s).
  assert.equal(monitorFreshness(fakeMonitor({ collectedAt: T0, intervalMs: 2000 }), at)("gpu"), false);
  assert.equal(monitorFreshness(fakeMonitor({ collectedAt: at, ok: false }), at)("gpu"), false, "failed poll");
  assert.equal(monitorFreshness(fakeMonitor({ collectedAt: null }), at)("llm"), false, "never collected");
  assert.equal(monitorFreshness(undefined, at)("gpu"), false);
});

test("freshness reads a real SparkMonitor through its public accessors, and follows setPollInterval", async () => {
  const monitor = new SparkMonitor({ id: "u", name: "u", lanIp: "127.0.0.1", isLocal: true, llmMonitoring: false });
  monitor.collector.collectRam = async () => ({ used: 10, total: 100, percentage: 10 });
  monitor._running = true;
  await monitor._pollDomain("ram");
  monitor._running = false;
  const at = monitor.lastCollectedAt("ram");
  assert.equal(monitorFreshness(monitor, at + 14_000)("ram"), true);
  assert.equal(monitorFreshness(monitor, at + 20_000)("ram"), false, "3 × 2 s floors at 15 s");
  monitor.setPollInterval(10_000);
  assert.equal(monitorFreshness(monitor, at + 20_000)("ram"), true, "3 × 10 s after the setting changed");
  assert.equal(monitorFreshness(monitor, at)("gpu"), false, "never collected");
});

test("off by default: the GPU tier is sampled as before, the bucketed tiers are not", (t) => {
  const { store, runtime, timers, advance, dir } = setup(t);
  runtime.start();
  timers.fire();
  advance(2_000);
  timers.fire();
  assert.equal(store.get("a").t.length, 2);
  assert.deepEqual(store.query("a", "1h", T0 + 2_000).points, []);
  runtime.stop();
  assert.ok(fs.existsSync(path.join(dir, "gpu-history.json")));
  assert.equal(fs.existsSync(path.join(dir, "metrics-history.json")), false, "never written while off");
});

test("turning the setting on records from the next tick, and off stops it", (t) => {
  const { state, store, runtime, timers, advance } = setup(t);
  runtime.start();
  timers.fire();
  state.enabled = true;
  advance(2_000);
  timers.fire();
  state.enabled = false;
  advance(2_000);
  timers.fire();
  const points = store.query("a", "1h", T0 + 4_000).points;
  assert.equal(points.length, 1);
  assert.equal(points[0].gpuUtil.avg, 50);
  assert.equal(store.get("a").t.length, 3, "GPU tier unaffected by the setting");
});

test("an offline unit, or one whose collections went stale, records gaps", (t) => {
  const stale = fakeMonitor({ collectedAt: T0 - 60_000 });
  const { state, store, runtime, timers } = setup(t, { enabled: true, monitor: stale });
  state.snapshots = [snapshot("a"), snapshot("b", { online: false })];
  runtime.start();
  timers.fire();
  assert.deepEqual(store.query("a", "1h", T0).points, [], "stale for 60 s at a 2 s interval");
  assert.deepEqual(store.query("b", "1h", T0).points, []);
  assert.equal(store.get("b").t.length, 0, "offline: no GPU sample either");
});

test("stop() writes synchronously and stops sampling", (t) => {
  const { store, runtime, timers, dir, state } = setup(t, { enabled: true });
  runtime.start();
  timers.fire();
  runtime.stop();
  assert.ok(timers.timers.every((x) => x.cleared));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "metrics-history.json"), "utf8"));
  assert.ok(saved.units.a);
  state.snapshots = [snapshot("a", { usage: 99 })];
  timers.timers[0].fn();
  assert.equal(store.get("a").u.length, 1, "no sample after stop");
});

test("routes: GPU history unchanged, history validates the range and reports the setting", async (t) => {
  const { state, store, runtime, timers, advance } = setup(t, { enabled: true });
  runtime.start();
  timers.fire();
  advance(1_000);
  const app = express();
  registerUnitHistoryRoutes(app, {
    store,
    hasUnit: (id) => id === "a",
    isEnabled: () => state.enabled,
    now: () => T0 + 1_000,
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => {
    const res = await fetch(base + p);
    return { status: res.status, body: await res.json() };
  };

  const gpu = await get("/api/sparks/a/gpu-history?windowMs=60000");
  assert.deepEqual(gpu, { status: 200, body: { t: [T0], u: [50], c: [45], p: [20], gpus: [] } });
  assert.equal((await get("/api/sparks/nope/gpu-history")).status, 404);

  const hist = await get("/api/sparks/a/history?range=6h");
  assert.equal(hist.status, 200);
  assert.equal(hist.body.enabled, true);
  assert.equal(hist.body.range, "6h");
  assert.deepEqual(hist.body.points[0].gpuUtil, { avg: 50, max: 50 });
  assert.equal((await get("/api/sparks/a/history")).body.range, "1h", "default range");
  for (const bad of ["2h", "__proto__", "toString"]) {
    assert.equal((await get(`/api/sparks/a/history?range=${bad}`)).status, 400, bad);
  }
  assert.equal((await get("/api/sparks/a/history?range=1h&range=6h")).status, 400, "array query");
  assert.equal((await get("/api/sparks/nope/history")).status, 404);
  state.enabled = false;
  assert.deepEqual((await get("/api/sparks/a/history?range=24h")).body, { enabled: false });
});

test("gpu-history serves windows over 8 h from the long series, up to 7 days", async (t) => {
  const dir = tmpDir(t);
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;
  const store = new UnitHistory({
    file: path.join(dir, "gpu-history.json"),
    longFile: path.join(dir, "gpu-history-long.json"),
    now: () => T0,
    logError: () => {},
  });
  t.after(() => store.stop());
  for (const [ago, temp] of [[9 * DAY, 30], [3 * DAY, 40], [2 * HOUR, 50], [0, 60]]) store.record("a", T0 - ago, 10, temp, 5);
  const app = express();
  registerUnitHistoryRoutes(app, { store, hasUnit: (id) => id === "a", isEnabled: () => false, now: () => T0 });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const temps = async (q) =>
    (await (await fetch(`http://127.0.0.1:${server.address().port}/api/sparks/a/gpu-history${q}`)).json()).c;

  assert.deepEqual(await temps(""), [50, 60], "default: the dense 8 h");
  assert.deepEqual(await temps(`?windowMs=${DAY}`), [50, 60], "a day from the long series");
  assert.deepEqual(await temps(`?windowMs=${7 * DAY}`), [40, 50, 60], "a week");
  assert.deepEqual(await temps(`?windowMs=${30 * DAY}`), [40, 50, 60], "capped at 7 days");
});
