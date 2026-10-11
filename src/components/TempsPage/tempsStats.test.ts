import { describe, expect, it } from "vitest";
import {
  TEMPS_RANGES,
  parseTempsRange,
  tempSeriesOf,
  tempsAxisLabels,
  toPoints,
} from "./tempsStats";

describe("TEMPS_RANGES", () => {
  it("covers at least a day and a week", () => {
    expect(TEMPS_RANGES.map((r) => r.id)).toEqual(["24h", "7d"]);
    expect(TEMPS_RANGES.map((r) => r.ms)).toEqual([24 * 3600_000, 7 * 24 * 3600_000]);
  });
});

describe("parseTempsRange", () => {
  it("accepts known ids and falls back to 24h", () => {
    expect(parseTempsRange("7d")).toBe("7d");
    expect(parseTempsRange("24h")).toBe("24h");
    expect(parseTempsRange(null)).toBe("24h");
    expect(parseTempsRange("31d")).toBe("24h");
  });
});

describe("tempSeriesOf", () => {
  it("keeps the aggregate for a single-GPU host", () => {
    expect(tempSeriesOf({ t: [1], u: [2], c: [61], p: [null] })).toEqual([
      { key: "agg", label: "GPU temperature", c: [61] },
    ]);
  });

  it("returns one series per card on a multi-GPU host, preferring the card name", () => {
    const resp = {
      t: [1, 2],
      u: [3, 4],
      c: [50, 51],
      p: [null, null],
      gpus: [
        { index: 0, name: "Orin", u: [1, 2], c: [60, 61], p: [10, 11] },
        { index: 1, name: null, u: [3, 4], c: [62, 63], p: [12, 13] },
      ],
    };
    expect(tempSeriesOf(resp)).toEqual([
      { key: "gpu0", label: "Orin", c: [60, 61] },
      { key: "gpu1", label: "GPU 1", c: [62, 63] },
    ]);
  });

  it("keeps the aggregate when gpus has a single card (it already is the aggregate)", () => {
    const resp = { t: [1], u: [2], c: [61], p: [null], gpus: [{ index: 0, name: "X", u: [2], c: [61], p: [null] }] };
    expect(tempSeriesOf(resp)).toEqual([{ key: "agg", label: "GPU temperature", c: [61] }]);
  });
});

describe("toPoints", () => {
  it("pairs timestamps with temperatures and drops nulls", () => {
    expect(toPoints([10, 20, 30], [61, null, 63])).toEqual([
      { at: 10, value: 61 },
      { at: 30, value: 63 },
    ]);
  });
});

describe("tempsAxisLabels", () => {
  it("labels the day range in hours and the week range in days", () => {
    expect(tempsAxisLabels(24 * 3600_000)).toEqual(["−24 h", "−12 h"]);
    expect(tempsAxisLabels(7 * 24 * 3600_000)).toEqual(["−7 d", "−3.5 d"]);
  });
});
