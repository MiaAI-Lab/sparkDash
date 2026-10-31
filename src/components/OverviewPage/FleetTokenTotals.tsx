import { AppLink } from "../ui/AppLink";
import { TOKENS_ID, idToPath } from "../../constants";
/**
 * FleetTokenTotals — Overview section with cumulative prompt/completion tokens
 * aggregated across all Sparks, grouped by model, plus a fleet-wide total.
 * Local-only component: own file + one import line and one render line in
 * OverviewPage (see docs/LOCAL-MODS.md).
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchLlmTokenTotals } from "../../api/llmTokenClient";
import { addTokens, formatTokensCompact } from "../../shared/tokenFormat";
import type { LlmTokenRange, LlmTokenSeriesTotals } from "../../api/llmTokenTypes";
import { unreportedOf } from "../SparkPage/tokenTotalsCopy";

const POLL_MS = 60_000;

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
  const { t } = useTranslation("overview");
  const rangeOptions: Array<{ value: LlmTokenRange; label: string }> = [
    { value: "all", label: t("tokens.ranges.all") },
    { value: "today", label: t("tokens.ranges.today") },
    { value: "6h", label: t("tokens.ranges.6h") },
    { value: "1h", label: t("tokens.ranges.1h") },
    { value: "7d", label: t("tokens.ranges.7d") },
    { value: "14d", label: t("tokens.ranges.14d") },
    { value: "30d", label: t("tokens.ranges.30d") },
  ];
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
        <h2 id="fleet-token-totals-title" className="ov-card__title">{t("tokens.title")}</h2>
        <div className="ov-card__tools">
          <span className="tag">
            {t("tokens.endpoints", { count: activeEndpoints })}
          </span>
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as LlmTokenRange)}
            aria-label={t("tokens.timeRange")}
            className="ov-select"
          >
            {rangeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {onOpenDetails ? (
            <AppLink href={idToPath(TOKENS_ID)} className="btn btn--sm btn--ghost" onNavigate={onOpenDetails}>
              {t("tokens.details")}
            </AppLink>
          ) : null}
        </div>
      </div>
      <div>
        <div className="big-num">
          {formatTokensCompact(totalCompletion)}
          <small>{t("tokens.generated")}</small>
        </div>
        <div className="ov-card__sub" title={t("tokens.ledgerTitle")}>
          {t("tokens.ledgerHint")}
        </div>
      </div>
      <div className="seg-bar" role="img" aria-label={t("tokens.shareAria")}>
        <i className="ov-seg ov-seg--gen" style={{ width: pct(totalCompletion) }} />
        <i className="ov-seg ov-seg--cached" style={{ width: pct(totalCached) }} />
        <i className="ov-seg ov-seg--comp" style={{ width: pct(prefillComputed) }} />
        {totalUnreported > 0 ? <i className="ov-seg ov-seg--unrep" style={{ width: pct(totalUnreported) }} /> : null}
      </div>
      <div className="legend">
        <span className="ov-leg--gen">{t("tokens.legendGenerated")}</span>
        <span className="ov-leg--cached">{t("tokens.cached")}</span>
        <span className="ov-leg--comp">{t("tokens.prefill")}</span>
        {totalUnreported > 0 ? <span className="ov-leg--unrep" title={t("tokens.notReportedHelp")}>{t("tokens.notReported")}</span> : null}
      </div>
      <div className="ov-rows">
        <div className="ov-row ov-row--head">
          <span className="ov-row__name eyebrow">{t("tokens.machineModel")}</span>
          <span className="ov-row__num eyebrow">{t("tokens.cached")}</span>
          <span className="ov-row__num eyebrow">{t("tokens.prefill")}</span>
          <span className="ov-row__num eyebrow">{t("tokens.gen")}</span>
        </div>
        {rows.length === 0 ? (
          <p className="ov-card__sub">{t("tokens.noTokens")}</p>
        ) : (
          combinedRows.map((row) => (
            <div
              key={`${row.sparkId}\u0000${row.modelId}`}
              className="ov-row"
              title={t("tokens.rowTitle", {
                prompt: row.promptTokens.toLocaleString(),
                cached: row.cachedTokens.toLocaleString(),
                prefill: (row.promptTokens - row.cachedTokens - row.unreportedPromptTokens).toLocaleString(),
                unreported: row.unreportedPromptTokens > 0 ? t("tokens.rowUnreported", { count: row.unreportedPromptTokens.toLocaleString() }) : "",
                generated: row.completionTokens.toLocaleString(),
              })}
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
          <span className="ov-row__name eyebrow">{t("tokens.total")}</span>
          <span className="ov-row__num mono">{totalCached > 0 ? formatTokensCompact(totalCached) : "\u2014"}</span>
          <span className="ov-row__num mono">{formatTokensCompact(prefillComputed)}</span>
          <span className="ov-row__num ov-row__num--strong mono">{formatTokensCompact(totalCompletion)}</span>
        </div>
      </div>
    </section>
  );
}
