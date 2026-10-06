import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { HistoryStat } from "../../api/types";

/**
 * One small-multiple line chart for the History section. Hand-rolled SVG like
 * the rest of the dashboard's charts: the plot stretches to its box
 * (preserveAspectRatio="none" + non-scaling strokes) and every label is HTML,
 * so text stays crisp at any width.
 *
 * The crosshair is shared (Grafana's "shared crosshair"): the section owns one
 * timestamp, every chart draws its vertical line there, and the chart under
 * the pointer or keyboard focus also shows a tooltip with the time and values.
 */

const VIEW_W = 300;
const VIEW_H = 90;
const PAD_Y = 3;
/** Consecutive buckets further apart than this many steps are a gap. */
const GAP_STEPS = 1.5;

export interface HistoryChartSeries {
  key: string;
  label: string;
  /** A theme token, e.g. `var(--color-accent)`. */
  color: string;
  /** Aligned with the shared timeline; null = no samples in that bucket. */
  values: ReadonlyArray<HistoryStat | null>;
  /** Faint band from the avg line to the bucket max — or min, for headroom. */
  band?: "max" | "min";
}

export interface HistoryThreshold {
  value: number;
  label: string;
  color: string;
}

export interface HistoryChartProps {
  id: string;
  title: string;
  /** Bucket start times shared by every chart in the section, ascending. */
  timeline: readonly number[];
  stepMs: number;
  from: number;
  to: number;
  series: readonly HistoryChartSeries[];
  format: (v: number) => string;
  /** Fixed y bounds (e.g. 0–100 for a percentage); otherwise from the data. */
  yMin?: number;
  yMax?: number;
  /** Round an auto y range to this unit (1024 for MB → whole GB, 5 for degrees). */
  yUnit?: number;
  thresholds?: readonly HistoryThreshold[];
  /** The shared crosshair timestamp, or null. */
  cursorT: number | null;
  onCursor: (t: number | null) => void;
  /** Tooltip time label. */
  formatTime: (t: number) => string;
  /** x-axis start / end labels. */
  formatAxisTime: (t: number) => string;
}

/**
 * Index runs to draw as one line each: consecutive buckets that both have a
 * value and are no more than GAP_STEPS steps apart. An offline stretch (no
 * buckets at all) or a series missing from some buckets breaks the line.
 */
export function segmentRuns(
  timeline: readonly number[],
  values: ReadonlyArray<HistoryStat | null>,
  stepMs: number,
): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  for (let i = 0; i < timeline.length; i++) {
    if (!values[i]) {
      if (run.length) runs.push(run);
      run = [];
      continue;
    }
    const prev = run[run.length - 1];
    if (prev != null && timeline[i] - timeline[prev] > stepMs * GAP_STEPS) {
      runs.push(run);
      run = [];
    }
    run.push(i);
  }
  if (run.length) runs.push(run);
  return runs;
}

/** Index of the timeline entry nearest to `t` (timeline ascending), or -1 if empty. */
export function nearestIndex(timeline: readonly number[], t: number): number {
  if (timeline.length === 0) return -1;
  let lo = 0;
  let hi = timeline.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(timeline[lo - 1] - t) <= Math.abs(timeline[lo] - t)) return lo - 1;
  return lo;
}

/** y bounds covering avg, the drawn band and the thresholds. */
export function yDomain(
  series: readonly HistoryChartSeries[],
  yMin?: number,
  yMax?: number,
  thresholds: readonly HistoryThreshold[] = [],
  yUnit = 1,
): { lo: number; hi: number } | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    for (const v of s.values) {
      if (!v) continue;
      lo = Math.min(lo, v.avg, s.band === "min" && v.min != null ? v.min : v.avg);
      hi = Math.max(hi, v.avg, s.band === "max" ? v.max : v.avg);
    }
  }
  if (!Number.isFinite(lo)) return null;
  for (const th of thresholds) {
    lo = Math.min(lo, th.value);
    hi = Math.max(hi, th.value);
  }
  if (yMin != null) lo = Math.min(yMin, lo);
  if (yMax != null) hi = Math.max(yMax, hi);
  if (yMax == null && thresholds.length > 0) {
    // A threshold's label sits just above its line; keep the highest one off
    // the top edge, where it would collide with the line and the y-max label.
    const top = Math.max(...thresholds.map((th) => th.value));
    hi = Math.max(hi, top + (top - Math.min(lo, 0)) * 0.25);
  }
  if (yMin == null) {
    // Leave a little air under the lowest point, on a round number.
    const pad = (hi - lo) * 0.1 || Math.abs(lo) * 0.1 || 1;
    const unit = Math.max(yUnit, 10 ** Math.floor(Math.log10(hi - lo + pad)));
    lo = Math.floor((lo - pad) / unit) * unit;
  }
  if (yMax == null) hi = niceCeil(hi / yUnit) * yUnit;
  if (hi <= lo) hi = lo + 1;
  return { lo, hi };
}

