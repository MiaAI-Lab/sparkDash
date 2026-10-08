import type { QualityBenchJob, QualityCategory } from "../../api/types";
import { mcnemarExactP, type QualityCompareRow } from "../../shared/qualityBench.js";

/** One item the two runs scored differently. */
export interface QualityDisagreement {
  id: string;
  category: QualityCategory;
  /** Result in this run (A). */
  okA: boolean;
  /** Result in the compared run (B). */
  okB: boolean;
  /** Parsed answer / failing line / excerpt from run A, for context. */
  note: string;
}

export interface QualityOverallVerdict {
  paired: number;
  onlyA: number;
  onlyB: number;
  p: number;
  withinNoise: boolean;
  /** Plain-words sentence for the score card. */
  text: string;
  /** "better" = this run significantly better, "worse" = significantly worse. */
  tone: "same" | "noise" | "better" | "worse";
}

function formatP(p: number): string {
  if (p >= 0.995) return "1.00";
  if (p < 0.001) return "<0.001";
  return p.toFixed(2);
}

/**
 * Pool the per-category McNemar tables into one overall verdict. The items are
 * independent pairs, so summing the discordant counts and running the exact
 * two-sided test on the totals is valid.
 */
export function overallVerdict(rows: QualityCompareRow[]): QualityOverallVerdict | null {
  if (!rows.length) return null;
  const paired = rows.reduce((n, r) => n + r.paired, 0);
  const onlyA = rows.reduce((n, r) => n + r.onlyA, 0);
  const onlyB = rows.reduce((n, r) => n + r.onlyB, 0);
  const p = mcnemarExactP(onlyA, onlyB);
  const withinNoise = p >= 0.05;
  if (onlyA + onlyB === 0) {
    return { paired, onlyA, onlyB, p, withinNoise, tone: "same", text: "Both runs scored every shared item the same." };
  }
  if (withinNoise) {
    return {
      paired,
      onlyA,
      onlyB,
      p,
      withinNoise,
      tone: "noise",
      text: `McNemar p = ${formatP(p)}. The difference is within noise.`,
    };
  }
  const better = onlyA > onlyB;
  return {
    paired,
    onlyA,
    onlyB,
    p,
    withinNoise,
    tone: better ? "better" : "worse",
    text: `McNemar p = ${formatP(p)}. This run is ${better ? "better" : "worse"} than the other, beyond noise.`,
  };
}

/** Items present in both runs whose pass/fail differs, in this run's order. */
export function disagreements(a: QualityBenchJob | null, b: QualityBenchJob | null): QualityDisagreement[] {
  const itemsA = a?.results?.items ?? [];
  const itemsB = b?.results?.items ?? [];
  if (!itemsA.length || !itemsB.length) return [];
  const byId = new Map(itemsB.map((it) => [it.id, it]));
  const out: QualityDisagreement[] = [];
  for (const ia of itemsA) {
    const ib = byId.get(ia.id);
    if (!ib || ib.category !== ia.category || ib.ok === ia.ok) continue;
    out.push({
      id: ia.id,
      category: ia.category,
      okA: ia.ok,
      okB: ib.ok,
      note: ia.error || ia.detail || ia.excerpt || "",
    });
  }
  return out;
}

/** Signed points difference, one decimal, or null when either side is missing. */
export function deltaPts(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null || b == null) return null;
  return Math.round((a - b) * 10) / 10;
}

export function formatDelta(d: number): string {
  return `${d > 0 ? "+" : ""}${d.toFixed(1)} pts`;
}
