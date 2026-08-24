import assert from "node:assert/strict";
import test from "node:test";

import { SparkMonitor } from "../SparkMonitor.js";

function spark() {
  return {
    id: "spark-test",
    name: "Spark Test",
    lanIp: "127.0.0.1",
    isLocal: true,
    llmMonitoring: false,
    comfyMonitoring: false,
  };
}

function validGpu(temperature = 42) {
  return {
    temperature,
    usage: 10,
    power: { draw: 18.5, limit: 120, systemDraw: 39 },
    vram: { used: 100, total: 128_000, percentage: 0, available: 120_000 },
    processes: [],
    throttle: {},
  };
}

test("a poll from an earlier monitor run cannot commit or clear a restarted poll", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(globalThis, "setInterval", () => Symbol("interval"));
  t.mock.method(globalThis, "clearInterval", () => {});
  const monitor = new SparkMonitor(spark());
  monitor._poll = async () => {};
  const pendingResolvers = [];
  monitor.collector.collectGpu = () =>
    new Promise((resolve) => pendingResolvers.push(resolve));

  monitor.start();
  const priorRunPoll = monitor._pollDomain("gpu");
  await Promise.resolve();
  monitor.stop();
  monitor.start();
  const currentRunPoll = monitor._pollDomain("gpu");
  await Promise.resolve();

  pendingResolvers[0](validGpu(41));
  await priorRunPoll;
  assert.equal(monitor.snapshot().metrics.gpu.temperature, 0);
  assert.equal(monitor._lastUpdate.gpu, undefined);
  assert.ok(monitor._inflight.gpu, "the earlier poll must not clear the current guard");

  pendingResolvers[1](validGpu(42));
  await currentRunPoll;
  assert.equal(monitor.snapshot().metrics.gpu.temperature, 42);
  assert.ok(Number.isFinite(monitor._lastUpdate.gpu));
  monitor.stop();
});

test("a poll from before updateConfig cannot commit against the new target", async () => {
  const monitor = new SparkMonitor(spark());
  monitor._running = true;
  const pendingResolvers = [];
  monitor.collector.collectGpu = () =>
    new Promise((resolve) => pendingResolvers.push(resolve));

  const priorTargetPoll = monitor._pollDomain("gpu");
  await Promise.resolve();
  monitor.updateConfig({ ...spark(), lanIp: "127.0.0.2" });
  const currentTargetPoll = monitor._pollDomain("gpu");
  await Promise.resolve();

  pendingResolvers[0](validGpu(41));
  await priorTargetPoll;
  assert.equal(monitor.snapshot().metrics.gpu.temperature, 0);
  assert.ok(monitor._inflight.gpu, "the prior target poll must not clear the current guard");

  pendingResolvers[1](validGpu(42));
  await currentTargetPoll;
  assert.equal(monitor.snapshot().metrics.gpu.temperature, 42);
});

test("a rejected older CPU poll cannot rewind the accepted generation baseline", async () => {
  const monitor = new SparkMonitor(spark());
  monitor._running = true;
  monitor.collector.lastCpuStat = { total: 100, used: 20 };
  let resolveOlder;
  let resolveCurrent;
  let callCount = 0;
  monitor.collector._getCPUUsage = () => {
    callCount += 1;
    if (callCount === 1) return new Promise((resolve) => (resolveOlder = resolve));
    if (callCount === 2) return new Promise((resolve) => (resolveCurrent = resolve));
    return Promise.resolve({ total: 250, used: 120 });
  };
  monitor.collector._getCPUTemperature = async () => 0;
  monitor.collector._getCPUPower = async () => ({ draw: 5.2, tdp: 65 });

  const olderPoll = monitor._pollDomain("cpu");
  await Promise.resolve();
  monitor.updateConfig({ ...spark(), lanIp: "127.0.0.2" });
  const currentPoll = monitor._pollDomain("cpu");
  await Promise.resolve();

  resolveCurrent({ total: 200, used: 100 });
  await currentPoll;
  assert.equal(monitor.snapshot().metrics.cpu.usage, 80);

  resolveOlder({ total: 150, used: 70 });
  await olderPoll;
  await monitor._pollDomain("cpu");
  assert.equal(monitor.snapshot().metrics.cpu.usage, 40);
});

test("a liveness check from an earlier run cannot commit or clear a restarted check", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(globalThis, "setInterval", () => Symbol("interval"));
  t.mock.method(globalThis, "clearInterval", () => {});
  const monitor = new SparkMonitor(spark());
  monitor._poll = async () => {};
  monitor._readUptime = async () => 123;
  const pendingResolvers = [];
  monitor.collector.pingHost = () =>
    new Promise((resolve) => pendingResolvers.push(resolve));

  monitor.start();
  const priorRunCheck = monitor._checkOnline();
  await Promise.resolve();
  monitor.stop();
  monitor.start();
  const currentRunCheck = monitor._checkOnline();
  await Promise.resolve();

  pendingResolvers[0]();
  await priorRunCheck;
  assert.equal(monitor.online, false);
  assert.ok(monitor._inflight.online, "the earlier check must not clear the current guard");

  pendingResolvers[1]();
  await currentRunCheck;
  assert.equal(monitor.online, true);
  assert.equal(monitor._uptimeSeconds, 123);
  assert.equal(monitor._inflight.online, false);
  monitor.stop();
});

test("a storage refresh from an earlier run cannot commit or clear a restarted refresh", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(globalThis, "setInterval", () => Symbol("interval"));
  t.mock.method(globalThis, "clearInterval", () => {});
  const monitor = new SparkMonitor(spark());
  monitor._poll = async () => {};
  const pendingResolvers = [];
  monitor.collector.collectStorage = () =>
    new Promise((resolve) => pendingResolvers.push(resolve));

  monitor.start();
  const priorRunRefresh = monitor.refreshDomain("storage");
  await Promise.resolve();
  monitor.stop();
  monitor.start();
  const currentRunRefresh = monitor.refreshDomain("storage");
  await Promise.resolve();

  pendingResolvers[0]([{ mount: "/old" }]);
  await priorRunRefresh;
  assert.deepEqual(monitor.snapshot().metrics.storage, []);
  assert.ok(monitor._inflight.storage, "the earlier refresh must not clear the current guard");

  pendingResolvers[1]([{ mount: "/current" }]);
  await currentRunRefresh;
  assert.deepEqual(monitor.snapshot().metrics.storage, [{ mount: "/current" }]);
  assert.equal(monitor._inflight.storage, false);
  monitor.stop();
});
