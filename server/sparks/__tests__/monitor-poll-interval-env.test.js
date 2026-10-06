/**
 * An explicitly set POLL_INTERVAL_* env var still pins its domain: Settings →
 * Poll interval moves every other fast domain, but not that one. (node --test
 * runs each file in its own process, so the env set here is seen by config.js
 * at import time, exactly as on a real server.)
 */
import assert from "node:assert/strict";
import test from "node:test";

for (const name of [
  "POLL_INTERVAL_CPU",
  "POLL_INTERVAL_NETWORK",
  "POLL_INTERVAL_LLM",
  "POLL_INTERVAL_COMFY",
  "POLL_INTERVAL_BANDWIDTH",
]) {
  delete process.env[name];
}
process.env.POLL_INTERVAL_GPU = "3000";

const { SparkMonitor } = await import("../SparkMonitor.js");
const { FAST_POLL_ENV_OVERRIDES } = await import("../../config.js");

test("POLL_INTERVAL_GPU wins over the setting for GPU only", async (t) => {
  assert.equal(FAST_POLL_ENV_OVERRIDES.gpu, 3000);
  assert.equal(FAST_POLL_ENV_OVERRIDES.cpu, null);

  t.mock.timers.enable({ apis: ["setInterval"] });
  t.mock.method(console, "log", () => {});
  const monitor = new SparkMonitor(
    {
      id: "spark-1",
      name: "spark-1",
      kind: "spark",
      lanIp: "192.168.1.119",
      isLocal: false,
      role: "standalone",
      llmMonitoring: false,
    },
    { pollIntervalMs: 10_000 }
  );
  t.after(() => monitor.stop());
  for (const method of ["collectGpu", "collectCpu", "collectRam", "collectNetwork", "collectUnifiedMemory"]) {
    monitor.collector[method] = async () => ({});
  }
  monitor.collector.collectStorage = async () => [];
  monitor._readUptime = async () => 1;
  monitor.online = true;
  const counts = { gpu: 0, cpu: 0 };
  const pollDomain = monitor._pollDomain.bind(monitor);
  monitor._pollDomain = (domain) => {
    if (domain in counts) counts[domain] += 1;
    return pollDomain(domain);
  };

  assert.equal(monitor._fastIntervals.gpu, 3000);
  assert.equal(monitor._fastIntervals.cpu, 10_000);

  monitor.start();
  await new Promise((resolve) => setImmediate(resolve));
  counts.gpu = 0;
  counts.cpu = 0;
  for (let i = 0; i < 300; i += 1) {
    t.mock.timers.tick(100);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(counts.gpu, 10, "GPU pinned at 3 s by env: 10 polls in 30 s");
  assert.equal(counts.cpu, 3, "CPU follows the 10 s setting: 3 polls in 30 s");

  const gpuTimer = monitor._domainTimers.gpu;
  monitor.setPollInterval(1000);
  assert.equal(monitor._domainTimers.gpu, gpuTimer, "the pinned GPU timer is not re-armed");
  assert.notEqual(monitor._domainTimers.cpu, undefined);
  assert.equal(monitor._fastIntervals.cpu, 1000);
});
