import { useEffect, useState } from "react";
import type { LlmMetrics, LlmTelemetryPoint } from "../../api/types";
import { fetchLlmTelemetry } from "../../api/llmTelemetryClient";
import { llmConcurrency, summarizeLlmHour, type LlmHourSummary } from "./llmHour";

const HOUR_MS = 60 * 60_000;
const REFRESH_MS = 30_000;
/** Pips past this collapse into a "+N" count so a busy engine cannot wrap the row. */
const MAX_PIPS = 16;

function formatRate(rate: number | null | undefined): string {
  return rate == null || !Number.isFinite(rate) ? "—" : rate.toFixed(0);
}

/** Last hour of ten-second telemetry for one LLM port, refreshed every 30 s. */
function useLlmHour(sparkId: string, port: number | null): LlmHourSummary | null {
  const [summary, setSummary] = useState<LlmHourSummary | null>(null);
  useEffect(() => {
    setSummary(null);
    if (port == null) return;
    let alive = true;
    let latestRequest = 0;
    const load = () => {
      const request = ++latestRequest;
      return fetchLlmTelemetry(sparkId, port, 1)
        .then((r) => alive && request === latestRequest && setSummary(summarizeLlmHour(r.points ?? [])))
        // A superseded failure must not clear a more recent successful read.
        .catch(() => alive && request === latestRequest && setSummary(null));
    };
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [sparkId, port]);
  return summary;
}

function busyCaption(hour: LlmHourSummary | null): string {
  if (!hour) return "60m —";
  if (hour.observedBuckets === 0) return "no data";
  if (hour.busyBuckets === 0) return "no decode observed";
  return `${hour.busyBuckets} busy samples`;
}

/**
 * `now` comes from the parent's render, so the window advances with each
 * 30 s telemetry refresh rather than on its own clock; that is fine-grained
 * enough for an hour-wide chart.
 */
function DecodeSparkline({ points, p50, now }: { points: LlmTelemetryPoint[]; p50: number | null; now: number }) {
  const W = 180;
  const H = 34;
  const start = now - HOUR_MS;
  const inHour = points.filter((p) => p.t >= start);
  const valid = inHour.filter((p) => p.available && p.generationTps != null && Number.isFinite(p.generationTps));
  const max = Math.max(1, ...valid.map((p) => p.generationTps!));
  const x = (t: number) => ((t - start) / HOUR_MS) * W;
  const y = (v: number) => H - 2 - (v / max) * (H - 4);
  let previous: number | null = null;
  const path = inHour.map((p) => {
    if (!p.available || p.generationTps == null || !Number.isFinite(p.generationTps)) {
      previous = null;
      return "";
    }
    const command = previous != null && p.t - previous <= 20_000 ? "L" : "M";
    previous = p.t;
    return `${command}${x(p.t).toFixed(1)},${y(p.generationTps).toFixed(1)}`;
  }).join(" ");
  const hasDecode = p50 != null;
  const description = valid.length === 0 ? "no decode data" : !hasDecode ? "no decode observed" : `median ${formatRate(p50)}`;
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="block shrink-0"
      role="img"
      aria-label={`Decode tok/s, last 60 minutes: ${description}`}
    >
      <line x1={0} x2={W} y1={H - 2} y2={H - 2} stroke="var(--color-border)" />
      {path && hasDecode ? <path d={path} fill="none" stroke="var(--color-accent)" strokeWidth={1.25} /> : null}
      {/* Isolated observations remain visible at slower configured poll cadences. */}
      {valid.map((p) => <circle key={p.t} cx={x(p.t)} cy={y(p.generationTps!)} r={1.5} fill="var(--color-accent)" />)}
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
function RequestPips({ running, waiting, extent }: { running: number; waiting: number; extent: number }) {
  const total = Math.max(extent, running + waiting, 1);
  const shown = Math.min(total, MAX_PIPS);
  return (
    <span className="flex items-center gap-1" aria-hidden>
      {Array.from({ length: shown }, (_, i) => (
        <span
          key={i}
          className={`h-2.5 w-2.5 rounded-full border ${
            i < running ? "border-accent bg-accent" : i < running + waiting ? "border-warning" : "border-border"
          }`}
        />
      ))}
      {total > shown ? <span className="text-[11px] text-muted">+{total - shown}</span> : null}
    </span>
  );
}

/**
 * Overview card footer: live decode rate against the hour's shape, concurrent
 * requests, and prefill. The hour comes from the restart-safe telemetry store,
 * so medians survive a dashboard restart.
 */
export function OverviewLlmFooter({ sparkId, port, llm }: { sparkId: string; port: number | null; llm: LlmMetrics }) {
  const hour = useLlmHour(sparkId, port);
  const { running, waiting, capacity } = llmConcurrency(llm);
  // An endpoint that answered but whose stats could not be read has unknown
  // rates this poll, not zero ones.
  const unreadable = llm.measurementValid === false;
  const unreadableWhy = unreadable ? llm.measurementError ?? "Stats could not be read" : undefined;
  const decodeNow = unreadable ? null : llm.generationTps;
  const prefillNow = unreadable ? null : llm.prefillTps;
  // Engines that report a rate only when a request finishes still say work is in flight.
  const decoding = !unreadable && llm.decodeActive === true && !((decodeNow ?? 0) > 0);
  const prefilling = !unreadable && llm.prefillActive === true && !((prefillNow ?? 0) > 0);
  const isStrata = llm.backend === "strata";
  const perStream = !unreadable ? llm.perStreamTps ?? null : null;
  const perRequestPrefill = !unreadable ? llm.perStreamPrefillTps ?? null : null;
  const extent = capacity ?? hour?.peakRunning ?? 0;

  return (
    <div className="ov-llm-footer mt-3.5 flex flex-col gap-3 border-t border-border pt-3">
      <div className="flex items-end justify-between gap-3">
        <div
          className="flex min-w-0 flex-col gap-1"
          title={
            isStrata
              ? "Live sliding-window decode rate. When that window is unavailable, the active-slot mean sums each active slot’s generated tokens divided by its elapsed time since first token; it excludes prefill time."
              : undefined
          }
        >
          <div className="eyebrow">Decode</div>
          <div>
            {decoding ? (
              <span className="text-sm font-semibold text-text-strong">decoding</span>
            ) : (
              <>
                <span className="font-tabular text-[28px] font-bold leading-none text-text-strong" title={unreadableWhy}>
                  {formatRate(decodeNow)}
                </span>
                <span className="text-sm font-normal text-muted"> tok/s</span>
              </>
            )}
          </div>
          <div className="font-tabular text-[11px] text-muted" title="Median decode tok/s over busy ten-second samples in the last hour">
            p50 <span className="text-text">{formatRate(hour?.decodeP50)}</span> · {busyCaption(hour)}
          </div>
          {isStrata && llm.generationTpsSource === "slot-mean" ? (
            <div className="text-[11px] text-muted">active-slot mean</div>
          ) : null}
          {perStream != null ? (
            <div
              className="font-tabular text-[11px] text-muted"
              title="Average decode throughput of one running stream (1 / mean seconds per output token). Only engines that publish a per-token latency histogram report it."
            >
              {perStream.toFixed(1)} tok/s per stream
            </div>
          ) : null}
        </div>
        <DecodeSparkline points={hour?.points ?? []} p50={hour?.decodeP50 ?? null} now={Date.now()} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 text-[12px]">
        <RequestsRow running={running} waiting={waiting} capacity={capacity} peak={hour?.peakRunning ?? null} extent={extent} />
        <div
          className="whitespace-nowrap font-tabular text-muted"
          title={
            isStrata
              ? "Engine-reported mean for computed/new prompt tokens. It may be from an earlier prefill and is not an aggregate across slots."
              : "Live prefill tok/s · median over busy ten-second samples in the last hour"
          }
        >
          prefill{" "}
          <span className="font-semibold text-text" title={unreadableWhy}>
            {prefilling ? "prefilling" : formatRate(prefillNow)}
          </span>
          <span> · p50 {formatRate(hour?.prefillP50)}</span>
          {isStrata && (prefillNow ?? 0) > 0 ? <span> · last reported mean</span> : null}
        </div>
      </div>
      {perRequestPrefill != null ? (
        <div
          className="font-tabular text-[11px] text-muted"
          title="Effective prefill rate of one request (prompt tokens ÷ prefill seconds over finished requests). The prompt counter includes prefix-cache tokens, so this is an effective speed, not raw GPU speed; it is held between completions."
        >
          {Math.round(perRequestPrefill).toLocaleString()} tok/s per request — effective (incl. cached tokens)
        </div>
      ) : null}
    </div>
  );
}

/**
 * Concurrent requests: pips plus a plain count. A queue the engine does not
 * report reads "queue unknown", and running requests it does not report read
 * "?" against a known slot count, so neither is shown as 0.
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
  if (running == null && capacity == null) {
    return (
      <div className="flex items-center gap-2 whitespace-nowrap" title="This engine does not report running requests">
        <span className="text-muted">Requests</span>
        <span className="text-muted">—</span>
      </div>
    );
  }
  const parts = [
    running == null ? `?/${capacity} slots` : `${running} running`,
    ...(running == null ? [] : [waiting == null ? "queue unknown" : `${waiting} queued`]),
    ...(running != null && capacity != null ? [`${capacity} slots`] : []),
    ...(capacity == null && peak ? [`peak ${peak}`] : []),
  ];
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
      title={capacity != null && running != null ? `${capacity} requests decode in parallel on this engine` : undefined}
    >
      <span className="text-muted">Requests</span>
      {running != null ? <RequestPips running={running} waiting={waiting ?? 0} extent={extent} /> : null}
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
