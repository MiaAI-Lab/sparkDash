/** Which GPU series the Spark page's main chart plots (pure helpers, no React). */
import { i18next } from "../../i18n";

export type GpuView = "combined" | "all" | number;
export type GpuMetric = "usage" | "powerPct" | "temp";

// Only the metric ids live here; the visible button / legend text is resolved by
// gpuMetricLabel / gpuMetricUnit below so it follows the active language.
export const GPU_METRICS: ReadonlyArray<{ id: GpuMetric }> = [
  { id: "usage" },
  { id: "powerPct" },
  { id: "temp" },
];

/** Short button label for one metric (an if-chain so the keys stay static). */
export function gpuMetricLabel(id: GpuMetric): string {
  if (id === "usage") return i18next.t("spark.chart.metricUsage", "Utilization");
  if (id === "powerPct") return i18next.t("spark.chart.metricPower", "Power");
  return i18next.t("spark.chart.metricTemp", "Temperature");
}

/** Y-axis / legend unit for one metric. */
export function gpuMetricUnit(id: GpuMetric): string {
  if (id === "usage") return i18next.t("spark.chart.unitUsage", "GPU utilization %");
  if (id === "powerPct") return i18next.t("spark.chart.unitPower", "Power % of limit");
  return i18next.t("spark.chart.unitTemp", "Temperature °C");
}

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
      label: i18next.t("spark.chart.gpu", "GPU {idx}", { idx }),
      color: gpuColor(pos),
      metric: `gpu.${idx}.${metric}`,
      fill: false,
    }));
  }
  const prefix = view === "combined" ? "gpu" : `gpu.${view}`;
  return GPU_METRICS.map((m) => ({
    key: m.id,
    label: gpuMetricUnit(m.id),
    color: METRIC_COLORS[m.id],
    metric: `${prefix}.${m.id}`,
    fill: m.id === "usage",
  }));
}
