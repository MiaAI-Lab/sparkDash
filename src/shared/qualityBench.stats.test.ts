import { describe, expect, it } from "vitest";
import {
  compareQualityOverall,
  compareQualityRuns,
  holmAdjust,
  longKeysBootstrapCi,
  overallBootstrapCi,
  pairedDeltaBootstrapCi,
  qualityProfile,
  wilsonInterval,
} from "./qualityBench.js";

const row = (id: string, category: string, ok: boolean, extra: Record<string, unknown> = {}) => ({
  id,
  category,
  ok,
  hash: `${id}-${ok ? 1 : 0}`,
  error: null,
  finishReason: "stop",
  ...extra,
});

describe("WP1 statistics", () => {
  it("qualityProfile names the default and full sets, order ignored, anything else is custom", () => {
    expect(qualityProfile(["mmlu", "qa", "gsm8k", "reason", "arith", "track"])).toBe("default");
    expect(qualityProfile(["qa", "reason", "arith", "track", "gsm8k", "mmlu", "follow", "long"])).toBe("full");
    expect(qualityProfile(["qa"])).toBe("custom");
    expect(qualityProfile(["qa", "reason", "arith", "track", "gsm8k", "mmlu", "follow"])).toBe("custom");
    expect(qualityProfile(null)).toBe("custom");
  });

  it("wilsonInterval stays inside 0–100 and tightens with n", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(40, 40)).toEqual([91.2, 100]);
    expect(wilsonInterval(0, 40)).toEqual([0, 8.8]);
    const [lo, hi] = wilsonInterval(285, 300)!;
    expect(lo).toBeGreaterThan(91);
    expect(hi).toBeLessThan(97.5);
    const wide = wilsonInterval(36, 40)!;
    const narrow = wilsonInterval(360, 400)!;
    expect(wide[1] - wide[0]).toBeGreaterThan(narrow[1] - narrow[0]);
  });

  it("overallBootstrapCi is deterministic, brackets the point estimate and ignores unscored rows", () => {
    const rows = [
      ...Array.from({ length: 40 }, (_, i) => row(`a-${i}`, "arith", i < 36)),
      ...Array.from({ length: 200 }, (_, i) => row(`g-${i}`, "gsm8k", i < 190)),
      row("e-1", "gsm8k", false, { error: "timeout" }),
      row("t-1", "gsm8k", false, { finishReason: "length" }),
    ];
    const ci = overallBootstrapCi(rows)!;
    const point = (36 / 40 + 190 / 200) / 2 * 100; // 92.5
    expect(ci[0]).toBeLessThan(point);
    expect(ci[1]).toBeGreaterThan(point);
    expect(ci[1] - ci[0]).toBeLessThan(12);
    expect(overallBootstrapCi(rows)).toEqual(ci);
    expect(overallBootstrapCi([])).toBeNull();
    expect(overallBootstrapCi(rows, ["arith"])![0]).toBeLessThan(90);
  });

  it("longKeysBootstrapCi resamples prompts", () => {
    const rows = [
      row("l-1", "long", true, { longCorrect: 16, longTotal: 16 }),
      row("l-2", "long", false, { longCorrect: 12, longTotal: 16 }),
      row("l-3", "long", false, { longCorrect: 8, longTotal: 16 }),
      row("l-4", "long", true, { longCorrect: 16, longTotal: 16 }),
    ];
    const ci = longKeysBootstrapCi(rows)!;
    expect(ci[0]).toBeGreaterThanOrEqual(50);
    expect(ci[1]).toBeLessThanOrEqual(100);
    expect(ci[0]).toBeLessThan(81.25);
    expect(ci[1]).toBeGreaterThan(81.25);
    expect(longKeysBootstrapCi([row("q", "qa", true)])).toBeNull();
  });

  it("pairedDeltaBootstrapCi: identical runs give [0, 0]; a one-sided difference excludes 0", () => {
    const same = Array.from({ length: 50 }, (_, i) => [i % 3 ? 1 : 0, i % 3 ? 1 : 0] as [number, number]);
    expect(pairedDeltaBootstrapCi({ qa: same })).toEqual([0, 0]);
    const better = Array.from({ length: 100 }, (_, i) => [1, i < 80 ? 1 : 0] as [number, number]);
    const ci = pairedDeltaBootstrapCi({ qa: better })!;
    expect(ci[0]).toBeGreaterThan(10);
    expect(ci[1]).toBeLessThan(30);
    expect(pairedDeltaBootstrapCi({})).toBeNull();
  });

  it("holmAdjust is monotone, capped at 1 and leaves a single p alone", () => {
    expect(holmAdjust([0.03])).toEqual([0.03]);
    const adj = holmAdjust([0.01, 0.04, 0.03, 0.5]);
    expect(adj[0]).toBeCloseTo(0.04);
    expect(adj[2]).toBeCloseTo(0.09);
    expect(adj[1]).toBeCloseTo(0.09);
    expect(adj[3]).toBe(0.5);
    expect(holmAdjust([0.6, 0.7])).toEqual([1, 1]);
  });

  it("compareQualityRuns carries the paired delta, its CI, Holm p and the verdict; the overall pools them", () => {
    type Cat = { passed: number; total: number; pct: number | null; coveragePct?: number | null; budgetedPct?: number | null };
    const mk = (oks: Record<string, boolean[]>, cats: Record<string, Cat>) => ({
      config: { suiteVersion: 1, scoringVersion: 3 },
      results: {
        categories: cats,
        items: Object.entries(oks).flatMap(([c, list]) => list.map((ok, i) => row(`${c}-${i}`, c, ok))),
      },
    });
    const a = mk(
      { qa: Array.from({ length: 100 }, (_, i) => i < 95), mmlu: Array.from({ length: 100 }, (_, i) => i < 90) },
      { qa: { passed: 95, total: 100, pct: 95, coveragePct: 100, budgetedPct: 95 }, mmlu: { passed: 90, total: 100, pct: 90, coveragePct: 100, budgetedPct: 90 } }
    );
    const b = mk(
      { qa: Array.from({ length: 100 }, (_, i) => i < 95), mmlu: Array.from({ length: 100 }, (_, i) => i >= 30) },
      { qa: { passed: 95, total: 100, pct: 95, coveragePct: 100, budgetedPct: 95 }, mmlu: { passed: 70, total: 100, pct: 70, coveragePct: 80, budgetedPct: 60 } }
    );
    const rows = compareQualityRuns(a, b);
    const qa = rows.find((r) => r.category === "qa")!;
    expect(qa.verdict).toBe("same");
    expect(qa.deltaPts).toBe(0);
    expect(qa.deltaCi).toEqual([0, 0]);
    expect(qa.equivalent).toBe(true);
    expect(qa.coverageB).toBe(100);
    const mm = rows.find((r) => r.category === "mmlu")!;
    expect(mm.onlyA).toBe(30);
    expect(mm.onlyB).toBe(10);
    expect(mm.pairedPctA).toBe(90);
    expect(mm.pairedPctB).toBe(70);
    expect(mm.deltaPts).toBe(20);
    expect(mm.deltaCi![0]).toBeGreaterThan(5);
    expect(mm.equivalent).toBe(false);
    expect(mm.pAdj).toBeGreaterThanOrEqual(mm.p);
    expect(mm.verdict).toBe("different");
    expect(mm.budgetedB).toBe(60);
    const overall = compareQualityOverall(a, b)!;
    expect(overall.categories).toBe(2);
    expect(overall.paired).toBe(200);
    expect(overall.onlyA).toBe(30);
    expect(overall.deltaPts).toBe(10);
    expect(overall.deltaCi![0]).toBeGreaterThan(0);
    expect(overall.equivalent).toBe(false);
    expect(compareQualityOverall(a, { config: { suiteVersion: 2 }, results: {} })).toBeNull();
  });
});
