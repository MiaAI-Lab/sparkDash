import { AppLink } from "../ui/AppLink";
import { TOKENS_ID, idToPath } from "../../constants";
/**
 * FleetTokenTotals — Overview section with cumulative prompt/completion tokens
 * aggregated across all Sparks, grouped by model, plus a fleet-wide total.
 * Local-only component: own file + one import line and one render line in
 * OverviewPage (see docs/LOCAL-MODS.md).
 */
import { useEffect, useState } from "react";
import { fetchLlmTokenTotals } from "../../api/llmTokenClient";
import { addTokens, formatTokensCompact } from "../../shared/tokenFormat";
import type { LlmTokenRange, LlmTokenSeriesTotals } from "../../api/llmTokenTypes";
import { LEDGER_HINT, LEDGER_TITLE, tokenRowTitle, unreportedOf } from "../SparkPage/tokenTotalsCopy";

const POLL_MS = 60_000;

const RANGE_OPTIONS: Array<{ value: LlmTokenRange; label: string }> = [
  { value: "all", label: "All time" },
  { value: "today", label: "Last 24 hours" },
  { value: "6h", label: "Last 6 hours" },
  { value: "1h", label: "Last 1 hour" },
  { value: "7d", label: "Last 7 days" },
  { value: "14d", label: "Last 14 days" },
  { value: "30d", label: "Last month" },
];

/** Aggregate per-series model rows into one fleet-wide per-model table. */
export function aggregateModelTotals(
  series: LlmTokenSeriesTotals[]
): {
  rows: Array<{ modelId: string; promptTokens: number; cachedTokens: number; unreportedPromptTokens: number; completionTokens: number; sparkCount: number }>;
  totalPrompt: number;
  totalCached: number;
  totalUnreported: number;
  totalCompletion: number;
} {
  const byModel = new Map<
    string,
    { promptTokens: number; cachedTokens: number; unreportedPromptTokens: number; completionTokens: number; sparks: Set<string> }
  >();
  let totalPrompt = 0;
  let totalCached = 0;
  let totalUnreported = 0;
  let totalCompletion = 0;
  for (const s of Array.isArray(series) ? series : []) {
    for (const row of Array.isArray(s.models) ? s.models : []) {
      const entry =
        byModel.get(row.modelId) ??
        { promptTokens: 0, cachedTokens: 0, unreportedPromptTokens: 0, completionTokens: 0, sparks: new Set<string>() };
      entry.promptTokens = addTokens(entry.promptTokens, row.promptTokens || 0);
      entry.cachedTokens = addTokens(entry.cachedTokens, row.cachedTokens || 0);
      entry.unreportedPromptTokens = addTokens(entry.unreportedPromptTokens, unreportedOf(row));
      entry.completionTokens = addTokens(entry.completionTokens, row.completionTokens || 0);
      entry.sparks.add(s.sparkId);
      byModel.set(row.modelId, entry);
      totalPrompt = addTokens(totalPrompt, row.promptTokens || 0);
      totalCached = addTokens(totalCached, row.cachedTokens || 0);
      totalUnreported = addTokens(totalUnreported, unreportedOf(row));
      totalCompletion = addTokens(totalCompletion, row.completionTokens || 0);
    }
  }
  const rows = [...byModel.entries()]
    .map(([modelId, entry]) => ({
      modelId,
      promptTokens: entry.promptTokens,
      cachedTokens: Math.min(entry.cachedTokens, entry.promptTokens),
      unreportedPromptTokens: entry.unreportedPromptTokens,
      completionTokens: entry.completionTokens,
      sparkCount: entry.sparks.size,
    }))
    .sort(
      (a, b) =>
        b.completionTokens + b.promptTokens - (a.completionTokens + a.promptTokens)
    );
  return { rows, totalPrompt, totalCached: Math.min(totalCached, totalPrompt), totalUnreported, totalCompletion };
}

