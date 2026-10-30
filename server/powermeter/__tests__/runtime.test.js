import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createPowerMeterRuntime } from "../runtime.js";
import { validatePowerMeterConfig } from "../config.js";
import { PowerMeterProvider } from "../providers/PowerMeterProvider.js";
import { FleetEnergyTracker } from "../../energy/FleetEnergyTracker.js";

const quiet = { warn() {}, log() {}, error() {} };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-10-29T20:00:00Z");
const SINCE = Date.parse("2026-08-13T00:00:00Z");

function okConfig(overrides = {}) {
  const { config, error } = validatePowerMeterConfig({
    meters: { strip: { type: "homeassistant", url: "https://ha.lan" } },
    units: {
      "spark-a": { meter: "strip", channel: "sensor.p3", since: "2026-08-13T00:00:00Z" },
      "spark-b": { meter: "strip", channel: "sensor.p4" },
    },
    ...overrides,
  });
  assert.equal(error, undefined);
  return { status: "ok", filePath: "/test/power-meters.json", config };
}

/** A scriptable meter that keeps history, built on the real interface. */
class FakeStrip extends PowerMeterProvider {
  static type = "fake";
  static label = "Fake strip";
  static historyPeriods = Object.freeze(["5minute", "hour"]);
  readings = new Map();
  history = { "5minute": new Map(), hour: new Map() };
  calls = [];
  failHistory = null;
  describe() {
    return { type: "fake", target: "fake://strip" };
  }
  async readPower(channels) {
    return new Map(channels.map((c) => [c, this.readings.get(c) ?? { watts: null, atMs: null, error: "no data" }]));
  }
  async readHistory(channels, { fromMs, toMs, period }) {
    this.calls.push({ period, fromMs, toMs });
    if (this.failHistory) throw new Error(this.failHistory);
    return new Map(channels.map((c) => [c, (this.history[period].get(c) ?? []).filter((p) => p.startMs >= fromMs && p.endMs <= toMs)]));
  }
}

class LivePlug extends PowerMeterProvider {
  static type = "plug";
  static label = "Live plug";
  async readPower(channels) {
    return new Map(channels.map((c) => [c, { watts: 10, atMs: T0 }]));
  }
}

function harness({ provider = new FakeStrip({}), configResult = okConfig(), createProviderFn, nodeIds = ["spark-a", "spark-b"] } = {}) {
  let clock = T0 + 2 * HOUR + 10_000;
  const tracker = new FleetEnergyTracker({ nodeIds, now: () => clock, load: false, setIntervalFn: null });
  const events = [];
  const runtime = createPowerMeterRuntime({
    configResult,
    tracker,
    now: () => clock,
    listUnits: () => nodeIds.map((id) => ({ id, name: id === "spark-a" ? "Dan" : "Stepan" })),
    recordEvent: (e) => events.push(e),
    createProviderFn: createProviderFn ?? (() => provider),
    logger: quiet,
  });
  return { runtime, tracker, provider, events, advance: (ms) => (clock += ms), at: () => clock };
}

async function serve(runtime) {
  const app = express();
  runtime.register(app);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { get: (p) => fetch(base + p), post: (p) => fetch(base + p, { method: "POST" }), close: () => new Promise((r) => server.close(r)) };
}

const hourRows = (from, count, meanW) =>
  Array.from({ length: count }, (_, i) => ({ startMs: from + i * HOUR, endMs: from + (i + 1) * HOUR, meanW }));

test("without a config file the runtime is inert and says so", async (t) => {
  let created = 0;
  const runtime = createPowerMeterRuntime({ configResult: { status: "absent" }, createProviderFn: () => created++, logger: quiet });
  assert.equal(runtime.enabled, false);
  runtime.start();
  assert.equal(created, 0);
  assert.equal(runtime.wallReadings(), null);
  assert.equal(runtime.renderPrometheus(), "");
  const http = await serve(runtime);
  t.after(http.close);
  assert.deepEqual(await (await http.get("/api/power-meters")).json(), { enabled: false, state: "absent" });
  assert.equal((await http.post("/api/power-meters/reconcile")).status, 404);
});

test("an invalid file keeps the feature off and reports why", () => {
  const runtime = createPowerMeterRuntime({ configResult: { status: "invalid", error: "units must map…" }, logger: quiet });
  assert.deepEqual(runtime.status(), { enabled: false, state: "invalid", error: "units must map…" });
});

