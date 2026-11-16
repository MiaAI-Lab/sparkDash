import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LlmMetrics, LlmTelemetryPoint } from "../../api/types";
import { fetchLlmTelemetry } from "../../api/llmTelemetryClient";
import { llmConcurrency, summarizeLlmHour, type LlmHourSummary } from "./llmHour";

const HOUR_MS = 60 * 60_000;
const REFRESH_MS = 30_000;
/** Re-read the whole hour occasionally so a server restart cannot leave a stale tail. */
const FULL_REFRESH_MS = 10 * 60_000;
/** Pips past this collapse into a "+N" count so a busy engine cannot wrap the row. */
const MAX_PIPS = 16;

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

/** Filled = running, outlined warning = queued, faint = room up to the slot cap or the hour's peak. */
function RequestPips({
  running,
  waiting,
  extent,
}: {
  running: number;
  waiting: number;
  extent: number;
}) {
  const total = Math.max(extent, running + waiting, 1);
  const shown = Math.min(total, MAX_PIPS);
  return (
    <span className="flex items-center gap-1" aria-hidden>
      {Array.from({ length: shown }, (_, i) => (
        <span
          key={i}
          className={`h-2.5 w-2.5 rounded-full border ${
            i < running
              ? "border-accent bg-accent"
              : i < running + waiting
                ? "border-warning"
                : "border-border"
          }`}
        />
      ))}
      {total > shown ? <span className="text-[11px] text-muted">+{total - shown}</span> : null}
    </span>
  );
}

/**
 * Overview card footer: live decode/prefill against the hour's shape and
 * concurrent requests. The hour comes from the restart-safe telemetry store,
 * so medians survive a dashboard restart. It is scoped to the currently served
 * model, so a router's earlier models never enter the median.
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
  const { running, waiting, capacity } = llmConcurrency(llm);
  // An endpoint that answered but whose stats could not be read has unknown
  // rates this poll, not zero ones.
  const unreadable = llm.measurementValid === false;
  const unreadableWhy = unreadable ? (llm.measurementError ?? t("card.statsCouldNotBeRead")) : undefined;
  const isStrata = llm.backend === "strata";
  const isTensorFold = llm.backend === "tensorfold";
  const completedPrefill = llm.prefillTpsSource?.startsWith("completed-") === true;
  const extent = capacity ?? hour?.peakRunning ?? 0;

  let caption: string;
  if (!hour) caption = t("card.historyPending");
  else if (hour.points.length === 0) caption = t("card.noData");
  else if (hour.closedBuckets === 0) caption = t("card.noCompletedSamples");
  else if (hour.observedBuckets === 0) caption = t("card.noAnswer");
  else if (hour.busyBuckets === 0) caption = t("card.noDecodeObserved");
  else caption = t("card.busySamples", { count: hour.busyBuckets });

  return (
    <div className="ov-llm-footer">
      <div className="ov-tps">
        <div
          title={
            isStrata
              ? t("card.decodeStrataHelp")
              : undefined
          }
        >
          <div className="eyebrow" title={isTensorFold ? t("card.decodeAggregateHelp") : undefined}>
            {isTensorFold ? t("card.decodeAggregate") : t("card.decode")}
          </div>
          {unreadable ? (
            <div className="big-num ov-tps__num" title={unreadableWhy}>—</div>
          ) : isStrata && llm.decodeActive && llm.generationTps <= 0 ? (
            <div className="big-num ov-tps__num ov-tps__num--live">
              <span className="ov-tps__dots" aria-hidden />
              <small>{t("card.decoding")}</small>
            </div>
          ) : (
            <div className="big-num ov-tps__num">
              {llm.generationTps.toFixed(1)}
              <small>{t("card.tokPerSecond")}</small>
            </div>
          )}
          {isStrata && llm.generationTpsSource === "slot-mean" && (
            <small className="text-muted">{t("card.activeSlotMean")}</small>
          )}
          {!unreadable && llm.perStreamTps != null && (
            <small
              className="text-muted"
              title={isTensorFold ? t("card.completedDecodeHelp") : t("card.perStreamDecodeHelp")}
            >
              {isTensorFold
                ? t("card.completedDecodeRate", { value: llm.perStreamTps.toFixed(1) })
                : t("card.tokPerSecondPerStream", { value: llm.perStreamTps.toFixed(1) })}
            </small>
          )}
        </div>
        <div
          title={
            isStrata
              ? t("card.prefillStrataHelp")
              : undefined
          }
        >
          <div className="eyebrow">{completedPrefill ? t("card.prefillCompleted") : t("card.prefill")}</div>
          {unreadable ? (
            <div className="big-num ov-tps__num" title={unreadableWhy}>—</div>
          ) : llm.prefillActive && llm.prefillTps <= 0 ? (
            <div
              className="big-num ov-tps__num ov-tps__num--live"
              title={isStrata ? t("card.prefillProcessingStrata") : t("card.prefillProcessing")}
            >
              <span className="ov-tps__dots" aria-hidden />
              <small>{t("card.prefilling")}</small>
            </div>
          ) : isTensorFold && llm.prefillTps <= 0 && !completedPrefill ? (
            <div className="big-num ov-tps__num" title={t("card.prefillNotMeasuredHelp")}>—</div>
          ) : (
            <div className="big-num ov-tps__num">
              {Math.round(llm.prefillTps).toLocaleString()}
              <small>{t("card.tokPerSecond")}</small>
            </div>
          )}
          {isTensorFold && !completedPrefill && llm.prefillTps <= 0 && (
            <small className="text-muted">{t("card.notMeasuredLive")}</small>
          )}
          {!unreadable && completedPrefill && (
            <small className="text-muted" title={t("card.completedPrefillHelp")}>
              {t("card.effectiveIncludesCached")}
            </small>
          )}
          {isStrata && llm.prefillTps > 0 && (
            <small className="text-muted">{t("card.lastReportedMean")}</small>
          )}
        </div>
      </div>

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

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 text-[12px]">
        <RequestsRow
          running={running}
          waiting={waiting}
          capacity={capacity}
          peak={hour?.peakRunning ?? null}
          extent={extent}
        />
      </div>
    </div>
  );
}

/**
 * Concurrent requests: pips plus a plain count. A queue the engine does not
 * report reads "queue unknown", and running requests it does not report read
 * "?/N slots", so neither is shown as 0.
 */
