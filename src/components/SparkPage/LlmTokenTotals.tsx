/**
 * LlmTokenTotals — per-model cumulative prompt/completion token table.
 * Local-only component: lives in its own file, rendered by LlmPanel via one
 * anchor line + one import line (see docs/LOCAL-MODS.md).
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchLlmTokenTotals } from "../../api/llmTokenClient";
import { formatTokensCompact } from "../../shared/tokenFormat";
import { formatSince } from "../../shared/formatSince";
import type { LlmTokenRange, LlmTokenSeriesTotals } from "../../api/llmTokenTypes";

const POLL_MS = 60_000;

const RANGE_VALUES: LlmTokenRange[] = ["all", "today", "7d", "14d", "30d"];

export function LlmTokenTotals({ sparkId, llmPort }: { sparkId: string; llmPort: number }) {
  const { t } = useTranslation();
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
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sparkId, llmPort, range]);

  if (!series || series.length === 0) return null;

  const rows = series
    .filter((s) => s.sparkId === sparkId && s.port === llmPort)
    .flatMap((s) => s.models);

  if (rows.length === 0 && range === "all") return null;

  const rangeLabel = (value: LlmTokenRange): string =>
    value === "all"
      ? t("tokens.totals.range.all", "All time")
      : value === "today"
        ? t("tokens.totals.range.today", "Today")
        : value === "7d"
          ? t("tokens.totals.range.7d", "Last 7 days")
          : value === "14d"
            ? t("tokens.totals.range.14d", "Last 14 days")
            : t("tokens.totals.range.30d", "Last month");

  return (
    <div className="sp-section">
      <div className="sp-section__head">
        <span
          className="min-w-0"
          title={t(
            "tokens.ledger.title",
            "Counted by sparkDash since tracking began, filtered by the selected range. It survives engine restarts, so it can be larger than the engine's own Generated counter.",
          )}
        >
          <span className="eyebrow block">{t("tokens.totals.title", "Total tokens by model")}</span>
          <span className="sp-muted block">
            {t("tokens.ledger.hint", "Counted by sparkDash since tracking began")}
          </span>
        </span>
        <div className="flex items-center gap-2">
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as LlmTokenRange)}
            aria-label={t("tokens.totals.rangeAria", "Token totals time range")}
            className="sp-select"
          >
            {RANGE_VALUES.map((value) => (
              <option key={value} value={value}>
                {rangeLabel(value)}
              </option>
            ))}
          </select>
          <span className="sp-tok-cols">
            <span className="inline-block w-14 text-right">{t("tokens.totals.cached", "Cached")}</span>

            <span className="inline-block w-14 text-right">{t("tokens.totals.prefill", "Prefill")}</span>

            <span className="inline-block w-16 text-right">{t("tokens.totals.generated", "Generated")}</span>
          </span>
        </div>
      </div>
      <div className="sp-tok-rows">
        {rows.length === 0 ? (
          <p className="sp-muted">{t("tokens.totals.empty", "No tokens recorded in this period.")}</p>
        ) : (
          rows.map((row) => {
          const seen = formatSince(row.lastSeenAt);
          const rowTitle = t(
            "tokens.totals.rowTitle",
            "{prompt} prompt · {cached} cached · {prefill} prefill · {generated} generated",
            {
              prompt: row.promptTokens.toLocaleString(),
              cached: row.cachedTokens.toLocaleString(),
              prefill: (row.promptTokens - row.cachedTokens).toLocaleString(),
              generated: row.completionTokens.toLocaleString(),
            },
          );
          return (
            <div
              key={row.modelId}
              className="flex items-center justify-between gap-2 text-[11px]"
              title={`${rowTitle}${seen ? t("tokens.totals.seenAgo", " · {seen} ago", { seen }) : ""}`}
            >
              <span
                className="min-w-0 flex-1 truncate text-text"
                title={row.modelId}
              >
                {row.modelId}
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
          );
        })
        )}
      </div>
    </div>
  );
}
