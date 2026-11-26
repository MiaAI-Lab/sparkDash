import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import { makeSpark } from "../../testing/fixtures";
import { flush, render } from "../../testing/render";
import type { LlmInsightsData, LlmMetrics, MetricsHistoryData } from "../../api/types";
import { LlmServerDetailPage } from "./LlmServerDetailPage";
import { LlmServersPage } from "./LlmServersPage";

const { history, insights, daily } = vi.hoisted(() => ({
  history: vi.fn(),
  insights: vi.fn(),
  daily: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  getUnitHistory: history,
  getLlmInsights: insights,
  fetchLlmDaily: daily,
}));
vi.mock("../../api/llmTokenClient", () => ({
  fetchLlmTokenTotals: vi.fn(() => Promise.resolve({ range: "all", series: [] })),
}));

function sparkWithEngine() {
  const spark = makeSpark();
  spark.metrics.llm = [
    {
      port: 8888,
      available: true,
      measurementValid: true,
      backend: "tensorfold",
      modelId: "Qwen3-32B",
      models: ["Qwen3-32B"],
      contextLength: 32768,
      generationTps: 69.53,
      perStreamTps: 93.65,
      prefillTps: 624,
      kvCacheUsage: 0.63,
      prefixCacheHitRate: 0.695,
      mtpAcceptanceRate: 0.672,
      requestsRunning: 1,
      requestsWaiting: 0,
      slots: { total: null, running: 1, waiting: 0, prefilling: false, decoding: true, idle: false },
      ttftP95Seconds: 89.8,
      deviceMemoryBytes: 112.4 * 1024 ** 3,
      cache: { status: "unavailable", source: "health", reason: "engine reports no cache group" },
      cluster: {
        parts: 2,
        partRows: 1000,
        ranksReported: 1,
        pair: { failed: 0, busyMs: 18, stallMs: 120000, stalled: false, broken: false },
        partStats: [
          { id: "0", freeRows: 200, liveRows: 0, keptRows: 800, twinRows: 0, holdRows: 0, liveStreams: 0 },
          { id: "1", freeRows: 300, liveRows: 100, keptRows: 600, twinRows: 0, holdRows: 0, liveStreams: 1 },
        ],
        ranks: [
          {
            id: "0", spillPoints: 3, spillBlocks: 10, storedBytes: 100 * 1024 ** 3,
            capacityBytes: 1024 * 1024 ** 3, diskFreeBytes: 500 * 1024 ** 3, stagingBytes: 0,
            stagingPeakBytes: 0, writesQueued: 10, writesCommitted: 10,
            writesFailed: 0, writesPending: 0, readBytes: 2 * 1024 ** 3, readFailed: 0,
            dedupBlocks: 1, dedupBytes: 0, compatibleMisses: 2, crcErrors: 0,
            sizeErrors: 0, evictedTurns: 4, evictedForks: 0, promptFetches: 20,
            promptRows: 500, promptBytes: 8 * 1024 ** 3, promptSyncs: 5,
            fetchRounds: 40, ownerRounds: 0, copies: 1, copyBytes: 1024 ** 2,
            plans: 20, checks: 2, transfersFailed: 0,
          },
          {
            id: "1", spillPoints: 3, spillBlocks: 10, storedBytes: 120 * 1024 ** 3,
            capacityBytes: 1024 * 1024 ** 3, diskFreeBytes: 480 * 1024 ** 3, stagingBytes: 0,
            stagingPeakBytes: 0, writesQueued: 10, writesCommitted: 10,
            writesFailed: 0, writesPending: 0, readBytes: 3 * 1024 ** 3, readFailed: 0,
            dedupBlocks: 1, dedupBytes: 0, compatibleMisses: 0, crcErrors: 0,
            sizeErrors: 0, evictedTurns: 4, evictedForks: 0, promptFetches: null,
            promptRows: null, promptBytes: null, promptSyncs: null, fetchRounds: null,
            ownerRounds: null, copies: null, copyBytes: null, plans: null, checks: null,
            transfersFailed: null,
          },
        ],
        transfer: {
          carries: 2, carryRescued: 1, carryPressure: 0, carryOthers: 1, carryPaused: 0,
          moves: 1, movedTokens: 400, movedBytes: 1024 ** 2, copies: 1,
          copyBytes: 1024 ** 2, promptFetches: 20, promptRows: 500,
          promptBytes: 8 * 1024 ** 3, promptSyncs: 5, fetchRounds: 40,
          ownerRounds: 0, transfersFailed: 0, refusedNoTarget: 5, noPart: 0, staled: 5,
        },
      },
    },
  ] as unknown as LlmMetrics[];
  return spark;
}

