import type { MetricsHistoryCacheEndpoints, MetricsHistoryCacheEvent } from "../../api/types";

const count = (n: number | undefined) => n == null ? "not reported" : n.toLocaleString();
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
  const points = endpoint.points;
  const promptMeasured = points.some((p) => p.promptTokens != null);
  const prompts = points.reduce((s, p) => s + (p.promptTokens ?? 0), 0);
  const cached = points.reduce((s, p) => s + (p.cachedTokens ?? 0), 0);
  const covered = points.reduce((s, p) => s + (p.coveredMs ?? 0), 0);
  const partial = points.some((p) => p.coveredMs == null || p.coveragePartial);
  const pressure = points.filter((p) => (p.waiting ?? 0) > 0 || Object.entries(p.churn ?? {}).some(([k, v]) =>
    ["evictions", "invalidations", "failures", "failuresKeep", "failuresRestore", "failuresPeerForget", "refusals", "placementBlocks"].includes(k) && (v ?? 0) > 0));
  const selectedEvents = events.filter((e) => e.port === endpoint.port);
  const q = (value: typeof points[number]["ttftP95"]) => !value ? "not reported" : value.open
    ? `above ${value.lowerBound} s (open upper bound)` : `≈ ${value.value} s (bucket upper bound ${value.upperBound} s)`;
  const populated = [...points].reverse().find((p) => (p.histogramSamples?.ttft ?? 0) > 0 || p.ttftP95 || p.latencyP95);
  return (
    <details className="sp-stack" data-cache-pressure={endpoint.port}>
      <summary>Cache events and pressure · :{endpoint.port} · {pressure.length} pressure buckets</summary>
      <p className="sp-hint">
        Completion-window reuse: {!promptMeasured ? "not reported" : prompts > 0 ? `${(100 * cached / prompts).toFixed(2)}% (${count(cached)} / ${count(prompts)} prompt tokens)` : points.some((p) => p.completions === 0) ? "No completions" : "No completed prompt tokens"}.
        {" "}First available bucket: {endpoint.firstAvailableAt != null ? formatTime(endpoint.firstAvailableAt) : "not reported"}; no pre-instrumentation backfill.
      </p>
      <p className="sp-hint">
        Coverage: {seconds(covered)} of valid observation intervals{partial ? "; partial — legacy duration coverage not recorded" : ""}.
        {" "}Buckets are {seconds(stepMs)} observation windows, not exact incident timestamps. Gaps and restart/reset boundaries are not backfilled.
        {" "}Headroom is per rank only, not a complete fleet minimum. The 16 GiB line is a prior validation threshold, not a reservation or automatic enforcement.
        {" "}Quantiles are approximate, calculated from histogram-count deltas; never an average of p95 values. Coarse ranges do not retain histograms.
      </p>
      <p className="sp-hint">Latest populated histogram window: {populated ? `${formatTime(populated.t)} · TTFT ${q(populated.ttftP95)} (n=${count(populated.histogramSamples?.ttft)}) · request latency ${q(populated.latencyP95)} (n=${count(populated.histogramSamples?.latency)})` : "not reported in this range"}.</p>
      <ul aria-label={`Cache event boundaries :${endpoint.port}`}>
        {selectedEvents.length === 0 ? <li>No recorded event boundaries in this range.</li> : selectedEvents.map((e, i) => (
          <li key={`${e.t}-${e.kind}-${i}`}>
            <button type="button" onClick={() => onCursor(e.t)}>{formatTime(e.t)} · {eventName(e.kind)}</button>
            {e.until != null && ` through ${formatTime(e.until)}`}
            {e.detail && Object.entries(e.detail).filter(([, v]) => typeof v === "number").map(([k, v]) => ` · ${eventName(k)} ${v}`).join("")}
          </li>
        ))}
      </ul>
      <p className="sp-hint">Latest 24 pressure buckets, newest first. Counts are valid counter deltas; rates use covered observation duration. Missing is not zero. Scroll the table horizontally on narrow screens.</p>
      <div style={{ overflowX: "auto", maxWidth: "100%" }} role="region" aria-label={`Pressure drill-down :${endpoint.port}`} tabIndex={0}>
        <table style={{ width: "100%", minWidth: 1000 }}>
          <thead><tr><th>Window</th><th>Coverage</th><th>Evictions / invalidations</th><th>Refusals / failures / blocked</th><th>Evictions/min</th><th>TTFT / latency p95</th><th>Histogram samples</th></tr></thead>
          <tbody>{pressure.slice(-24).reverse().map((p) => <tr key={p.t}>
            <td><button type="button" onClick={() => onCursor(p.t)}>{formatTime(p.t)}</button></td>
            <td>{p.coveredMs == null ? "unknown (legacy)" : `${seconds(p.coveredMs)}${p.coveragePartial ? " partial" : ""}`} · {p.n} observations</td>
            <td>{count(p.churn?.evictions)} / {count(p.churn?.invalidations)}</td>
            <td>{count(p.churn?.refusals)} / {count(p.churn?.failures)} / {count(p.churn?.placementBlocks)}<br />Failures: keep {count(p.churn?.failuresKeep)}, restore {count(p.churn?.failuresRestore)}, peer forget {count(p.churn?.failuresPeerForget)}</td>
            <td>{p.coveredMs && !p.coveragePartial && p.churn?.evictions != null ? (p.churn.evictions * 60_000 / p.coveredMs).toFixed(2) : "not reported"}</td>
            <td>{q(p.ttftP95)} / {q(p.latencyP95)}</td>
            <td>{count(p.histogramSamples?.ttft)} / {count(p.histogramSamples?.latency)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </details>
  );
}
