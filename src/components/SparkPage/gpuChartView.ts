/** Which GPU series the Spark page's main chart plots (pure helpers, no React). */

export type GpuView = "combined" | "all" | number;
export type GpuMetric = "usage" | "powerPct" | "temp";

export const GPU_METRICS: ReadonlyArray<{ id: GpuMetric; label: string; unit: string }> = [
  { id: "usage", label: "Utilization", unit: "GPU utilization %" },
  { id: "powerPct", label: "Power", unit: "Power % of limit" },
  { id: "temp", label: "Temperature", unit: "Temperature °C" },
];

/** One colour per card, by position; cycles past six cards. */
const GPU_COLORS = [
  "var(--color-accent)",
  "var(--color-info)",
  "var(--color-violet)",
  "var(--color-success)",
  "var(--color-warning)",
  "var(--color-mem-engine)",
];
export const gpuColor = (position: number): string => GPU_COLORS[position % GPU_COLORS.length];

const METRIC_COLORS: Record<GpuMetric, string> = {
  usage: "var(--color-accent)",
  powerPct: "var(--color-violet)",
  temp: "var(--color-info)",
};

export interface ChartSeriesSpec {
  key: string;
  label: string;
  color: string;
  /** Key in the metrics store, after the Spark id. */
  metric: string;
  /** Draw the soft area under this line. */
  fill: boolean;
}

/** Stored choice back to a view; anything that no longer matches the cards falls back to "all". */
export function parseGpuView(raw: string | null | undefined, indices: readonly number[]): GpuView {
  if (raw === "combined" || raw === "all") return raw;
  const n = raw != null && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return indices.includes(n) ? n : "all";
}

export function parseGpuMetric(raw: string | null | undefined): GpuMetric {
  return GPU_METRICS.some((m) => m.id === raw) ? (raw as GpuMetric) : "usage";
}

/** The lines for a view: the host aggregate, every card for one metric, or one card's three metrics. */
export function chartSeriesSpecs(view: GpuView, metric: GpuMetric, indices: readonly number[]): ChartSeriesSpec[] {
  if (view === "all") {
    return indices.map((idx, pos) => ({
      key: `gpu${idx}`,
      label: `GPU ${idx}`,
      color: gpuColor(pos),
      metric: `gpu.${idx}.${metric}`,
      fill: false,
    }));
  }
  const prefix = view === "combined" ? "gpu" : `gpu.${view}`;
  return GPU_METRICS.map((m) => ({
    key: m.id,
    label: m.unit,
    color: METRIC_COLORS[m.id],
    metric: `${prefix}.${m.id}`,
    fill: m.id === "usage",
  }));
}
