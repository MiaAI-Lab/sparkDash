import assert from "node:assert/strict";
import test from "node:test";
import { SparkMonitor } from "../SparkMonitor.js";

function unit(overrides = {}) {
  return {
    id: "mac-test",
    name: "Mac Test",
    kind: "mac",
    lanIp: "127.0.0.1",
    isLocal: true,
    llmMonitoring: false,
    agent: { port: 8790 },
    ...overrides,
  };
}

function harness(t, overrides) {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(SparkMonitor.prototype, "_detectHardwareInBackground", () => {});
  const timers = new Map();
  t.mock.method(globalThis, "setInterval", (callback, delay) => {
    const id = Symbol("interval");
    timers.set(id, { callback, delay });
    return id;
  });
  t.mock.method(globalThis, "clearInterval", (id) => timers.delete(id));
  const monitor = new SparkMonitor(unit(overrides));
  // Exercise startup and timer-driven runtimes without unrelated system I/O.
  let startup;
  monitor._poll = () => { startup = monitor._pollDomain("runtimes"); };
  t.after(() => monitor.stop());
  return { monitor, timers, startup: () => startup };
}

const serving = {
  agentOnline: true,
  runtimes: [{ name: "tensorfold", port: 8300, state: "serving" }],
  unavailable: [],
};
const offline = {
  agentOnline: false,
  runtimes: [],
  unavailable: [{ metric: "agent", reason: "mac agent unreachable" }],
};

test("startup failure recovers on the slow runtimes interval without a restart", async (t) => {
  const { monitor, timers, startup } = harness(t);
  const probe = t.mock.method(monitor.collector, "collectRuntimes", async () => offline);
  monitor.start();
  await startup();
  assert.equal(monitor.snapshot().metrics.agentOnline, false);
  assert.deepEqual(monitor.snapshot().metrics.unavailable, offline.unavailable);
  const timer = timers.get(monitor._runtimesIntervalId);
  assert.equal(timer.delay, 30_000);
  assert.equal(probe.mock.callCount(), 1, "startup must not double-probe");

  probe.mock.mockImplementation(async () => serving);
  await timer.callback();
  assert.equal(monitor.snapshot().metrics.agentOnline, true);
  assert.deepEqual(monitor.snapshot().metrics.runtimes, serving.runtimes);
  assert.deepEqual(monitor.snapshot().metrics.unavailable, []);

  probe.mock.mockImplementation(async () => offline);
  await timer.callback();
  assert.equal(monitor.snapshot().metrics.agentOnline, false);
  assert.deepEqual(monitor.snapshot().metrics.runtimes, []);
  assert.deepEqual(monitor.snapshot().metrics.unavailable, offline.unavailable);
});

test("a rejected runtimes probe clears stale success and can recover", async (t) => {
  const { monitor, timers, startup } = harness(t);
  const probe = t.mock.method(monitor.collector, "collectRuntimes", async () => serving);
  monitor.start();
  await startup();
  const timer = timers.get(monitor._runtimesIntervalId);
  probe.mock.mockImplementation(async () => { throw new Error("probe failed"); });
  await timer.callback();
  assert.equal(monitor.snapshot().metrics.agentOnline, false);
  assert.deepEqual(monitor.snapshot().metrics.runtimes, []);
  assert.equal(monitor.snapshot().metrics.unavailable[0].metric, "agent");
  probe.mock.mockImplementation(async () => serving);
  await timer.callback();
  assert.equal(monitor.snapshot().metrics.agentOnline, true);
  assert.deepEqual(monitor.snapshot().metrics.unavailable, []);
});

test("repeated starts keep one runtimes timer; stop clears it and disables callbacks", async (t) => {
  const { monitor, timers, startup } = harness(t);
  const probe = t.mock.method(monitor.collector, "collectRuntimes", async () => serving);
  monitor.start();
  await startup();
  const id = monitor._runtimesIntervalId;
  const timer = timers.get(id);
  const count = timers.size;
  monitor.start();
  assert.equal(monitor._runtimesIntervalId, id);
  assert.equal(timers.size, count);
  monitor.stop();
  assert.equal(timers.size, 0);
  assert.equal(monitor._runtimesIntervalId, null);
  await timer.callback();
  assert.equal(probe.mock.callCount(), 1);
  monitor.start();
  await startup();
  assert.notEqual(monitor._runtimesIntervalId, id);
  assert.equal(timers.size, count);
  assert.equal(probe.mock.callCount(), 2);
});