function RequestsRow({
  running,
  waiting,
  capacity,
  peak,
  extent,
}: {
  running: number | null;
  waiting: number | null;
  capacity: number | null;
  peak: number | null;
  extent: number;
}) {
  const { t } = useTranslation("overview");
  if (running == null && capacity == null) {
    return (
      <div
        className="flex items-center gap-2 whitespace-nowrap"
        title={t("card.requestsUnknownHelp")}
      >
        <span className="text-muted">{t("card.requests")}</span>
        <span className="text-muted">—</span>
      </div>
    );
  }
  const parts = [
    running == null
      ? t("card.unknownSlotCount", { count: capacity })
      : t("card.runningCount", { count: running }),
    ...(running == null
      ? []
      : [waiting == null ? t("card.queueUnknown") : t("card.queued", { count: waiting })]),
    ...(running != null && capacity != null ? [t("card.slotCount", { count: capacity })] : []),
    ...(capacity == null && peak ? [t("card.peakRunning", { count: peak })] : []),
  ];
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
      title={
        capacity != null && running != null
          ? t("card.parallelRequests", { count: capacity })
          : undefined
      }
    >
      <span className="text-muted">{t("card.requests")}</span>
      {running != null ? (
        <RequestPips running={running} waiting={waiting ?? 0} extent={extent} />
      ) : null}
      {/* Each part stays whole; the list wraps between parts on a narrow card. */}
      <span className="font-tabular text-text">
        {parts.map((part, i) => (
          <span key={part} className="whitespace-nowrap">
            {i > 0 ? " · " : ""}
            {part}
          </span>
        ))}
      </span>
    </div>
  );
}
