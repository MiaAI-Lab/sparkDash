import { describe, expect, it } from "vitest";
import { labelIndexes, niceScale } from "./chartScale";

describe("niceScale", () => {
  it("rounds the max up to a tidy axis and returns evenly spaced ticks from 0", () => {
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceScale(87)).toEqual({ max: 100, ticks: [0, 25, 50, 75, 100] });
    expect(niceScale(4.2).max).toBeGreaterThanOrEqual(4.2);
    const s = niceScale(3_300_000);
    expect(s.max).toBeGreaterThanOrEqual(3_300_000);
    expect(s.ticks[0]).toBe(0);
    expect(s.ticks.at(-1)).toBe(s.max);
  });

  it("is safe for non-finite input", () => {
    expect(niceScale(Number.NaN).max).toBe(1);
    expect(niceScale(-5).max).toBe(1);
  });
});

describe("labelIndexes", () => {
  it("always labels the last bar and thins labels to fit", () => {
    const idx = labelIndexes(30, 300, 60);
    expect(idx.at(-1)).toBe(29);
    expect(idx.length).toBeLessThanOrEqual(5);
    expect(labelIndexes(0, 300)).toEqual([]);
    expect(labelIndexes(3, 600)).toEqual([0, 1, 2]);
  });
});
