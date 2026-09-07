import { useMemo } from "react";
import { HISTORY_MAX, useMetricsHistory, useTimedMetricsHistory, avgPositive } from "../../hooks/metricsStore";
import type { TimedSample } from "../../hooks/ringBuffer";

const VIEW_W = 300;
const VIEW_H = 64;
const PAD = 2;
/**
 * Fixed display window: 30 minutes of 2 s samples. The x-axis is anchored to
 * this constant — never the current sample count — so the line grows into the
 * chart left-to-right and then scrolls, instead of re-stretching (rewriting
 * history) on every tick. Averages below still span full HISTORY_MAX retention.
 */
const DISPLAY_WINDOW = 900;
const DISPLAY_WINDOW_MS = 30 * 60 * 1000;

function fmt(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n >= 100 ? n.toFixed(0) : n.toFixed(1);
}

/**
 * Polyline points for one series, normalised to the shared max. x maps onto a
 * FIXED window: the newest sample sits at the right edge once the window is
 * full; while filling, points occupy only the left fraction and the line grows.
 */
function buildSegments(data: readonly TimedSample[], max: number): string[] {
  if (data.length < 2) return [];
  const span = max || 1;
  const end = data[data.length - 1].at;
  const start = end - DISPLAY_WINDOW_MS;
  const segments: string[][] = [[]];
  data.forEach((sample, i) => {
    if (i > 0 && sample.at - data[i - 1].at > 10_000) segments.push([]);
    const x = ((sample.at - start) / DISPLAY_WINDOW_MS) * VIEW_W;
    const y = VIEW_H - PAD - (Math.min(sample.value, max) / span) * (VIEW_H - PAD * 2);
    segments[segments.length - 1].push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  return segments.filter((segment) => segment.length > 1).map((segment) => segment.join(" "));
}

function areaPath(points: string): string {
  const seg = points.split(" ");
  const first = seg[0]?.split(",")[0] ?? "0";
  const last = seg[seg.length - 1]?.split(",")[0] ?? first;
  return `M${first},${VIEW_H} L${points} L${last},${VIEW_H} Z`;
}

/** Human label: chart shows the last window; averages span full retention. */
function fmtSpan(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = seconds / 3600;
  return `${h % 1 === 0 ? h : h.toFixed(1)}h`;
}

function historyLabel(): string {
  return `last 30m · averages since page opened (up to ${fmtSpan(HISTORY_MAX * 2)})`;
}

/** Newest DISPLAY_WINDOW samples — the slice the chart draws. */
function windowed(data: readonly number[]): readonly number[] {
  return data.length > DISPLAY_WINDOW ? data.slice(-DISPLAY_WINDOW) : data;
}

/**
 * tok/s trend chart for one LLM port. The x-axis is a FIXED 30-minute window:
 * the line grows left-to-right while filling, then scrolls — history already
 * drawn never re-stretches, so the chart can't "rewrite" its own past. The
 * averages below span the full retention (VITE_HISTORY_HOURS, default 8 h).
 *
 * TTFT is deliberately NOT drawn here: vLLM reports it only while serving, so
 * the series is sparse and not tick-aligned — overlaying it on this chart would
 * misplace it in time. It is also near-redundant with the prefill spikes it
 * tracks. The busy-sample TTFT average badge is the useful signal and reads the
 * sparse series directly (no x-axis involved).
 */
export function LlmTrendChart({
  sparkId,
  llmPort,
}: {
  sparkId: string;
  llmPort: number;
}) {
  const gen = useMetricsHistory(sparkId, `llm:${llmPort}.tps`);
  const prefill = useMetricsHistory(sparkId, `llm:${llmPort}.prefill`);
  const ttft = useMetricsHistory(sparkId, `llm:${llmPort}.ttft`);
  const genTimed = useTimedMetricsHistory(sparkId, `llm:${llmPort}.tps`);
  const prefillTimed = useTimedMetricsHistory(sparkId, `llm:${llmPort}.prefill`);

  const genAvg = useMemo(() => avgPositive(gen), [gen]);
  const prefillAvg = useMemo(() => avgPositive(prefill), [prefill]);
  const ttftAvg = useMemo(() => avgPositive(ttft), [ttft]);

  // Chart draws only the newest hour; averages above use the full series.
  const genWin = useMemo(() => windowed(gen), [gen]);
  const prefillWin = useMemo(() => windowed(prefill), [prefill]);

  // Normalise each series to its OWN max: prefill (thousands) and generation
  // (tens) differ by ~100x, so a shared scale would flatten gen into the floor.
  // Max is over the drawn window so old spikes can't squash recent detail.
  const genMax = useMemo(() => Math.max(1, ...genWin), [genWin]);
  const prefillMax = useMemo(() => Math.max(1, ...prefillWin), [prefillWin]);
  const genPts = useMemo(() => buildSegments(genTimed.filter((s) => s.at >= (genTimed.at(-1)?.at ?? 0) - DISPLAY_WINDOW_MS), genMax), [genTimed, genMax]);
  const prefillPts = useMemo(() => buildSegments(prefillTimed.filter((s) => s.at >= (prefillTimed.at(-1)?.at ?? 0) - DISPLAY_WINDOW_MS), prefillMax), [prefillTimed, prefillMax]);

  const hasData = genWin.length > 1 || prefillWin.length > 1;

  return (
    <div className="border-t border-border pt-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted">
          tok/s history
        </span>
        <span className="text-[10px] text-muted">{historyLabel()}</span>
      </div>
      {!hasData ? (
        <p className="text-[10px] text-muted">No samples yet.</p>
      ) : (
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          className="block w-full"
          style={{ height: 64 }}
          role="img"
          aria-label="Generation and prefill tokens per second over the last 30 minutes"
        >
          {prefillPts.map((points, index) => (
            <g key={`prefill-${index}`}>
              <path d={areaPath(points)} fill="var(--color-text)" opacity={0.1} />
              <polyline
                points={points}
                fill="none"
                stroke="var(--color-text)"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          ))}
          {genPts.map((points, index) => (
            <g key={`gen-${index}`}>
              <path d={areaPath(points)} fill="var(--color-accent)" opacity={0.12} />
              <polyline
                points={points}
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          ))}
        </svg>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[10px] text-muted">
        <span>
          Gen avg{" "}
          <span className="font-tabular text-xs text-accent">{fmt(genAvg)}</span>
        </span>
        <span>
          Prefill avg{" "}
          <span className="font-tabular text-xs text-text">{fmt(prefillAvg)}</span>
        </span>
        <span>
          TTFT avg{" "}
          <span className="font-tabular text-xs text-muted">
            {ttftAvg != null ? `${ttftAvg.toFixed(3)}s` : "—"}
          </span>
        </span>
        <span className="text-[9px]">avg over busy samples only</span>
      </div>
    </div>
  );
}
