import { beforeEach, describe, expect, it } from "vitest";
import { _resetStore, backfillHistory, getMetricHistorySamples, ingestSnapshots } from "./metricsStore";
import { makeSpark } from "../testing/fixtures";

describe("backfillHistory", () => {
  beforeEach(() => _resetStore());

  it("puts older samples in front of what the tab collected, without duplicating overlap", () => {
    ingestSnapshots([makeSpark("s1")], 10_000);
    ingestSnapshots([makeSpark("s1")], 12_000);
    backfillHistory("s1", "gpu.usage", [
      { at: 2_000, value: 5 },
      { at: 6_000, value: 6 },
      { at: 10_000, value: 99 },
      { at: 12_000, value: 99 },
    ]);
    const s = getMetricHistorySamples("s1", "gpu.usage");
    expect(s.map((x) => x.at)).toEqual([2_000, 6_000, 10_000, 12_000]);
    expect(s[0].value).toBe(5);
    expect(s[2].value).not.toBe(99);
  });

  it("works on an empty series and ignores an empty list", () => {
    backfillHistory("s1", "gpu.temp", []);
    expect(getMetricHistorySamples("s1", "gpu.temp")).toHaveLength(0);
    backfillHistory("s1", "gpu.temp", [{ at: 3, value: 1 }, { at: 1, value: 2 }]);
    expect(getMetricHistorySamples("s1", "gpu.temp").map((x) => x.at)).toEqual([1, 3]);
  });
});