function historyData(): MetricsHistoryData {
  const now = Date.now();
  const point = (offset: number, waiting: number, perStream: number) => ({
    t: now - offset,
    requestsWaiting: { avg: waiting, max: waiting, n: 1 },
    requestsRunning: { avg: 2, max: 2, n: 1 },
    perStreamTps: { avg: perStream, max: perStream, n: 1 },
    genTps: { avg: perStream * 2, max: perStream * 2, n: 1 },
    prefillTps: { avg: 600, max: 600, n: 1 },
    kvUsage: { avg: 0.6, max: 0.6, n: 1 },
    cacheHitRate: { avg: 0.7, max: 0.7, n: 1 },
    deviceMemory: { avg: 110, max: 110, n: 1 },
    prefillActive: { avg: 0.4, max: 1, n: 1 },
    decodeActive: { avg: 0.5, max: 1, n: 1 },
    queueWait: { avg: 4, max: 4, n: 1 },
    prefillSeconds: { avg: 3, max: 3, n: 1 },
    decodeSeconds: { avg: 2, max: 2, n: 1 },
  });
  return {
    enabled: true,
    range: "24h",
    stepMs: 180_000,
    from: now - 6 * 180_000,
    to: now,
    points: [],
    llm: [
      {
        port: 8888,
        points: [point(300_000, 0, 50), point(120_000, 1, 48), point(0, 3, 30)],
      },
    ],
    cache: null,
  };
}

