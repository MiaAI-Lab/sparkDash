import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import {
  FleetEnergyTracker as BaseFleetEnergyTracker,
  estimateNodeWatts,
} from "../../energy/FleetEnergyTracker.js";

const fleetEnergyRuntime = await import("../../energy/FleetEnergyRuntime.js").catch(() => ({}));

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const CANONICAL_NODE_IDS = Object.freeze([
  "node-a",
  "node-b",
  "node-c",
  "node-d",
]);

class FleetEnergyTracker extends BaseFleetEnergyTracker {
  constructor(options = {}) {
    super({ nodeIds: CANONICAL_NODE_IDS, ...options });
  }
}

function almostEqual(actual, expected, epsilon = 1e-10) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

function nodeSnapshot(
  id,
  {
    watts = 100,
    cpuUsage = 0,
    gpuDraw,
    online = true,
    fresh,
    telemetryFresh = true,
    role,
    outputTokens,
    outputAvailable = true,
    outputPort = 8000,
    llmEntries,
    llmPorts,
  } = {}
) {
  const cpuWatts = 5.2 + ((65 - 5.2) * Math.max(0, Math.min(100, cpuUsage))) / 100;
  const resolvedGpuDraw = gpuDraw ?? watts - cpuWatts - 23;
  const snapshot = {
    id,
    online,
    llmPorts:
      llmPorts ??
      (outputTokens === undefined && llmEntries === undefined ? [] : [outputPort]),
    metrics: {
      gpu: { power: { draw: resolvedGpuDraw } },
      cpu: { usage: cpuUsage },
      llm:
        llmEntries ??
        (outputTokens === undefined
          ? []
          : [{ available: outputAvailable, totalOutputTokens: outputTokens }]),
    },
  };
  if (fresh !== undefined) snapshot.fresh = fresh;
  if (telemetryFresh !== undefined) snapshot.telemetryFresh = telemetryFresh;
  if (role !== undefined) snapshot.role = role;
  return snapshot;
}

function fleetSnapshots(watts, { outputTokens } = {}) {
  return CANONICAL_NODE_IDS.map((id, index) =>
    nodeSnapshot(id, {
      watts,
      role: index === 0 ? "head" : "worker",
      outputTokens: index === 0 ? outputTokens : undefined,
    })
  );
}

function noTimerOptions() {
  return { filePath: null, load: false };
}

function runtimeFunction(name) {
  assert.equal(
    typeof fleetEnergyRuntime[name],
    "function",
    `FleetEnergyRuntime must export ${name}()`
  );
  return fleetEnergyRuntime[name];
}

function realShapeSnapshot(id = "node-a", overrides = {}) {
  return {
    id,
    name: id,
    online: true,
    role: id === "node-a" ? "head" : "worker",
    llmPorts: id === "node-a" ? [8000] : [],
    metrics: {
      gpu: {
        temperature: 42,
        usage: 0,
        power: { draw: 18.5, limit: 120, systemDraw: 44 },
        vram: { used: 0, total: 128_000, percentage: 0, available: 120_000 },
        processes: [],
        temperatureAverage1h: null,
        temperatureAverage1hSamples: 0,
        temperatureAverage1hCoverageMs: 0,
      },
      cpu: { usage: 0, temperature: 38, draw: 5.2, tdp: 65 },
      llm:
        id === "node-a"
          ? [{ available: true, totalOutputTokens: 100 }]
          : [],
    },
    ...overrides,
  };
}

function failedGpuSnapshot() {
  const snapshot = realShapeSnapshot();
  snapshot.metrics.gpu = {
    temperature: 0,
    usage: 0,
    power: { draw: 0, limit: 120, systemDraw: 0 },
    vram: { used: 0, total: 0, percentage: 0, available: 0 },
    processes: [],
    temperatureAverage1h: null,
    temperatureAverage1hSamples: 0,
    temperatureAverage1hCoverageMs: 0,
  };
  return snapshot;
}

function failedCpuSnapshot() {
  const snapshot = realShapeSnapshot();
  snapshot.metrics.cpu = { usage: 0, temperature: 0, draw: 0, tdp: 0 };
  return snapshot;
}

function monitorWithCollectionState({
  gpuAt,
  cpuAt,
  gpuSuccessful = true,
  cpuSuccessful = true,
} = {}) {
  return {
    _lastUpdate: { gpu: gpuAt, cpu: cpuAt },
    _metricCollectionSuccessful: {
      gpu: gpuSuccessful,
      cpu: cpuSuccessful,
    },
    collector: {
      wasLastCollectionSuccessful() {
        throw new Error("freshness must not read collector-global state");
      },
    },
  };
}

const APPROVED_RESPONSE_FIELDS = [
  "estimated",
  "membershipChanged",
  "restartRequired",
  "trackedNodeIds",
  "currentNodeIds",
  "freshNodeCount",
  "currentWatts30s",
  "energy24hKwh",
  "energy31dKwh",
  "whPerOutputToken24h",
  "outputTokens24h",
  "coverage24hMs",
  "coverage31dMs",
  "nodeCoverage24hMs",
  "nodeCoverage31dMs",
  "hourlyWatts24h",
];

function assertNullableFiniteNumber(value) {
  assert.ok(value === null || Number.isFinite(value));
}

function assertFleetEnergyResponseContract(response) {
  assert.deepEqual(Object.keys(response).sort(), [...APPROVED_RESPONSE_FIELDS].sort());
  assert.equal(typeof response.estimated, "boolean");
  assert.equal(typeof response.membershipChanged, "boolean");
  assert.equal(typeof response.restartRequired, "boolean");
  assert.equal(Array.isArray(response.trackedNodeIds), true);
  assert.equal(Array.isArray(response.currentNodeIds), true);
  for (const field of [
    "freshNodeCount",
    "outputTokens24h",
    "coverage24hMs",
    "coverage31dMs",
  ]) {
    assert.equal(typeof response[field], "number", field);
    assert.equal(Number.isFinite(response[field]), true, field);
  }
  for (const field of [
    "currentWatts30s",
    "energy24hKwh",
    "energy31dKwh",
    "whPerOutputToken24h",
  ]) {
    assertNullableFiniteNumber(response[field]);
  }
  for (const field of ["nodeCoverage24hMs", "nodeCoverage31dMs"]) {
    assert.deepEqual(Object.keys(response[field]), CANONICAL_NODE_IDS);
    assert.equal(
      Object.values(response[field]).every((value) => Number.isFinite(value)),
      true
    );
  }
  assert.equal(response.hourlyWatts24h.length, 24);
  response.hourlyWatts24h.forEach(assertNullableFiniteNumber);
}

test("power telemetry freshness accepts current and 10-second-old real monitor samples", () => {
  const hasFreshPowerTelemetry = runtimeFunction("hasFreshPowerTelemetry");
  const now = 50_000;
  const snapshot = realShapeSnapshot();

  assert.equal(
    hasFreshPowerTelemetry(
      snapshot,
      monitorWithCollectionState({ gpuAt: now, cpuAt: now }),
      now
    ),
    true
  );
  assert.equal(
    hasFreshPowerTelemetry(snapshot, { _lastUpdate: { gpu: now, cpu: now } }, now),
    false,
    "timestamps alone cannot distinguish a failed collection from a real idle sample"
  );
  assert.equal(
    hasFreshPowerTelemetry(
      snapshot,
      monitorWithCollectionState({ gpuAt: now - 10_000, cpuAt: now - 10_000 }),
      now
    ),
    true
  );
});

