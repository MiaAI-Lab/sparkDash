import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetStore,
  getMetricHistorySamples,
  ingestSnapshots,
} from "./metricsStore";
import { makeSpark } from "../testing/fixtures";

describe("metricsStore timestamp contract", () => {
  beforeEach(_resetStore);

  it.each([1_000, 2_000, 5_000])("preserves a %sms source cadence", (interval) => {
    const spark = makeSpark();
    ingestSnapshots([spark], 10_000);
    spark.metrics.gpu!.usage = 50;
    ingestSnapshots([spark], 10_000 + interval);
    expect(getMetricHistorySamples(spark.id, "gpu.usage")).toEqual([
      { at: 10_000, value: 42 },
      { at: 10_000 + interval, value: 50 },
    ]);
  });

  it("replaces duplicate frames and retains real disconnect gaps", () => {
    const spark = makeSpark();
    ingestSnapshots([spark], 1_000);
    spark.metrics.gpu!.usage = 55;
    ingestSnapshots([spark], 1_000);
    spark.metrics.gpu!.usage = 60;
    ingestSnapshots([spark], 61_000);
    expect(getMetricHistorySamples(spark.id, "gpu.usage")).toEqual([
      { at: 1_000, value: 55 },
      { at: 61_000, value: 60 },
    ]);
  });

  it("ignores out-of-order frames instead of rewinding chart time", () => {
    const spark = makeSpark();
    ingestSnapshots([spark], 5_000);
    spark.metrics.gpu!.usage = 99;
    ingestSnapshots([spark], 4_000);
    expect(getMetricHistorySamples(spark.id, "gpu.usage")).toEqual([
      { at: 5_000, value: 42 },
    ]);
  });

  it("does not record unavailable GPU fields as fabricated zero readings", () => {
    const spark = makeSpark();
    spark.metrics.gpu!.metricAvailability = {
      temperature: false, usage: false, powerDraw: false, powerLimit: false, vramUsed: false, vramTotal: false,
    };
    spark.metrics.gpu!.usage = 0;
    spark.metrics.gpu!.temperature = 0;
    spark.metrics.gpu!.power = { draw: 0, limit: 0 };
    ingestSnapshots([spark], 10_000);
    expect(getMetricHistorySamples(spark.id, "gpu.usage")).toEqual([]);
    expect(getMetricHistorySamples(spark.id, "gpu.temp")).toEqual([]);
    expect(getMetricHistorySamples(spark.id, "gpu.powerPct")).toEqual([]);
  });

  it("leaves a gap, not a zero, for an LLM poll whose stats could not be read", () => {
    const spark = makeSpark();
    spark.llmPorts = [8888];
    Object.assign(spark.metrics.llm[0], { available: true, generationTps: 40, prefillTps: 900, measurementValid: true });
    ingestSnapshots([spark], 1_000);
    Object.assign(spark.metrics.llm[0], { generationTps: 0, prefillTps: 0, measurementValid: false });
    ingestSnapshots([spark], 3_000);
    Object.assign(spark.metrics.llm[0], { generationTps: 42, prefillTps: 0, measurementValid: true });
    ingestSnapshots([spark], 5_000);
    expect(getMetricHistorySamples(spark.id, "llm:8888.tps")).toEqual([
      { at: 1_000, value: 40 },
      { at: 5_000, value: 42 },
    ]);
    expect(getMetricHistorySamples(spark.id, "llm:8888.prefill")).toEqual([
      { at: 1_000, value: 900 },
      { at: 5_000, value: 0 },
    ]);
  });
});
