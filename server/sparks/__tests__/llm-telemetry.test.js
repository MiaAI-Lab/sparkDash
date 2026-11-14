import assert from "node:assert/strict";
import test from "node:test";
import { SparkMonitor } from "../SparkMonitor.js";
import { llmDaily } from "../../collectors/LlmDaily.js";

test("only a running monitor writes poll results to its application-owned history", async (t) => {
  t.mock.method(llmDaily, "record", () => {});
  const writes = [];
  const monitor = new SparkMonitor({ id: "fixture", kind: "spark", isLocal: true, llmPorts: [18888], llmMonitoring: true }, {
    llmTelemetry: { record: (...args) => writes.push(args) },
  });
  const metrics = { available: true, backend: "vllm", generationTps: 50, prefillTps: 0 };
  monitor.llmProbes.get(18888).probe = async () => metrics;
  monitor._running = true;
  await monitor._pollDomain("llm");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], ["fixture", 18888, metrics]);
  monitor.stop();
  await monitor._pollDomain("llm");
  assert.equal(writes.length, 1);
});
