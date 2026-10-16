/**
 * Pure logic for the Cost compare page: hosted-model pricing math over the same
 * token rows the Token totals page uses. No React, no I/O.
 *
 * Cost model: computed prefill × input price, cached prefill × cache-read price
 * (the input price when the provider does not report one), generated × output
 * price. All prices are USD per token.
 */
import type { ModelPrice } from "../../api/costTypes";
import type { Entry } from "../TokensPage/tokenStats";

/** Counters are never negative or non-finite; anything else is treated as zero. */
function nn(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

export interface CostTally {
  /** Computed prefill × input price, plus cached prefill at the cache rate. */
  inputCost: number;
  /** Generated tokens × output price. */
  outputCost: number;
  /** What the cached prefill would have cost at the full input rate, minus the cache rate. */
  cacheSavings: number;
  /** inputCost + outputCost. */
  totalCost: number;
}

export function emptyCost(): CostTally {
  return { inputCost: 0, outputCost: 0, cacheSavings: 0, totalCost: 0 };
}

/** The per-token price actually charged for cached prefill. */
export function cachedRate(price: Pick<ModelPrice, "inputCostPerToken" | "cacheReadCostPerToken">): number {
  return price.cacheReadCostPerToken != null ? price.cacheReadCostPerToken : price.inputCostPerToken;
}

/** Add one entry's cost to `t`. */
export function addCost(
  t: CostTally,
  e: Pick<Entry, "promptTokens" | "completionTokens" | "cachedTokens">,
  price: ModelPrice
): void {
  const prompt = nn(e.promptTokens);
  const cached = Math.min(nn(e.cachedTokens), prompt);
  const computed = prompt - cached;
  const cachedRate_ = cachedRate(price);
  const uncachedValue = cached * price.inputCostPerToken;
  t.inputCost += computed * price.inputCostPerToken + cached * cachedRate_;
  t.outputCost += nn(e.completionTokens) * price.outputCostPerToken;
  if (cachedRate_ < price.inputCostPerToken) t.cacheSavings += uncachedValue - cached * cachedRate_;
  t.totalCost = t.inputCost + t.outputCost;
}

export function costOf(entries: readonly Pick<Entry, "promptTokens" | "completionTokens" | "cachedTokens">[], price: ModelPrice): CostTally {
  const t = emptyCost();
  for (const e of entries) addCost(t, e, price);
  return t;
}

/** Per-bucket { input, output } cost stacks, oldest first — for the page's chart. */
export function costBuckets(
  rows: readonly (Entry & { t: string })[],
  keys: readonly string[],
  price: ModelPrice
): { key: string; input: number; output: number }[] {
  const wanted = new Set(keys);
  const byKey = new Map<string, Entry[]>();
  for (const r of rows) {
    if (!wanted.has(r.t)) continue;
    const list = byKey.get(r.t);
    if (list) list.push(r);
    else byKey.set(r.t, [r]);
  }
  return keys.map((key) => {
    const t = costOf(byKey.get(key) ?? [], price);
    return { key, input: t.inputCost, output: t.outputCost };
  });
}

// ─── Formatting ──────────────────────────────────────────

/** "$1,234.56"; small values keep four decimals ("$0.0123"). */
export function fmtMoney(v: number): string {
  const n = Number.isFinite(v) ? v : 0;
  const digits = n !== 0 && Math.abs(n) < 0.01 ? 4 : 2;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** Human price line for pickers: "$3.00 / 1M in · $15.00 / 1M out". */
export function priceLabel(p: Pick<ModelPrice, "inputCostPerToken" | "outputCostPerToken">): string {
  const perM = (v: number) => `$${(v * 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `${perM(p.inputCostPerToken)} / 1M in · ${perM(p.outputCostPerToken)} / 1M out`;
}

// ─── Model picker ────────────────────────────────────────

/** Substring matches on id then provider, case-insensitive, prefix matches first, capped. */
export function filterModels(all: readonly ModelPrice[], query: string, cap = 40): ModelPrice[] {
  const q = query.trim().toLowerCase();
  const scored: { p: ModelPrice; s: number }[] = [];
  for (const p of all) {
    const id = p.id.toLowerCase();
    let s = -1;
    if (!q || id.startsWith(q)) s = 0;
    else if (id.includes(q)) s = 1;
    else if (p.provider && p.provider.toLowerCase().includes(q)) s = 2;
    if (s >= 0) scored.push({ p, s });
  }
  return scored
    .sort((a, b) => a.s - b.s || a.p.id.localeCompare(b.p.id))
    .slice(0, cap)
    .map((x) => x.p);
}

/** Blended USD per 1M tokens across the window; null with no tokens. */
export function blendedPerMillion(totalCost: number, totalTokens: number): number | null {
  return totalTokens > 0 ? (totalCost / totalTokens) * 1_000_000 : null;
}

