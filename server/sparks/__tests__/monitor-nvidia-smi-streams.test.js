/**
 * The monitor owns its collector's long-lived nvidia-smi readers: it turns
 * them on at its poll cadence, re-tunes them when the interval changes, and
 * stops them when it stops or replaces the collector.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

for (const name of ["POLL_INTERVAL_GPU", "POLL_INTERVAL_BANDWIDTH"]) delete process.env[name];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-smi-streams-"));
process.env.LLM_DAILY_JSON_PATH = path.join(tmp, "llm-daily.json");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { SparkMonitor } = await import("../SparkMonitor.js");

function localSpark(overrides = {}) {
  return {
    id: "local",
    name: "local",
    kind: "spark",
    isLocal: true,
    role: "standalone",
    llmMonitoring: false,
    comfyMonitoring: false,
    hermesMonitoring: false,
    tailscaleMonitoring: false,
    ...overrides,
  };
}

/** Records the stream calls a collector receives; polls do nothing. */
function recordingCollector(collector, calls) {
  collector.useNvidiaSmiStreams = (intervals) => calls.push(["use", intervals.gpu, intervals.memory]);
  collector.dispose = () => calls.push(["dispose"]);
  for (const name of ["collectGpu", "collectCpu", "collectRam", "collectNetwork", "collectUnifiedMemory"]) {
    collector[name] = async () => null;
  }
  collector.collectStorage = async () => [];
  return collector;
}

test("start enables the readers at the poll cadence, interval changes re-tune them, stop disposes", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.mock.method(console, "log", () => {});
  const monitor = new SparkMonitor(localSpark(), { pollIntervalMs: 1000 });
  monitor._poll = () => {};
  const calls = [];
  recordingCollector(monitor.collector, calls);

  monitor.start();
  assert.deepEqual(calls, [["use", 1000, 2000]], "bandwidth keeps its 2 s floor");
  monitor.setPollInterval(5000);
  assert.deepEqual(calls.at(-1), ["use", 5000, 5000]);
  monitor.stop();
  assert.deepEqual(calls.at(-1), ["dispose"]);
  monitor.setPollInterval(1000);
  assert.deepEqual(calls.at(-1), ["dispose"], "a stopped monitor does not start readers");
});

test("a replaced collector is disposed and the new one takes over", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.mock.method(console, "log", () => {});
  const monitor = new SparkMonitor(localSpark(), { pollIntervalMs: 2000 });
  monitor._poll = () => {};
  monitor._detectHardwareInBackground = () => {};
  const oldCalls = [];
  recordingCollector(monitor.collector, oldCalls);
  monitor.start();
  const old = monitor.collector;

  monitor.updateConfig(localSpark({ agent: { url: "http://127.0.0.1:1" } }));
  assert.notEqual(monitor.collector, old);
  assert.deepEqual(oldCalls.at(-1), ["dispose"]);
  assert.deepEqual(monitor.collector._smiStreamIntervals, { gpu: 2000, memory: 2000 });
  monitor.stop();
  assert.equal(monitor.collector._smiStreamIntervals, null);
});
