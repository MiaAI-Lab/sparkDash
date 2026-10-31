import test from "node:test";
import assert from "node:assert/strict";
import { extractSample, memoryReading } from "../historySample.js";

const piSnapshot = (overrides = {}) => ({
  id: "luffy-1",
  kind: "pi",
  online: true,
  metrics: {
    gpu: { temperature: 0, usage: 0, power: { draw: 0 }, vram: { total: 0 } },
    cpu: { usage: 22, temperature: 64, draw: null, tdp: null },
    ram: { used: 2048, total: 8192, percentage: 25, available: 6144 },
    storage: [{ used: 1, total: 2, percentage: 50 }],
    network: { primaryInterface: "eth0", interfaces: [{ name: "eth0", rxSpeed: 10, txSpeed: 20 }] },
    llm: [],
    unifiedMemory: { total: 0, available: 0 },
  },
  ...overrides,
});

test("Pi memory history uses MemAvailable, not the GPU pool or total-minus-used", () => {
  const snapshot = piSnapshot();
  assert.deepEqual(memoryReading(snapshot, () => true), { usedMB: 2048, freeMB: 6144 });
  // Without MemAvailable the fallback still uses the collector's used figure.
  snapshot.metrics.ram = { used: 2048, total: 8192, percentage: 25 };
  assert.deepEqual(memoryReading(snapshot, () => true), { usedMB: 2048, freeMB: 6144 });
});

test("Pi history samples CPU and RAM but no GPU or power series", () => {
  const sample = extractSample(piSnapshot(), () => true);
  assert.equal(sample.cpuUtil, 22);
  assert.equal(sample.cpuTemp, 64);
  assert.equal(sample.ramUsedMB, 2048);
  assert.equal(sample.gpuUtil, undefined);
  assert.equal(sample.gpuPower, undefined);
});
