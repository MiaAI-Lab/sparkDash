import type { QualityBenchJob, QualityCategory } from "../../api/types";
import {
  mcnemarExactP,
  qualityRowUnscored,
  type QualityCompareOverall,
  type QualityCompareRow,
} from "../../shared/qualityBench.js";

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

/** The noise floor a run measured (WP0): the largest flip rate seen, overall and per category. */
export interface QualityNoiseBand {
  overall: number | null;
  categories: Partial<Record<QualityCategory, number>>;
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

/** "91.9–96.2" for an interval in percent, "" without one. */
export function formatCi(ci: [number, number] | null | undefined): string {
  if (!ci) return "";
  return `${ci[0].toFixed(1)}–${ci[1].toFixed(1)}`;
}

/** Signed points with its interval: "+1.2 pts (−0.4 to 2.8)". */
export function formatDeltaCi(delta: number | null | undefined, ci: [number, number] | null | undefined): string {
  if (delta == null) return "—";
  const sign = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
  return `${sign(delta)} pts${ci ? ` (${sign(ci[0])} to ${sign(ci[1])})` : ""}`;
}

function excludedNote(excluded: number): string {
  return excluded > 0
    ? ` ${excluded} pair${excluded === 1 ? "" : "s"} left out (request error, cut-off or disputed item in one run).`
    : "";
}

/**
 * The flip rates a run's own noise floor measured, to read a paired delta against: a delta smaller
 * than the share of items that flip between two identical runs is noise, whatever p says.
 */
export function noiseBand(...jobs: Array<QualityBenchJob | null | undefined>): QualityNoiseBand | null {
  let overall: number | null = null;
  const categories: Partial<Record<QualityCategory, number>> = {};
  let any = false;
  for (const job of jobs) {
    const noise = job?.results?.noise;
    if (!noise?.passes?.length) continue;
    any = true;
    for (const v of [noise.repeatFlipPct, noise.batchFlipPct]) {
      if (v != null) overall = Math.max(overall ?? 0, v);
    }
    for (const p of noise.passes) {
      for (const [cat, s] of Object.entries(p.categories) as Array<[QualityCategory, { flipPct: number | null }]>) {
        if (s?.flipPct != null) categories[cat] = Math.max(categories[cat] ?? 0, s.flipPct);
      }
    }
  }
  return any ? { overall, categories } : null;
}

/** True when a paired delta is no larger than the measured flip rate. */
export function insideNoiseBand(delta: number | null | undefined, band: number | null | undefined): boolean {
  return delta != null && band != null && Math.abs(delta) <= band;
}

/**
 * One overall verdict: the per-category McNemar tables pooled (independent pairs, so summing the
 * discordant counts and running the exact two-sided test on the totals is valid), the paired delta
 * with its stratified bootstrap interval, the declared equivalence margin, and the run's own noise
 * floor when it has one. Non-significance is reported as insufficient evidence, never as sameness.
 */
export function overallVerdict(
  rows: QualityCompareRow[],
  overall: QualityCompareOverall | null = null,
  band: number | null = null
): QualityOverallVerdict | null {
  if (!rows.length) return null;
  const paired = rows.reduce((n, r) => n + r.paired, 0);
  const excluded = rows.reduce((n, r) => n + (r.excluded ?? 0), 0);
  const onlyA = rows.reduce((n, r) => n + r.onlyA, 0);
  const onlyB = rows.reduce((n, r) => n + r.onlyB, 0);
  const p = mcnemarExactP(onlyA, onlyB);
  const withinNoise = p >= 0.05;
  const note = excludedNote(excluded);
  const discordant = onlyA + onlyB;
  const deltaText = overall?.deltaPts != null ? ` Paired delta ${formatDeltaCi(overall.deltaPts, overall.deltaCi)}.` : "";
  const equivalence = overall?.equivalent ? ` Equivalent within ±${overall.margin} pts.` : "";
  const inBand = insideNoiseBand(overall?.deltaPts, band);
  const bandText = inBand ? ` The delta is inside this engine's measured noise floor (${band!.toFixed(1)} % of items flip between identical runs).` : "";
  if (discordant === 0) {
    return { paired, excluded, onlyA, onlyB, p, withinNoise, tone: "same", text: `Both runs scored every shared item the same.${note}` };
  }
  if (withinNoise) {
    return {
      paired, excluded, onlyA, onlyB, p, withinNoise, tone: "noise",
      text: `McNemar p = ${formatP(p)} on ${discordant} discordant of ${paired} paired items: insufficient evidence of a difference.${deltaText}${equivalence}${bandText}${note}`,
    };
  }
  const better = onlyA > onlyB;
  return {
    paired, excluded, onlyA, onlyB, p, withinNoise,
    tone: inBand ? "noise" : better ? "better" : "worse",
    text: inBand
      ? `McNemar p = ${formatP(p)} on ${discordant} discordant of ${paired} paired items, but the paired delta ${formatDeltaCi(overall?.deltaPts, overall?.deltaCi)} is inside the measured noise floor (${band!.toFixed(1)} %): read it as noise.${note}`
      : `McNemar p = ${formatP(p)} on ${discordant} discordant of ${paired} paired items: this run is ${better ? "better" : "worse"} than the other.${deltaText}${note}`,
  };
}

/** One category's verdict for the bars and the share text. */
export function categoryVerdictLine(r: QualityCompareRow, band: number | null = null): string {
  const discordant = r.onlyA + r.onlyB;
  if (discordant === 0) return "no discordant items";
  const delta = r.deltaPts != null ? formatDeltaCi(r.deltaPts, r.deltaCi) : "";
  const inBand = insideNoiseBand(r.deltaPts, band);
  if (r.verdict === "different" && !inBand) return `different (Holm p ${formatP(r.pAdj)}, ${discordant} discordant)${delta ? ` · ${delta}` : ""}`;
  const parts = [`insufficient evidence (Holm p ${formatP(r.pAdj)}, ${discordant} discordant)`];
  if (delta) parts.push(delta);
  if (r.equivalent) parts.push(`equivalent within ±${r.margin} pts`);
  if (inBand) parts.push(`inside noise floor ${band!.toFixed(1)} %`);
  return parts.join(" · ");
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
    // An unscored row (request error, cut off before an answer, disputed item) says nothing
    // about the model; it is not a disagreement.
    if (qualityRowUnscored(ia) || qualityRowUnscored(ib)) continue;
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
