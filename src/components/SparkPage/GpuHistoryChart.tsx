import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { GpuMetrics } from "../../api/types";
import { getGpuHistory } from "../../api/client";
import { backfillHistory, getMetricHistorySamples, useTimedMetricsHistory } from "../../hooks/metricsStore";
import { seriesSegments, windowAxisLabels, type Pt } from "./chartMath";
import {
  GPU_METRICS,
  chartSeriesSpecs,
  parseGpuMetric,
  parseGpuView,
  type GpuMetric,
  type GpuView,
} from "./gpuChartView";

const VIEW_KEY = "sparkdash.gpuChart.view";
const METRIC_KEY = "sparkdash.gpuChart.metric";

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a preference is a convenience */
  }
}

export const GPU_CHART_WINDOWS = [
  { id: "30m", label: "30 min", ms: 30 * 60_000 },
  { id: "1h", label: "1 h", ms: 60 * 60_000 },
  { id: "8h", label: "8 h", ms: 8 * 60 * 60_000 },
] as const;

const HEIGHT = 200;
const PAD = { l: 30, r: 8, t: 8, b: 22 };

/**
 * Fill the chart from the server's history once a minute at most per Spark, so it shows the last hours
 * straight away instead of starting empty. Failure just leaves the chart collecting live.
 */
const BACKFILL_COOLDOWN_MS = 60_000;
const lastBackfill = new Map<string, number>();
function useServerBackfill(sparkId: string) {
  useEffect(() => {
    // Idempotent (only older samples are added), so refetching after a cooldown is safe and recovers from a failed or empty first try.
    const last = lastBackfill.get(sparkId) ?? 0;
    if (Date.now() - last < BACKFILL_COOLDOWN_MS) return;
    lastBackfill.set(sparkId, Date.now());
    // The store is global, so the result is applied even if this chart unmounts meanwhile.
    void getGpuHistory(sparkId, GPU_CHART_WINDOWS[GPU_CHART_WINDOWS.length - 1].ms)
      .then((h) => {
        const series = (vals: ReadonlyArray<number | null>) =>
          h.t.flatMap((at, i) => (vals[i] == null ? [] : [{ at, value: vals[i] as number }]));
        backfillHistory(sparkId, "gpu.usage", series(h.u));
        backfillHistory(sparkId, "gpu.temp", series(h.c));
        backfillHistory(sparkId, "gpu.powerPct", series(h.p));
        for (const g of h.gpus ?? []) {
          backfillHistory(sparkId, `gpu.${g.index}.usage`, series(g.u));
          backfillHistory(sparkId, `gpu.${g.index}.temp`, series(g.c));
          backfillHistory(sparkId, `gpu.${g.index}.powerPct`, series(g.p));
        }
      })
      .catch(() => lastBackfill.delete(sparkId));
  }, [sparkId]);
}

/**
 * Width of the element the returned ref is attached to, kept current with a
 * ResizeObserver. A callback ref, because the chart's wrapper element is swapped
 * (the "collecting history" box becomes the chart): an observer started once on the
 * first element kept watching the removed one and the chart stayed at its first width.
 */
function useWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [w, setW] = useState(560);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const measure = () => setW(Math.max(240, Math.round(el.clientWidth) || 560));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
  }, []);
  return [ref, w];
}

interface Line {
  key: string;
  label: string;
  color: string;
  fill: boolean;
  segs: Pt[][];
}

