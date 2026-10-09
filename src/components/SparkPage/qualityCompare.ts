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
  /** Pairs left out because either run had a request error / timeout. */
  excluded: number;
  onlyA: number;
  onlyB: number;
  p: number;
  withinNoise: boolean;
  /** Plain-words sentence for the score card. */
  text: string;
  /** "better" = this run significantly better, "worse" = significantly worse. */
  tone: "same" | "noise" | "better" | "worse";
}

/**
 * One format everywhere (verdict, table, share text): 3 decimals, "<0.001" at the bottom, and
 * never a rounded-up "0.05" beside "beyond noise" for a p that is just under the threshold.
 */
export function formatP(p: number): string {
  if (!Number.isFinite(p)) return "—";
  if (p >= 0.9995) return "1.000";
  if (p < 0.001) return "<0.001";
  const s = p.toFixed(3);
  if (p < 0.05 && Number(s) >= 0.05) return "<0.05";
  return s;
}

function excludedNote(excluded: number): string {
  return excluded > 0
    ? ` ${excluded} pair${excluded === 1 ? "" : "s"} left out (request error or timeout in one run).`
    : "";
}

/**
 * Pool the per-category McNemar tables into one overall verdict. The items are
 * independent pairs, so summing the discordant counts and running the exact
 * two-sided test on the totals is valid. Pairs with a request error in either run
 * are not in the counts; `excluded` says how many.
 */
export function overallVerdict(rows: QualityCompareRow[]): QualityOverallVerdict | null {
  if (!rows.length) return null;
  const paired = rows.reduce((n, r) => n + r.paired, 0);
  const excluded = rows.reduce((n, r) => n + (r.excluded ?? 0), 0);
  const onlyA = rows.reduce((n, r) => n + r.onlyA, 0);
  const onlyB = rows.reduce((n, r) => n + r.onlyB, 0);
  const p = mcnemarExactP(onlyA, onlyB);
  const withinNoise = p >= 0.05;
  const note = excludedNote(excluded);
  if (onlyA + onlyB === 0) {
    return {
      paired,
      excluded,
      onlyA,
      onlyB,
      p,
      withinNoise,
      tone: "same",
      text: `Both runs scored every shared item the same.${note}`,
    };
  }
  if (withinNoise) {
    return {
      paired,
      excluded,
      onlyA,
      onlyB,
      p,
      withinNoise,
      tone: "noise",
      text: `McNemar p = ${formatP(p)}. The difference is within noise.${note}`,
    };
  }
  const better = onlyA > onlyB;
  return {
    paired,
    excluded,
    onlyA,
    onlyB,
    p,
    withinNoise,
    tone: better ? "better" : "worse",
    text: `McNemar p = ${formatP(p)}. This run is ${better ? "better" : "worse"} than the other, beyond noise.${note}`,
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
    // A request error says nothing about the model; it is not a disagreement.
    if (ia.error || ib.error) continue;
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

/**
 * Overall delta over the categories both runs scored (the means of different category sets are not
 * comparable: a run without the hard category looks better). `categories` is how many were shared.
 */
export function sharedOverallDelta(
  a: QualityBenchJob | null,
  b: QualityBenchJob | null
): { delta: number | null; categories: number; meanA: number | null; meanB: number | null } {
  const ca = a?.results?.categories ?? {};
  const cb = b?.results?.categories ?? {};
  const shared = Object.keys(ca).filter((k) => {
    const x = (ca as Record<string, { pct: number | null } | undefined>)[k]?.pct;
    const y = (cb as Record<string, { pct: number | null } | undefined>)[k]?.pct;
    return x != null && y != null;
  });
  if (!shared.length) return { delta: null, categories: 0, meanA: null, meanB: null };
  const mean = (c: Record<string, { pct: number | null } | undefined>) =>
    shared.reduce((n, k) => n + (c[k]?.pct ?? 0), 0) / shared.length;
  const meanA = mean(ca as Record<string, { pct: number | null } | undefined>);
  const meanB = mean(cb as Record<string, { pct: number | null } | undefined>);
  return { delta: Math.round((meanA - meanB) * 10) / 10, categories: shared.length, meanA, meanB };
}