test("only a configured Mac agent gets a runtimes interval", async (t) => {
  for (const overrides of [{ agent: null }, { kind: "spark" }, { kind: "host" }]) {
    await t.test(JSON.stringify(overrides), async (t) => {
      const { monitor, timers, startup } = harness(t, overrides);
      monitor.start();
      await startup();
      // _runtimesIntervalId is the single source of truth for whether the
      // Mac-agent runtimes poll is armed. A bare 30s-delay check would also
      // match the always-on residentModels timer, which every kind gets.
      assert.equal(monitor._runtimesIntervalId, null);
      assert.equal(monitor.snapshot().metrics.agentOnline, null);
      assert.equal(monitor.snapshot().metrics.runtimes, null);
    });
  }
});

test("agent configuration changes replace the timer and clear the old inventory", async (t) => {
  const { monitor, timers, startup } = harness(t);
  t.mock.method(monitor.collector, "collectRuntimes", async () => serving);
  monitor.start();
  await startup();
  const priorId = monitor._runtimesIntervalId;

  monitor.updateConfig(unit({ agent: null }));
  assert.equal(timers.has(priorId), false);
  assert.equal(monitor._runtimesIntervalId, null);
  assert.equal(monitor.snapshot().metrics.agentOnline, null);
  assert.equal(monitor.snapshot().metrics.runtimes, null);
  assert.equal(monitor.snapshot().metrics.unavailable, null);

  // Stub the prototype before updateConfig's immediate probe of the new collector.
  const { MacAgentCollector } = await import("../../collectors/MacAgentCollector.js");
  t.mock.method(MacAgentCollector.prototype, "collectRuntimes", async () => serving);
  monitor.updateConfig(unit({ agent: { port: 9100 } }));
  const newId = monitor._runtimesIntervalId;
  await timers.get(newId).callback();
  assert.equal(monitor.snapshot().metrics.agentOnline, true);
  monitor.updateConfig(unit({ agent: { port: 9200 } }));
  assert.equal(timers.has(newId), false);
  assert.notEqual(monitor._runtimesIntervalId, newId);
  assert.equal(monitor.snapshot().metrics.agentOnline, null);
  await Promise.resolve();
  assert.equal(monitor.snapshot().metrics.agentOnline, true);
});

test("in-flight runtimes polls cannot overlap or publish after stop and restart", async (t) => {
  const { monitor, timers, startup } = harness(t);
  const pending = [];
  const probe = t.mock.method(monitor.collector, "collectRuntimes", () =>
    new Promise((resolve, reject) => pending.push({ resolve, reject }))
  );
  monitor.start();
  const priorPoll = startup();
  await timers.get(monitor._runtimesIntervalId).callback();
  assert.equal(probe.mock.callCount(), 1, "timer must not overlap a slow probe");
  monitor.stop();
  monitor.start();
  const currentPoll = startup();
  pending[0].reject(new Error("old run failed late"));
  await priorPoll;
  assert.equal(monitor.snapshot().metrics.agentOnline, null);
  assert.ok(monitor._inflight.runtimes, "old completion must not clear the current guard");
  pending[1].resolve(serving);
  await currentPoll;
  assert.equal(monitor.snapshot().metrics.agentOnline, true);
});

test("a runtimes response from a replaced endpoint cannot overwrite the new target", async (t) => {
  const { monitor, timers, startup } = harness(t);
  let resolvePrior;
  t.mock.method(monitor.collector, "collectRuntimes", () =>
    new Promise((resolve) => { resolvePrior = resolve; })
  );
  monitor.start();
  const priorPoll = startup();
  const { MacAgentCollector } = await import("../../collectors/MacAgentCollector.js");
  t.mock.method(MacAgentCollector.prototype, "collectRuntimes", async () => offline);
  monitor.updateConfig(unit({ agent: { port: 9100 } }));
  await timers.get(monitor._runtimesIntervalId).callback();
  resolvePrior(serving);
  await priorPoll;
  assert.equal(monitor.snapshot().metrics.agentOnline, false);
  assert.deepEqual(monitor.snapshot().metrics.runtimes, []);
  assert.deepEqual(monitor.snapshot().metrics.unavailable, offline.unavailable);
});
