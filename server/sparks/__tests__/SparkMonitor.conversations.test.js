/**
 * SparkMonitor occupancy attach (U5).
 * Conversations are top-level, omitted when empty/disabled/worker.
 * No per-tick timestamp. Occupancy must not blank metrics.llm.
 * Run: npm test
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { SparkMonitor } from "../SparkMonitor.js";

function stubSpark(overrides = {}) {
  return {
    id: "spark-local",
    name: "Local",
    lanIp: "127.0.0.1",
    isLocal: true,
    llmPorts: [8888],
    role: "standalone",
    llmMonitoring: true,
    disabledDevices: [],
    disabledInterfaces: [],
    ...overrides,
  };
}

function llmMetrics() {
  return [
    {
      available: true,
      backend: "vllm",
      modelId: "test-model",
      modelPath: null,
      contextLength: 8192,
      gpuMemoryUtilization: 0.5,
      slotsActive: 0,
      slotsTotal: 0,
      generationTps: 0,
      prefillTps: 0,
      totalOutputTokens: 0,
      error: null,
    },
  ];
}

function conversation(overrides = {}) {
  return {
    source: "openclaw",
    handle: "chat-a",
    badge: "stalled",
    port: 8888,
    ...overrides,
  };
}

function monitorWithLlm(spark = stubSpark()) {
  const monitor = new SparkMonitor(spark);
  monitor._metrics.llm = llmMetrics();
  return monitor;
}

test("AE4: occupancy empty leaves metrics.llm and omits conversations", () => {
  const monitor = monitorWithLlm();
  monitor.setConversations([]);
  const snap = monitor.snapshot();
  assert.equal(snap.metrics.llm[0].available, true);
  assert.equal(snap.metrics.llm[0].modelId, "test-model");
  assert.equal("conversations" in snap, false);
});

test("worker spark omits conversations even after setConversations", () => {
  const monitor = monitorWithLlm(stubSpark({ role: "worker", workerNode: true, llmMonitoring: false }));
  monitor.setConversations([conversation()]);
  const snap = monitor.snapshot();
  assert.equal("conversations" in snap, false);
});

test("unchanged conversation list: two snapshot() JSON strings equal", () => {
  const monitor = monitorWithLlm();
  monitor.setConversations([conversation({ handle: "chat-a", badge: "generating" })]);
  const a = JSON.stringify(monitor.snapshot());
  const b = JSON.stringify(monitor.snapshot());
  assert.equal(a, b);
  assert.ok(!a.includes("Date"));
  const snap = monitor.snapshot();
  assert.equal(snap.conversations.length, 1);
  assert.equal(snap.conversations[0].handle, "chat-a");
  assert.equal("timestamp" in snap.metrics, false);
});

test("llmOn snapshot includes conversations when rows exist", () => {
  const monitor = monitorWithLlm();
  monitor.setConversations([conversation()]);
  const snap = monitor.snapshot();
  assert.deepEqual(snap.conversations, [conversation()]);
  assert.equal(snap.metrics.llm[0].available, true);
});

test("setConversations stores a copy", () => {
  const monitor = monitorWithLlm();
  const rows = [conversation()];
  monitor.setConversations(rows);
  rows[0].handle = "mutated";
  assert.equal(monitor.snapshot().conversations[0].handle, "chat-a");
});
