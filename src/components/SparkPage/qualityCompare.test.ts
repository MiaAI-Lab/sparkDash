import { describe, expect, it } from "vitest";
import type { QualityBenchJob } from "../../api/types";
import { checkQualityComparable, compareQualityRuns } from "../../shared/qualityBench.js";
import { deltaPts, disagreements, formatDelta, formatP, overallVerdict, sharedOverallDelta } from "./qualityCompare";

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

  it("leaves request errors out of the table, the disagreements and the verdict", () => {
    const a = job([true, true, true, true]);
    const b = job([true, false, false, false]);
    b.results!.items![1].error = "Timed out";
    a.results!.items![2].error = "HTTP 500";
    const rows = compareQualityRuns(a, b);
    expect(rows[0].paired).toBe(2);
    expect(rows[0].excluded).toBe(2);
    expect(rows[0].onlyA).toBe(1); // only qa-3
    expect(disagreements(a, b).map((x) => x.id)).toEqual(["qa-3"]);
    const v = overallVerdict(rows);
    expect(v?.excluded).toBe(2);
    expect(v?.text).toContain("2 pairs left out");
  });

  it("refuses to compare runs from different suite or scoring versions", () => {
    const a = { ...job([true]), config: { suiteVersion: 1, scoringVersion: 2 } } as unknown as QualityBenchJob;
    const b = { ...job([true]), config: { suiteVersion: 1, scoringVersion: 1 } } as unknown as QualityBenchJob;
    const c = { ...job([true]), config: { suiteVersion: 2, scoringVersion: 2 } } as unknown as QualityBenchJob;
    expect(compareQualityRuns(a, b)).toEqual([]);
    expect(checkQualityComparable(a, b).reason).toMatch(/scored by different rules/);
    expect(checkQualityComparable(a, c).reason).toMatch(/different item sets/);
    // runs saved before the versions existed count as v1/v1
    expect(checkQualityComparable(job([true]), b).ok).toBe(true);
    expect(compareQualityRuns(a, a)).toHaveLength(1);
  });

  it("formats p-values consistently and never rounds a significant p up to 0.05", () => {
    expect(formatP(0.0496)).toBe("<0.05");
    expect(formatP(0.049)).toBe("0.049");
    expect(formatP(0.05)).toBe("0.050");
    expect(formatP(0.0004)).toBe("<0.001");
    expect(formatP(1)).toBe("1.000");
  });

  it("computes the overall delta over shared categories only", () => {
    const mk = (cats: Record<string, number>) =>
      ({
        results: { categories: Object.fromEntries(Object.entries(cats).map(([k, pct]) => [k, { pct }])) },
      }) as unknown as QualityBenchJob;
    const r = sharedOverallDelta(mk({ qa: 90, mmlu: 50 }), mk({ qa: 80 }));
    expect(r.categories).toBe(1);
    expect(r.delta).toBe(10);
    expect(sharedOverallDelta(mk({ qa: 1 }), mk({ mmlu: 1 })).delta).toBeNull();
  });
});
