import assert from "node:assert/strict";
import test from "node:test";

import { SparkMonitor } from "../SparkMonitor.js";
import { SWAP_STREAK } from "../../health/HealthEvaluator.js";

function spark() {
  return {
    id: "spark-swap",
    name: "Spark Swap",
    lanIp: "127.0.0.1",
    isLocal: true,
    llmMonitoring: false,
    comfyMonitoring: false,
  };
}

/** A memory sample with swap traffic, as SystemCollector reports it. */
function swapping(inPagesPerSec, outPagesPerSec) {
  return {
    total: 124000,
    available: 8000,
    percentage: 50,
    swap: { inPagesPerSec, outPagesPerSec },
  };
}

test("a memory poll advances the swap streak, so sustained swapping reaches health", async () => {
  const monitor = new SparkMonitor(spark());
  monitor._running = true;
  monitor.collector.collectUnifiedMemory = async () => swapping(500, 0);

  for (let i = 0; i < SWAP_STREAK - 1; i++) {
    await monitor._pollDomain("memory");
    assert.deepEqual(monitor._health.map((f) => f.id), []);
  }
  await monitor._pollDomain("memory");
  const ids = monitor._health.map((f) => f.id);
  assert.ok(ids.includes("swap-traffic"), `expected swap-traffic in ${JSON.stringify(ids)}`);
  const finding = monitor._health.find((f) => f.id === "swap-traffic");
  assert.match(finding.detail, /Swap-in 500 pages\/s/);
});
