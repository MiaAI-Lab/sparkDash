import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { MetricsHistory } from "../MetricsHistory.js";
import {
  HISTORY_FLUSH_INTERVAL_MS,
  HISTORY_SAMPLE_INTERVAL_MS,
  MAX_DOMAIN_AGE_MS,
  maxDomainAgeMs,
  createMetricsHistoryRuntime,
  monitorFreshness,
  registerMetricsHistoryRoute,
} from "../MetricsHistoryRuntime.js";

const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-history-rt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "metrics-history.json");
}

function snapshot(id, { online = true, usage = 50 } = {}) {
  return {
    id,
    kind: "spark",
    online,
    llmPorts: [],
    metrics: {
      gpu: { temperature: 45, usage, power: { draw: 20, limit: 100 }, vram: { used: 1, total: 100, available: 50 } },
      cpu: { usage: 10, temperature: 40, draw: 5, tdp: 65 },
      network: { interfaces: [] },
      llm: [],
    },
  };
}

/** Fake timers: collect the callbacks so a test can fire them by hand. */
function fakeTimers() {
  const timers = [];
  return {
    timers,
    setIntervalFn: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => {
      timer.cleared = true;
    },
    fire: (ms) => timers.filter((t) => t.ms === ms && !t.cleared).forEach((t) => t.fn()),
  };
}

function setup(t, { enabled = false, snapshots = [snapshot("a")] } = {}) {
  const file = tmpFile(t);
  let clock = T0;
  const state = { enabled, snapshots };
  const store = new MetricsHistory({ filePath: file, now: () => clock });
  const timers = fakeTimers();
  const runtime = createMetricsHistoryRuntime({
    store,
    orderedSnapshots: () => state.snapshots,
    monitors: new Map(),
    isEnabled: () => state.enabled,
    now: () => clock,
    ...timers,
    logError: () => {},
  });
  return {
    file,
    state,
    store,
    runtime,
    timers,
    advance: (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
}

test("disabled: nothing is recorded and no file is written, even on shutdown", (t) => {
  const { file, store, runtime, timers, advance } = setup(t, { enabled: false });
  runtime.start();
  for (let i = 0; i < 40; i++) {
    advance(HISTORY_SAMPLE_INTERVAL_MS);
    timers.fire(HISTORY_SAMPLE_INTERVAL_MS);
  }
  timers.fire(HISTORY_FLUSH_INTERVAL_MS);
  runtime.stop();
  assert.deepEqual(store.unitIds, []);
  assert.equal(fs.existsSync(file), false);
});

test("turning the setting on starts recording on the next tick, no restart", (t) => {
  const { file, state, store, runtime, timers, advance, now } = setup(t, { enabled: false });
  runtime.start();
  assert.equal(store.query("a", "1h", now()).points.length, 0);
  state.enabled = true;
  advance(HISTORY_SAMPLE_INTERVAL_MS);
  timers.fire(HISTORY_SAMPLE_INTERVAL_MS);
  assert.equal(store.query("a", "1h", now()).points.length, 1);
  timers.fire(HISTORY_FLUSH_INTERVAL_MS);
  assert.equal(fs.existsSync(file), true);

  // Off again: recording stops; shutdown still flushes what was recorded.
  state.enabled = false;
  advance(HISTORY_SAMPLE_INTERVAL_MS);
  timers.fire(HISTORY_SAMPLE_INTERVAL_MS);
  assert.equal(store.dirty, false);
  assert.equal(runtime.stop(), true);
  assert.ok(timers.timers.every((timer) => timer.cleared));
});

test("an offline unit records a gap", (t) => {
  const { state, store, runtime, timers, advance, now } = setup(t, { enabled: true });
  runtime.start();
  state.snapshots = [snapshot("a", { online: false })];
  for (let i = 0; i < 10; i++) {
    advance(HISTORY_SAMPLE_INTERVAL_MS);
    timers.fire(HISTORY_SAMPLE_INTERVAL_MS);
  }
  const points = store.query("a", "1h", now()).points;
  assert.equal(points.length, 1, "only the first (online) sample");
});

test("stale or failed collections are not values", () => {
  const at = T0;
  const fresh = monitorFreshness(
    {
      _metricCollectionSuccessful: { gpu: true, cpu: false },
      _lastUpdate: { gpu: at - 1_000, cpu: at - 1_000, network: at - MAX_DOMAIN_AGE_MS - 1 },
    },
    at
  );
  assert.equal(fresh("gpu"), true);
  assert.equal(fresh("cpu"), false, "failed collection");
  assert.equal(fresh("network"), false, "stale");
  assert.equal(fresh("llm"), false, "never collected");
  assert.equal(monitorFreshness(undefined, at)("gpu"), true);
});

test("the staleness window follows the monitor's current poll interval", () => {
  const at = T0;
  // Settings → Poll interval 10 s: a 20 s old reading is still the latest poll.
  const slow = { gpu: 10_000, cpu: 10_000, network: 10_000, ram: 10_000, memory: 10_000, llm: 10_000, comfy: 10_000 };
  assert.equal(maxDomainAgeMs(slow), 30_000);
  const fresh = monitorFreshness(
    {
      _fastIntervals: slow,
      _metricCollectionSuccessful: { gpu: true, cpu: true },
      _lastUpdate: { gpu: at - 20_000, cpu: at - 31_000 },
    },
    at
  );
  assert.equal(fresh("gpu"), true, "within three 10 s polls");
  assert.equal(fresh("cpu"), false, "older than three 10 s polls");
  // 1 s polling never shrinks the window below 15 s; no bookkeeping → env window.
  assert.equal(maxDomainAgeMs({ gpu: 1_000, memory: 2_000 }), 15_000);
  assert.equal(maxDomainAgeMs(undefined), MAX_DOMAIN_AGE_MS);
});

// ─── Route ────────────────────────────────────────────────

async function serve(t, deps) {
  const app = express();
  registerMetricsHistoryRoute(app, deps);
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.on("error", reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return (p) => fetch(`http://127.0.0.1:${port}${p}`);
}

test("GET /api/sparks/:id/history validates the unit and the range", async (t) => {
  let enabled = true;
  const store = new MetricsHistory({ now: () => T0 });
  store.record([{ id: "a", values: { gpuUtil: 42 } }], T0);
  const get = await serve(t, {
    store,
    hasUnit: (id) => id === "a",
    isEnabled: () => enabled,
    now: () => T0,
  });

  assert.equal((await get("/api/sparks/zzz/history?range=1h")).status, 404);
  for (const bad of ["2h", "", "1H", "constructor", "toString"]) {
    const res = await get(`/api/sparks/a/history?range=${bad}`);
    assert.equal(res.status, 400, `range=${bad}`);
    assert.match((await res.json()).error, /1h, 6h, 24h, 7d, 30d/);
  }
  assert.equal((await get("/api/sparks/a/history?range=1h&range=6h")).status, 400);

  const ok = await get("/api/sparks/a/history?range=6h");
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.enabled, true);
  assert.equal(body.range, "6h");
  assert.equal(body.stepMs, 60_000);
  assert.deepEqual(body.points, [{ t: T0, gpuUtil: { avg: 42, max: 42 } }]);
  assert.deepEqual(body.llm, []);

  // No range → 1h.
  assert.equal((await (await get("/api/sparks/a/history")).json()).range, "1h");

  enabled = false;
  assert.deepEqual(await (await get("/api/sparks/a/history?range=24h")).json(), { enabled: false });
});
