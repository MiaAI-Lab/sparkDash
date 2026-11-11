import { describe, expect, it } from "vitest";
import type { DecodeBenchJob, PrefillBenchJob, QualityBenchJob } from "../../../api/types";
import { decodeHistoryRow, prefillHistoryRow, qualityHistoryRow } from "./historyRows";

const level = (concurrency: number, agg: number, mean: number) =>
  ({
    concurrency,
    aggregateDecodeTps: agg,
    meanDecodeTps: mean,
    totalDecodeTokens: 100,
    totalCompletionTokens: 100,
    model: "m",
  }) as unknown as DecodeBenchJob["results"][number];

describe("history rows", () => {
  it("decode picks the peak aggregate level", () => {
    const job = {
      benchId: "d1",
      startedAt: 1,
      status: "completed",
      config: { concurrencies: [1, 4], modelId: "qwen" },
      results: [level(1, 30, 30), level(4, 90, 25)],
    } as unknown as DecodeBenchJob;
    const row = decodeHistoryRow(job);
    expect(row.headline).toBe("90.0 tok/s");
    expect(row.detail).toBe("peak at ×4 · 30.0/stream at ×1 · temp 0 · thinking off");
    expect(row.label).toBe("×1, 4");
    expect(row.model).toBe("qwen");
  });

  it("decode names the start context only when one was set", () => {
    const job = (contextTokens?: number) =>
      ({
        benchId: "d3",
        startedAt: 1,
        status: "completed",
        config: { concurrencies: [4], modelId: "qwen", ...(contextTokens ? { contextTokens } : {}) },
        results: [level(4, 90, 25)],
      }) as unknown as DecodeBenchJob;
    expect(decodeHistoryRow(job(131072)).detail).toBe("peak at ×4 · temp 0 · thinking off · 128k start ctx");
    expect(decodeHistoryRow(job()).detail).not.toContain("start ctx");
  });

  it("decode shows a dash when nothing decoded", () => {
    const job = {
      benchId: "d2",
      startedAt: 1,
      status: "failed",
      config: { concurrencies: [1], modelId: null },
      results: [{ ...level(1, 0, 0), totalDecodeTokens: 0, totalCompletionTokens: 0, model: null }],
    } as unknown as DecodeBenchJob;
    expect(decodeHistoryRow(job).headline).toBe("—");
  });

  it("prefill picks the fastest size", () => {
    const job = {
      benchId: "p1",
      startedAt: 1,
      status: "completed",
      config: { contextSizes: [4096, 16384], modelId: "m" },
      results: [
        { targetTokens: 4096, prefillTps: 1000, model: "m" },
        { targetTokens: 16384, prefillTps: 800, model: "m" },
      ],
    } as unknown as PrefillBenchJob;
    const row = prefillHistoryRow(job);
    expect(row.headline).toBe("1000.0 tok/s");
    expect(row.detail).toBe("best at 4k");
  });

  it("quality reports the overall score and label", () => {
    const job = {
      benchId: "q1",
      startedAt: 1,
      status: "completed",
      config: { label: "fp4 KV", modelId: "m", profile: "default" },
      results: { overallPct: 71.234, overallCi: [66.1, 75.9], categories: { qa: {}, code: {} } },
    } as unknown as QualityBenchJob;
    const row = qualityHistoryRow(job);
    expect(row.headline).toBe("71.2%");
    expect(row.label).toBe("fp4 KV");
    expect(row.detail).toBe("2 categories · 66.1–75.9 · suite v1 · scoring v1");
    // WP1: a partial run (custom categories, or saved before profiles) carries no headline.
    const partial = { ...job, config: { label: "qa only", modelId: "m", categories: ["qa"] } } as unknown as QualityBenchJob;
    expect(qualityHistoryRow(partial).headline).toBe("—");
    expect(qualityHistoryRow(partial).detail).toBe("2 categories · suite v1 · scoring v1");
  });
});
