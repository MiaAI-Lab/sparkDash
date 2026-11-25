import { describe, expect, it } from "vitest";
import type { LlmTelemetryPoint } from "../../api/types";
import { summarizeLlmHour } from "./llmHour";

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

  it("reports an unknown median for an hour with nothing to measure", () => {
    const hour = summarizeLlmHour([point({ generationTps: 0 }), point({ generationTps: null })]);
    expect(hour.decodeP50).toBeNull();
    expect(hour.prefillP50).toBeNull();
    expect(hour.busyBuckets).toBe(0);
    expect(hour.observedBuckets).toBe(2);
  });

});


it("excludes the still-open newest bucket from medians and counts", () => {
  const now = 100_000;
  const result = summarizeLlmHour(
    [
      point({ t: 80_000, generationTps: 40, prefillTps: 300, requestsRunning: 2 }),
      point({ t: 95_000, generationTps: 999, prefillTps: 999, requestsRunning: 99 }),
    ],
    now
  );
  expect(result.points).toHaveLength(2);
  expect(result.decodeP50).toBe(40);
  expect(result.prefillP50).toBe(300);
  expect(result.busyBuckets).toBe(1);
  expect(result.closedBuckets).toBe(1);
  expect(result.observedBuckets).toBe(1);
});

it("counts no closed bucket while the only sample is still open", () => {
  const result = summarizeLlmHour([point({ t: 95_000, generationTps: 40 })], 100_000);
  expect(result.points).toHaveLength(1);
  expect(result.closedBuckets).toBe(0);
  expect(result.observedBuckets).toBe(0);
  expect(result.decodeP50).toBeNull();
});

it("excludes unavailable retained rates from the medians", () => {
  const result = summarizeLlmHour([
    point({ available: false, generationTps: 999, prefillTps: 999, requestsRunning: 99 }),
    point({ generationTps: 40, prefillTps: 300, requestsRunning: 2 }),
  ]);
  expect(result.decodeP50).toBe(40);
  expect(result.prefillP50).toBe(300);
});
