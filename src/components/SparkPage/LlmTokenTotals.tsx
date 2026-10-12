import { t } from "../../i18n";
/**
 * LlmTokenTotals — per-model cumulative prompt/completion token table.
 * Local-only component: lives in its own file, rendered by LlmPanel via one
 * anchor line + one import line (see docs/LOCAL-MODS.md).
 */
import { useEffect, useState } from "react";
import { fetchLlmTokenTotals } from "../../api/llmTokenClient";
import { formatTokensCompact } from "../../shared/tokenFormat";
import { formatSince } from "../../shared/formatSince";
import type { LlmTokenRange, LlmTokenSeriesTotals } from "../../api/llmTokenTypes";
import { LEDGER_HINT, LEDGER_TITLE } from "./tokenTotalsCopy";

const POLL_MS = 60_000;

const RANGE_OPTIONS: Array<{ value: LlmTokenRange; label: string }> = [
  { value: "all", label: "rangeAll" },
  { value: "today", label: "rangeToday" },
  { value: "7d", label: "range7d" },
  { value: "14d", label: "range14d" },
  { value: "30d", label: "range30d" },
];

export function LlmTokenTotals({ sparkId, llmPort }: { sparkId: string; llmPort: number }) {
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
  }, [sparkId, llmPort, range]);

  if (!series || series.length === 0) return null;

  const rows = series
    .filter((s) => s.sparkId === sparkId && s.port === llmPort)
    .flatMap((s) => s.models);

  if (rows.length === 0 && range === "all") return null;

  return (
    <div className="sp-section">
      <div className="sp-section__head">
        <span className="min-w-0" title={t("tokens.ledger_title")}>
          <span className="eyebrow block">{t("llm.total_by_model")}</span>
          <span className="sp-muted block">{t("tokens.ledger_title")}</span>
        </span>
        <div className="flex items-center gap-2">
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as LlmTokenRange)}
            aria-label={t("ui.token_totals_time_range_d8cb")}
            className="sp-select"
          >
            {RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {t(`tokens.${opt.label}`)}
              </option>
            ))}
          </select>
          <span className="sp-tok-cols">
            <span className="inline-block w-14 text-right">{t("tokens.col_cached")}</span>

            <span className="inline-block w-14 text-right">{t("tokens.col_prefill")}</span>

            <span className="inline-block w-16 text-right">{t("tokens.col_generated")}</span>
          </span>
        </div>
      </div>
      <div className="sp-tok-rows">
        {rows.length === 0 ? (
          <p className="sp-muted">{t("ui.no_tokens_recorded_in_this_4c8a")}</p>
        ) : (
          rows.map((row) => {
          const seen = formatSince(row.lastSeenAt);
          return (
            <div
              key={row.modelId}
              className="flex items-center justify-between gap-2 text-[11px]"
              title={`${row.promptTokens.toLocaleString()} prompt · ${row.cachedTokens.toLocaleString()} cached · ${(row.promptTokens - row.cachedTokens).toLocaleString()} prefill · ${row.completionTokens.toLocaleString()} generated${seen ? ` · ${seen} ago` : ""}`}
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
