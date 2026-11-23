import assert from "node:assert/strict";
import test from "node:test";
import { computeLlmInsights } from "../llmInsights.js";

function stat(avg, n = 1, max = avg) {
  return { avg, max, n };
}

function point(t, overrides = {}) {
  return {
    t,
    requestsWaiting: stat(0),
    requestsRunning: stat(1),
    perStreamTps: stat(50),
    genTps: stat(50),
    prefillActive: stat(0),
    decodeActive: stat(1),
    cacheHitRate: stat(0.75),
    kvUsage: stat(0.5),
    deviceMemory: stat(100),
    ttftTime: stat(10, 2),
    ttftCount: stat(1, 2),
    prefillSeconds: stat(4, 2),
    prefillCount: stat(1, 2),
    decodeSeconds: stat(2, 2),
    decodeCount: stat(1, 2),
    latencyTime: stat(20, 2),
    latencyCount: stat(1, 2),
    tpotTime: stat(0.02, 2),
    tpotCount: stat(1, 2),
    preemptions: stat(0, 2),
    promptTokens: stat(1000, 2),
    cachedTokens: stat(500, 2),
    genTokens: stat(100, 2),
    decodeRounds: stat(10, 2),
    ...overrides,
  };
}

test("no points is an explicit unavailable answer, not zeros", () => {
  const out = computeLlmInsights({ points: [] });
  assert.equal(out.available, false);
  assert.equal(out.reason, "no-history");
  assert.deepEqual(out.insights, []);
  assert.equal(out.queueBins.length, 0);
});

test("queue bins summarize decode and TTFT per queue depth and find the knee", () => {
  const points = [
    // Three unqueued buckets.
    point(1),
    point(2),
    point(3),
    // Three buckets with one waiting request, decode holding.
    point(4, { requestsWaiting: stat(1), perStreamTps: stat(48) }),
    point(5, { requestsWaiting: stat(1), perStreamTps: stat(49) }),
    point(6, { requestsWaiting: stat(1), perStreamTps: stat(50) }),
    // Three buckets with two waiting, decode collapsing to 60% and prefill inflating.
    point(7, { requestsWaiting: stat(2), perStreamTps: stat(30), prefillSeconds: stat(18, 2) }),
    point(8, { requestsWaiting: stat(2), perStreamTps: stat(31), ttftTime: stat(60, 2), prefillSeconds: stat(18, 2) }),
    point(9, { requestsWaiting: stat(2), perStreamTps: stat(29), ttftTime: stat(60, 2), prefillSeconds: stat(18, 2) }),
  ];
  const out = computeLlmInsights({ points, stepMs: 60_000 });

  assert.equal(out.available, true);
  assert.equal(out.queueBins[0].buckets, 3);
  assert.equal(out.queueBins[1].buckets, 3);
  assert.equal(out.queueBins[2].buckets, 3);
  assert.equal(out.queueBins[2].perStreamTps, 30);
  assert.equal(out.knee.baselineWaiting, "0");
  assert.equal(out.knee.waiting, "1");
  assert.equal(out.knee.perStreamTps, 49);
  assert.equal(out.knee.baselinePrefillSeconds, 4);
  assert.equal(out.knee.collapse.waiting, "2");
  assert.equal(out.knee.collapse.perStreamTps, 30);
  assert.equal(out.knee.collapse.prefillSeconds, 18);
  assert.equal(out.queueBins[0].ttftSeconds, 10);
  assert.equal(out.queueBins[2].ttftSeconds, 60);
  assert.ok(out.insights.some((i) => i.kind === "queueKnee" && i.severity === "warn"));
  assert.ok(out.insights.some((i) => i.kind === "queuePrefill" && i.severity === "warn"));
});

test("one populated queue bin does not claim a knee", () => {
  const out = computeLlmInsights({
    points: [point(1), point(2), point(3)],
  });
  assert.equal(out.queueBins[0].buckets, 3);
  assert.equal(out.knee, null);
  assert.ok(!out.insights.some((i) => i.kind === "queueKnee"));
});

test("fractional queue averages stay in the low bin, not the last bin", () => {
  const out = computeLlmInsights({
    points: [
      point(1, { requestsWaiting: stat(0.27) }),
      point(2, { requestsWaiting: stat(0.4) }),
      point(3, { requestsWaiting: stat(0.49) }),
    ],
  });
  assert.equal(out.queueBins[0].buckets, 3);
  assert.equal(out.queueBins[4].buckets, 0);
  assert.equal(out.queueBins[4].waitingMean, null);
});

test("a rounded-up fractional queue lands in the next bin", () => {
  const out = computeLlmInsights({
    points: [
      point(1, { requestsWaiting: stat(0.9) }),
      point(2, { requestsWaiting: stat(0.8) }),
      point(3, { requestsWaiting: stat(0.7) }),
    ],
  });
  assert.equal(out.queueBins[0].buckets, 0);
  assert.equal(out.queueBins[1].buckets, 3);
});