test("power telemetry freshness rejects liveness, clock, default-result, and power-input failures", () => {
  const hasFreshPowerTelemetry = runtimeFunction("hasFreshPowerTelemetry");
  const now = 50_000;
  const freshMonitor = monitorWithCollectionState({
    gpuAt: now - 1_000,
    cpuAt: now - 1_000,
  });
  const offline = realShapeSnapshot("node-a", { online: false });
  const nonfiniteGpuDraw = realShapeSnapshot();
  nonfiniteGpuDraw.metrics.gpu.power.draw = Number.NaN;
  const nonfiniteCpuUsage = realShapeSnapshot();
  nonfiniteCpuUsage.metrics.cpu.usage = Number.POSITIVE_INFINITY;

  const cases = [
    [offline, freshMonitor],
    [realShapeSnapshot(), monitorWithCollectionState({ cpuAt: now })],
    [realShapeSnapshot(), monitorWithCollectionState({ gpuAt: now + 1, cpuAt: now })],
    [realShapeSnapshot(), monitorWithCollectionState({ gpuAt: now - 10_001, cpuAt: now })],
    [realShapeSnapshot(), monitorWithCollectionState({ gpuAt: Number.NaN, cpuAt: now })],
    [
      realShapeSnapshot(),
      monitorWithCollectionState({ gpuAt: now, cpuAt: now, gpuSuccessful: false }),
    ],
    [
      realShapeSnapshot(),
      monitorWithCollectionState({ gpuAt: now, cpuAt: now, cpuSuccessful: false }),
    ],
    [failedGpuSnapshot(), freshMonitor],
    [failedCpuSnapshot(), freshMonitor],
    [nonfiniteGpuDraw, freshMonitor],
    [nonfiniteCpuUsage, freshMonitor],
  ];

  for (const [snapshot, monitor] of cases) {
    assert.equal(hasFreshPowerTelemetry(snapshot, monitor, now), false);
  }
});

test("one fleet-energy sampler tick records decorated clones without changing normal snapshots", () => {
  const runFleetEnergySamplerTick = runtimeFunction("runFleetEnergySamplerTick");
  const now = 50_000;
  const snapshots = [realShapeSnapshot("node-a"), failedCpuSnapshot()];
  snapshots[1].id = "node-b";
  snapshots[1].role = "worker";
  snapshots[1].llmPorts = [];
  snapshots[1].metrics.llm = [];
  let orderedCalls = 0;
  let recorded = null;
  const result = runFleetEnergySamplerTick({
    tracker: {
      record(decorated, atMs) {
        recorded = { decorated, atMs };
        return "recorded";
      },
    },
    orderedSnapshots() {
      orderedCalls += 1;
      return snapshots;
    },
    monitors: new Map([
      [
        "node-a",
        monitorWithCollectionState({ gpuAt: now - 2_000, cpuAt: now - 2_000 }),
      ],
      [
        "node-b",
        monitorWithCollectionState({ gpuAt: now - 2_000, cpuAt: now - 2_000 }),
      ],
    ]),
    now: () => now,
  });

  assert.equal(result, "recorded");
  assert.equal(orderedCalls, 1);
  assert.equal(recorded.atMs, now);
  assert.notEqual(recorded.decorated, snapshots);
  assert.notEqual(recorded.decorated[0], snapshots[0]);
  assert.equal(recorded.decorated[0].telemetryFresh, true);
  assert.equal(recorded.decorated[1].telemetryFresh, false);
  assert.equal(Object.hasOwn(snapshots[0], "telemetryFresh"), false);
  assert.equal(Object.hasOwn(snapshots[1], "telemetryFresh"), false);
});

test("fleet-energy handler returns the exact empty tracker response contract", () => {
  const createFleetEnergyHandler = runtimeFunction("createFleetEnergyHandler");
  const tracker = new FleetEnergyTracker({
    ...noTimerOptions(),
    now: () => Date.UTC(2026, 7, 23, 12, 34, 0),
  });
  let response;
  createFleetEnergyHandler(tracker)({}, { json: (value) => (response = value) });

  assertFleetEnergyResponseContract(response);
  assert.equal(response.currentWatts30s, null);
  assert.equal(response.energy24hKwh, null);
  assert.equal(response.energy31dKwh, null);
  assert.equal(response.whPerOutputToken24h, null);
  assert.deepEqual(response.hourlyWatts24h, Array(24).fill(null));
  assert.equal(response.membershipChanged, false);
  assert.deepEqual(response.trackedNodeIds, CANONICAL_NODE_IDS);
  assert.deepEqual(response.currentNodeIds, CANONICAL_NODE_IDS);
});

test("fleet-energy handler returns the exact populated tracker response contract", () => {
  const createFleetEnergyHandler = runtimeFunction("createFleetEnergyHandler");
  const now = Date.UTC(2026, 7, 23, 12, 34, 0);
  const tracker = new FleetEnergyTracker({ ...noTimerOptions(), now: () => now });
  tracker.record(fleetSnapshots(100, { outputTokens: 100 }), now - 30 * MINUTE_MS);
  tracker.record(fleetSnapshots(100, { outputTokens: 120 }), now - 30 * MINUTE_MS + 2_000);
  tracker.record(fleetSnapshots(100, { outputTokens: 120 }), now);
  let response;
  createFleetEnergyHandler(tracker)({}, { json: (value) => (response = value) });

  assertFleetEnergyResponseContract(response);
  assert.equal(response.freshNodeCount, 4);
  assert.equal(response.currentWatts30s, 400);
  assert.ok(response.energy24hKwh > 0);
  assert.ok(response.energy31dKwh > 0);
  assert.ok(response.whPerOutputToken24h > 0);
  assert.equal(response.outputTokens24h, 20);
  assert.equal(response.hourlyWatts24h.some(Number.isFinite), true);
});

test("fleet-energy membership changes invalidate aggregates until restart", () => {
  const now = Date.UTC(2026, 7, 23, 12, 34, 0);
  const tracker = new FleetEnergyTracker({ ...noTimerOptions(), now: () => now });
  tracker.record(fleetSnapshots(100, { outputTokens: 100 }), now - 2_000);
  tracker.record(fleetSnapshots(100, { outputTokens: 120 }), now);
  assert.equal(tracker.snapshot(now).currentWatts30s, 400);

  assert.equal(tracker.invalidateMembership([...CANONICAL_NODE_IDS, "node-e"]), true);
  const changed = tracker.snapshot(now);
  assert.equal(changed.membershipChanged, true);
  assert.equal(changed.restartRequired, true);
  assert.deepEqual(changed.trackedNodeIds, CANONICAL_NODE_IDS);
  assert.deepEqual(changed.currentNodeIds, [...CANONICAL_NODE_IDS, "node-e"]);
  assert.equal(changed.freshNodeCount, 0);
  assert.equal(changed.currentWatts30s, null);
  assert.equal(changed.energy24hKwh, null);
  assert.equal(changed.energy31dKwh, null);
  assert.equal(changed.whPerOutputToken24h, null);
  assert.deepEqual(changed.hourlyWatts24h, Array(24).fill(null));
});

test("fleet-energy runtime samples without WebSockets and schedules decorated ticks every 2000ms", () => {
  const createFleetEnergyRuntime = runtimeFunction("createFleetEnergyRuntime");
  const now = 50_000;
  const snapshots = [realShapeSnapshot("node-a")];
  const records = [];
  let scheduled = null;
  let intervalCalls = 0;
  const runtime = createFleetEnergyRuntime({
    tracker: {
      record(inputs, atMs) {
        records.push({ inputs, atMs });
      },
      close() {},
    },
    orderedSnapshots: () => snapshots,
    monitors: new Map([
      [
        "node-a",
        monitorWithCollectionState({ gpuAt: now - 2_000, cpuAt: now - 2_000 }),
      ],
    ]),
    now: () => now,
    setIntervalFn(callback, intervalMs) {
      intervalCalls += 1;
      scheduled = { callback, intervalMs, timer: Symbol("energy-timer") };
      return scheduled.timer;
    },
    clearIntervalFn() {},
    logError() {},
  });

  runtime.start();
  runtime.start();
  assert.equal(records.length, 1, "start performs one immediate sample even without WS clients");
  assert.equal(intervalCalls, 1, "start is idempotent");
  assert.equal(scheduled.intervalMs, 2_000);
  assert.equal(records[0].inputs[0].telemetryFresh, true);
  assert.equal(Object.hasOwn(snapshots[0], "telemetryFresh"), false);

  scheduled.callback();
  assert.equal(records.length, 2);
  assert.equal(records[1].atMs, now);
  assert.equal(records[1].inputs[0].telemetryFresh, true);
});