/** Round up to a 1-1.2-1.5-2-2.5-3-4-5-6-8 × 10^k step. */
function niceCeil(v: number): number {
  if (!(v > 0)) return v;
  const unit = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8]) if (v <= m * unit + 1e-9) return m * unit;
  return 10 * unit;
}

function latestIndex(series: readonly HistoryChartSeries[]): number | null {
  for (let i = (series[0]?.values.length ?? 0) - 1; i >= 0; i--) {
    if (series.some((s) => s.values[i])) return i;
  }
  return null;
}

export function HistoryChart({
  id,
  title,
  timeline,
  stepMs,
  from,
  to,
  series,
  format,
  yMin,
  yMax,
  yUnit,
  thresholds = [],
  cursorT,
  onCursor,
  formatTime,
  formatAxisTime,
}: HistoryChartProps) {
  const plotRef = useRef<HTMLDivElement>(null);
  /** This chart is the one under the pointer / keyboard focus: it shows the tooltip. */
  const [active, setActive] = useState(false);
  const [focused, setFocused] = useState(false);
  const tooltipId = useId();

  const domain = yDomain(series, yMin, yMax, thresholds, yUnit);
  const span = Math.max(1, to - from);
  // A bucket is drawn at its middle, clamped into the window.
  const xOf = (t: number) =>
    Math.min(VIEW_W, Math.max(0, ((t + stepMs / 2 - from) / span) * VIEW_W));
  const yOf = (v: number) =>
    domain
      ? VIEW_H - PAD_Y - ((v - domain.lo) / (domain.hi - domain.lo)) * (VIEW_H - PAD_Y * 2)
      : VIEW_H;

  const cursorIdx = cursorT != null ? nearestIndex(timeline, cursorT) : -1;
  const hasCursor = cursorIdx >= 0 && domain != null;
  const readIdx = hasCursor ? cursorIdx : latestIndex(series);

  const move = (idx: number | null) => onCursor(idx == null ? null : timeline[idx] ?? null);

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || timeline.length === 0) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setActive(true);
    // Invert xOf: the pointer sits over a bucket's middle.
    move(nearestIndex(timeline, from + frac * span - stepMs / 2));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = timeline.length;
    if (n === 0) return;
    const cur = cursorIdx >= 0 ? cursorIdx : n - 1;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = cursorIdx >= 0 ? Math.max(0, cur - 1) : cur;
    else if (e.key === "ArrowRight") next = Math.min(n - 1, cur + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if (e.key === "Escape") {
      e.preventDefault();
      onCursor(null);
      return;
    }
    if (next == null) return;
    e.preventDefault();
    setActive(true);
    move(next);
  };

  const crossX = hasCursor ? xOf(timeline[cursorIdx]) : null;
  const crossPct = crossX != null ? (crossX / VIEW_W) * 100 : null;
  const showTooltip = hasCursor && active;

  const point = (i: number, v: number) => `${xOf(timeline[i]).toFixed(2)},${yOf(v).toFixed(2)}`;

  return (
    <div className="history-chart min-w-0 rounded-[var(--radius-sm)] border border-border p-2" data-chart={id}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="truncate text-[10px] uppercase tracking-wide text-muted">{title}</span>
        <span className="flex shrink-0 items-baseline gap-2 font-tabular text-[11px]">
          {series.map((s) => {
            const v = readIdx != null ? s.values[readIdx] : null;
            return (
              <span key={s.key} className="flex items-baseline gap-1" data-readout={s.key}>
                {series.length > 1 && <span className="text-[9px] text-muted">{s.label}</span>}
                <span style={{ color: s.color }}>{v ? format(v.avg) : "—"}</span>
              </span>
            );
          })}
        </span>
      </div>
      <div className="flex items-stretch gap-1.5">
        <div
          className="flex w-14 shrink-0 flex-col justify-between whitespace-nowrap text-right font-tabular text-[9px] leading-none text-muted"
          style={{ height: VIEW_H }}
          aria-hidden="true"
        >
          <span data-axis="ymax">{domain ? format(domain.hi) : ""}</span>
          <span data-axis="ymin">{domain ? format(domain.lo) : ""}</span>
        </div>
        <div
          ref={plotRef}
          className="relative min-w-0 flex-1 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-accent"
          tabIndex={domain ? 0 : -1}
          role="group"
          aria-label={`${title} from ${formatTime(from)} to ${formatTime(to)}. Use the arrow keys to read values; Escape clears.`}
          aria-describedby={showTooltip ? tooltipId : undefined}
          onKeyDown={onKeyDown}
          onPointerMove={onPointerMove}
          onPointerDown={onPointerMove}
          onPointerLeave={() => {
            setActive(false);
            if (!focused) onCursor(null);
          }}
          onFocus={() => {
            setFocused(true);
            setActive(true);
            if (cursorIdx < 0 && timeline.length > 0) move(timeline.length - 1);
          }}
          onBlur={() => {
            setFocused(false);
            setActive(false);
            onCursor(null);
          }}
        >
          <svg
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="none"
            className="block w-full"
            style={{ height: VIEW_H }}
            aria-hidden="true"
          >
            {[PAD_Y, VIEW_H / 2, VIEW_H - PAD_Y].map((y) => (
              <line
                key={y}
                x1={0}
                x2={VIEW_W}
                y1={y}
                y2={y}
                stroke="var(--color-border)"
                strokeWidth={1}
                strokeDasharray={y === VIEW_H - PAD_Y ? undefined : "2 3"}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {domain &&
              thresholds.map((th) => (
                <line
                  key={th.label}
                  data-threshold={th.label}
                  x1={0}
                  x2={VIEW_W}
                  y1={yOf(th.value)}
                  y2={yOf(th.value)}
                  stroke={th.color}
                  strokeWidth={1}
                  strokeDasharray="4 3"
                  opacity={0.8}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            {domain &&
              series.map((s) =>
                segmentRuns(timeline, s.values, stepMs).map((run, r) => {
                  const avgPts = run.map((i) => point(i, s.values[i]!.avg));
                  const bandPts = s.band
                    ? run.map((i) => {
                        const v = s.values[i]!;
                        return point(i, s.band === "max" ? v.max : v.min ?? v.avg);
                      })
                    : null;
                  if (run.length === 1) {
                    // A lone bucket: a short tick, so it is visible at all.
                    const x = xOf(timeline[run[0]]);
                    const y = yOf(s.values[run[0]]!.avg);
                    return (
                      <line
                        key={`${s.key}-${r}`}
                        data-series={s.key}
                        x1={x - 0.6}
                        x2={x + 0.6}
                        y1={y}
                        y2={y}
                        stroke={s.color}
                        strokeWidth={2.5}
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                      />
                    );
                  }
                  return (
                    <g key={`${s.key}-${r}`}>
                      {bandPts && (
                        <polygon
                          data-band={s.key}
                          points={[...bandPts, ...avgPts.slice().reverse()].join(" ")}
                          fill={s.color}
                          opacity={0.14}
                        />
                      )}
                      <polyline
                        data-series={s.key}
                        points={avgPts.join(" ")}
                        fill="none"
                        stroke={s.color}
                        strokeWidth={1.5}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                      />
                    </g>
                  );
                }),
              )}
            {crossX != null && (
              <line
                data-crosshair=""
                x1={crossX}
                x2={crossX}
                y1={0}
                y2={VIEW_H}
                stroke="var(--color-muted)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {domain &&
            thresholds.map((th) => (
              <span
                key={th.label}
                className="pointer-events-none absolute left-0.5 -translate-y-full font-tabular text-[9px] leading-none"
                style={{ top: `${(yOf(th.value) / VIEW_H) * 100}%`, color: th.color }}
                aria-hidden="true"
              >
                {th.label}
              </span>
            ))}
          {hasCursor &&
            series.map((s) => {
              const v = s.values[cursorIdx];
              if (!v) return null;
              return (
                <span
                  key={s.key}
                  className="pointer-events-none absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                  style={{
                    left: `${crossPct}%`,
                    top: `${(yOf(v.avg) / VIEW_H) * 100}%`,
                    background: s.color,
                  }}
                  aria-hidden="true"
                />
              );
            })}
          {!domain && (
            <div className="absolute inset-0 flex items-center justify-center text-[10px] text-muted">
              No data in this range
            </div>
          )}
          {showTooltip && crossPct != null && (
            <div
              id={tooltipId}
              role="status"
              data-tooltip=""
              className="pointer-events-none absolute top-1 z-10 w-max max-w-[15rem] rounded-md border border-border bg-surface-elevated px-2 py-1.5 text-[10px] text-text shadow-lg"
              style={
                crossPct < 55
                  ? { left: `calc(${crossPct}% + 8px)` }
                  : { right: `calc(${100 - crossPct}% + 8px)` }
              }
            >
              <div className="font-semibold text-text-strong">{formatTime(timeline[cursorIdx])}</div>
              {series.map((s) => {
                const v = s.values[cursorIdx];
                return (
                  <div key={s.key} className="flex items-center gap-1.5 font-tabular">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: s.color }} />
                    <span className="text-muted">{s.label}</span>
                    <span>{v ? format(v.avg) : "—"}</span>
                    {v && s.band === "max" && (
                      <span className="text-muted">· max {format(v.max)}</span>
                    )}
                    {v && s.band === "min" && v.min != null && (
                      <span className="text-muted">· min {format(v.min)}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <div className="mt-0.5 flex justify-between pl-[3.875rem] font-tabular text-[9px] text-muted" aria-hidden="true">
        <span data-axis="xstart">{formatAxisTime(from)}</span>
        <span data-axis="xend">{formatAxisTime(to)}</span>
      </div>
    </div>
  );
}
