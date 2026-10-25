import { describe, expect, it } from "vitest";
import type { LlmMetrics, LlmTelemetryPoint } from "../../api/types";
import { llmConcurrency, summarizeLlmHour } from "./llmHour";

function point(over: Partial<LlmTelemetryPoint>): LlmTelemetryPoint {
  return { t: 0, available: true, backend: "vllm", generationTps: null, prefillTps: null, ...over } as LlmTelemetryPoint;
}

describe("summarizeLlmHour", () => {
  it("takes medians over busy buckets so idle time does not drag them to zero", () => {
    const hour = summarizeLlmHour([
      point({ generationTps: 0, prefillTps: 0 }),
      point({ generationTps: 0, prefillTps: 0 }),
      point({ generationTps: 0, prefillTps: 0 }),
      point({ generationTps: 40, prefillTps: 300 }),
      point({ generationTps: 60, prefillTps: null }),
      point({ generationTps: 50, prefillTps: 500 }),
    ]);
    expect(hour.decodeP50).toBe(50);
    expect(hour.prefillP50).toBe(400);
    expect(hour.busyBuckets).toBe(3);
  });

  it("reports an unknown median and no peak for an hour with nothing to measure", () => {
    const hour = summarizeLlmHour([point({ generationTps: 0 }), point({ generationTps: null })]);
    expect(hour.decodeP50).toBeNull();
    expect(hour.prefillP50).toBeNull();
    expect(hour.busyBuckets).toBe(0);
    expect(hour.observedBuckets).toBe(2);
    expect(hour.peakRunning).toBeNull();
  });

  it("keeps the hour's peak concurrency", () => {
    const hour = summarizeLlmHour([
      point({ requestsRunning: 2 }),
      point({ requestsRunning: 6 }),
      point({ requestsRunning: null }),
    ]);
    expect(hour.peakRunning).toBe(6);
  });
});

describe("llmConcurrency", () => {
  const base = { slotsActive: 0, slotsTotal: 0 } as LlmMetrics;

  it("does not treat vLLM's full-context KV estimate as a slot cap", () => {
    expect(
      llmConcurrency({ ...base, requestsRunning: 4, requestsWaiting: 0, kvCacheMaxConcurrency: 3.78 } as LlmMetrics)
    ).toEqual({ running: 4, waiting: 0, capacity: null });
  });

  it("uses an engine-reported slot cap, falling back to busy slots for running", () => {
    expect(llmConcurrency({ ...base, slotsActive: 2, slotsTotal: 4 })).toEqual({
      running: 2,
      waiting: null,
      capacity: 4,
    });
  });

  it("leaves running unknown when the engine reports neither requests nor slots", () => {
    expect(llmConcurrency(base).running).toBeNull();
  });
});

it("excludes unavailable retained rates from medians and peak requests", () => {
  const result = summarizeLlmHour([
    point({ available: false, generationTps: 999, prefillTps: 999, requestsRunning: 99 }),
    point({ generationTps: 40, prefillTps: 300, requestsRunning: 2 }),
  ]);
  expect(result.decodeP50).toBe(40);
  expect(result.prefillP50).toBe(300);
  expect(result.peakRunning).toBe(2);
});
