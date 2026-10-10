import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetStore,
  getMetricHistorySamples,
  ingestSnapshots,
} from "./metricsStore";
import { makeSpark } from "../testing/fixtures";

describe("metricsStore timestamp contract", () => {
  beforeEach(_resetStore);

  it("does not record invented zero rates when a backend has no live counters", () => {
    const spark = makeSpark();
    spark.metrics.llm[0].liveRatesAvailable = false;
    ingestSnapshots([spark], 1_000);
    expect(getMetricHistorySamples(spark.id, `llm:${spark.llmPorts[0]}.tps`)).toEqual([]);
  });

  it("keeps history gaps through unavailable snapshots and backend redetection resets", () => {
    const spark = makeSpark();
    const rateKey = `llm:${spark.llmPorts[0]}`;
    ingestSnapshots([spark], 1_000);
    Object.assign(spark.metrics.llm[0], { available: false, backend: "ollama", liveRatesAvailable: false, generationTps: 0, prefillTps: 0 });
    ingestSnapshots([spark], 2_000);
    delete spark.metrics.llm[0].liveRatesAvailable;
    spark.metrics.llm[0].backend = null;
    ingestSnapshots([spark], 3_000);
    Object.assign(spark.metrics.llm[0], { available: true, backend: "vllm", generationTps: 40, prefillTps: 400 });
    ingestSnapshots([spark], 4_000);
    expect(getMetricHistorySamples(spark.id, `${rateKey}.tps`)).toEqual([{ at: 1_000, value: 20 }, { at: 4_000, value: 40 }]);
    expect(getMetricHistorySamples(spark.id, `${rateKey}.prefill`)).toEqual([{ at: 1_000, value: 200 }, { at: 4_000, value: 400 }]);
    expect(getMetricHistorySamples(spark.id, "gpu.usage")).toHaveLength(4);
  });

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
});
