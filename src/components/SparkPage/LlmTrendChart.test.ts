import { describe, expect, it } from "vitest";
import { buildSegments, DISPLAY_WINDOW_MS, windowSamples } from "./LlmTrendChart";
import type { MetricSample } from "../../hooks/metricsStore";

describe("LlmTrendChart elapsed-time window", () => {
  it.each([1_000, 2_000, 5_000])("positions a %sms cadence by timestamps", (interval) => {
    const endAt = DISPLAY_WINDOW_MS;
    const samples: MetricSample[] = [
      { at: endAt - interval, value: 10 },
      { at: endAt, value: 20 },
    ];
    const [points] = buildSegments(samples, 20, endAt);
    const [firstX, secondX] = points.split(" ").map((point) => Number(point.split(",")[0]));
    expect(secondX).toBe(300);
    expect(firstX).toBeCloseTo(300 - (interval / DISPLAY_WINDOW_MS) * 300, 1);
  });

  it("excludes samples older than 30 minutes", () => {
    const endAt = 2 * DISPLAY_WINDOW_MS;
    expect(windowSamples([
      { at: 0, value: 1 },
      { at: endAt - DISPLAY_WINDOW_MS, value: 2 },
      { at: endAt, value: 3 },
    ], endAt)).toEqual([
      { at: endAt - DISPLAY_WINDOW_MS, value: 2 },
      { at: endAt, value: 3 },
    ]);
  });

  it("splits a disconnect gap rather than drawing through it", () => {
    const samples: MetricSample[] = [
      { at: 0, value: 10 },
      { at: 2_000, value: 11 },
      { at: 60_000, value: 12 },
      { at: 62_000, value: 13 },
    ];
    expect(buildSegments(samples, 13, 62_000)).toHaveLength(2);
  });
});
