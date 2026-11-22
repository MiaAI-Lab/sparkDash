import { useTranslation } from "react-i18next";
import type { MetricsHistoryCacheEndpoints, MetricsHistoryCacheEvent } from "../../api/types";

const seconds = (n: number) => `${(n / 1000).toFixed(1)} s`;
const eventName = (kind: string) => kind.replaceAll("_", " ");

/** Numeric aggregates only; legacy buckets never acquire invented duration or sample coverage. */
export function CacheHistoryDetails({ endpoint, events, stepMs, formatTime, onCursor }: {
  endpoint: MetricsHistoryCacheEndpoints;
  events: readonly MetricsHistoryCacheEvent[];
  stepMs: number;
  formatTime: (t: number) => string;
  onCursor: (t: number) => void;
}) {
  const { t } = useTranslation("hardware");
  const notReported = t("cacheHistory.notReported");
  const count = (n: number | undefined) => n == null ? notReported : n.toLocaleString();
  const points = endpoint.points;
  const promptMeasured = points.some((p) => p.promptTokens != null);
  const prompts = points.reduce((s, p) => s + (p.promptTokens ?? 0), 0);
  const cached = points.reduce((s, p) => s + (p.cachedTokens ?? 0), 0);
  const covered = points.reduce((s, p) => s + (p.coveredMs ?? 0), 0);
  const partial = points.some((p) => p.coveredMs == null || p.coveragePartial);
  const pressure = points.filter((p) => (p.waiting ?? 0) > 0 || Object.entries(p.churn ?? {}).some(([k, v]) =>
    ["evictions", "invalidations", "failures", "failuresKeep", "failuresRestore", "failuresPeerForget", "refusals", "placementBlocks"].includes(k) && (v ?? 0) > 0));
  const selectedEvents = events.filter((e) => e.port === endpoint.port);
  const q = (value: typeof points[number]["ttftP95"]) => !value ? notReported : value.open
    ? t("cacheHistory.quantileOpen", { lower: value.lowerBound })
    : t("cacheHistory.quantile", { value: value.value, upper: value.upperBound });
  const populated = [...points].reverse().find((p) => (p.histogramSamples?.ttft ?? 0) > 0 || p.ttftP95 || p.latencyP95);
  const reuse = !promptMeasured ? notReported : prompts > 0
    ? t("cacheHistory.reuseTokens", { percent: (100 * cached / prompts).toFixed(2), cached: count(cached), prompts: count(prompts) })
    : points.some((p) => p.completions === 0) ? t("cacheHistory.noCompletions") : t("cacheHistory.noPromptTokens");
  const histogram = populated
    ? t("cacheHistory.histogramValues", {
        time: formatTime(populated.t), ttft: q(populated.ttftP95), ttftSamples: count(populated.histogramSamples?.ttft),
        latency: q(populated.latencyP95), latencySamples: count(populated.histogramSamples?.latency),
      })
    : t("cacheHistory.histogramMissing");
  return (
    <details className="sp-stack" data-cache-pressure={endpoint.port}>
      <summary>{t("cacheHistory.details", { port: endpoint.port, buckets: pressure.length })}</summary>
      <p className="sp-hint">
        {t("cacheHistory.reuse", { reuse, first: endpoint.firstAvailableAt != null ? formatTime(endpoint.firstAvailableAt) : notReported })}
      </p>
      <p className="sp-hint">
        {t("cacheHistory.coverage", { duration: seconds(covered), partial: partial ? t("cacheHistory.partialCoverage") : "", step: seconds(stepMs) })}
        {" "}{t("cacheHistory.headroom")}{" "}{t("cacheHistory.quantileHelp")}
      </p>
      <p className="sp-hint">{t("cacheHistory.histogram", { summary: histogram })}</p>
      <ul aria-label={t("cacheHistory.eventBoundaries", { port: endpoint.port })}>
        {selectedEvents.length === 0 ? <li>{t("cacheHistory.noEvents")}</li> : selectedEvents.map((e, i) => (
          <li key={`${e.t}-${e.kind}-${i}`}>
            <button type="button" onClick={() => onCursor(e.t)}>{formatTime(e.t)} · {eventName(e.kind)}</button>
            {e.until != null && t("cacheHistory.through", { time: formatTime(e.until) })}
            {e.detail && Object.entries(e.detail).filter(([, v]) => typeof v === "number").map(([k, v]) => ` · ${eventName(k)} ${v}`).join("")}
          </li>
        ))}
      </ul>
      <p className="sp-hint">{t("cacheHistory.drillHelp")}</p>
      <div style={{ overflowX: "auto", maxWidth: "100%" }} role="region" aria-label={t("cacheHistory.drill", { port: endpoint.port })} tabIndex={0}>
        <table style={{ width: "100%", minWidth: 1000 }}>
          <thead><tr>
            <th>{t("cacheHistory.window")}</th><th>{t("cacheHistory.coverageColumn")}</th>
            <th>{t("cacheHistory.evictionsAndInvalidations")}</th><th>{t("cacheHistory.refusalsFailuresBlocked")}</th>
            <th>{t("cacheHistory.evictionsRate")}</th><th>{t("cacheHistory.latencyColumn")}</th>
            <th>{t("cacheHistory.histogramSamples")}</th>
          </tr></thead>
          <tbody>{pressure.slice(-24).reverse().map((p) => <tr key={p.t}>
            <td><button type="button" onClick={() => onCursor(p.t)}>{formatTime(p.t)}</button></td>
            <td>{t("cacheHistory.observations", {
              coverage: p.coveredMs == null ? t("cacheHistory.unknownLegacy")
                : p.coveragePartial ? t("cacheHistory.partial", { duration: seconds(p.coveredMs) }) : seconds(p.coveredMs),
              samples: p.n,
            })}</td>
            <td>{count(p.churn?.evictions)} / {count(p.churn?.invalidations)}</td>
            <td>{count(p.churn?.refusals)} / {count(p.churn?.failures)} / {count(p.churn?.placementBlocks)}<br />
              {t("cacheHistory.failureBreakdown", { keep: count(p.churn?.failuresKeep), restore: count(p.churn?.failuresRestore), forget: count(p.churn?.failuresPeerForget) })}
            </td>
            <td>{p.coveredMs && !p.coveragePartial && p.churn?.evictions != null ? (p.churn.evictions * 60_000 / p.coveredMs).toFixed(2) : notReported}</td>
            <td>{q(p.ttftP95)} / {q(p.latencyP95)}</td>
            <td>{count(p.histogramSamples?.ttft)} / {count(p.histogramSamples?.latency)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </details>
  );
}
