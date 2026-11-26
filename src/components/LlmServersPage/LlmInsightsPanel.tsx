import { useTranslation } from "react-i18next";
import type { LlmInsight, LlmInsightsData } from "../../api/types";
import { fmtNum, fmtPct, fmtSeconds } from "./LlmServerCharts";

function param(insight: LlmInsight, key: string): number | null {
  const value = insight.params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textParam(insight: LlmInsight, key: string): string | null {
  const value = insight.params[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function fmtTokens(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return Math.round(n).toLocaleString();
}

/** Advisory findings; the server owns the math, the templates live here. */
export function LlmInsightsPanel({ insights }: { insights: LlmInsightsData }) {
  const { t } = useTranslation("spark");
  const rows = insights.insights;
  if (rows.length === 0) {
    return <p className="sp-muted">{t("llmInsights.empty")}</p>;
  }

  return (
    <div className="ls-insights">
      {rows.map((insight) => {
        const title = (() => {
          switch (insight.kind) {
            case "queueKnee":
              return t("llmInsights.queueKnee.title");
            case "queuePrefill":
              return t("llmInsights.queuePrefill.title");
            case "requestBreakdown":
              return t("llmInsights.requestBreakdown.title");
            case "cacheGap":
              return t("llmInsights.cacheGap.title");
            case "cacheTelemetryMissing":
              return t("llmInsights.cacheTelemetryMissing.title");
            case "kvPressure":
              return t("llmInsights.kvPressure.title");
            case "mtpEfficiency":
              return t("llmInsights.mtpEfficiency.title");
            case "longContext":
              return t("llmInsights.longContext.title");
          }
        })();
        const severity =
          insight.severity === "warn"
            ? t("llmInsights.severity.warn")
            : t("llmInsights.severity.info");
        const detail = (() => {
          switch (insight.kind) {
            case "queueKnee": {
              const collapseWaiting = textParam(insight, "collapseWaiting");
              return collapseWaiting
                ? t("llmInsights.queueKnee.detail", {
                    waiting: textParam(insight, "waiting") ?? "—",
                    baseline: fmtNum(param(insight, "baselinePerStreamTps")),
                    tps: fmtNum(param(insight, "perStreamTps")),
                    collapseWaiting,
                    collapseTps: fmtNum(param(insight, "collapsePerStreamTps")),
                    collapseTtft: fmtSeconds(param(insight, "collapseTtftSeconds")),
                    buckets: Math.round(param(insight, "buckets") ?? 0),
                  })
                : t("llmInsights.queueKnee.detailHolds", {
                    waiting: textParam(insight, "waiting") ?? "—",
                    baselineWaiting: textParam(insight, "baselineWaiting") ?? "—",
                    baseline: fmtNum(param(insight, "baselinePerStreamTps")),
                    tps: fmtNum(param(insight, "perStreamTps")),
                    buckets: Math.round(param(insight, "buckets") ?? 0),
                  });
            }
            case "queuePrefill":
              return t("llmInsights.queuePrefill.detail", {
                baselineWaiting: textParam(insight, "baselineWaiting") ?? "—",
                collapseWaiting: textParam(insight, "collapseWaiting") ?? "—",
                baselinePrefill: fmtSeconds(param(insight, "baselinePrefillSeconds")),
                collapsePrefill: fmtSeconds(param(insight, "collapsePrefillSeconds")),
                ratio: fmtNum(param(insight, "ratio"), 2),
              });
            case "requestBreakdown":
              return t("llmInsights.requestBreakdown.detail", {
                requests: Math.round(param(insight, "requests") ?? 0).toLocaleString(),
                queueShare: fmtPct(param(insight, "queueShare")),
                prefillShare: fmtPct(param(insight, "prefillShare")),
                decodeShare: fmtPct(param(insight, "decodeShare")),
                overheadShare: fmtPct(param(insight, "overheadShare")),
                queueSeconds: fmtSeconds(param(insight, "queueSecondsPerRequest")),
                prefillSeconds: fmtSeconds(param(insight, "prefillSecondsPerRequest")),
                decodeSeconds: fmtSeconds(param(insight, "decodeSecondsPerRequest")),
                ttftSeconds: fmtSeconds(param(insight, "ttftSecondsPerRequest")),
                latencySeconds: fmtSeconds(param(insight, "latencySecondsPerRequest")),
              });
            case "cacheGap":
              return t("llmInsights.cacheGap.detail", {
                hitRate: fmtPct(param(insight, "hitRate")),
                target: fmtPct(param(insight, "targetHitRate")),
                prefillSeconds: fmtSeconds(param(insight, "prefillSecondsPerRequest")),
                savedSeconds: fmtSeconds(param(insight, "prefillSavedPerRequest")),
                savedTotal: fmtSeconds(param(insight, "prefillSavedTotal")),
                cached: fmtTokens(param(insight, "cachedTokens")),
                computed: fmtTokens(param(insight, "computedTokens")),
              });
            case "cacheTelemetryMissing":
              return t("llmInsights.cacheTelemetryMissing.detail", {
                reason: textParam(insight, "reason") ?? t("llmInsights.cacheTelemetryMissing.reasonUnknown"),
              });
            case "kvPressure":
              return t("llmInsights.kvPressure.detail", {
                usageMean: fmtPct(param(insight, "usageMean")),
                usageMax: fmtPct(param(insight, "usageMax")),
                deviceMax: fmtNum(param(insight, "deviceMaxGb")),
                preemptions: param(insight, "preemptions") == null ? "—" : Math.round(param(insight, "preemptions") as number).toLocaleString(),
              });
            case "mtpEfficiency":
              return t("llmInsights.mtpEfficiency.detail", {
                acceptance: fmtPct(param(insight, "acceptance")),
                tokensPerRound: fmtNum(param(insight, "tokensPerRound"), 2),
                decodeTps: fmtNum(param(insight, "decodeTps")),
              });
            case "longContext":
              return t("llmInsights.longContext.detail", {
                ratio: fmtNum(param(insight, "promptPerCompletion")),
                promptPerRequest: fmtTokens(param(insight, "promptPerRequest")),
                outputPerRequest: fmtTokens(param(insight, "outputPerRequest")),
                cachedShare: fmtPct(param(insight, "cachedShare")),
              });
            default:
              return "";
          }
        })();

        return (
          <article key={insight.kind} className={`ls-insight ls-insight--${insight.severity}`}>
            <header className="ls-insight__head">
              <h3>{title}</h3>
              <span className={`ls-insight__severity ls-insight__severity--${insight.severity}`}>
                {severity}
              </span>
            </header>
            <p>{detail}</p>
          </article>
        );
      })}
    </div>
  );
}
