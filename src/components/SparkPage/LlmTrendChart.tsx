import { useMemo } from "react";
import { HISTORY_MAX, useMetricsHistory, avgPositive } from "../../hooks/metricsStore";

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

function fmt(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n >= 100 ? n.toFixed(0) : n.toFixed(1);
}

/**
 * Polyline points for one series, normalised to the shared max. x maps onto a
 * FIXED window: the newest sample sits at the right edge once the window is
 * full; while filling, points occupy only the left fraction and the line grows.
 */
function buildPoints(raw: readonly number[], max: number): string {
  // Only the newest DISPLAY_WINDOW samples are drawn; older ones still feed
  // the averages below. Once full, the window scrolls (newest at right edge).
  const data = raw.length > DISPLAY_WINDOW ? raw.slice(-DISPLAY_WINDOW) : raw;
  if (data.length < 2) return "";
  const span = max || 1;
  const pts = data.map((v, i) => {
    const x = (i / (DISPLAY_WINDOW - 1)) * VIEW_W;
    const y = VIEW_H - PAD - (Math.min(v, max) / span) * (VIEW_H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return pts.join(" ");
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
  return `chart ~${fmtSpan(DISPLAY_WINDOW * 2)} · avgs ~${fmtSpan(HISTORY_MAX * 2)} · 2s samples`;
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
  const genPts = useMemo(() => buildPoints(genWin, genMax), [genWin, genMax]);
  const prefillPts = useMemo(() => buildPoints(prefillWin, prefillMax), [prefillWin, prefillMax]);

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
          {prefillPts && (
            <>
              <path d={areaPath(prefillPts)} fill="var(--color-text)" opacity={0.1} />
              <polyline
                points={prefillPts}
                fill="none"
                stroke="var(--color-text)"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </>
          )}
          {genPts && (
            <>
              <path d={areaPath(genPts)} fill="var(--color-accent)" opacity={0.12} />
              <polyline
                points={genPts}
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </>
          )}
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