/** GPU usage / power % / temperature overlaid on one 0–100 axis, with grid, axis labels and end dots. */
export function GpuHistoryChart({
  sparkId,
  gpu,
  windowMs,
}: {
  sparkId: string;
  gpu: GpuMetrics | null;
  windowMs: number;
}) {
  const gradId = useId();
  const usage = useTimedMetricsHistory(sparkId, "gpu.usage");
  const temp = useTimedMetricsHistory(sparkId, "gpu.temp");
  useServerBackfill(sparkId);
  const power = useTimedMetricsHistory(sparkId, "gpu.powerPct");
  const [wrapRef, width] = useWidth();

  // Cards of a multi-GPU host; a single card (or none) keeps the plain aggregate chart.
  const indices = useMemo(() => (gpu?.gpus && gpu.gpus.length > 1 ? gpu.gpus.map((d) => d.index) : []), [gpu?.gpus]);
  const multi = indices.length > 1;
  const indexKey = indices.join(",");
  const [viewRaw, setViewRaw] = useState<string | null>(() => readPref(VIEW_KEY));
  const [metric, setMetric] = useState<GpuMetric>(() => parseGpuMetric(readPref(METRIC_KEY)));
  const view: GpuView = multi ? parseGpuView(viewRaw, indices) : "combined";
  const specs = useMemo(() => chartSeriesSpecs(view, metric, indices), [view, metric, indexKey]);

  const lines = useMemo<Line[]>(() => {
    // The aggregate series change on every sample and on backfill, which is also when the per-card ones do.
    void usage;
    const all = specs.map((sp) => ({ sp, samples: getMetricHistorySamples(sparkId, sp.metric) }));
    const end = Math.max(0, ...all.map((x) => x.samples.at(-1)?.at ?? 0));
    if (!end) return [];
    return all.map(({ sp, samples }) => ({
      key: sp.key,
      label: sp.label,
      color: sp.color,
      fill: sp.fill,
      segs: seriesSegments(samples, windowMs, end),
    }));
  }, [specs, usage, sparkId, windowMs]);

  const endAt = useMemo(
    () => Math.max(0, ...specs.map((sp) => getMetricHistorySamples(sparkId, sp.metric).at(-1)?.at ?? 0)),
    [specs, usage, temp, power, sparkId]
  );

  const iw = width - PAD.l - PAD.r;
  const ih = HEIGHT - PAD.t - PAD.b;
  const startAt = endAt - windowMs;
  const xOf = (at: number) => PAD.l + ((at - startAt) / windowMs) * iw;
  const yOf = (v: number) => PAD.t + ih - (Math.max(0, Math.min(100, v)) / 100) * ih;
  const d = (seg: Pt[]) => seg.map((p, i) => `${i ? "L" : "M"}${xOf(p.at).toFixed(1)} ${yOf(p.value).toFixed(1)}`).join(" ");
  const [axA, axB] = windowAxisLabels(windowMs);
  const hasData = lines.some((l) => l.segs.some((s) => s.length > 1));

  const pickView = (v: GpuView) => {
    setViewRaw(String(v));
    writePref(VIEW_KEY, String(v));
  };
  const pickMetric = (m: GpuMetric) => {
    setMetric(m);
    writePref(METRIC_KEY, m);
  };
  const viewOptions: Array<[GpuView, string]> = [["combined", "Combined"], ["all", "All GPUs"], ...indices.map((i): [GpuView, string] => [i, `GPU ${i}`])];
  const controls = multi ? (
    <div className="sp-chart__controls">
      <div className="seg" role="group" aria-label="GPUs to plot">
        {viewOptions.map(([v, label]) => (
          <button
            key={String(v)}
            type="button"
            className={v === view ? "is-on" : ""}
            aria-pressed={v === view}
            title={typeof v === "number" ? (gpu?.gpus?.find((d) => d.index === v)?.name ?? undefined) : undefined}
            onClick={() => pickView(v)}
          >
            {label}
          </button>
        ))}
      </div>
      {view === "all" && (
        <div className="seg" role="group" aria-label="Metric to plot">
          {GPU_METRICS.map((m) => (
            <button
              key={m.id}
              type="button"
              className={m.id === metric ? "is-on" : ""}
              aria-pressed={m.id === metric}
              onClick={() => pickMetric(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  ) : null;
  const legend = multi ? (
    <div className="legend">
      {specs.map((sp) => (
        <span key={sp.key} style={{ "--c": sp.color } as React.CSSProperties}>
          {sp.label}
        </span>
      ))}
    </div>
  ) : null;

  // Until two samples exist (history is collected while the page is open, and an idle
  // GPU sends few updates) show a short placeholder instead of a large empty plot.
  if (!hasData) {
    return (
      <div>
        {controls}
        <div className="sp-chart sp-chart--empty" ref={wrapRef}>
          <p className="sp-chart__note">Collecting history. The chart fills in while this page is open.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="sp-chart" ref={wrapRef}>
      {controls}
      <svg
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="img"
        aria-label="GPU utilization, power and temperature history"
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--color-accent)" stopOpacity="0.28" />
            <stop offset="1" stopColor="var(--color-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 25, 50, 75, 100].map((t) => (
          <g key={t}>
            <line
              x1={PAD.l}
              x2={width - PAD.r}
              y1={yOf(t)}
              y2={yOf(t)}
              stroke="var(--color-border)"
              strokeDasharray={t ? "2 4" : undefined}
            />
            <text x={PAD.l - 6} y={yOf(t) + 3.5} textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        <text x={PAD.l} y={HEIGHT - 4} textAnchor="start">
          {axA}
        </text>
        <text x={PAD.l + iw / 2} y={HEIGHT - 4} textAnchor="middle">
          {axB}
        </text>
        <text x={width - PAD.r} y={HEIGHT - 4} textAnchor="end">
          now
        </text>
        {hasData &&
          lines.map((l) =>
            l.segs
              .filter((s) => s.length > 1)
              .map((seg, si) => {
                const path = d(seg);
                const last = seg[seg.length - 1];
                const first = seg[0];
                return (
                  <g key={`${l.key}-${si}`}>
                    {l.fill && (
                      <path
                        d={`${path} L${xOf(last.at).toFixed(1)} ${yOf(0)} L${xOf(first.at).toFixed(1)} ${yOf(0)} Z`}
                        fill={`url(#${gradId})`}
                      />
                    )}
                    <path d={path} fill="none" stroke={l.color} strokeWidth="1.8" strokeLinejoin="round" />
                    {si === l.segs.filter((s) => s.length > 1).length - 1 && (
                      <circle cx={xOf(last.at)} cy={yOf(last.value)} r="3.5" fill={l.color} />
                    )}
                  </g>
                );
              })
          )}
      </svg>
      {legend}
    </div>
  );
}
