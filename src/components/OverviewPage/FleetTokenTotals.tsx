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

const POLL_MS = 60_000;

const RANGE_OPTIONS: Array<{ value: LlmTokenRange; label: string }> = [
  { value: "all", label: "All time" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "14d", label: "Last 14 days" },
  { value: "30d", label: "Last month" },
];

/** Aggregate per-series model rows into one fleet-wide per-model table. */
export function aggregateModelTotals(
  series: LlmTokenSeriesTotals[]
): {
  rows: Array<{ modelId: string; promptTokens: number; cachedTokens: number; completionTokens: number; sparkCount: number }>;
  totalPrompt: number;
  totalCached: number;
  totalCompletion: number;
} {
  const byModel = new Map<
    string,
    { promptTokens: number; cachedTokens: number; completionTokens: number; sparks: Set<string> }
  >();
  let totalPrompt = 0;
  let totalCached = 0;
  let totalCompletion = 0;
  for (const s of Array.isArray(series) ? series : []) {
    for (const row of Array.isArray(s.models) ? s.models : []) {
      const entry =
        byModel.get(row.modelId) ??
        { promptTokens: 0, cachedTokens: 0, completionTokens: 0, sparks: new Set<string>() };
      entry.promptTokens = addTokens(entry.promptTokens, row.promptTokens || 0);
      entry.cachedTokens = addTokens(entry.cachedTokens, row.cachedTokens || 0);
      entry.completionTokens = addTokens(entry.completionTokens, row.completionTokens || 0);
      entry.sparks.add(s.sparkId);
      byModel.set(row.modelId, entry);
      totalPrompt = addTokens(totalPrompt, row.promptTokens || 0);
      totalCached = addTokens(totalCached, row.cachedTokens || 0);
      totalCompletion = addTokens(totalCompletion, row.completionTokens || 0);
    }
  }
  const rows = [...byModel.entries()]
    .map(([modelId, entry]) => ({
      modelId,
      promptTokens: entry.promptTokens,
      cachedTokens: Math.min(entry.cachedTokens, entry.promptTokens),
      completionTokens: entry.completionTokens,
      sparkCount: entry.sparks.size,
    }))
    .sort(
      (a, b) =>
        b.completionTokens + b.promptTokens - (a.completionTokens + a.promptTokens)
    );
  return { rows, totalPrompt, totalCached: Math.min(totalCached, totalPrompt), totalCompletion };
}

export function FleetTokenTotals() {
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

  const { rows, totalPrompt, totalCached, totalCompletion } = aggregateModelTotals(series);
  // Count only endpoints with token data in the selected period, not all configured ones.
  const activeEndpoints = series.filter((s) => s.models.length > 0).length;
  if (rows.length === 0 && range === "all") return null;

  return (
    <section className="panel p-4" aria-labelledby="fleet-token-totals-title">
      <div className="flex items-center justify-between gap-2">
        <h2 id="fleet-token-totals-title" className="text-sm font-semibold text-text-strong">
          LLM Token Totals
        </h2>
        <div className="flex items-center gap-2">
          <span className="shrink-0 whitespace-nowrap text-[10px] text-muted">
            {activeEndpoints} endpoint{activeEndpoints === 1 ? "" : "s"}
          </span>
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as LlmTokenRange)}
            aria-label="Token totals time range"
            className="rounded border border-border bg-surface-elevated text-text"
            style={{ height: "20px", padding: "0 4px", fontSize: "9px", width: "auto" }}
          >
            {RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted">
          Cumulative tokens by model, whole fleet
        </span>
        <span className="shrink-0 whitespace-nowrap text-[10px] text-muted">
          <span className="inline-block w-14 text-right">Cached</span>

          <span className="inline-block w-14 text-right">Prefill</span>

          <span className="inline-block w-16 text-right">Generated</span>
        </span>
      </div>
      <div className="mt-3 space-y-1">
        {rows.length === 0 ? (
          <p className="text-[11px] text-muted">No tokens recorded in this period.</p>
        ) : (
          rows.map((row) => (
          <div
            key={row.modelId}
            className="flex items-center justify-between gap-2 text-[11px]"
            title={`${row.promptTokens.toLocaleString()} prompt · ${row.cachedTokens.toLocaleString()} cached · ${(row.promptTokens - row.cachedTokens).toLocaleString()} prefill · ${row.completionTokens.toLocaleString()} generated · ${row.sparkCount} Spark${row.sparkCount === 1 ? "" : "s"}`}
          >
            <span className="min-w-0 flex-1 truncate text-text" title={row.modelId}>
              {row.modelId}
              {row.sparkCount > 1 && (
                <span className="ml-1.5 text-[9px] text-muted">×{row.sparkCount}</span>
              )}
            </span>
            <span className="shrink-0 font-tabular text-muted">
              <span className="inline-block w-14 text-right">
                {row.cachedTokens > 0 ? formatTokensCompact(row.cachedTokens) : "—"}
              </span>

              <span className="inline-block w-14 text-right">
                {formatTokensCompact(row.promptTokens - row.cachedTokens)}
              </span>

              <span className="inline-block w-16 text-right text-text">
                {formatTokensCompact(row.completionTokens)}
              </span>
            </span>
          </div>
        ))
        )}
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-2 text-[11px]">
        <span className="uppercase tracking-wide text-muted">Total</span>
        <span className="font-tabular">
          <span className="inline-block w-14 text-right text-muted">
            {totalCached > 0 ? formatTokensCompact(totalCached) : "—"}
          </span>

          <span className="inline-block w-14 text-right text-muted">
            {formatTokensCompact(totalPrompt - totalCached)}
          </span>

          <span className="inline-block w-16 text-right text-sm font-semibold text-text-strong">
            {formatTokensCompact(totalCompletion)}
          </span>
        </span>
      </div>
    </section>
  );
}
