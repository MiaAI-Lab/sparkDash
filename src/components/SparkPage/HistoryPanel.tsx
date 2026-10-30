import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getUnitHistory } from "../../api/client";
import type {
  HistoryStat,
  MetricsHistoryData,
  MetricsHistoryRange,
  MetricsHistoryResponse,
} from "../../api/types";
import { formatBytesPerSec, formatMb } from "../../shared/formatBytes";
import { configuredTimeZone } from "../../shared/timeZone";
import { HEADROOM_THRESHOLDS_MB, memoryModelFor } from "../../shared/vramBreakdown";
import { Panel } from "../ui/Panel";
import { ChartIcon } from "../ui/icons";
import { HistoryChart, type HistoryChartSeries, type HistoryThreshold } from "./HistoryChart";

/**
 * The unit's server-side history (Settings → Metrics history): 48 h of 1-minute and
 * 30 days of 15-minute buckets from GET /api/sparks/:id/history, as small multiples
 * with a shared crosshair. Polls every 30 s, and only while the panel is on screen
 * and the tab is visible.
 */

export const HISTORY_RANGES: readonly MetricsHistoryRange[] = ["1h", "6h", "24h", "7d", "30d"];
export const HISTORY_POLL_MS = 30_000;
export const HISTORY_RANGE_KEY = "sparkdash.ui.history.range";

const RANGE_TITLE: Record<MetricsHistoryRange, string> = {
  "1h": "last hour",
  "6h": "last 6 hours",
  "24h": "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
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
    /* a preference is a convenience */
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

/** Tooltip and axis labels, in Settings → Time zone like the other charts. */
function timeFormatters(range: MetricsHistoryRange) {
  const timeZone = configuredTimeZone() ?? undefined;
  const long = range === "7d" || range === "30d";
  const time = new Intl.DateTimeFormat(undefined, { timeZone, hour: "2-digit", minute: "2-digit" });
  const day = new Intl.DateTimeFormat(undefined, { timeZone, month: "short", day: "numeric" });
  const dayTime = new Intl.DateTimeFormat(undefined, {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return {
    tooltip: (t: number) => (range === "1h" || range === "6h" ? time.format(t) : dayTime.format(t)),
    axis: (t: number) => (long ? day.format(t) : time.format(t)),
    /** When the data on screen was fetched. */
    stamp: (t: number) => time.format(t),
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
  platform: string | undefined,
  temperatureUnit: "celsius" | "fahrenheit",
): ChartDef[] {
  const pts = data.points;
  const f = temperatureUnit === "fahrenheit";
  const toTemp = f ? (c: number) => (c * 9) / 5 + 32 : undefined;
  const temp = (v: number) => `${Math.round(v)}°${f ? "F" : "C"}`;
  const accent = "var(--color-accent)";
  const model = memoryModelFor(kind, platform);
  const headroom = HEADROOM_THRESHOLDS_MB[model];

  const charts: ChartDef[] = [
    {
      id: "gpuUtil",
      title: "GPU utilization",
      format: pct,
      yMin: 0,
      yMax: 100,
      series: [{ key: "gpuUtil", label: "GPU", color: accent, band: "max", values: aligned(timeline, pts, (p) => p.gpuUtil) }],
    },
    {
      id: "gpuTemp",
      title: "GPU temperature",
      format: temp,
      yUnit: 5,
      series: [{ key: "gpuTemp", label: "GPU", color: "var(--color-info)", band: "max", values: aligned(timeline, pts, (p) => p.gpuTemp, toTemp) }],
    },
    {
      id: "gpuPower",
      title: "GPU power",
      format: watts,
      yMin: 0,
      series: [{ key: "gpuPower", label: "Power", color: "var(--color-violet)", band: "max", values: aligned(timeline, pts, (p) => p.gpuPower) }],
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
      series: [{ key: "memFreeMB", label: "Free", color: "var(--color-success)", band: "min", values: aligned(timeline, pts, (p) => p.memFreeMB) }],
    },
    {
      id: "cpuUtil",
      title: "CPU utilization",
      format: pct,
      yMin: 0,
      yMax: 100,
      series: [{ key: "cpuUtil", label: "CPU", color: accent, band: "max", values: aligned(timeline, pts, (p) => p.cpuUtil) }],
    },
    {
      id: "cpuTemp",
      title: "CPU temperature",
      format: temp,
      yUnit: 5,
      series: [{ key: "cpuTemp", label: "CPU", color: "var(--color-info)", band: "max", values: aligned(timeline, pts, (p) => p.cpuTemp, toTemp) }],
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
      { key: "netTx", label: "↑ tx", color: "var(--color-info)", values: aligned(timeline, pts, (p) => p.netTx) },
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
        series: [{ key: "prefillTps", label: "Prefill", color: "var(--color-violet)", band: "max", values: aligned(timeline, lp, (p) => p.prefillTps) }],
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
        series: [{ key: "kvUsage", label: "KV", color: "var(--color-mem-engine)", band: "max", values: kv }],
      });
    }
  }
  return charts;
}

/**
 * Whether the element the returned ref is attached to is on screen. Without
 * IntersectionObserver (old browsers, tests) it counts as visible.
 */
function useOnScreen(): [(el: HTMLElement | null) => void, boolean] {
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  const observer = useRef<IntersectionObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el || typeof IntersectionObserver === "undefined") return;
    observer.current = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setVisible(entry.isIntersecting);
    });
    observer.current.observe(el);
  }, []);
  return [ref, visible];
}

function useTabVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

/**
 * Poll the history endpoint while `active`; the last answer stays on screen while paused, and
 * after a failed refresh (`error` set with `data`, `loadedAt` saying when it was fetched).
 */
function useUnitHistory(sparkId: string, range: MetricsHistoryRange, active: boolean) {
  const [data, setData] = useState<MetricsHistoryResponse | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A new unit or range starts from "loading", not from the previous answer.
  useEffect(() => {
    setData(null);
    setLoadedAt(null);
    setError(null);
  }, [sparkId, range]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const load = () => {
      getUnitHistory(sparkId, range)
        .then((res) => {
          if (cancelled) return;
          setData(res);
          setLoadedAt(Date.now());
          setError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    };
    load();
    const timer = setInterval(load, HISTORY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sparkId, range, active]);

  return { data, loadedAt, error };
}

export function HistoryPanel({
  sparkId,
  kind,
  platform,
  temperatureUnit,
}: {
  sparkId: string;
  kind?: string;
  /** A macOS host's memory is unified, like a Spark's. */
  platform?: string;
  temperatureUnit: "celsius" | "fahrenheit";
}) {
  const [range, setRange] = useState<MetricsHistoryRange>(readHistoryRange);
  /** Shared crosshair: one timestamp for every chart. */
  const [cursorT, setCursorT] = useState<number | null>(null);
  const [screenRef, onScreen] = useOnScreen();
  const tabVisible = useTabVisible();
  const { data, loadedAt, error } = useUnitHistory(sparkId, range, onScreen && tabVisible);

  const enabled = data?.enabled === true ? data : null;
  const timeline = useMemo(() => (enabled ? buildTimeline(enabled) : []), [enabled]);
  const charts = useMemo(
    () => (enabled ? buildCharts(enabled, timeline, kind, platform, temperatureUnit) : []),
    [enabled, timeline, kind, platform, temperatureUnit],
  );
  const formats = useMemo(() => timeFormatters(range), [range]);

  const pick = (next: MetricsHistoryRange) => {
    if (next === range) return;
    writeHistoryRange(next);
    setCursorT(null);
    setRange(next);
  };

  const chips = (
    <div className="seg" role="group" aria-label="History range">
      {HISTORY_RANGES.map((r) => (
        <button
          key={r}
          type="button"
          className={r === range ? "is-on" : ""}
          aria-pressed={r === range}
          onClick={() => pick(r)}
        >
          {r}
        </button>
      ))}
    </div>
  );

  let body;
  if (error && !data) {
    body = <p className="sp-error">Could not load history: {error}</p>;
  } else if (!data) {
    body = <p className="sp-muted">Loading history…</p>;
  } else if (!enabled) {
    body = <p className="sp-muted">Metrics history is off on the server. Turn it on in Settings → Metrics history.</p>;
  } else if (timeline.length === 0) {
    body = (
      <div className="sp-chart sp-chart--empty">
        <p className="sp-chart__note">No history in this range yet. The server records every unit while it is online.</p>
      </div>
    );
  } else {
    body = (
      <>
        <p className="sp-hint">
          Average per {stepLabel(enabled.stepMs)} · shaded: peak (low point for free memory) · gaps: offline or not
          reported
        </p>
        <div className="sp-hist-grid">
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

  // A refresh failed after an earlier answer: keep that answer on screen, but say it is stale.
  const stale =
    error && data && loadedAt !== null ? (
      <p className="sp-error" role="status">
        Stale: could not refresh ({error}). Showing data from {formats.stamp(loadedAt)}.
      </p>
    ) : null;

  return (
    <div ref={screenRef} className="sp-hist">
      <Panel title={`History · ${RANGE_TITLE[range]}`} icon={<ChartIcon />} actions={chips} bodyClassName="sp-stack sp-stack--tight">
        {stale}
        {body}
      </Panel>
    </div>
  );
}