function insightsData(): LlmInsightsData {
  return {
    enabled: true,
    port: 8888,
    range: "24h",
    stepMs: 180_000,
    from: 0,
    to: 1,
    available: true,
    reason: null,
    sampleBuckets: 3,
    queueBins: [
      { id: "0", label: "0", buckets: 1, requests: 2, waitingMean: 0, runningMean: 2, perStreamTps: 50, genTps: 100, ttftSeconds: 10, prefillSeconds: 4, decodeSeconds: 2, cacheHitRate: 0.7, kvUsage: 0.6, decodeEfficiency: 1, prefillActiveFraction: 0.4, decodeActiveFraction: 0.5, prefillShare: 0.2 },
      { id: "1", label: "1", buckets: 1, requests: 2, waitingMean: 1, runningMean: 2, perStreamTps: 48, genTps: 96, ttftSeconds: 14, prefillSeconds: 5, decodeSeconds: 2, cacheHitRate: 0.7, kvUsage: 0.6, decodeEfficiency: 1, prefillActiveFraction: 0.5, decodeActiveFraction: 0.5, prefillShare: 0.25 },
      { id: "2", label: "2", buckets: 0, requests: 0, waitingMean: null, runningMean: null, perStreamTps: null, genTps: null, ttftSeconds: null, prefillSeconds: null, decodeSeconds: null, cacheHitRate: null, kvUsage: null, decodeEfficiency: null, prefillActiveFraction: null, decodeActiveFraction: null, prefillShare: null },
      { id: "3-4", label: "3–4", buckets: 1, requests: 2, waitingMean: 3, runningMean: 2, perStreamTps: 30, genTps: 60, ttftSeconds: 40, prefillSeconds: 9, decodeSeconds: 2, cacheHitRate: 0.7, kvUsage: 0.6, decodeEfficiency: 1, prefillActiveFraction: 0.8, decodeActiveFraction: 0.2, prefillShare: 0.5 },
      { id: "5+", label: "5+", buckets: 0, requests: 0, waitingMean: null, runningMean: null, perStreamTps: null, genTps: null, ttftSeconds: null, prefillSeconds: null, decodeSeconds: null, cacheHitRate: null, kvUsage: null, decodeEfficiency: null, prefillActiveFraction: null, decodeActiveFraction: null, prefillShare: null },
    ],
    knee: { waiting: "1", baselineWaiting: "0", baselinePerStreamTps: 50, baselinePrefillSeconds: 4, perStreamTps: 48, buckets: 1, collapse: { waiting: "3–4", perStreamTps: 30, ttftSeconds: 40, prefillSeconds: 9 } },
    requestTime: {
      requests: 6,
      queueSecondsPerRequest: 4,
      prefillSecondsPerRequest: 4,
      decodeSecondsPerRequest: 2,
      ttftSecondsPerRequest: 10,
      latencySecondsPerRequest: 20,
      queueShare: 0.2,
      prefillShare: 0.2,
      decodeShare: 0.1,
      overheadShare: 0.5,
      meanInterTokenSeconds: 0.02,
      perStreamTpsFromTpot: 50,
    },
    cache: {
      hitRate: 0.5,
      hitRateGauge: 0.7,
      promptTokens: 4000,
      cachedTokens: 2000,
      computedTokens: 2000,
      targetHitRate: 0.9,
      prefillSavedPerRequest: 3.2,
      prefillSavedTotal: 16,
      telemetry: "unavailable",
    },
    kv: {
      usageMean: 0.6,
      usageMax: 0.9,
      deviceMeanGb: 110,
      deviceMaxGb: 112,
      preemptions: 0,
      clientDisconnections: 4,
    },
    mtp: { acceptance: 0.62, tokensPerRound: 3.14, decodeTps: 50, rounds: 10 },
    workload: {
      promptTokens: 4000,
      completionTokens: 1000,
      promptPerCompletion: 4,
      cachedShare: 0.5,
      promptPerRequest: 1000,
      outputPerRequest: 250,
    },
    timeInState: {
      prefillFraction: 0.4,
      decodeFraction: 0.5,
      queuedFraction: 0.667,
      idleFraction: 0,
      runningMean: 2,
      waitingMean: 1,
      waitingMax: 3,
    },
    insights: [
      {
        kind: "queueKnee",
        severity: "warn",
        params: {
          waiting: "1",
          baselineWaiting: "0",
          baselinePerStreamTps: 50,
          perStreamTps: 48,
          collapseWaiting: "3–4",
          collapsePerStreamTps: 30,
          collapseTtftSeconds: 40,
        },
      },
      {
        kind: "queuePrefill",
        severity: "warn",
        params: {
          baselineWaiting: "0",
          collapseWaiting: "3–4",
          baselinePrefillSeconds: 4,
          collapsePrefillSeconds: 9,
          ratio: 2.25,
        },
      },
      {
        kind: "cacheGap",
        severity: "info",
        params: {
          hitRate: 0.5,
          targetHitRate: 0.9,
          prefillSecondsPerRequest: 4,
          prefillSavedPerRequest: 3.2,
          prefillSavedTotal: 16,
          cachedTokens: 2000,
          computedTokens: 2000,
        },
      },
    ],
  };
}

beforeEach(async () => {
  history.mockReset().mockResolvedValue(historyData());
  insights.mockReset().mockResolvedValue(insightsData());
  daily.mockReset().mockResolvedValue({ days: [] });
  localStorage.clear();
  await act(() => setLocale("en"));
});