test("readings are cached: wallReadings returns only fresh ones and never asks the meter", async () => {
  const { runtime, provider, at, advance } = harness();
  let reads = 0;
  const original = provider.readPower.bind(provider);
  provider.readPower = (...args) => {
    reads += 1;
    return original(...args);
  };
  provider.readings.set("sensor.p3", { watts: 60, atMs: at() - 2_000 });
  provider.readings.set("sensor.p4", { watts: 40, atMs: at() - 5 * MINUTE });
  await runtime.pollOnce();
  for (let i = 0; i < 5; i += 1) runtime.wallReadings();
  assert.equal(reads, 1);
  assert.deepEqual([...runtime.wallReadings()], [["spark-a", 60]]);
  // The cached reading itself goes stale as time passes.
  advance(40_000);
  assert.deepEqual([...runtime.wallReadings()], []);

  const [a, b] = runtime.status().units;
  assert.deepEqual([a.name, a.known, a.recorded, a.watts], ["Dan", true, true, 60]);
  assert.deepEqual([b.fresh, b.error], [false, "reading is stale"]);
});

test("health changes are announced in the activity log and exported", async () => {
  const { runtime, provider, events, at } = harness();
  const both = (watts) => {
    provider.readings.set("sensor.p3", { watts, atMs: at() });
    provider.readings.set("sensor.p4", { watts, atMs: at() });
  };
  both(50);
  await runtime.pollOnce();
  await runtime.pollOnce();
  provider.readings.set("sensor.p4", { watts: null, atMs: at(), error: "entity is unavailable" });
  await runtime.pollOnce();
  await runtime.pollOnce();
  both(50);
  await runtime.pollOnce();
  assert.deepEqual(
    events.map((e) => [e.type, e.severity]),
    [
      ["power-meter.connected", "success"],
      ["power-meter.unreachable", "error"],
      ["power-meter.recovered", "success"],
    ]
  );
  // The name comes from the provider that is running, not from the configured type.
  assert.equal(events[0].message, "Fake strip connected: 2 outlets");
  assert.equal(events[1].message, "Fake strip stopped reading: spark-b: entity is unavailable");
  assert.equal(events[2].message, "Fake strip is reading again");
  assert.equal(runtime.status().meters[0].label, "Fake strip");
  const metrics = runtime.renderPrometheus();
  assert.match(metrics, /sparkdash_power_meter_up\{meter="strip",type="homeassistant"\} 1\n/);
  assert.match(metrics, /sparkdash_wall_power_watts\{unit="spark-a",meter="strip"\} 50\n/);
  assert.equal(runtime.status().meters[0].health, "ok");
});

test("the first pass backfills: window minutes into the tracker, older hours into months", async () => {
  const { runtime, tracker, provider, events, at } = harness();
  const windowStart = tracker.windowStartMs(at());
  const from = windowStart - 10 * HOUR;
  provider.history.hour.set("sensor.p3", hourRows(from, 12, 55));
  provider.history.hour.set("sensor.p4", hourRows(from, 12, 45));
  const fiveMin = Math.floor((at() - 10 * MINUTE) / (5 * MINUTE)) * 5 * MINUTE;
  provider.history["5minute"].set("sensor.p3", [{ startMs: fiveMin, endMs: fiveMin + 5 * MINUTE, meanW: 70 }]);

  assert.equal(runtime.settledBefore(), -Infinity, "nothing settles before the first pass");
  await runtime.reconcileOnce();
  const hourCall = provider.calls.find((c) => c.period === "hour");
  assert.ok(hourCall.fromMs <= SINCE + HOUR, "backfill starts at the earliest since");

  // 10 hours before the window went to Monthly; the 2 inside it into minute buckets.
  const months = tracker.monthlySnapshot().months;
  const imported = months.reduce((sum, m) => sum + (m.nodes["spark-a"]?.wallWh ?? 0), 0);
  assert.ok(imported >= 10 * 55 - 1e-6, `imported ${imported}`);
  const rows = tracker.history(at()).hourly;
  assert.equal(rows.find((r) => r.t === windowStart)?.nodeWallWh["spark-a"], 55);
  assert.equal(rows.find((r) => r.t === windowStart)?.nodeWallMeteredMs["spark-a"], HOUR);

  const unit = runtime.status().units[0];
  assert.equal(unit.reconciledThroughMs, fiveMin + 5 * MINUTE);
  // spark-b has no recent figures from the meter, so it settles an hour behind.
  assert.equal(runtime.settledBefore(), Math.min(fiveMin + 5 * MINUTE, at() - HOUR));
  assert.equal(runtime.status().meters[0].history.state, "ok");
  assert.deepEqual(events.map((e) => e.type), ["power-meter.history-loaded"]);

  // Steady state: no second backfill, a short 5-minute lookback, no hourly fetch within the hour.
  provider.calls.length = 0;
  await runtime.reconcileOnce();
  assert.ok(provider.calls.every((c) => c.period === "5minute" && c.fromMs >= at() - 6 * HOUR - 5 * MINUTE));
  assert.deepEqual(events.map((e) => e.type), ["power-meter.history-loaded"]);
});

