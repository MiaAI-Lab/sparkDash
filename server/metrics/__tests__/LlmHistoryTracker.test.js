import assert from "node:assert/strict";
import test from "node:test";
import { createLlmHistoryTracker } from "../LlmHistoryTracker.js";
import { llmKey } from "../historyTiers.js";

function snap(overrides = {}, llm = {}) {
  return {
    id: "unit",
    online: true,
    llmPorts: [8888],
    metrics: {
      llm: [
        {
          port: 8888,
          available: true,
          measurementValid: true,
          modelId: "model",
          generationTps: 50,
          perStreamTps: 25,
          requestsRunning: 2,
          requestsWaiting: 1,
          slotsTotal: 4,
          prefillActive: false,
          decodeActive: true,
          prefixCacheHitRate: 0.75,
          mtpAcceptanceRate: 0.6,
          kvCacheUsage: 0.5,
          deviceMemoryBytes: 100 * 1024 ** 3,
          totalPromptTokens: 1000,
          totalCachedTokens: 700,
          totalOutputTokens: 100,
          prefillSecondsTotal: 10,
          prefillCountTotal: 1,
          decodeSecondsTotal: 20,
          decodeCountTotal: 1,
          ttftSecondsTotal: 30,
          ttftCountTotal: 1,
          latencySecondsTotal: 55,
          latencyCountTotal: 1,
          tpotSecondsTotal: 0.4,
          tpotCountTotal: 1,
          preemptionsTotal: 0,
          decodeRoundsTotal: 10,
          ...llm,
        },
      ],
    },
    ...overrides,
  };
}

test("the first sample seeds cumulative baselines and records gauges only", () => {
  const tracker = createLlmHistoryTracker();
  const values = tracker.record(snap(), 1_000, () => true);
  assert.equal(values[llmKey(8888, "requestsRunning")], 2);
  assert.equal(values[llmKey(8888, "requestsWaiting")], 1);
  assert.equal(values[llmKey(8888, "queued")], 1);
  assert.equal(values[llmKey(8888, "idle")], 0);
  assert.equal(values[llmKey(8888, "perStreamTps")], 25);
  assert.equal(values[llmKey(8888, "decodeActive")], 1);
  assert.equal(values[llmKey(8888, "deviceMemory")], 100);
  // No delta on the first sample: a restart is not one interval of requests.
  assert.equal(values[llmKey(8888, "prefillSeconds")], undefined);
  assert.equal(values[llmKey(8888, "queueWait")], undefined);
});

test("the second sample differences counters and derives queue/prefill shares", () => {
  const tracker = createLlmHistoryTracker();
  tracker.record(snap(), 1_000, () => true);
  const values = tracker.record(
    snap({}, {
      prefillSecondsTotal: 13,
      prefillCountTotal: 2,
      decodeSecondsTotal: 24,
      decodeCountTotal: 2,
      ttftSecondsTotal: 40,
      ttftCountTotal: 2,
      latencySecondsTotal: 71,
      latencyCountTotal: 2,
      tpotSecondsTotal: 0.6,
      tpotCountTotal: 2,
      totalPromptTokens: 1500,
      totalCachedTokens: 900,
      totalOutputTokens: 160,
      decodeRoundsTotal: 16,
    }),
    3_000,
    () => true
  );
  assert.equal(values[llmKey(8888, "prefillSeconds")], 3);
  assert.equal(values[llmKey(8888, "prefillCount")], 1);
  assert.equal(values[llmKey(8888, "decodeSeconds")], 4);
  assert.equal(values[llmKey(8888, "ttftTime")], 10);
  // TTFT includes queue wait + prefill: 10 − 3 = 7.
  assert.equal(values[llmKey(8888, "queueWait")], 7);
  assert.ok(Math.abs(values[llmKey(8888, "prefillShare")] - 3 / 14) < 1e-9);
  assert.equal(values[llmKey(8888, "promptTokens")], 500);
  assert.equal(values[llmKey(8888, "cachedTokens")], 200);
  assert.equal(values[llmKey(8888, "genTokens")], 60);
  assert.equal(values[llmKey(8888, "decodeRounds")], 6);
  assert.equal(values[llmKey(8888, "latencyTime")], 16);
  assert.equal(values[llmKey(8888, "overheadSeconds")], 2);
});

test("a gap longer than the baseline window seeds instead of reporting the gap", () => {
  const tracker = createLlmHistoryTracker();
  tracker.record(snap(), 1_000, () => true);
  const values = tracker.record(snap(), 200_000, () => true);
  assert.equal(values[llmKey(8888, "prefillSeconds")], undefined);
  assert.equal(values[llmKey(8888, "requestsRunning")], 2);
});

test("a counter reset omits the delta and reseeds from the new value", () => {
  const tracker = createLlmHistoryTracker();
  tracker.record(snap(), 1_000, () => true);
  const reset = tracker.record(snap({}, { totalOutputTokens: 10 }), 3_000, () => true);
  assert.equal(reset[llmKey(8888, "genTokens")], undefined);
  const next = tracker.record(snap({}, { totalOutputTokens: 40 }), 5_000, () => true);
  assert.equal(next[llmKey(8888, "genTokens")], 30);
});

test("unknown queue and run gauges stay gaps, not false idle", () => {
  const tracker = createLlmHistoryTracker();
  const values = tracker.record(
    snap({}, { requestsRunning: null, requestsWaiting: null }),
    1_000,
    () => true
  );
  assert.equal(values[llmKey(8888, "queued")], undefined);
  assert.equal(values[llmKey(8888, "idle")], undefined);
  assert.equal(values[llmKey(8888, "requestsWaiting")], undefined);
});

test("an offline unit or a stale LLM domain contributes nothing", () => {
  const tracker = createLlmHistoryTracker();
  assert.deepEqual(tracker.record(snap({ online: false }), 1_000, () => true), {});
  assert.deepEqual(tracker.record(snap(), 1_000, () => false), {});
});

test("an endpoint whose stats could not be read is a gap, not zeros", () => {
  const tracker = createLlmHistoryTracker();
  const values = tracker.record(snap({}, { measurementValid: false }), 1_000, () => true);
  assert.deepEqual(values, {});
});
