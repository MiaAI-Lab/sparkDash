/**
 * The display-carveout card is opt-in per unit. Off (the default), no probe
 * exists, no timer runs and nothing reaches the snapshot; on, the probe runs on
 * its own cadence and its result is passed through; turned off again, it stops
 * and its last result is dropped. Only Linux Sparks keep the setting.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-attic-"));
process.env.LLM_DAILY_JSON_PATH = path.join(tmp, "llm-daily.json");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { SparkMonitor } = await import("../SparkMonitor.js");
const { SparkRegistry } = await import("../SparkRegistry.js");
const { AtticProbe } = await import("../../collectors/AtticProbe.js");
const { POLL_INTERVAL_ATTIC } = await import("../../config.js");

const LENDING = {
  available: true,
  state: "lending",
  attic: { status: "ready", lentMib: 2044 },
  atticd: { present: true, active: true, state: "active" },
  error: null,
};

function spark(overrides = {}) {
  return {
    id: "spark-8",
    name: "spark-8",
    kind: "spark",
    lanIp: "192.168.1.218",
    isLocal: false,
    role: "worker",
    llmMonitoring: false,
    comfyMonitoring: false,
    hermesMonitoring: false,
    tailscaleMonitoring: false,
    ...overrides,
  };
}

/** A remote monitor whose collectors are stubs (no SSH), with every carveout probe counted. */
function stubbedMonitor(t, overrides) {
  t.mock.method(console, "log", () => {});
  const probes = t.mock.method(AtticProbe.prototype, "probe", async () => LENDING);
  const monitor = new SparkMonitor(spark(overrides));
  const collector = monitor.collector;
  collector.collectGpu = async () => collector._defaultGpu();
  collector.collectCpu = async () => collector._defaultCpu();
  collector.collectRam = async () => collector._defaultRam();
  collector.collectNetwork = async () => collector._defaultNetwork();
  collector.collectStorage = async () => [];
  collector.collectUnifiedMemory = async () => collector._defaultUnifiedMemory();
  monitor.llmProbes = new Map();
  monitor._readUptime = async () => 1234;
  monitor._checkOnline = async () => {};
  monitor.online = true;
  t.after(() => monitor.stop());
  return { monitor, probes };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("off by default: no probe, no timer, nothing in the snapshot", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { monitor, probes } = stubbedMonitor(t);
  monitor.start();
  await flush();
  await monitor._pollDomain("attic");
  t.mock.timers.tick(POLL_INTERVAL_ATTIC * 3);
  await flush();
  assert.equal(monitor.atticProbe, null);
  assert.equal(monitor._atticIntervalId, null);
  assert.equal(probes.mock.callCount(), 0, "nothing runs on the unit");
  const snap = monitor.snapshot();
  assert.equal(snap.atticMonitoring, false);
  assert.equal(snap.metrics.attic, null);
});

test("on: the probe runs on its own cadence and its result reaches the snapshot", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { monitor, probes } = stubbedMonitor(t, { atticMonitoring: true });
  assert.ok(monitor.atticProbe instanceof AtticProbe);
  monitor.start();
  await flush();
  const first = probes.mock.callCount();
  assert.ok(first >= 1, "polled at start");
  t.mock.timers.tick(POLL_INTERVAL_ATTIC);
  await flush();
  assert.equal(probes.mock.callCount(), first + 1, "then once a period");
  const snap = monitor.snapshot();
  assert.equal(snap.atticMonitoring, true);
  assert.deepEqual(snap.metrics.attic, LENDING);
});

test("turned off: the timer stops and the last result is dropped", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { monitor, probes } = stubbedMonitor(t, { atticMonitoring: true });
  monitor.start();
  await flush();
  assert.deepEqual(monitor.snapshot().metrics.attic, LENDING);

  monitor.updateConfig(spark({ atticMonitoring: false }));
  assert.equal(monitor.atticProbe, null);
  assert.equal(monitor._atticIntervalId, null);
  const calls = probes.mock.callCount();
  t.mock.timers.tick(POLL_INTERVAL_ATTIC * 3);
  await flush();
  assert.equal(probes.mock.callCount(), calls, "no more probes");
  assert.equal(monitor.snapshot().metrics.attic, null);

  monitor.updateConfig(spark({ atticMonitoring: true }));
  await flush();
  assert.ok(probes.mock.callCount() > calls, "turned on again, it polls at once");
});

test("the registry keeps the setting for Linux Sparks only, off unless set", () => {
  const r = Object.create(SparkRegistry.prototype);
  const norm = (partial) => r._normalizeConfig({ id: "s8", name: "S8", lanIp: "10.0.0.8", ...partial }).atticMonitoring;
  assert.equal(norm({}), false, "default off");
  assert.equal(norm({ atticMonitoring: true }), true);
  assert.equal(norm({ atticMonitoring: true, role: "worker" }), true, "every role: a worker has a carveout too");
  assert.equal(norm({ atticMonitoring: true, kind: "host" }), false, "a dedicated-GPU host has no display carveout");
  assert.equal(norm({ atticMonitoring: true, kind: "mac" }), false, "a Mac unit has none either");
  assert.equal(norm({ atticMonitoring: true, platform: "darwin" }), false);
  assert.equal(norm({ atticMonitoring: true, platform: "windows" }), false);
  assert.equal(norm({ atticMonitoring: "yes" }), true, "truthy, as the other opt-ins");
});