test("a failing history keeps live readings and is announced once", async () => {
  const { runtime, provider, events } = harness();
  provider.failHistory = "Home Assistant WebSocket timed out";
  await runtime.reconcileOnce();
  await runtime.reconcileOnce();
  const meter = runtime.status().meters[0];
  assert.equal(meter.history.state, "error");
  assert.match(meter.history.lastError, /timed out/);
  assert.deepEqual(events.map((e) => e.type), ["power-meter.history-failed"]);
  provider.failHistory = null;
  await runtime.reconcileOnce();
  assert.deepEqual(events.map((e) => e.type), ["power-meter.history-failed", "power-meter.history-loaded", "power-meter.history-recovered"]);
});

test("a meter without history settles at once and stays live-only", async () => {
  const { runtime } = harness({ provider: new LivePlug({}) });
  await runtime.reconcileOnce();
  assert.equal(runtime.status().meters[0].history.state, "unsupported");
  assert.equal(runtime.settledBefore(), Infinity);
});

test("a meter that cannot start marks its units without stopping the runtime", async () => {
  const { runtime } = harness({
    createProviderFn: () => {
      throw new Error("environment variable HOME_ASSISTANT_TOKEN is not set");
    },
  });
  await runtime.pollOnce();
  await runtime.reconcileOnce();
  const status = runtime.status();
  assert.equal(status.meters[0].health, "unavailable");
  assert.equal(status.meters[0].label, "Home Assistant", "a meter that could not start is still named by its provider");
  assert.match(status.meters[0].error, /HOME_ASSISTANT_TOKEN/);
  assert.equal(status.units[0].error, "environment variable HOME_ASSISTANT_TOKEN is not set");
  assert.deepEqual([...runtime.wallReadings()], []);
});

test("a provider must implement the interface", () => {
  const { runtime } = harness({ createProviderFn: () => ({ readPower: async () => new Map() }) });
  assert.match(runtime.status().meters[0].error, /does not extend PowerMeterProvider/);
});

test("a unit moved to another outlet loses its old wall minutes, not its months", async () => {
  const first = harness();
  first.tracker.applyWallPeriods("spark-a", [{ startMs: T0, endMs: T0 + HOUR, meanW: 50 }]);
  first.tracker.setWallState("spark-a", { key: "strip|homeassistant|sensor.old", marks: {}, backfill: "x" });
  // Same tracker, new config pointing spark-a at sensor.p3.
  createPowerMeterRuntime({ configResult: okConfig(), tracker: first.tracker, now: first.at, createProviderFn: () => first.provider, logger: quiet });
  const row = first.tracker.history(first.at()).hourly.find((r) => r.t === T0);
  assert.equal(row?.nodeWallWh?.["spark-a"] ?? 0, 0);
  assert.equal(first.tracker.wallState("spark-a"), null);
});

test("units the registry does not know are shown but not recorded", () => {
  const { runtime, tracker } = harness({ nodeIds: ["spark-a"] });
  assert.deepEqual(tracker.wallNodeIds, ["spark-a"]);
  const b = runtime.status().units.find((u) => u.id === "spark-b");
  assert.deepEqual([b.known, b.recorded], [false, false]);
});

test("status and reconcile routes", async (t) => {
  const { runtime } = harness();
  const http = await serve(runtime);
  t.after(http.close);
  const status = await (await http.get("/api/power-meters")).json();
  assert.equal(status.enabled, true);
  assert.equal(status.meters[0].target, "fake://strip");
  assert.equal(status.pollIntervalMs, 10_000);
  const reconciled = await http.post("/api/power-meters/reconcile");
  assert.equal(reconciled.status, 200);
  assert.equal((await reconciled.json()).meters[0].history.state, "ok");
});
