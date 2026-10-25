import type { LlmMetrics, LlmTelemetryPoint } from "../../api/types";

/** What the Overview footer needs from the last hour of ten-second telemetry. */
export interface LlmHourSummary {
  points: LlmTelemetryPoint[];
  /** Median decode tok/s over busy buckets; null when nothing decoded. */
  decodeP50: number | null;
  /** Median prefill tok/s over busy buckets; null when nothing prefilled. */
  prefillP50: number | null;
  /** Ten-second buckets that decoded anything. */
  busyBuckets: number;
  /** Buckets where the engine answered at all; 0 means no data, not idle. */
  observedBuckets: number;
  /** Highest running-request count seen; null when the engine never reported one. */
  peakRunning: number | null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const busy = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v > 0;

/**
 * Medians count busy buckets only: an idle hour is mostly zeros, and folding
 * them in would report a typical speed of 0 for an engine that was fast
 * whenever it worked.
 */
export function summarizeLlmHour(points: LlmTelemetryPoint[]): LlmHourSummary {
  const observed = points.filter((p) => p.available);
  const decode = observed.map((p) => p.generationTps).filter(busy);
  const prefill = observed.map((p) => p.prefillTps).filter(busy);
  const running = points
    .filter((p) => p.available)
    .map((p) => p.requestsRunning)
    .filter((v): v is number => v != null && Number.isFinite(v));
  return {
    points,
    decodeP50: median(decode),
    prefillP50: median(prefill),
    busyBuckets: decode.length,
    observedBuckets: points.filter((p) => p.available).length,
    peakRunning: running.length ? Math.max(...running) : null,
  };
}

/**
 * Concurrent requests for the card. Only an engine-reported slot cap is a
 * denominator: vLLM's KV estimate (`kvCacheMaxConcurrency`) counts requests at
 * full context, and short requests routinely exceed it.
 */
export function llmConcurrency(llm: LlmMetrics) {
  const capacity = llm.slotsTotal > 0 ? llm.slotsTotal : null;
  const running = llm.requestsRunning ?? (capacity != null ? llm.slotsActive : null);
  return { running, waiting: llm.requestsWaiting ?? null, capacity };
}
