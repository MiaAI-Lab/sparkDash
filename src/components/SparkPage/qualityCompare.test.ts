import { describe, expect, it } from "vitest";
import type { QualityBenchJob } from "../../api/types";
import { compareQualityRuns } from "../../shared/qualityBench.js";
import { deltaPts, disagreements, formatDelta, overallVerdict } from "./qualityCompare";

function job(oks: boolean[]): QualityBenchJob {
  return {
    results: {
      items: oks.map((ok, i) => ({ id: `qa-${i}`, category: "qa", ok, excerpt: `r${i}`, hash: `h${i}`, detail: null, error: null })),
      categories: {},
    },
  } as unknown as QualityBenchJob;
}

describe("quality compare view logic", () => {
  it("reports no verdict without shared items", () => {
    expect(overallVerdict([])).toBeNull();
  });

  it("calls a 1 vs 1 split within noise", () => {
    const a = job([true, false, true, true]);
    const b = job([true, true, true, false]);
    const v = overallVerdict(compareQualityRuns(a, b));
    expect(v?.tone).toBe("noise");
    expect(v?.onlyA).toBe(1);
    expect(v?.onlyB).toBe(1);
    expect(v?.text).toContain("within noise");
  });

  it("calls a lopsided split significant in the right direction", () => {
    const a = job(Array(12).fill(true));
    const b = job(Array(12).fill(false));
    const v = overallVerdict(compareQualityRuns(a, b));
    expect(v?.tone).toBe("better");
    const w = overallVerdict(compareQualityRuns(b, a));
    expect(w?.tone).toBe("worse");
  });

  it("identical outcomes give the same verdict", () => {
    const v = overallVerdict(compareQualityRuns(job([true, false]), job([true, false])));
    expect(v?.tone).toBe("same");
  });

  it("lists only items the runs disagree on", () => {
    const d = disagreements(job([true, false, true]), job([true, true, false]));
    expect(d.map((x) => [x.id, x.okA, x.okB])).toEqual([
      ["qa-1", false, true],
      ["qa-2", true, false],
    ]);
  });

  it("formats deltas", () => {
    expect(deltaPts(86.2, 84.9)).toBe(1.3);
    expect(deltaPts(null, 1)).toBeNull();
    expect(formatDelta(1.3)).toBe("+1.3 pts");
    expect(formatDelta(-2)).toBe("-2.0 pts");
  });
});