test("decode holding through the deepest bin reports no collapse", () => {
  const points = [
    point(1),
    point(2),
    point(3),
    point(4, { requestsWaiting: stat(1) }),
    point(5, { requestsWaiting: stat(1) }),
    point(6, { requestsWaiting: stat(1) }),
  ];
  const out = computeLlmInsights({ points });
  assert.equal(out.knee.waiting, "1");
  assert.equal(out.knee.collapse, null);
  const finding = out.insights.find((i) => i.kind === "queueKnee");
  assert.ok(finding);
  assert.equal(finding.params.collapseWaiting, null);
  assert.ok(!out.insights.some((i) => i.kind === "queuePrefill"));
});

test("request time breaks into queue, prefill, decode and overhead", () => {
  const out = computeLlmInsights({ points: [point(1), point(2)] });
  const r = out.requestTime;
  assert.equal(r.requests, 4);
  assert.equal(r.ttftSecondsPerRequest, 10);
  assert.equal(r.queueSecondsPerRequest, 6);
  assert.equal(r.prefillSecondsPerRequest, 4);
  assert.equal(r.decodeSecondsPerRequest, 2);
  assert.equal(r.latencySecondsPerRequest, 20);
  assert.equal(r.queueShare, 0.3);
  assert.equal(r.prefillShare, 0.2);
  assert.equal(r.decodeShare, 0.1);
  assert.equal(r.overheadShare, 0.4);
  assert.equal(r.perStreamTpsFromTpot, 50);
  assert.ok(out.insights.some((i) => i.kind === "requestBreakdown"));
});

test("cache savings estimate targets a 90% hit rate", () => {
  const out = computeLlmInsights({ points: [point(1), point(2)] });
  assert.equal(out.cache.hitRate, 0.5);
  assert.equal(out.cache.promptTokens, 4000);
  assert.equal(out.cache.cachedTokens, 2000);
  assert.equal(out.cache.computedTokens, 2000);
  // factor = (0.9 − 0.5) / (1 − 0.5) = 0.8; 4 s prefill per request → 3.2 s saved.
  assert.equal(out.cache.prefillSavedPerRequest, 3.2);
  assert.ok(out.insights.some((i) => i.kind === "cacheGap"));
});

test("cache telemetry missing is surfaced even when hit rate exists", () => {
  const out = computeLlmInsights({
    points: [point(1)],
    live: { cache: { status: "unavailable", reason: "engine reports no cache group" } },
  });
  assert.equal(out.cache.telemetry, "unavailable");
  assert.ok(out.insights.some((i) => i.kind === "cacheTelemetryMissing"));
});

test("KV pressure and MTP efficiency are reported from history and live gauges", () => {
  const out = computeLlmInsights({
    points: [
      point(1, { kvUsage: stat(0.9), deviceMemory: stat(110) }),
      point(2, { kvUsage: stat(0.9), deviceMemory: stat(112) }),
    ],
    live: { cache: { status: "unavailable" }, mtpAcceptanceRate: 0.62, clientDisconnectionsTotal: 4 },
  });
  assert.equal(out.kv.usageMax, 0.9);
  assert.equal(out.kv.deviceMaxGb, 112);
  assert.equal(out.kv.clientDisconnections, 4);
  assert.equal(out.mtp.acceptance, 0.62);
  assert.equal(out.mtp.tokensPerRound, 10);
  assert.equal(out.mtp.decodeTps, 50);
  assert.ok(out.insights.some((i) => i.kind === "kvPressure"));
  assert.ok(out.insights.some((i) => i.kind === "mtpEfficiency"));
});

test("time in state reports the share of buckets queued and idle", () => {
  const out = computeLlmInsights({
    points: [
      point(1, { requestsWaiting: stat(0), requestsRunning: stat(0) }),
      point(2, { requestsWaiting: stat(2), requestsRunning: stat(2) }),
      point(3, { requestsWaiting: stat(1), requestsRunning: stat(1), prefillActive: stat(1), decodeActive: stat(0) }),
    ],
  });
  assert.equal(out.timeInState.idleFraction, 0.333);
  assert.equal(out.timeInState.queuedFraction, 0.667);
  assert.equal(out.timeInState.prefillFraction, 0.333);
  assert.equal(out.timeInState.decodeFraction, 0.667);
  assert.equal(out.timeInState.waitingMax, 2);
});

test("the queued flag gives the exact time fraction when present", () => {
  const out = computeLlmInsights({
    points: [
      point(1, { queued: stat(1), idle: stat(0) }),
      point(2, { queued: stat(0), idle: stat(1) }),
      point(3, { queued: stat(0), idle: stat(0) }),
      point(4, { queued: stat(1), idle: stat(1) }),
    ],
  });
  assert.equal(out.timeInState.queuedFraction, 0.5);
  assert.equal(out.timeInState.idleFraction, 0.5);
});

test("a long-context workload is called out from the prompt/completion ratio", () => {
  const out = computeLlmInsights({
    points: [point(1, { promptTokens: stat(100_000, 2), cachedTokens: stat(60_000, 2), genTokens: stat(500, 2) })],
  });
  assert.equal(out.workload.promptPerCompletion, 200);
  assert.equal(out.workload.cachedShare, 0.6);
  assert.ok(out.insights.some((i) => i.kind === "longContext"));
});
