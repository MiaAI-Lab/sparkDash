import { useEffect, useMemo, useState } from "react";
import { fetchMetricsHistory } from "../../api/client";
import type {
  HistoryStat,
  MetricsHistoryData,
  MetricsHistoryRange,
  MetricsHistoryResponse,
} from "../../api/types";
import { formatBytesPerSec, formatMb } from "../../shared/formatBytes";
import { HEADROOM_THRESHOLDS_MB, memoryModelFor } from "../../shared/vramBreakdown";
import { Panel } from "../ui/Panel";
import { HistoryChart, type HistoryChartSeries, type HistoryThreshold } from "./HistoryChart";

/**
 * Server-side metrics history for one unit (Settings → Metrics history). Polls
 * GET /api/sparks/:id/history every 30 s while mounted — the parent mounts it
 * only while the section is open — and pauses while the tab is hidden.
 */

export const HISTORY_RANGES: readonly MetricsHistoryRange[] = ["1h", "6h", "24h", "7d", "30d"];
export const HISTORY_POLL_MS = 30_000;
export const HISTORY_RANGE_KEY = "sparkdash.ui.history.range";

const RANGE_TITLE: Record<MetricsHistoryRange, string> = {
  "1h": "Last hour",
  "6h": "Last 6 hours",
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

export function readHistoryRange(): MetricsHistoryRange {
  try {
    const raw = localStorage.getItem(HISTORY_RANGE_KEY);
    if (raw && (HISTORY_RANGES as readonly string[]).includes(raw)) return raw as MetricsHistoryRange;
  } catch {
    /* private mode / blocked storage */
  }
  return "1h";
}

function writeHistoryRange(range: MetricsHistoryRange) {
  try {
    localStorage.setItem(HISTORY_RANGE_KEY, range);
  } catch {
    /* ignore */
  }
}

function stepLabel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

const pct = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
const watts = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)} W`;
const tokS = (v: number) =>
  v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k` : v >= 100 ? v.toFixed(0) : v.toFixed(1);

function timeFormatters(range: MetricsHistoryRange) {
  const long = range === "7d" || range === "30d";
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    ...(range === "1h" ? { second: "2-digit" } : {}),
  });
  const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const dayTime = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const axisTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
  return {
    tooltip: (t: number) => (range === "1h" || range === "6h" ? time.format(t) : dayTime.format(t)),
    axis: (t: number) => (long ? day.format(t) : axisTime.format(t)),
  };
}

interface ChartDef {
  id: string;
  title: string;
  series: HistoryChartSeries[];
  format: (v: number) => string;
  yMin?: number;
  yMax?: number;
  yUnit?: number;
  thresholds?: HistoryThreshold[];
}

/** Every bucket start in the response (unit and LLM points), ascending. */
export function buildTimeline(data: MetricsHistoryData): number[] {
  const ts = new Set<number>();
  for (const p of data.points) ts.add(p.t);
  for (const e of data.llm) for (const p of e.points) ts.add(p.t);
  return [...ts].sort((a, b) => a - b);
}

function aligned<P extends { t: number }>(
  timeline: readonly number[],
  points: readonly P[],
  pick: (p: P) => HistoryStat | undefined,
  map?: (v: number) => number,
): Array<HistoryStat | null> {
  const at = new Map<number, HistoryStat>();
  for (const p of points) {
    const v = pick(p);
    if (v) at.set(p.t, map ? { avg: map(v.avg), max: map(v.max), min: v.min != null ? map(v.min) : undefined } : v);
  }
  return timeline.map((t) => at.get(t) ?? null);
}

const hasAny = (values: ReadonlyArray<HistoryStat | null>) => values.some(Boolean);