test("fleet-energy startup helper starts monitors before the sampler", () => {
  const startFleetEnergyCollection = runtimeFunction("startFleetEnergyCollection");
  const events = [];

  startFleetEnergyCollection({
    startAllMonitors: () => events.push("monitors"),
    energyRuntime: { start: () => events.push("sampler") },
  });

  assert.deepEqual(events, ["monitors", "sampler"]);
});

test("fleet-energy runtime retries one transient close failure and stays idempotent", () => {
  const createFleetEnergyRuntime = runtimeFunction("createFleetEnergyRuntime");
  const timer = Symbol("energy-timer");
  const cleared = [];
  const logged = [];
  let closeCalls = 0;
  const runtime = createFleetEnergyRuntime({
    tracker: {
      record() {},
      close() {
        closeCalls += 1;
        if (closeCalls === 1) throw new Error("transient close failure");
      },
    },
    orderedSnapshots: () => [],
    monitors: new Map(),
    setIntervalFn: () => timer,
    clearIntervalFn: (received) => cleared.push(received),
    logError: (...args) => logged.push(args),
  });

  runtime.start();
  assert.equal(runtime.stop(), true);
  assert.equal(runtime.stop(), true);

  assert.deepEqual(cleared, [timer]);
  assert.equal(closeCalls, 2);
  assert.equal(logged.length, 1);
  assert.match(logged[0].map(String).join(" "), /transient close failure/);
});

test("fleet-energy runtime contains two persistent close failures and returns false", () => {
  const createFleetEnergyRuntime = runtimeFunction("createFleetEnergyRuntime");
  const timer = Symbol("energy-timer");
  const cleared = [];
  const logged = [];
  let closeCalls = 0;
  const runtime = createFleetEnergyRuntime({
    tracker: {
      record() {},
      close() {
        closeCalls += 1;
        throw new Error(`persistent close failure ${closeCalls}`);
      },
    },
    orderedSnapshots: () => [],
    monitors: new Map(),
    setIntervalFn: () => timer,
    clearIntervalFn: (received) => cleared.push(received),
    logError: (...args) => logged.push(args),
  });

  runtime.start();
  assert.equal(runtime.stop(), false);
  assert.equal(runtime.stop(), false);

  assert.deepEqual(cleared, [timer]);
  assert.equal(closeCalls, 2);
  assert.equal(logged.length, 2);
  assert.match(logged[0].map(String).join(" "), /persistent close failure 1/);
  assert.match(logged[1].map(String).join(" "), /persistent close failure 2/);
});

test("fleet-energy server-close handler exits non-zero only after failed persistence", () => {
  const createFleetEnergyExitHandler = runtimeFunction("createFleetEnergyExitHandler");
  const exitCodes = [];

  createFleetEnergyExitHandler(true, (code) => exitCodes.push(code))();
  createFleetEnergyExitHandler(false, (code) => exitCodes.push(code))();

  assert.deepEqual(exitCodes, [0, 1]);
});

