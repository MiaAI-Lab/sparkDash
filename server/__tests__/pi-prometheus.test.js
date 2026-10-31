import test from "node:test";
import assert from "node:assert/strict";
import { renderPrometheusMetrics, unitMetricJson } from "../prometheus.js";

const MIB = 1024 * 1024;

const throttle = {
  raw: "0x50005",
  underVoltage: true,
  freqCapped: false,
  throttled: true,
  softTempLimit: false,
  underVoltageOccurred: true,
  freqCappedOccurred: false,
  throttledOccurred: true,
  softTempLimitOccurred: false,
};

const snapshot = {
  id: "luffy-1",
  name: "luffy-1",
  kind: "pi",
  role: "standalone",
  online: true,
  uptime: 600,
  metrics: {
    gpu: { temperature: 0, usage: 0, power: { draw: 0 }, vram: { total: 0 } },
    cpu: { usage: 21, temperature: 63, draw: null, tdp: null },
    ram: { used: 2048, total: 8192, percentage: 25, available: 6144 },
    storage: [],
    network: { interfaces: [{ name: "eth0", rxSpeed: 10, txSpeed: 20 }] },
    unifiedMemory: { total: 0, available: 0 },
    llm: [],
    pi: { model: "Raspberry Pi 4 Model B Rev 1.4", revision: "c03114", serial: "abc", throttle, throttleAvailable: true },
  },
};

test("Prometheus exports Pi RAM headroom and firmware throttle without GPU series", () => {
  const text = renderPrometheusMetrics([
    { snapshot, collected: { gpu: false, cpu: true }, collectedAt: { cpu: 1, ram: 1, pi: 1 } },
  ]);
  assert.doesNotMatch(text, /sparkdash_gpu_utilization_ratio/);
  assert.match(text, /sparkdash_memory_available_bytes\{[^}]*kind="pi"[^}]*\} 6442450944/);
  assert.match(text, /sparkdash_pi_throttled\{[^}]*reason="under_voltage"[^}]*\} 1/);
  assert.match(text, /sparkdash_pi_throttled\{[^}]*reason="freq_capped"[^}]*\} 0/);
  assert.match(text, /sparkdash_cpu_utilization_ratio\{[^}]*kind="pi"[^}]*\} 0\.21/);
  assert.match(text, /sparkdash_ram_total_bytes\{[^}]*kind="pi"[^}]*\} 8589934592/);
});

test("MQTT JSON carries Pi model/throttle and RAM headroom", () => {
  const json = unitMetricJson({
    snapshot,
    collected: { gpu: false, cpu: true },
    collectedAt: { cpu: 1, ram: 1, pi: 1 },
  });
  assert.equal(json.up, 1);
  assert.equal(json.memory_available_bytes, 6144 * MIB);
  assert.equal(json.pi.model, "Raspberry Pi 4 Model B Rev 1.4");
  assert.equal(json.pi.throttle.underVoltage, true);
  assert.equal(json.gpu, undefined);
  assert.equal(json.cpu.utilization_ratio, 0.21);
  assert.equal(json.ram.total_bytes, 8192 * MIB);
});