function buildCharts(
  data: MetricsHistoryData,
  timeline: readonly number[],
  kind: string | undefined,
  temperatureUnit: "celsius" | "fahrenheit",
): ChartDef[] {
  const pts = data.points;
  const f = temperatureUnit === "fahrenheit";
  const toTemp = f ? (c: number) => (c * 9) / 5 + 32 : undefined;
  const temp = (v: number) => `${Math.round(v)}°${f ? "F" : "C"}`;
  const accent = "var(--color-accent)";
  const second = "var(--color-mem-engine)";
  const model = memoryModelFor(kind);
  const headroom = HEADROOM_THRESHOLDS_MB[model];

  const charts: ChartDef[] = [
    {
      id: "gpuUtil",
      title: "GPU util",
      format: pct,
      yMin: 0,
      yMax: 100,
      series: [{ key: "gpuUtil", label: "GPU", color: accent, band: "max", values: aligned(timeline, pts, (p) => p.gpuUtil) }],
    },
    {
      id: "gpuTemp",
      title: "GPU temp",
      format: temp,
      yUnit: 5,
      series: [{ key: "gpuTemp", label: "GPU", color: accent, band: "max", values: aligned(timeline, pts, (p) => p.gpuTemp, toTemp) }],
    },
    {
      id: "gpuPower",
      title: "GPU power",
      format: watts,
      yMin: 0,
      series: [{ key: "gpuPower", label: "Power", color: accent, band: "max", values: aligned(timeline, pts, (p) => p.gpuPower) }],
    },
    {
      id: "memFree",
      title: model === "unified" ? "Memory free (unified)" : "VRAM free",
      format: formatMb,
      yMin: 0,
      yUnit: 1024,
      thresholds: [
        { value: headroom.low, label: `low ${formatMb(headroom.low)}`, color: "var(--color-warning)" },
        { value: headroom.critical, label: `critical ${formatMb(headroom.critical)}`, color: "var(--color-danger)" },
      ],
      series: [{ key: "memFreeMB", label: "Free", color: accent, band: "min", values: aligned(timeline, pts, (p) => p.memFreeMB) }],
    },
    {
      id: "cpuUtil",
      title: "CPU util",
      format: pct,
      yMin: 0,
      yMax: 100,
      series: [{ key: "cpuUtil", label: "CPU", color: accent, band: "max", values: aligned(timeline, pts, (p) => p.cpuUtil) }],
    },
    {
      id: "cpuTemp",
      title: "CPU temp",
      format: temp,
      yUnit: 5,
      series: [{ key: "cpuTemp", label: "CPU", color: accent, band: "max", values: aligned(timeline, pts, (p) => p.cpuTemp, toTemp) }],
    },
  ];

  const ram = aligned(timeline, pts, (p) => p.ramUsedMB);
  if (kind === "host" && hasAny(ram)) {
    charts.push({
      id: "ramUsed",
      title: "RAM used",
      format: formatMb,
      yMin: 0,
      yUnit: 1024,
      series: [{ key: "ramUsedMB", label: "Used", color: accent, band: "max", values: ram }],
    });
  }

  charts.push({
    id: "network",
    title: "Network",
    format: (v) => formatBytesPerSec(Math.round(v)),
    yMin: 0,
    series: [
      { key: "netRx", label: "↓ rx", color: accent, values: aligned(timeline, pts, (p) => p.netRx) },
      { key: "netTx", label: "↑ tx", color: second, values: aligned(timeline, pts, (p) => p.netTx) },
    ],
  });

  for (const endpoint of data.llm) {
    const port = endpoint.port;
    const lp = endpoint.points;
    charts.push(
      {
        id: `llm-${port}-gen`,
        title: `Decode tok/s · :${port}`,
        format: tokS,
        yMin: 0,
        series: [{ key: "genTps", label: "Decode", color: accent, band: "max", values: aligned(timeline, lp, (p) => p.genTps) }],
      },
      {
        id: `llm-${port}-prefill`,
        title: `Prefill tok/s · :${port}`,
        format: tokS,
        yMin: 0,
        series: [{ key: "prefillTps", label: "Prefill", color: "var(--color-text)", band: "max", values: aligned(timeline, lp, (p) => p.prefillTps) }],
      },
    );
    const kv = aligned(timeline, lp, (p) => p.kvUsage, (v) => v * 100);
    if (hasAny(kv)) {
      charts.push({
        id: `llm-${port}-kv`,
        title: `KV cache · :${port}`,
        format: pct,
        yMin: 0,
        yMax: 100,
        series: [{ key: "kvUsage", label: "KV", color: second, band: "max", values: kv }],
      });
    }
  }
  return charts;
}