export function FleetTokenTotals({ onOpenDetails }: { onOpenDetails?: () => void }) {
  const [series, setSeries] = useState<LlmTokenSeriesTotals[] | null>(null);
  const [range, setRange] = useState<LlmTokenRange>("all");

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchLlmTokenTotals(range)
        .then((res) => {
          if (!cancelled) setSeries(res.series || []);
        })
        .catch(() => {
          if (!cancelled) setSeries([]);
        });
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [range]);

  if (!series || series.length === 0) return null;

  const { rows, totalPrompt, totalCached, totalUnreported, totalCompletion } = aggregateModelTotals(series);
  // One row per machine-model combination (merged across ports on the same
  // machine serving the same model). Workers serve no LLM endpoint, so they
  // produce no series and appear nowhere.
  const combinedRows = (() => {
    const byKey = new Map<
      string,
      { sparkId: string; modelId: string; promptTokens: number; cachedTokens: number; unreportedPromptTokens: number; completionTokens: number }
    >();
    for (const s of Array.isArray(series) ? series : []) {
      for (const m of Array.isArray(s.models) ? s.models : []) {
        const key = `${s.sparkId}\u0000${m.modelId}`;
        const entry =
          byKey.get(key) ??
          { sparkId: s.sparkId, modelId: m.modelId, promptTokens: 0, cachedTokens: 0, unreportedPromptTokens: 0, completionTokens: 0 };
        entry.promptTokens = addTokens(entry.promptTokens, m.promptTokens || 0);
        entry.unreportedPromptTokens = addTokens(entry.unreportedPromptTokens, unreportedOf(m));
        entry.cachedTokens = addTokens(entry.cachedTokens, m.cachedTokens || 0);
        entry.completionTokens = addTokens(entry.completionTokens, m.completionTokens || 0);
        byKey.set(key, entry);
      }
    }
    return [...byKey.values()]
      .map((e) => ({ ...e, cachedTokens: Math.min(e.cachedTokens, e.promptTokens) }))
      .sort(
        (a, b) =>
          a.sparkId.localeCompare(b.sparkId) || a.modelId.localeCompare(b.modelId)
      );
  })();
  // Count only endpoints with token data in the selected period, not all configured ones.
  const activeEndpoints = series.filter((s) => s.models.length > 0).length;
  if (rows.length === 0 && range === "all") return null;

  const prefillComputed = Math.max(0, totalPrompt - totalCached - totalUnreported);
  const grand = Math.max(1, totalCompletion + totalCached + prefillComputed + totalUnreported);
  const pct = (n: number) => `${((n / grand) * 100).toFixed(1)}%`;

  return (
    <section className="panel ov-card" aria-labelledby="fleet-token-totals-title">
      <div className="ov-card__head">
        <h2 id="fleet-token-totals-title" className="ov-card__title">LLM token totals</h2>
        <div className="ov-card__tools">
          <span className="tag">
            {activeEndpoints} endpoint{activeEndpoints === 1 ? "" : "s"}
          </span>
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as LlmTokenRange)}
            aria-label="Token totals time range"
            className="ov-select"
          >
            {RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {onOpenDetails ? (
            <AppLink href={idToPath(TOKENS_ID)} className="btn btn--sm btn--ghost" onNavigate={onOpenDetails}>
              Details
            </AppLink>
          ) : null}
        </div>
      </div>
      <div>
        <div className="big-num">
          {formatTokensCompact(totalCompletion)}
          <small>generated</small>
        </div>
        <div className="ov-card__sub" title={LEDGER_TITLE}>
          {LEDGER_HINT}, whole fleet
        </div>
      </div>
      <div className="seg-bar" role="img" aria-label="Generated, cached prefill and computed prefill token share">
        <i className="ov-seg ov-seg--gen" style={{ width: pct(totalCompletion) }} />
        <i className="ov-seg ov-seg--cached" style={{ width: pct(totalCached) }} />
        <i className="ov-seg ov-seg--comp" style={{ width: pct(prefillComputed) }} />
        {totalUnreported > 0 ? <i className="ov-seg ov-seg--unrep" style={{ width: pct(totalUnreported) }} /> : null}
      </div>
      <div className="legend">
        <span className="ov-leg--gen">Generated</span>
        <span className="ov-leg--cached">Cached</span>
        <span className="ov-leg--comp">Prefill</span>
        {totalUnreported > 0 ? <span className="ov-leg--unrep" title="Prompt read while the engine published no prefix-cache counter">Not reported</span> : null}
      </div>
      <div className="ov-rows">
        <div className="ov-row ov-row--head">
          <span className="ov-row__name eyebrow">Machine · Model</span>
          <span className="ov-row__num eyebrow">Cached</span>
          <span className="ov-row__num eyebrow">Prefill</span>
          <span className="ov-row__num eyebrow">Gen</span>
        </div>
        {rows.length === 0 ? (
          <p className="ov-card__sub">No tokens recorded in this period.</p>
        ) : (
          combinedRows.map((row) => (
            <div
              key={`${row.sparkId}\u0000${row.modelId}`}
              className="ov-row"
              title={tokenRowTitle(row)}
            >
              <span className="ov-row__name" title={row.modelId}>
                {row.sparkId}
                <span className="text-muted">{" \u00b7 "}{row.modelId}</span>
              </span>
              <span className="ov-row__num mono">{row.cachedTokens > 0 ? formatTokensCompact(row.cachedTokens) : "\u2014"}</span>
              <span className="ov-row__num mono">{formatTokensCompact(row.promptTokens - row.cachedTokens - row.unreportedPromptTokens)}</span>
              <span className="ov-row__num ov-row__num--strong mono">{formatTokensCompact(row.completionTokens)}</span>
            </div>
          ))
        )}
        <div className="ov-row ov-row--total">
          <span className="ov-row__name eyebrow">Total</span>
          <span className="ov-row__num mono">{totalCached > 0 ? formatTokensCompact(totalCached) : "\u2014"}</span>
          <span className="ov-row__num mono">{formatTokensCompact(prefillComputed)}</span>
          <span className="ov-row__num ov-row__num--strong mono">{formatTokensCompact(totalCompletion)}</span>
        </div>
      </div>
    </section>
  );
}
