import assert from "node:assert/strict";
import test from "node:test";

import { SparkMonitor } from "../SparkMonitor.js";
import { COLLECTION_SUCCESS } from "../../collectors/SystemCollector.js";

function piSpark(overrides = {}) {
  return {
    id: "luffy-1",
    name: "luffy-1",
    kind: "pi",
    platform: "linux",
    lanIp: "192.0.2.10",
    isLocal: false,
    role: "standalone",
    llmMonitoring: true,
    comfyMonitoring: true,
    llmPorts: [],
    ssh: { host: "192.0.2.10", user: "devopsfortunato", auth: "key" },
    ...overrides,
  };
}

function tagged(value) {
  Object.defineProperty(value, COLLECTION_SUCCESS, { value: true, enumerable: false });
  return value;
}

test("a Pi monitor never arms GPU/memory/LLM probes and schedules its own status poll", () => {
  const monitor = new SparkMonitor(piSpark());
  monitor._poll = async () => {};
  monitor.start();
  try {
    assert.equal(monitor._domainTimers.gpu, undefined);
    assert.equal(monitor._domainTimers.memory, undefined);
    assert.ok(monitor._domainTimers.cpu != null);
    assert.equal(monitor.llmProbes.size, 0);
    assert.equal(monitor.comfyProbe, null);
    assert.equal(monitor._llmMonitoringEnabled(), false);
  } finally {
    monitor.stop();
  }
});

test("a Pi poll stores board status and skips GPU/unified-memory collection", async () => {
  const monitor = new SparkMonitor(piSpark());
  monitor._running = true;
  monitor.online = true;
  monitor._checkOnline = async () => {};
  let gpuCalls = 0;
  let memoryCalls = 0;
  monitor.collector.collectGpu = async () => {
    gpuCalls += 1;
    return monitor.collector._defaultGpu();
  };
  monitor.collector.collectUnifiedMemory = async () => {
    memoryCalls += 1;
    return monitor.collector._defaultUnifiedMemory();
  };
  monitor.collector.collectCpu = async () =>
    tagged({ usage: 12, temperature: 61, temperatureLabel: "CPU", temperatureSource: "cpu-thermal", draw: null, tdp: null });
  monitor.collector.collectRam = async () => ({ used: 2048, total: 8192, percentage: 25, available: 6144 });
  monitor.collector.collectNetwork = async () => ({ primaryInterface: "eth0", interfaces: [{ name: "eth0" }] });
  monitor.collector.collectStorage = async () => [{ label: "/", used: 10, total: 100, percentage: 10 }];
  monitor.collector.collectPiStatus = async () => ({
    model: "Raspberry Pi 4 Model B Rev 1.4",
    revision: "c03114",
    serial: "abc",
    throttle: { underVoltage: false, throttled: false },
    throttleAvailable: true,
  });

  await monitor._poll();

  assert.equal(gpuCalls, 0);
  assert.equal(memoryCalls, 0);
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.kind, "pi");
  assert.equal(snapshot.metrics.pi.model, "Raspberry Pi 4 Model B Rev 1.4");
  assert.equal(snapshot.pi.model, "Raspberry Pi 4 Model B Rev 1.4");
  assert.equal(snapshot.metrics.cpu.draw, null);
  assert.deepEqual(snapshot.llmPorts, []);
  assert.deepEqual(snapshot.metrics.llm, []);
  assert.equal(snapshot.llmMonitoring, false);
  assert.equal(snapshot.comfyMonitoring, false);
  assert.equal(snapshot.metrics.ram.available, 6144);
});

test("Pi health reports CPU temperature, RAM and firmware throttle state", async () => {
  const monitor = new SparkMonitor(piSpark());
  monitor._running = true;
  monitor._metrics.cpu = { usage: 10, temperature: 76, temperatureLabel: "CPU", temperatureSource: "cpu-thermal", draw: null, tdp: null };
  monitor._metrics.ram = { used: 7600, total: 8192, percentage: 93, available: 592 };
  monitor._metrics.pi = { model: "Raspberry Pi 4", throttle: { underVoltage: true, throttled: true } };
  monitor._updateHealth();
  const ids = monitor.snapshot().health.map((f) => f.id);
  assert.deepEqual(ids, ["pi-thermal", "pi-memory", "pi-under-voltage", "pi-throttle"]);
});

test("Pi lastSuccess drops domains that are never polled", () => {
  const monitor = new SparkMonitor(piSpark());
  monitor._lastSuccess = { gpu: 1, cpu: 2, ram: 3, memory: 4, network: 5, storage: 6, pi: 7, roce: 8 };
  const out = monitor.lastSuccess();
  assert.equal(out.gpu, undefined);
  assert.equal(out.memory, undefined);
  assert.equal(out.roce, undefined);
  assert.equal(out.cpu, 2);
  assert.equal(out.pi, 7);
});