/** Poll the history endpoint while mounted and the tab is visible. */
function useMetricsHistory(sparkId: string, range: MetricsHistoryRange) {
  const [data, setData] = useState<MetricsHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    setData(null);
    setError(null);
    const load = () => {
      fetchMetricsHistory(sparkId, range)
        .then((res) => {
          if (cancelled) return;
          setData(res);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    };
    const start = () => {
      if (timer != null) return;
      load();
      timer = setInterval(load, HISTORY_POLL_MS);
    };
    const stop = () => {
      if (timer == null) return;
      clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.visibilityState === "hidden" ? stop() : start());
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [sparkId, range]);

  return { data, error };
}

export function HistorySection({
  sparkId,
  kind,
  temperatureUnit,
  className = "",
}: {
  sparkId: string;
  kind?: string;
  temperatureUnit: "celsius" | "fahrenheit";
  className?: string;
}) {
  const [range, setRange] = useState<MetricsHistoryRange>(readHistoryRange);
  /** Shared crosshair: one timestamp for every chart. */
  const [cursorT, setCursorT] = useState<number | null>(null);
  const { data, error } = useMetricsHistory(sparkId, range);

  const enabled = data?.enabled === true ? data : null;
  const timeline = useMemo(() => (enabled ? buildTimeline(enabled) : []), [enabled]);
  const charts = useMemo(
    () => (enabled ? buildCharts(enabled, timeline, kind, temperatureUnit) : []),
    [enabled, timeline, kind, temperatureUnit],
  );
  const formats = useMemo(() => timeFormatters(range), [range]);

  const pick = (next: MetricsHistoryRange) => {
    if (next === range) return;
    writeHistoryRange(next);
    setCursorT(null);
    setRange(next);
  };

  const chips = (
    <div className="flex items-center gap-1" role="group" aria-label="History range">
      {HISTORY_RANGES.map((r) => (
        <button
          key={r}
          type="button"
          aria-pressed={r === range}
          onClick={() => pick(r)}
          className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
            r === range
              ? "bg-accent text-white"
              : "border border-border bg-surface-elevated text-muted hover:bg-surface-hover"
          }`}
        >
          {r}
        </button>
      ))}
    </div>
  );

  let body;
  if (error && !data) {
    body = <p className="text-xs text-danger">Could not load history: {error}</p>;
  } else if (!data) {
    body = <p className="text-xs text-muted">Loading history…</p>;
  } else if (!enabled) {
    body = (
      <p className="text-xs text-muted">
        Metrics history is off on the server. Turn it on in Settings → Metrics history.
      </p>
    );
  } else if (timeline.length === 0) {
    body = (
      <p className="text-xs text-muted">
        No history in this range yet. sparkDash records a sample every 2 s while the unit is online.
      </p>
    );
  } else {
    body = (
      <>
        <p className="mb-2 text-[10px] text-muted">
          Average per {stepLabel(enabled.stepMs)} · shaded: peak (low point for free memory) · gaps:
          offline or not reported
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {charts.map((c) => (
            <HistoryChart
              key={c.id}
              id={c.id}
              title={c.title}
              timeline={timeline}
              stepMs={enabled.stepMs}
              from={enabled.from}
              to={enabled.to}
              series={c.series}
              format={c.format}
              yMin={c.yMin}
              yMax={c.yMax}
              yUnit={c.yUnit}
              thresholds={c.thresholds}
              cursorT={cursorT}
              onCursor={setCursorT}
              formatTime={formats.tooltip}
              formatAxisTime={formats.axis}
            />
          ))}
        </div>
      </>
    );
  }

  return (
    <Panel title={RANGE_TITLE[range]} actions={chips} className={className}>
      {body}
    </Panel>
  );
}
