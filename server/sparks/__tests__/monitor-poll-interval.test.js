/**
 * Settings → Poll interval drives the collectors, not just the broadcast.
 *
 * The bug this pins down: choosing 10 s only slowed the WebSocket push while
 * every monitor kept polling GPU/CPU/network/LLM over SSH every 2 s (and 1 s
 * gave no fresher data), because the collector timers read env-only constants.
 * Now the fast domains follow the setting, a change re-arms the running
 * timers in place, and storage / liveness / Tailnet / Hermes keep their own
 * cadences. Bandwidth (nvidia-smi dmon blocks ~1 s) never drops below 2 s.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Nothing in this file may pin a domain, and no test may write under config/.
for (const name of [
  "POLL_INTERVAL_GPU",
  "POLL_INTERVAL_CPU",
  "POLL_INTERVAL_NETWORK",
  "POLL_INTERVAL_LLM",
  "POLL_INTERVAL_COMFY",
  "POLL_INTERVAL_BANDWIDTH",
]) {
  delete process.env[name];
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-poll-"));
process.env.LLM_DAILY_JSON_PATH = path.join(tmp, "llm-daily.json");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { SparkMonitor } = await import("../SparkMonitor.js");
const { resolveFastPollIntervals, BANDWIDTH_MIN_INTERVAL_MS } = await import("../../config.js");

const DOMAINS = ["gpu", "cpu", "ram", "network", "memory", "storage", "llm", "online"];

function spark(overrides = {}) {
  return {
    id: "spark-2",
    name: "spark-2",
    kind: "spark",
    lanIp: "192.168.1.210",
    isLocal: false,
    role: "standalone",
    llmMonitoring: false,
    comfyMonitoring: false,
    hermesMonitoring: false,
    tailscaleMonitoring: false,
    ...overrides,
  };
}

/**
 * A remote monitor whose collectors are stubs (no SSH), with every scheduled
 * domain poll and liveness check counted.
 */
function countingMonitor(t, { sparkOverrides, pollIntervalMs } = {}) {
  t.mock.method(console, "log", () => {});
  const monitor = new SparkMonitor(spark(sparkOverrides), { pollIntervalMs });
  const collector = monitor.collector;
  collector.collectGpu = async () => collector._defaultGpu();
  collector.collectCpu = async () => collector._defaultCpu();
  collector.collectRam = async () => collector._defaultRam();
  collector.collectNetwork = async () => collector._defaultNetwork();
  collector.collectStorage = async () => [];
  collector.collectUnifiedMemory = async () => collector._defaultUnifiedMemory();
  monitor.llmProbes = new Map();
  monitor._readUptime = async () => 1234;
  monitor.online = true;

  const counts = Object.fromEntries(DOMAINS.map((d) => [d, 0]));
  const pollDomain = monitor._pollDomain.bind(monitor);
  monitor._pollDomain = (domain) => {
    counts[domain] += 1;
    return pollDomain(domain);
  };
  const checkOnline = monitor._checkOnline.bind(monitor);
  monitor._checkOnline = () => {
    counts.online += 1;
    return checkOnline();
  };
  const reset = () => DOMAINS.forEach((d) => (counts[d] = 0));
  t.after(() => monitor.stop());
  return { monitor, counts, reset };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Advance the mocked clock in small steps so async polls settle between ticks. */
async function advance(t, ms, step = 100) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    t.mock.timers.tick(step);
    await flush();
  }
}

test("collectors follow the poll interval, and a change re-arms only the fast domains", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { monitor, counts, reset } = countingMonitor(t, { pollIntervalMs: 2000 });
  monitor.start();
  await flush();
  reset();

  await advance(t, 10_000);
  assert.deepEqual(
    { gpu: counts.gpu, cpu: counts.cpu, ram: counts.ram, network: counts.network, memory: counts.memory },
    { gpu: 5, cpu: 5, ram: 5, network: 5, memory: 5 },
    "2 s: five polls per fast domain in 10 s"
  );
  assert.equal(counts.storage, 2, "storage keeps its 5 s cadence");
  assert.equal(counts.online, 2, "liveness keeps its 5 s cadence");

  const storageTimers = monitor._intervals.length;
  monitor.setPollInterval(10_000);
  assert.equal(monitor._intervals.length, storageTimers, "re-armed in place: no timer leaked or lost");
  reset();
  await advance(t, 20_000);
  assert.deepEqual(
    { gpu: counts.gpu, cpu: counts.cpu, ram: counts.ram, network: counts.network, memory: counts.memory },
    { gpu: 2, cpu: 2, ram: 2, network: 2, memory: 2 },
    "10 s: two polls per fast domain in 20 s"
  );
  assert.equal(counts.storage, 4, "storage unaffected by the setting");
  assert.equal(counts.online, 4, "liveness unaffected by the setting");

  monitor.setPollInterval(1000);
  reset();
  await advance(t, 10_000);
  assert.equal(counts.gpu, 10, "1 s: ten GPU polls in 10 s");
  assert.equal(counts.cpu, 10);
  assert.equal(counts.network, 10);
  assert.equal(counts.memory, 5, "bandwidth (dmon) stays at its 2 s floor");
});