test("registered fleet-energy GET is read-only and serves the exact contract", async (t) => {
  const registerFleetEnergyRoute = runtimeFunction("registerFleetEnergyRoute");
  const tracker = new FleetEnergyTracker({
    ...noTimerOptions(),
    now: () => Date.UTC(2026, 7, 23, 12, 34, 0),
  });
  const app = express();
  registerFleetEnergyRoute(app, tracker);

  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.on("error", reject);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      })
  );
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}/api/fleet-energy`;

  const read = await fetch(endpoint);
  assert.equal(read.status, 200);
  const response = await read.json();
  assertFleetEnergyResponseContract(response);
  assert.equal(response.currentWatts30s, null);
  assert.equal(response.energy24hKwh, null);
  assert.deepEqual(response.hourlyWatts24h, Array(24).fill(null));

  for (const method of ["POST", "PUT", "DELETE"]) {
    const mutation = await fetch(endpoint, {
      method,
    });
    assert.equal(mutation.status, 404, `${method} must not be registered`);
  }
});

test("estimator models CPU at 0, 50, and 100 percent without using systemDraw", () => {
  const atCpu = (usage) =>
    estimateNodeWatts({
      online: true,
      telemetryFresh: true,
      metrics: {
        gpu: { power: { draw: 10, systemDraw: 999 } },
        cpu: { usage },
      },
    });

  almostEqual(atCpu(0), 38.2);
  almostEqual(atCpu(50), 68.1);
  almostEqual(atCpu(100), 98);
});

test("estimator clamps CPU usage and total node power", () => {
  almostEqual(estimateNodeWatts(nodeSnapshot("node-a", { cpuUsage: -20, gpuDraw: 10 })), 38.2);
  almostEqual(estimateNodeWatts(nodeSnapshot("node-a", { cpuUsage: 120, gpuDraw: 10 })), 98);
  assert.equal(estimateNodeWatts(nodeSnapshot("node-a", { gpuDraw: 500 })), 240);
});

test("estimator requires explicit telemetryFresh true", () => {
  const onlineOnly = nodeSnapshot("node-a", { online: true });
  delete onlineOnly.telemetryFresh;
  assert.equal(
    estimateNodeWatts(onlineOnly),
    null
  );
  assert.equal(
    estimateNodeWatts(nodeSnapshot("node-a", { online: true, telemetryFresh: false })),
    null
  );
  assert.equal(
    estimateNodeWatts(nodeSnapshot("node-a", { online: false, telemetryFresh: true })),
    100
  );
  assert.equal(estimateNodeWatts(nodeSnapshot("node-a", { gpuDraw: -1 })), null);
  assert.equal(estimateNodeWatts(nodeSnapshot("node-a", { cpuUsage: Number.NaN })), null);
});

test("record integrates constant and changing power with trapezoids", () => {
  const constant = new FleetEnergyTracker(noTimerOptions());
  constant.record([nodeSnapshot("node-a", { watts: 100 })], 0);
  constant.record([nodeSnapshot("node-a", { watts: 100 })], 10_000);
  almostEqual(constant.snapshot(10_000).energy24hKwh, (100 * 10_000) / 3_600_000 / 1000);

  const changing = new FleetEnergyTracker(noTimerOptions());
  changing.record([nodeSnapshot("node-a", { watts: 100 })], 0);
  changing.record([nodeSnapshot("node-a", { watts: 200 })], 10_000);
  almostEqual(changing.snapshot(10_000).energy24hKwh, (150 * 10_000) / 3_600_000 / 1000);
});

test("integration splits energy and coverage at UTC minute boundaries", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-energy-split-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "fleet-energy.json");
  const minute = Date.UTC(2026, 7, 23, 12, 0, 0);
  const tracker = new FleetEnergyTracker({
    filePath,
    load: false,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });

  tracker.record([nodeSnapshot("node-a", { watts: 100 })], minute + 59_000);
  tracker.record([nodeSnapshot("node-a", { watts: 100 })], minute + 61_000);
  assert.equal(tracker.flush(), true);

  const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.deepEqual(
    saved.buckets.map((bucket) => bucket.minuteStartMs),
    [minute, minute + MINUTE_MS]
  );
  for (const bucket of saved.buckets) {
    almostEqual(bucket.nodeWh["node-a"], 100 / 3_600);
    assert.equal(bucket.nodeCoverageMs["node-a"], 1_000);
  }
});

test("a 10 second gap integrates but a longer gap resets the node baseline", () => {
  const tracker = new FleetEnergyTracker(noTimerOptions());
  tracker.record([nodeSnapshot("node-a", { watts: 100 })], 0);
  tracker.record([nodeSnapshot("node-a", { watts: 100 })], 10_000);
  tracker.record([nodeSnapshot("node-a", { watts: 200 })], 20_001);
  tracker.record([nodeSnapshot("node-a", { watts: 200 })], 22_001);

  const expectedWh = (100 * 10_000 + 200 * 2_000) / 3_600_000;
  almostEqual(tracker.snapshot(22_001).energy24hKwh, expectedWh / 1000);
});

test("a disappearing node cannot invent a ramp when it reappears", () => {
  const tracker = new FleetEnergyTracker(noTimerOptions());
  tracker.record([nodeSnapshot("node-a", { watts: 100 })], 0);
  tracker.record([], 2_000);
  tracker.record([nodeSnapshot("node-a", { watts: 200 })], 4_000);
  tracker.record([nodeSnapshot("node-a", { watts: 200 })], 6_000);

  almostEqual(tracker.snapshot(6_000).energy24hKwh, (200 * 2_000) / 3_600_000 / 1000);
});

test("full-fleet samples drive the arithmetic 30 second mean and simultaneous coverage", () => {
  const tracker = new FleetEnergyTracker(noTimerOptions());
  tracker.record(fleetSnapshots(100), 0);
  tracker.record(fleetSnapshots(200), 2_000);
  tracker.record(fleetSnapshots(300).slice(0, 3), 4_000);
  tracker.record(fleetSnapshots(300), 6_000);

  const snapshot = tracker.snapshot(6_000);
  assert.equal(snapshot.freshNodeCount, 4);
  almostEqual(snapshot.currentWatts30s, (400 + 800 + 960) / 3);
  assert.equal(snapshot.coverage24hMs, 2_000);
  assert.equal(snapshot.coverage31dMs, 2_000);
  assert.deepEqual(snapshot.nodeCoverage24hMs, {
    "node-a": 6_000,
    "node-b": 6_000,
    "node-c": 6_000,
    "node-d": 2_000,
  });
  assert.deepEqual(Object.keys(snapshot.nodeCoverage31dMs), CANONICAL_NODE_IDS);
});

test("currentWatts30s excludes stale full-fleet samples and is null without any", () => {
  const tracker = new FleetEnergyTracker(noTimerOptions());
  assert.equal(tracker.snapshot(0).currentWatts30s, null);
  tracker.record(fleetSnapshots(100), 0);
  tracker.record(fleetSnapshots(200), 31_000);
  assert.equal(tracker.snapshot(31_000).currentWatts30s, 800);
});

test("a backward wall-clock step clears live baselines without recounting prior intervals", () => {
  const tracker = new FleetEnergyTracker(noTimerOptions());
  tracker.record(fleetSnapshots(100), 10_000);
  tracker.record(fleetSnapshots(100), 12_000);

  assert.equal(tracker.record(fleetSnapshots(200), 5_000), true);
  assert.equal(tracker.snapshot(5_000).currentWatts30s, 800);
  assert.equal(tracker.record(fleetSnapshots(200), 7_000), true);
  assert.equal(tracker.record(fleetSnapshots(200), 7_000), false);

  const expectedKwh = (400 * 2_000) / 3_600_000 / 1000;
  almostEqual(tracker.snapshot(7_000).energy24hKwh, expectedKwh);
});

test("rollback catch-up clips and interpolates an interval that straddles high-water", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-energy-straddle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "fleet-energy.json");
  let now = 0;
  const tracker = new FleetEnergyTracker({
    filePath,
    load: false,
    now: () => now,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  tracker.record(fleetSnapshots(100), 0);
  tracker.record(fleetSnapshots(100), 10_000);

  tracker.record(fleetSnapshots(100), 4_000);
  tracker.record(fleetSnapshots(100), 8_000);
  now = 12_000;
  tracker.record(fleetSnapshots(200), now);

  const snapshot = tracker.snapshot(now);
  assert.equal(snapshot.coverage24hMs, 12_000);
  assert.deepEqual(
    snapshot.nodeCoverage24hMs,
    Object.fromEntries(CANONICAL_NODE_IDS.map((id) => [id, 12_000]))
  );
  almostEqual(snapshot.energy24hKwh, 5_400_000 / 3_600_000 / 1000);

  tracker.flush();
  const bucket = JSON.parse(fs.readFileSync(filePath, "utf8")).buckets[0];
  almostEqual(bucket.fleetWattMs, 5_400_000);
  for (const id of CANONICAL_NODE_IDS) {
    almostEqual(bucket.nodeWh[id], 1_350_000 / 3_600_000);
  }
});

test("rollback suppression survives reload and prevents duplicate UTC-minute energy", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-energy-rollback-reload-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "fleet-energy.json");
  let now = 0;
  const timerOptions = { setIntervalFn: () => 1, clearIntervalFn: () => {} };
  const first = new FleetEnergyTracker({
    filePath,
    load: false,
    now: () => now,
    ...timerOptions,
  });

  for (let atMs = 0; atMs <= MINUTE_MS; atMs += 10_000) {
    first.record(fleetSnapshots(100), atMs);
  }
  const beforeRollback = first.snapshot(MINUTE_MS);
  assert.equal(beforeRollback.coverage24hMs, MINUTE_MS);
  assert.deepEqual(
    beforeRollback.nodeCoverage24hMs,
    Object.fromEntries(CANONICAL_NODE_IDS.map((id) => [id, MINUTE_MS]))
  );

  first.record(fleetSnapshots(100), 0);
  first.record(fleetSnapshots(100), 10_000);
  now = 20_000;
  first.record(fleetSnapshots(100), now);
  first.flush();

  const rolledBackState = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const completedMinute = rolledBackState.buckets.find((bucket) => bucket.minuteStartMs === 0);
  assert.equal(completedMinute.fleetCoverageMs, MINUTE_MS);
  assert.ok(Object.values(completedMinute.nodeCoverageMs).every((value) => value <= MINUTE_MS));
  assert.equal(rolledBackState.integrationHighWaterMs, MINUTE_MS);

  const second = new FleetEnergyTracker({ filePath, now: () => now, ...timerOptions });
  const afterReload = second.snapshot(now);
  assert.equal(afterReload.coverage24hMs, beforeRollback.coverage24hMs);
  almostEqual(afterReload.energy24hKwh, beforeRollback.energy24hKwh);

  for (const atMs of [30_000, 40_000, 50_000, 60_000, 70_000, 80_000]) {
    now = atMs;
    second.record(fleetSnapshots(100), atMs);
  }
  const caughtUp = second.snapshot(now);
  assert.equal(caughtUp.coverage24hMs, 80_000);
  assert.deepEqual(
    caughtUp.nodeCoverage24hMs,
    Object.fromEntries(CANONICAL_NODE_IDS.map((id) => [id, 80_000]))
  );
  almostEqual(caughtUp.energy24hKwh, (400 * 80_000) / 3_600_000 / 1000);

  second.flush();
  const caughtUpState = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.ok(caughtUpState.buckets.every((bucket) => bucket.fleetCoverageMs <= MINUTE_MS));
  assert.ok(
    caughtUpState.buckets.every((bucket) =>
      Object.values(bucket.nodeCoverageMs).every((value) => value <= MINUTE_MS)
    )
  );
});

test("reload repairs a safe but impossible high-water so integration can resume", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-energy-high-water-repair-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "fleet-energy.json");
  const nodeCoverageMs = Object.fromEntries(CANONICAL_NODE_IDS.map((id) => [id, 10_000]));
  const nodeWh = Object.fromEntries(
    CANONICAL_NODE_IDS.map((id) => [id, (100 * 10_000) / 3_600_000])
  );
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      version: 1,
      nodeIds: CANONICAL_NODE_IDS,
      integrationHighWaterMs: Number.MAX_SAFE_INTEGER,
      buckets: [{
        minuteStartMs: 0,
        nodeWh,
        nodeCoverageMs,
        fleetWattMs: 400 * 10_000,
        fleetCoverageMs: 10_000,
        outputTokens: 0,
      }],
    })
  );

  let now = MINUTE_MS;
  const tracker = new FleetEnergyTracker({
    filePath,
    now: () => now,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  tracker.record(fleetSnapshots(100), now);
  now += 2_000;
  tracker.record(fleetSnapshots(100), now);

  const snapshot = tracker.snapshot(now);
  assert.equal(snapshot.coverage24hMs, 12_000);
  almostEqual(snapshot.energy24hKwh, (400 * 12_000) / 3_600_000 / 1000);
  tracker.flush();
  assert.equal(
    JSON.parse(fs.readFileSync(filePath, "utf8")).integrationHighWaterMs,
    now
  );
});

test("reload repairs high-water below credited coverage before catch-up", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-energy-high-water-coverage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "fleet-energy.json");
  const nodeCoverageMs = Object.fromEntries(CANONICAL_NODE_IDS.map((id) => [id, MINUTE_MS]));
  const nodeWh = Object.fromEntries(
    CANONICAL_NODE_IDS.map((id) => [id, (100 * MINUTE_MS) / 3_600_000])
  );
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      version: 1,
      nodeIds: CANONICAL_NODE_IDS,
      integrationHighWaterMs: 1,
      buckets: [{
        minuteStartMs: 0,
        nodeWh,
        nodeCoverageMs,
        fleetWattMs: 400 * MINUTE_MS,
        fleetCoverageMs: MINUTE_MS,
        outputTokens: 0,
      }],
    })
  );

  let now = 1_000;
  const tracker = new FleetEnergyTracker({
    filePath,
    now: () => now,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  const beforeCatchUp = tracker.snapshot(now);
  tracker.record(fleetSnapshots(100), now);
  now = 2_000;
  tracker.record(fleetSnapshots(100), now);

  const afterCatchUp = tracker.snapshot(now);
  assert.equal(afterCatchUp.coverage24hMs, MINUTE_MS);
  assert.deepEqual(afterCatchUp.nodeCoverage24hMs, nodeCoverageMs);
  almostEqual(afterCatchUp.energy24hKwh, beforeCatchUp.energy24hKwh);

  tracker.flush();
  const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(saved.integrationHighWaterMs, MINUTE_MS);
  assert.equal(saved.buckets[0].fleetCoverageMs, MINUTE_MS);
  assert.deepEqual(saved.buckets[0].nodeCoverageMs, nodeCoverageMs);
});

test("flush persists a conservative safe-integer high-water for fractional clocks", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-energy-fractional-clock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "fleet-energy.json");
  let now = 0.25;
  const timerOptions = { setIntervalFn: () => 1, clearIntervalFn: () => {} };
  const first = new FleetEnergyTracker({
    filePath,
    load: false,
    now: () => now,
    ...timerOptions,
  });
  first.record(fleetSnapshots(100), now);
  now = 2_000.25;
  first.record(fleetSnapshots(100), now);
  first.flush();

  const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(saved.integrationHighWaterMs, 2_001);
  assert.equal(Number.isSafeInteger(saved.integrationHighWaterMs), true);

  const second = new FleetEnergyTracker({ filePath, now: () => now, ...timerOptions });
  assert.equal(second.snapshot(now).coverage24hMs, 2_000);
});

test("nonfinite clocks neither prune history nor freeze snapshot output", () => {
  const tracker = new FleetEnergyTracker({ ...noTimerOptions(), now: () => Number.NaN });
  tracker.record(fleetSnapshots(100), 0);
  tracker.record(fleetSnapshots(100), 2_000);
  const expected = tracker.snapshot(2_000);

  assert.equal(tracker.record(fleetSnapshots(200), Number.NaN), false);
  const fallback = tracker.snapshot();
  almostEqual(fallback.energy31dKwh, expected.energy31dKwh);
  assert.equal(fallback.currentWatts30s, expected.currentWatts30s);
  assert.equal(fallback.freshNodeCount, expected.freshNodeCount);

  const empty = new FleetEnergyTracker({ ...noTimerOptions(), now: () => Number.NaN });
  assert.equal(empty.snapshot().energy31dKwh, null);
  assert.equal(empty.snapshot().hourlyWatts24h.length, 24);
});

test("head output-token deltas accumulate while counter resets establish a new baseline", () => {
  const tracker = new FleetEnergyTracker(noTimerOptions());
  tracker.record(fleetSnapshots(100, { outputTokens: 100 }), 0);
  tracker.record(fleetSnapshots(100, { outputTokens: 150 }), 2_000);
  tracker.record(fleetSnapshots(100, { outputTokens: 25 }), 4_000);
  tracker.record(fleetSnapshots(100, { outputTokens: 40 }), 6_000);

  const snapshot = tracker.snapshot(6_000);
  assert.equal(snapshot.outputTokens24h, 65);
  const observedWh = (400 * 6_000) / 3_600_000;
  almostEqual(snapshot.whPerOutputToken24h, observedWh / 65);
});

test("a short unavailable token-source gap preserves the baseline", () => {
  const tracker = new FleetEnergyTracker(noTimerOptions());
  tracker.record(fleetSnapshots(100, { outputTokens: 1_000 }), 0);
  const unavailable = fleetSnapshots(100, { outputTokens: 0 });
  unavailable[0].metrics.llm[0].available = false;
  tracker.record(unavailable, 2_000);
  tracker.record(fleetSnapshots(100, { outputTokens: 1_020 }), 4_000);

  assert.equal(tracker.snapshot(4_000).outputTokens24h, 20);
});

test("a backward clock rebases tokens even when rollback telemetry is unavailable", () => {
  const tracker = new FleetEnergyTracker(noTimerOptions());
  tracker.record(fleetSnapshots(100, { outputTokens: 100 }), 10_000);
  tracker.record(fleetSnapshots(100, { outputTokens: 120 }), 12_000);

  const unavailable = fleetSnapshots(100, { outputTokens: 0 });
  unavailable[0].metrics.llm[0].available = false;
  tracker.record(unavailable, 5_000);
  tracker.record(fleetSnapshots(100, { outputTokens: 140 }), 12_000);
  assert.equal(tracker.snapshot(12_000).outputTokens24h, 20);

  tracker.record(fleetSnapshots(100, { outputTokens: 145 }), 14_000);
  assert.equal(tracker.snapshot(14_000).outputTokens24h, 25);
});

test("token observation gaps over 10 seconds and source changes rebase", () => {
  const tracker = new FleetEnergyTracker(noTimerOptions());
  tracker.record(fleetSnapshots(100, { outputTokens: 100 }), 0);
  tracker.record(fleetSnapshots(100, { outputTokens: 150 }), 10_001);
  tracker.record(fleetSnapshots(100, { outputTokens: 160 }), 12_001);

  const changedPort = fleetSnapshots(100, { outputTokens: 900 });
  changedPort[0].llmPorts[0] = 9000;
  tracker.record(changedPort, 14_001);
  const sameChangedPort = fleetSnapshots(100, { outputTokens: 910 });
  sameChangedPort[0].llmPorts[0] = 9000;
  tracker.record(sameChangedPort, 16_001);

  assert.equal(tracker.snapshot(16_001).outputTokens24h, 20);
});

test("token source requires exactly one canonical head and ignores noncanonical heads", () => {
  const tracker = new FleetEnergyTracker(noTimerOptions());
  const withIntruder = fleetSnapshots(100, { outputTokens: 100 });
  withIntruder.push(
    nodeSnapshot("spark-intruder", { role: "head", outputTokens: 9_000 })
  );
  tracker.record(withIntruder, 0);
  const withIntruderAgain = fleetSnapshots(100, { outputTokens: 120 });
  withIntruderAgain.push(
    nodeSnapshot("spark-intruder", { role: "head", outputTokens: 9_100 })
  );
  tracker.record(withIntruderAgain, 2_000);

  const duplicateHeads = fleetSnapshots(100, { outputTokens: 999 });
  duplicateHeads[1].role = "head";
  duplicateHeads[1].llmPorts = [8000];
  duplicateHeads[1].metrics.llm = [
    { available: true, totalOutputTokens: 500 },
  ];
  tracker.record(duplicateHeads, 4_000);
  tracker.record(fleetSnapshots(100, { outputTokens: 130 }), 6_000);

  assert.equal(tracker.snapshot(6_000).outputTokens24h, 30);
});

test("token source ignores unavailable siblings but rejects ambiguous available entries", () => {
  const tracker = new FleetEnergyTracker(noTimerOptions());
  const first = fleetSnapshots(100, { outputTokens: 100 });
  first[0].llmPorts = [7000, 8000, 9000];
  first[0].metrics.llm = [
    { available: false, totalOutputTokens: 0 },
    { available: true, totalOutputTokens: 100 },
    { available: false, totalOutputTokens: 0 },
  ];
  tracker.record(first, 0);

  const second = fleetSnapshots(100, { outputTokens: 120 });
  second[0].llmPorts = [7000, 8000, 9000];
  second[0].metrics.llm = [
    { available: false, totalOutputTokens: 0 },
    { available: true, totalOutputTokens: 120 },
    { available: false, totalOutputTokens: 0 },
  ];
  tracker.record(second, 2_000);

  const ambiguous = fleetSnapshots(100, { outputTokens: 110 });
  ambiguous[0].llmPorts = [8000, 9000];
  ambiguous[0].metrics.llm = [
    { available: true, totalOutputTokens: 130 },
    { available: true, totalOutputTokens: 5 },
  ];
  tracker.record(ambiguous, 4_000);

  const afterAmbiguous = fleetSnapshots(100, { outputTokens: 140 });
  tracker.record(afterAmbiguous, 6_000);

  assert.equal(tracker.snapshot(6_000).outputTokens24h, 40);
});

test("token source requires a matching safe-integer llmPorts entry and counter", () => {
  const tracker = new FleetEnergyTracker(noTimerOptions());
  tracker.record(fleetSnapshots(100, { outputTokens: 100 }), 0);

  const invalidCounters = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1];
  for (const [index, invalid] of invalidCounters.entries()) {
    const snapshots = fleetSnapshots(100, { outputTokens: invalid });
    tracker.record(snapshots, 2_000 + index * 1_000);
  }

  const invalidPort = fleetSnapshots(100, { outputTokens: 120 });
  invalidPort[0].llmPorts[0] = 8000.5;
  tracker.record(invalidPort, 5_000);
  const mismatched = fleetSnapshots(100, { outputTokens: 125 });
  mismatched[0].llmPorts = [];
  tracker.record(mismatched, 6_000);
  tracker.record(fleetSnapshots(100, { outputTokens: 130 }), 8_000);

  assert.equal(tracker.snapshot(8_000).outputTokens24h, 30);
});

test("LLM port reordering and changes rebase instead of cross-counting counters", () => {
  const tracker = new FleetEnergyTracker(noTimerOptions());
  tracker.record(fleetSnapshots(100, { outputTokens: 100 }), 0);

  const reordered = fleetSnapshots(100, { outputTokens: 900 });
  reordered[0].llmPorts = [9000, 8000];
  reordered[0].metrics.llm = [
    { available: true, totalOutputTokens: 900 },
    { available: false, totalOutputTokens: 100 },
  ];
  tracker.record(reordered, 2_000);

  const sameReordered = fleetSnapshots(100, { outputTokens: 910 });
  sameReordered[0].llmPorts = [9000, 8000];
  sameReordered[0].metrics.llm = [
    { available: true, totalOutputTokens: 910 },
    { available: false, totalOutputTokens: 100 },
  ];
  tracker.record(sameReordered, 4_000);

  assert.equal(tracker.snapshot(4_000).outputTokens24h, 10);
});

test("Wh per output token is null with zero tokens or without observed energy", () => {
  const noTokens = new FleetEnergyTracker(noTimerOptions());
  noTokens.record(fleetSnapshots(100, { outputTokens: 0 }), 0);
  noTokens.record(fleetSnapshots(100, { outputTokens: 0 }), 2_000);
  assert.equal(noTokens.snapshot(2_000).outputTokens24h, 0);
  assert.equal(noTokens.snapshot(2_000).whPerOutputToken24h, null);

  const noEnergy = new FleetEnergyTracker(noTimerOptions());
  noEnergy.record(fleetSnapshots(100, { outputTokens: 0 }), 0);
  noEnergy.record(fleetSnapshots(100, { outputTokens: 10 }), 20_000);
  assert.equal(noEnergy.snapshot(20_000).energy24hKwh, null);
  assert.equal(noEnergy.snapshot(20_000).whPerOutputToken24h, null);
});

test("24 hour and 31 day windows prune old energy independently", () => {
  const now = Date.UTC(2026, 7, 23, 12, 0, 0);
  const tracker = new FleetEnergyTracker({ ...noTimerOptions(), now: () => now });
  const intervals = [now - 31 * DAY_MS - 2 * MINUTE_MS, now - 25 * HOUR_MS, now - HOUR_MS];
  for (const start of intervals) {
    tracker.record([nodeSnapshot("node-a", { watts: 100 })], start);
    tracker.record([nodeSnapshot("node-a", { watts: 100 })], start + 1_000);
  }

  const snapshot = tracker.snapshot(now);
  const oneIntervalKwh = (100 * 1_000) / 3_600_000 / 1000;
  almostEqual(snapshot.energy24hKwh, oneIntervalKwh);
  almostEqual(snapshot.energy31dKwh, 2 * oneIntervalKwh);
});

test("an exact 24-hour cutoff excludes the completed minute before the boundary", () => {
  const now = DAY_MS + MINUTE_MS;
  const tracker = new FleetEnergyTracker(noTimerOptions());
  tracker.record([nodeSnapshot("node-a", { watts: 100 })], 58_000);
  tracker.record([nodeSnapshot("node-a", { watts: 100 })], 59_000);
  tracker.record([nodeSnapshot("node-a", { watts: 100 })], MINUTE_MS);
  tracker.record([nodeSnapshot("node-a", { watts: 100 })], MINUTE_MS + 1_000);

  const snapshot = tracker.snapshot(now);
  almostEqual(snapshot.energy24hKwh, (100 * 1_000) / 3_600_000 / 1000);
  assert.equal(snapshot.nodeCoverage24hMs["node-a"], 1_000);
});

test("hourly graph returns 24 scalar means oldest-to-newest with nulls for empty windows", () => {
  const now = Date.UTC(2026, 7, 23, 12, 34, 45);
  const tracker = new FleetEnergyTracker({ ...noTimerOptions(), now: () => now });
  tracker.record(fleetSnapshots(100), now - 30 * MINUTE_MS);
  tracker.record(fleetSnapshots(100), now - 30 * MINUTE_MS + 2_000);

  const hourly = tracker.snapshot(now).hourlyWatts24h;
  assert.equal(hourly.length, 24);
  assert.deepEqual(hourly.slice(0, -1), Array(23).fill(null));
  almostEqual(hourly.at(-1), 400);
});

test("persistence reload preserves aggregates, token baseline, and does not backfill downtime", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-energy-reload-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "fleet-energy.json");
  let now = Date.UTC(2026, 7, 23, 12, 0, 0);
  const timerOptions = { setIntervalFn: () => 1, clearIntervalFn: () => {} };

  const first = new FleetEnergyTracker({ filePath, load: false, now: () => now, ...timerOptions });
  first.record(fleetSnapshots(100, { outputTokens: 100 }), now);
  first.record(fleetSnapshots(100, { outputTokens: 150 }), now + 2_000);
  assert.equal(first.flush(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")).tokenCounter, {
    headId: "node-a",
    port: 8000,
    totalOutputTokens: 150,
    observedAtMs: now + 2_000,
  });
  const before = first.snapshot(now + 2_000);

  now += HOUR_MS;
  const second = new FleetEnergyTracker({ filePath, now: () => now, ...timerOptions });
  const loaded = second.snapshot(now);
  almostEqual(loaded.energy24hKwh, before.energy24hKwh);
  assert.equal(loaded.outputTokens24h, 50);

  second.record(fleetSnapshots(100, { outputTokens: 175 }), now);
  assert.equal(second.snapshot(now).outputTokens24h, 50);
  almostEqual(second.snapshot(now).energy24hKwh, before.energy24hKwh);
  second.record(fleetSnapshots(100, { outputTokens: 180 }), now + 2_000);
  assert.equal(second.snapshot(now + 2_000).outputTokens24h, 55);
  almostEqual(second.snapshot(now + 2_000).energy24hKwh, before.energy24hKwh + 0.8 / 3_600);
});

test("reload migrates legacy version-one state when its node keys match the configured fleet", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-energy-legacy-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "fleet-energy.json");
  const coverageMs = Object.fromEntries(CANONICAL_NODE_IDS.map((id) => [id, 2_000]));
  const nodeWh = Object.fromEntries(
    CANONICAL_NODE_IDS.map((id) => [id, (100 * 2_000) / 3_600_000])
  );
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      version: 1,
      integrationHighWaterMs: 2_000,
      buckets: [{
        minuteStartMs: 0,
        nodeWh,
        nodeCoverageMs: coverageMs,
        fleetWattMs: 400 * 2_000,
        fleetCoverageMs: 2_000,
        outputTokens: 25,
      }],
    })
  );

  const tracker = new FleetEnergyTracker({
    filePath,
    now: () => 2_000,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  const snapshot = tracker.snapshot(2_000);
  assert.equal(snapshot.coverage24hMs, 2_000);
  assert.equal(snapshot.outputTokens24h, 25);
  assert.equal(tracker.close(), true);

  const migrated = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.deepEqual(migrated.nodeIds, CANONICAL_NODE_IDS);
});

test("reload does not restore ephemeral freshness or current-power samples", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-energy-ephemeral-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "fleet-energy.json");
  const now = Date.UTC(2026, 7, 23, 12, 0, 0);
  const timerOptions = { setIntervalFn: () => 1, clearIntervalFn: () => {} };
  const first = new FleetEnergyTracker({ filePath, load: false, now: () => now, ...timerOptions });
  first.record(fleetSnapshots(100), now);
  first.flush();

  const second = new FleetEnergyTracker({ filePath, now: () => now, ...timerOptions });
  const loaded = second.snapshot(now);
  assert.equal(loaded.freshNodeCount, 0);
  assert.equal(loaded.currentWatts30s, null);
});

test("freshNodeCount expires when the latest record is future-dated or over 10 seconds old", () => {
  const tracker = new FleetEnergyTracker(noTimerOptions());
  tracker.record(fleetSnapshots(100), 10_000);

  assert.equal(tracker.snapshot(9_999).freshNodeCount, 0);
  assert.equal(tracker.snapshot(20_000).freshNodeCount, 4);
  assert.equal(tracker.snapshot(20_001).freshNodeCount, 0);
});

test("reload marks pruned persisted buckets dirty so close durably removes them", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-energy-load-prune-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "fleet-energy.json");
  const now = Date.UTC(2026, 7, 23, 12, 0, 0);
  const values = Object.fromEntries(CANONICAL_NODE_IDS.map((id) => [id, 0]));
  const bucket = (minuteStartMs) => ({
    minuteStartMs,
    nodeWh: { ...values },
    nodeCoverageMs: { ...values },
    fleetWattMs: 0,
    fleetCoverageMs: 0,
    outputTokens: 1,
  });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      version: 1,
      nodeIds: CANONICAL_NODE_IDS,
      buckets: [bucket(now - 31 * DAY_MS - MINUTE_MS), bucket(now)],
    })
  );
  const tracker = new FleetEnergyTracker({
    filePath,
    now: () => now,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });

  assert.equal(tracker.snapshot(now).outputTokens24h, 1);
  assert.equal(tracker.close(), true);
  const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.deepEqual(saved.buckets.map((entry) => entry.minuteStartMs), [now]);
});

test("reload rejects persisted buckets and integration high-water outside physical bounds", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-energy-invalid-buckets-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "fleet-energy.json");
  const now = 10 * MINUTE_MS;
  const unsafeAlignedMinute =
    Math.ceil((Number.MAX_SAFE_INTEGER + 1) / MINUTE_MS) * MINUTE_MS;
  const values = Object.fromEntries(CANONICAL_NODE_IDS.map((id) => [id, 0]));
  const bucket = (minuteStartMs, outputTokens, changes = {}) => ({
    minuteStartMs,
    nodeWh: { ...values },
    nodeCoverageMs: { ...values },
    fleetWattMs: 0,
    fleetCoverageMs: 0,
    outputTokens,
    ...changes,
  });
  const invalid = [
    bucket(-MINUTE_MS, 1),
    bucket(unsafeAlignedMinute, 8),
    bucket(MINUTE_MS, 2, { nodeWh: { ...values, "node-a": 4.000_001 } }),
    bucket(2 * MINUTE_MS, 3, {
      nodeCoverageMs: { ...values, "node-b": MINUTE_MS + 1 },
    }),
    bucket(3 * MINUTE_MS, 4, { fleetWattMs: 57_600_001 }),
    bucket(4 * MINUTE_MS, 5, { fleetCoverageMs: MINUTE_MS + 1 }),
    bucket(5 * MINUTE_MS, 1.5),
    bucket(6 * MINUTE_MS, Number.MAX_SAFE_INTEGER + 1),
    bucket(7 * MINUTE_MS, 6, { nodeWh: { ...values, extra: 0 } }),
  ];
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      version: 1,
      nodeIds: CANONICAL_NODE_IDS,
      integrationHighWaterMs: Number.MAX_SAFE_INTEGER + 1,
      buckets: [...invalid, bucket(now, 7)],
    })
  );

  const tracker = new FleetEnergyTracker({
    filePath,
    now: () => now,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  assert.equal(tracker.snapshot(now).outputTokens24h, 7);
  tracker.close();
  const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.deepEqual(saved.buckets.map((entry) => entry.minuteStartMs), [now]);
  assert.equal(saved.integrationHighWaterMs, null);
});

test("reload rejects relationally impossible buckets while allowing floating tolerance", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-energy-relational-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "fleet-energy.json");
  const zeros = Object.fromEntries(CANONICAL_NODE_IDS.map((id) => [id, 0]));
  const thousands = Object.fromEntries(CANONICAL_NODE_IDS.map((id) => [id, 1_000]));
  const bucket = (minuteStartMs, outputTokens, changes = {}) => ({
    minuteStartMs,
    nodeWh: { ...zeros },
    nodeCoverageMs: { ...zeros },
    fleetWattMs: 0,
    fleetCoverageMs: 0,
    outputTokens,
    ...changes,
  });
  const invalidNodeEnergy = bucket(0, 1, {
    nodeWh: { ...zeros, "node-a": 0.07 },
    nodeCoverageMs: { ...thousands },
  });
  const invalidFleetPower = bucket(MINUTE_MS, 2, {
    nodeCoverageMs: { ...thousands },
    fleetWattMs: 1_000_000,
    fleetCoverageMs: 1_000,
  });
  const invalidFleetCoverage = bucket(2 * MINUTE_MS, 3, {
    nodeCoverageMs: { ...thousands, "node-d": 500 },
    fleetCoverageMs: 600,
  });
  const tolerantCoverage = 1_000;
  const tolerantFleetCoverage = tolerantCoverage + 1e-10;
  const tolerant = bucket(3 * MINUTE_MS, 7, {
    nodeWh: Object.fromEntries(
      CANONICAL_NODE_IDS.map((id) => [
        id,
        (240 * tolerantCoverage) / 3_600_000 + 1e-12,
      ])
    ),
    nodeCoverageMs: { ...thousands },
    fleetWattMs: 960 * tolerantFleetCoverage + 1e-6,
    fleetCoverageMs: tolerantFleetCoverage,
  });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      version: 1,
      nodeIds: CANONICAL_NODE_IDS,
      integrationHighWaterMs: 3 * MINUTE_MS + 1_000,
      buckets: [invalidNodeEnergy, invalidFleetPower, invalidFleetCoverage, tolerant],
    })
  );

  const now = 4 * MINUTE_MS;
  const tracker = new FleetEnergyTracker({
    filePath,
    now: () => now,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  assert.equal(tracker.snapshot(now).outputTokens24h, 7);
  tracker.close();
  const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.deepEqual(saved.buckets.map((entry) => entry.minuteStartMs), [3 * MINUTE_MS]);
});

test("reload rejects energy below estimator minima and fleet energy above node energy", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-energy-minimums-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "fleet-energy.json");
  const zeros = Object.fromEntries(CANONICAL_NODE_IDS.map((id) => [id, 0]));
  const oneSecondCoverage = Object.fromEntries(
    CANONICAL_NODE_IDS.map((id) => [id, 1_000])
  );
  const nodeWhAt = (watts) =>
    Object.fromEntries(
      CANONICAL_NODE_IDS.map((id) => [id, (watts * 1_000) / 3_600_000])
    );
  const bucket = (minuteStartMs, outputTokens, changes) => ({
    minuteStartMs,
    nodeWh: { ...zeros },
    nodeCoverageMs: { ...oneSecondCoverage },
    fleetWattMs: 0,
    fleetCoverageMs: 1_000,
    outputTokens,
    ...changes,
  });
  const belowAllMinimums = bucket(0, 1, {});
  const belowFleetMinimum = bucket(MINUTE_MS, 2, {
    nodeWh: nodeWhAt(28.2),
  });
  const fleetExceedsNodes = bucket(2 * MINUTE_MS, 4, {
    nodeWh: nodeWhAt(30),
    fleetWattMs: 200 * 1_000,
  });
  const validMinimum = bucket(3 * MINUTE_MS, 8, {
    nodeWh: nodeWhAt(28.2),
    fleetWattMs: 112.8 * 1_000,
  });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      version: 1,
      nodeIds: CANONICAL_NODE_IDS,
      integrationHighWaterMs: 3 * MINUTE_MS + 1_000,
      buckets: [belowAllMinimums, belowFleetMinimum, fleetExceedsNodes, validMinimum],
    })
  );

  const now = 4 * MINUTE_MS;
  const tracker = new FleetEnergyTracker({
    filePath,
    now: () => now,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  assert.equal(tracker.snapshot(now).outputTokens24h, 8);
  tracker.close();
  const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.deepEqual(saved.buckets.map((entry) => entry.minuteStartMs), [3 * MINUTE_MS]);
});

test("reload keeps the first valid bucket when persisted minute timestamps are duplicated", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-energy-duplicate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "fleet-energy.json");
  const now = 10 * MINUTE_MS;
  const values = Object.fromEntries(CANONICAL_NODE_IDS.map((id) => [id, 0]));
  const bucket = (outputTokens) => ({
    minuteStartMs: now,
    nodeWh: { ...values },
    nodeCoverageMs: { ...values },
    fleetWattMs: 0,
    fleetCoverageMs: 0,
    outputTokens,
  });
  fs.writeFileSync(
    filePath,
    JSON.stringify({ version: 1, nodeIds: CANONICAL_NODE_IDS, buckets: [bucket(7), bucket(9)] })
  );

  const tracker = new FleetEnergyTracker({
    filePath,
    now: () => now,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  assert.equal(tracker.snapshot(now).outputTokens24h, 7);
});

test("truncated persistence warns and starts empty without throwing", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-energy-truncated-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "fleet-energy.json");
  fs.writeFileSync(filePath, '{"version":1,"buckets":[');
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  t.after(() => {
    console.warn = originalWarn;
  });

  let tracker;
  assert.doesNotThrow(() => {
    tracker = new FleetEnergyTracker({
      filePath,
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });
  });
  assert.equal(tracker.snapshot(0).energy31dKwh, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unable to load/);
});

test("rename failure preserves the prior target and a dirty retry succeeds at mode 0600", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-energy-rename-failure-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "fleet-energy.json");
  const priorContents = "prior-good-state\n";
  fs.writeFileSync(filePath, priorContents, { mode: 0o666 });
  fs.chmodSync(filePath, 0o666);
  let failRename = true;
  const fileSystem = {
    ...fs,
    renameSync(...args) {
      if (failRename) {
        failRename = false;
        const error = new Error("injected rename failure");
        error.code = "EIO";
        throw error;
      }
      return fs.renameSync(...args);
    },
  };
  const tracker = new FleetEnergyTracker({
    filePath,
    fileSystem,
    load: false,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  tracker.record(fleetSnapshots(100, { outputTokens: 0 }), 0);

  assert.throws(() => tracker.flush(), /injected rename failure/);
  assert.equal(fs.readFileSync(filePath, "utf8"), priorContents);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(filePath)]);
  assert.equal(tracker.flush(), true);
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).version, 1);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("persistence uses mode 0600 and auto-flush cadence is capped at 30 seconds", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-energy-mode-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "fleet-energy.json");
  let scheduled;
  let cleared = false;
  const timerId = { timer: true };
  const tracker = new FleetEnergyTracker({
    filePath,
    load: false,
    flushIntervalMs: 60_000,
    setIntervalFn: (callback, intervalMs) => {
      scheduled = { callback, intervalMs };
      return timerId;
    },
    clearIntervalFn: (received) => {
      assert.equal(received, timerId);
      cleared = true;
    },
  });

  assert.equal(scheduled.intervalMs, 30_000);
  tracker.record(fleetSnapshots(100, { outputTokens: 0 }), 0);
  scheduled.callback();
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  tracker.close();
  assert.equal(cleared, true);
});

test("retention is bounded to 44,640 completed minute buckets plus the active minute", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-energy-retention-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "fleet-energy.json");
  const start = Date.UTC(2026, 6, 1, 0, 0, 0);
  let now = start;
  const completedBuckets = 44_640;
  const tracker = new FleetEnergyTracker({
    filePath,
    load: false,
    now: () => now,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });

  for (let index = 0; index < completedBuckets + 2; index += 1) {
    now = start + index * MINUTE_MS;
    tracker.record([nodeSnapshot("node-a")], now);
    tracker.record([nodeSnapshot("node-a")], now + 1_000);
    now += 1_000;
  }
  tracker.flush();

  const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(saved.buckets.length, completedBuckets + 1);
  assert.equal(saved.buckets.at(-1).minuteStartMs, start + (completedBuckets + 1) * MINUTE_MS);
});

test("bucket pruning remains correct after a backward clock inserts an older minute", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-energy-clock-prune-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "fleet-energy.json");
  let now = 30 * MINUTE_MS;
  const tracker = new FleetEnergyTracker({
    filePath,
    load: false,
    now: () => now,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  tracker.record([nodeSnapshot("node-a")], now);
  tracker.record([nodeSnapshot("node-a")], now + 2_000);
  tracker.record([nodeSnapshot("node-a")], 0);
  tracker.record([nodeSnapshot("node-a")], 2_000);

  now = 31 * DAY_MS + 20 * MINUTE_MS;
  tracker.snapshot(now);
  tracker.flush();
  const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.deepEqual(saved.buckets.map((bucket) => bucket.minuteStartMs), [30 * MINUTE_MS]);
});
