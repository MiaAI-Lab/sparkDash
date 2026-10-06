/**
 * An idle LLM card used to show "0 tok/s  0 prefill", which says nothing. The
 * monitor now remembers, per port, the last poll in which the endpoint
 * generated or prefilled tokens, and publishes it as `lastActiveAt` on each
 * LLM metrics entry so the UI can say "Idle · last served 12m ago".
 */
import assert from "node:assert/strict";
import test from "node:test";

import { SparkMonitor } from "../SparkMonitor.js";
import { llmDaily } from "../../collectors/LlmDaily.js";

function spark(llmPorts = [8888, 30000]) {
  return {
    id: "llm-last-active",
    name: "LLM last active",
    lanIp: "127.0.0.1",
    isLocal: true,
    llmMonitoring: true,
    llmPorts,
    comfyMonitoring: false,
  };
}

function sample(generationTps, prefillTps) {
  return { available: true, backend: "vllm", modelId: "m", generationTps, prefillTps, error: null };
}

/** Monitor whose probes return whatever `rates` holds for their port. */
function scriptedMonitor(t, ports) {
  t.mock.method(llmDaily, "record", () => {});
  const monitor = new SparkMonitor(spark(ports));
  monitor._running = true;
  const rates = new Map();
  for (const [port, probe] of monitor.llmProbes) {
    probe.probe = async () => sample(...(rates.get(port) ?? [0, 0]));
  }
  return { monitor, rates };
}

test("lastActiveAt is null until a port serves, then holds the last serving poll", async (t) => {
  let clock = 1_000_000;
  t.mock.method(Date, "now", () => clock);
  const { monitor, rates } = scriptedMonitor(t, [8888, 30000]);

  await monitor._pollDomain("llm");
  assert.deepEqual(
    monitor.snapshot().metrics.llm.map((l) => l.lastActiveAt),
    [null, null],
  );

  // Port 8888 decodes, 30000 only prefills — both count as serving.
  rates.set(8888, [42, 0]);
  rates.set(30000, [0, 900]);
  clock = 2_000_000;
  await monitor._pollDomain("llm");
  assert.deepEqual(
    monitor.snapshot().metrics.llm.map((l) => l.lastActiveAt),
    [2_000_000, 2_000_000],
  );

  // Both go idle: the timestamp stays where the last traffic left it.
  rates.clear();
  clock = 3_000_000;
  await monitor._pollDomain("llm");
  const llm = monitor.snapshot().metrics.llm;
  assert.deepEqual(llm.map((l) => l.lastActiveAt), [2_000_000, 2_000_000]);
  assert.deepEqual(llm.map((l) => l.generationTps), [0, 0]);

  // Only 30000 serves again.
  rates.set(30000, [5, 0]);
  clock = 4_000_000;
  await monitor._pollDomain("llm");
  assert.deepEqual(
    monitor.snapshot().metrics.llm.map((l) => l.lastActiveAt),
    [2_000_000, 4_000_000],
  );
});

test("a port that is removed and re-added starts over at null", async (t) => {
  t.mock.method(Date, "now", () => 5_000);
  const { monitor, rates } = scriptedMonitor(t, [8888]);
  rates.set(8888, [10, 0]);
  await monitor._pollDomain("llm");
  assert.equal(monitor.snapshot().metrics.llm[0].lastActiveAt, 5_000);

  monitor.updateConfig(spark([9999]));
  monitor._running = true;
  for (const probe of monitor.llmProbes.values()) probe.probe = async () => sample(0, 0);
  await monitor._pollDomain("llm");

  monitor.updateConfig(spark([8888]));
  monitor._running = true;
  for (const probe of monitor.llmProbes.values()) probe.probe = async () => sample(0, 0);
  await monitor._pollDomain("llm");
  assert.equal(monitor.snapshot().metrics.llm[0].lastActiveAt, null);
});