test("setting the same interval again leaves every timer alone", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { monitor } = countingMonitor(t, { pollIntervalMs: 5000 });
  monitor.start();
  const before = { ...monitor._domainTimers };
  monitor.setPollInterval(5000);
  assert.deepEqual(monitor._domainTimers, before);
});

test("the LLM timer follows the setting while LLM monitoring is on", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { monitor, counts, reset } = countingMonitor(t, {
    sparkOverrides: { role: "head", llmMonitoring: true, llmPorts: [8888] },
    pollIntervalMs: 2000,
  });
  monitor.start();
  monitor.llmProbes = new Map(); // no HTTP: the probe set is empty
  await flush();
  reset();
  await advance(t, 10_000);
  assert.equal(counts.llm, 5);

  monitor.setPollInterval(5000);
  reset();
  await advance(t, 10_000);
  assert.equal(counts.llm, 2);
});

test("a monitor that is not running only records the interval, and start() uses it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { monitor, counts, reset } = countingMonitor(t, { pollIntervalMs: 2000 });
  monitor.setPollInterval(10_000);
  assert.deepEqual(monitor._domainTimers, {});
  assert.equal(monitor._intervals.length, 0);
  monitor.start();
  await flush();
  reset();
  await advance(t, 10_000);
  assert.equal(counts.gpu, 1);
});

test("re-arming keeps the in-flight guard: no double poll, and the running poll still lands", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { monitor } = countingMonitor(t, { pollIntervalMs: 2000 });
  let gpuCalls = 0;
  let release;
  monitor.collector.collectGpu = () => {
    gpuCalls += 1;
    return new Promise((resolve) => {
      release = () => resolve({ ...monitor.collector._defaultGpu(), temperature: 61 });
    });
  };
  monitor.start(); // the initial poll starts a GPU collection that hangs
  await flush();
  assert.equal(gpuCalls, 1);
  const generation = monitor._runGeneration;

  monitor.setPollInterval(1000);
  await advance(t, 3_000);
  assert.equal(gpuCalls, 1, "the guard held across the re-arm: no second GPU collection");
  assert.equal(monitor._runGeneration, generation, "the run generation is untouched");

  release();
  await flush();
  assert.equal(monitor._metrics.gpu.temperature, 61, "the in-flight result was committed, not discarded");
  await advance(t, 1_000);
  assert.equal(gpuCalls, 2, "polling resumes on the new 1 s cadence");
});

test("re-arming does not reset the offline pause or the liveness backoff", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { monitor } = countingMonitor(t, { pollIntervalMs: 2000 });
  let gpuCalls = 0;
  monitor.collector.collectGpu = async () => {
    gpuCalls += 1;
    return monitor.collector._defaultGpu();
  };
  monitor._readUptime = async () => {
    throw new Error("Permission denied (publickey)");
  };
  monitor.start();
  await flush();
  monitor.online = false;
  monitor._livenessFailures = 5;
  monitor._nextLivenessAt = Date.now() + 15 * 60_000;
  monitor.offlineReason = "SSH authentication failed — check the key or user for this unit";
  gpuCalls = 0;

  monitor.setPollInterval(1000);
  await advance(t, 5_000);

  assert.equal(gpuCalls, 0, "an unreachable remote unit stays paused on the new cadence");
  assert.equal(monitor._pollsPaused, true);
  assert.equal(monitor._livenessFailures, 5);
  assert.ok(monitor._nextLivenessAt > Date.now() + 14 * 60_000, "the backoff deadline is kept");
});

test("resolveFastPollIntervals: setting, env pin per domain, bandwidth floor", () => {
  assert.deepEqual(resolveFastPollIntervals(10_000, {}), {
    gpu: 10_000,
    cpu: 10_000,
    ram: 10_000,
    network: 10_000,
    memory: 10_000,
    llm: 10_000,
    comfy: 10_000,
  });
  assert.equal(BANDWIDTH_MIN_INTERVAL_MS, 2000);
  assert.equal(resolveFastPollIntervals(1000, {}).memory, 2000, "dmon floor");
  assert.equal(resolveFastPollIntervals(1000, {}).gpu, 1000);
  // An explicitly set env var wins for its own domain only.
  const pinned = resolveFastPollIntervals(10_000, { gpu: 3000, memory: 1000 });
  assert.equal(pinned.gpu, 3000);
  assert.equal(pinned.memory, 1000, "an explicit env value is the operator's call, floor or not");
  assert.equal(pinned.cpu, 10_000);
  // No setting (or garbage) falls back to the historical 2 s.
  assert.equal(resolveFastPollIntervals(undefined, {}).gpu, 2000);
  assert.equal(resolveFastPollIntervals(Number.NaN, {}).gpu, 2000);
});