describe("LLM Servers view", () => {
  it("lists monitored endpoints with their live engine state", async () => {
    const { container } = render(<LlmServersPage sparks={[sparkWithEngine()]} />);
    await flush();
    expect(container.querySelector(".ls-card")).not.toBeNull();
    expect(container.textContent).toContain("Spark spark-1");
    expect(container.textContent).toContain("TensorFold");
    expect(container.textContent).toContain("Qwen3-32B");
    expect(container.textContent).toContain("69.5");
    expect(container.textContent).toContain("63%");
    expect(container.textContent).toContain("70%");
    expect(container.querySelector('a[href="/llm/spark-1"]')).not.toBeNull();
  });

  it("shows the endpoint detail with live tiles, charts and findings", async () => {
    const { container } = render(
      <LlmServerDetailPage sparkId="spark-1" sparks={[sparkWithEngine()]} onBack={() => {}} />
    );
    await flush();
    expect(container.textContent).toContain("Spark spark-1");
    expect(container.textContent).toContain("Qwen3-32B");
    expect(container.textContent).toContain("69.5");
    expect(container.textContent).toContain("93.7");
    expect(container.textContent).toContain("Right now");
    expect(container.textContent).toContain("Decoding");
    expect(container.textContent).toContain("Serving normally");
    expect(container.textContent).toContain("Throughput");
    expect(container.textContent).toContain("Latency");
    expect(container.textContent).toContain("Engine memory");
    expect(container.textContent).toContain("Cluster");
    expect(container.textContent).toContain("2 nodes");
    expect(container.textContent).toContain("across 2 nodes");
    expect(container.textContent).toContain("2 KV parts · 1,000 rows each");
    expect(container.textContent).toContain("Pair healthy");
    expect(container.textContent).toContain("Node 0");
    expect(container.textContent).toContain("Node 1");
    expect(container.textContent).toContain("600");
    expect(container.textContent).toContain("Cross-rank transfers");
    expect(container.textContent).toContain("Queue knee");
    expect(container.textContent).toContain("Queue depth and prefill time");
    expect(container.textContent).toContain("Prefix cache headroom");
    expect(container.textContent).toContain("Time in state");
    expect(container.textContent).toContain("Queue depth vs decode");
    expect(container.textContent).toContain("Prefill vs decode");
    expect(container.textContent).toContain("Cache and KV");
    expect(history).toHaveBeenCalledWith("spark-1", "24h", true);
    expect(insights).toHaveBeenCalledWith("spark-1", 8888, "24h");
  });

  it("switches range and endpoint port", async () => {
    const spark = sparkWithEngine();
    spark.llmPorts = [8888, 8889];
    spark.metrics.llm = [
      ...(spark.metrics.llm ?? []),
      { port: 8889, available: false, backend: "vllm", modelId: null, generationTps: 0, prefillTps: 0 },
    ] as unknown as LlmMetrics[];
    const { container } = render(
      <LlmServerDetailPage sparkId="spark-1" sparks={[spark]} onBack={() => {}} />
    );
    await flush();
    const sixHours = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "6h")!;
    act(() => sixHours.click());
    await flush();
    expect(history).toHaveBeenLastCalledWith("spark-1", "6h", true);
    const secondPort = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === ":8889")!;
    act(() => secondPort.click());
    await flush();
    expect(insights).toHaveBeenLastCalledWith("spark-1", 8889, "6h");
  });

  it("keeps the live tiles when metrics history is off", async () => {
    history.mockResolvedValue({ enabled: false });
    insights.mockResolvedValue({ enabled: false });
    const { container } = render(
      <LlmServerDetailPage sparkId="spark-1" sparks={[sparkWithEngine()]} onBack={() => {}} />
    );
    await flush();
    expect(container.textContent).toContain("Metrics history is off");
    expect(container.textContent).toContain("69.5");
    expect(container.textContent).not.toContain("Queue knee");
  });

  it("summarises an idle engine with its last activity", async () => {
    const spark = sparkWithEngine();
    const base = spark.metrics.llm![0] as LlmMetrics;
    spark.metrics.llm = [
      {
        ...base,
        generationTps: 0,
        perStreamTps: null,
        prefillTps: 0,
        requestsRunning: 0,
        requestsWaiting: 0,
        slots: { total: 4, running: 0, waiting: 0, prefilling: false, decoding: false, idle: true },
        lastActiveAt: Date.now() - 120_000,
      },
    ] as unknown as LlmMetrics[];
    const { container } = render(
      <LlmServerDetailPage sparkId="spark-1" sparks={[spark]} onBack={() => {}} />
    );
    await flush();
    expect(container.textContent).toContain("Idle");
    expect(container.textContent).toContain("No requests in flight.");
    expect(container.textContent).toContain("Last served 2m ago");
  });

  it("flags queue pressure and running/waiting slots", async () => {
    const spark = sparkWithEngine();
    const base = spark.metrics.llm![0] as LlmMetrics;
    spark.metrics.llm = [
      {
        ...base,
        requestsRunning: 2,
        requestsWaiting: 3,
        prefixCacheHitRate: 0.1,
        slots: { total: 8, running: 2, waiting: 3, prefilling: false, decoding: true, idle: false },
      },
    ] as unknown as LlmMetrics[];
    const { container } = render(
      <LlmServerDetailPage sparkId="spark-1" sparks={[spark]} onBack={() => {}} />
    );
    await flush();
    expect(container.textContent).toContain("Queued");
    expect(container.textContent).toContain("3 waiting · 2 running.");
    expect(container.textContent).toContain("Queue pressure");
    expect(container.textContent).toContain("Cache cold");
    expect(container.textContent).toContain("5 of 8 slots");
  });
});
