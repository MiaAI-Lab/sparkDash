import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LlmMetrics, LlmTelemetryPoint } from "../../api/types";
import { fetchLlmTelemetry } from "../../api/llmTelemetryClient";
import { summarizeLlmHour, type LlmHourSummary } from "./llmHour";

const HOUR_MS = 60 * 60_000;
const REFRESH_MS = 30_000;
/** Re-read the whole hour occasionally so a server restart cannot leave a stale tail. */
const FULL_REFRESH_MS = 10 * 60_000;

function formatMedian(rate: number | null | undefined): string {
  return rate == null || !Number.isFinite(rate) ? "—" : rate.toFixed(0);
}

/**
 * Last hour of ten-second telemetry for one LLM port and the model currently
 * served there. The first read is the full window; later reads use the
 * exclusive `since` cursor so a visible card does not refetch 360 points every
 * 30 seconds.
 */
function useLlmHour(
  sparkId: string,
  port: number | null,
  modelId: string | null
): LlmHourSummary | null {
  const [summary, setSummary] = useState<LlmHourSummary | null>(null);
  useEffect(() => {
    setSummary(null);
    if (port == null) return;
    let alive = true;
    let latestRequest = 0;
    let points: LlmTelemetryPoint[] = [];
    let since: number | null = null;
    let lastFullRead = 0;
    const load = () => {
      const request = ++latestRequest;
      const full = since == null || Date.now() - lastFullRead >= FULL_REFRESH_MS;
      return fetchLlmTelemetry(sparkId, port, 1, { modelId, since: full ? null : since })
        .then((result) => {
          if (!alive || request !== latestRequest) return;
          if (full) {
            points = result.points ?? [];
            lastFullRead = Date.now();
          } else {
            const seen = new Set(points.map((point) => point.t));
            const added = (result.points ?? []).filter((point) => !seen.has(point.t));
            if (added.length) points = [...points, ...added].sort((a, b) => a.t - b.t);
          }
          const cutoff = Date.now() - HOUR_MS;
          points = points.filter((point) => point.t >= cutoff);
          since = result.nextSince ?? since;
          setSummary(summarizeLlmHour(points, Date.now()));
        })
        // A failed refresh keeps the last good hour. A failed first read leaves
        // the summary null, which the footer reports as unknown rather than zero.
        .catch(() => undefined);
    };
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [sparkId, port, modelId]);
  return summary;
}

/**
 * `now` comes from the parent's render, so the window advances with each
 * 30 s telemetry refresh rather than on its own clock; that is fine-grained
 * enough for an hour-wide chart.
 */
function DecodeSparkline({
  points,
  p50,
  now,
}: {
  points: LlmTelemetryPoint[];
  p50: number | null;
  now: number;
}) {
  const { t } = useTranslation("overview");
  const W = 180;
  const H = 34;
  const start = now - HOUR_MS;
  const inHour = points.filter((p) => p.t >= start);
  const valid = inHour.filter(
    (p) => p.available && p.generationTps != null && Number.isFinite(p.generationTps)
  );
  const max = Math.max(1, ...valid.map((p) => p.generationTps!));
  const x = (time: number) => ((time - start) / HOUR_MS) * W;
  const y = (value: number) => H - 2 - (value / max) * (H - 4);
  let previous: number | null = null;
  const path = inHour
    .map((p) => {
      if (!p.available || p.generationTps == null || !Number.isFinite(p.generationTps)) {
        previous = null;
        return "";
      }
      const command = previous != null && p.t - previous <= 20_000 ? "L" : "M";
      previous = p.t;
      return `${command}${x(p.t).toFixed(1)},${y(p.generationTps).toFixed(1)}`;
    })
    .join(" ");
  const hasDecode = p50 != null;
  const description =
    valid.length === 0
      ? t("card.sparklineNoData")
      : !hasDecode
        ? t("card.sparklineNoDecode")
        : t("card.sparklineMedian", { value: formatMedian(p50) });
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="block shrink-0"
      role="img"
      aria-label={t("card.sparklineLabel", { summary: description })}
    >
      <line x1={0} x2={W} y1={H - 2} y2={H - 2} stroke="var(--color-border)" />
      {path && hasDecode ? (
        <path d={path} fill="none" stroke="var(--color-accent)" strokeWidth={1.25} />
      ) : null}
      {/* Isolated observations remain visible at slower configured poll cadences. */}
      {valid.map((p) => (
        <circle key={p.t} cx={x(p.t)} cy={y(p.generationTps!)} r={1.5} fill="var(--color-accent)" />
      ))}
      {hasDecode ? (
        <line
          x1={0}
          x2={W}
          y1={y(p50)}
          y2={y(p50)}
          stroke="var(--color-text)"
          strokeOpacity={0.55}
          strokeDasharray="2 3"
        />
      ) : null}
    </svg>
  );
}

/**
 * Under the card's live decode/prefill tiles: the hour behind them. The sparkline
 * and medians come from the restart-safe telemetry store, so they survive a
 * dashboard restart. The series is scoped to the model served now, so a router's
 * earlier models never enter the median.
 */
export function OverviewLlmFooter({
  sparkId,
  port,
  llm,
}: {
  sparkId: string;
  port: number | null;
  llm: LlmMetrics;
}) {
  const { t } = useTranslation("overview");
  const hour = useLlmHour(sparkId, port, llm.modelId ?? null);
  let caption: string;
  if (!hour) caption = t("card.historyPending");
  else if (hour.points.length === 0) caption = t("card.noData");
  else if (hour.closedBuckets === 0) caption = t("card.noCompletedSamples");
  else if (hour.observedBuckets === 0) caption = t("card.noAnswer");
  else if (hour.busyBuckets === 0) caption = t("card.noDecodeObserved");
  else caption = t("card.busySamples", { count: hour.busyBuckets });

  return (
    <div className="ov-llm-footer">
      <div className="mt-3 flex items-end justify-between gap-3">
        <div
          className="min-w-0 font-tabular text-[11px] text-muted"
          title={t("card.historyHelp")}
        >
          <span title={t("card.medianDecodeHelp")}>
            {t("card.medianDecode", { value: formatMedian(hour?.decodeP50) })}
          </span>
          <span> · </span>
          <span title={t("card.medianPrefillHelp")}>
            {t("card.medianPrefill", { value: formatMedian(hour?.prefillP50) })}
          </span>
          <span> · {caption}</span>
        </div>
        <DecodeSparkline points={hour?.points ?? []} p50={hour?.decodeP50 ?? null} now={Date.now()} />
      </div>

    </div>
  );
}
