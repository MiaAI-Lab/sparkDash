/** Type declarations for src/config/display.js (honest-visuals constants). */

export const DISPLAY: {
  SPARKLINE_WINDOW_S: number;
  TEMP_DOMAIN_C: [number, number];
  TEMP_WARN_C: number;
  TEMP_THROTTLE_C: number;
  USAGE_DOMAIN: [number, number];
  GAUGE_SMOOTH_MS: number;
  IDLE_AFTER_S: number;
  STALE_AFTER_S: number;
  DEAD_AFTER_S: number;
  AGG_WINDOW_S: number;
  STORAGE_WARN: number;
  STORAGE_RISK: number;
  TELEMETRY_STRING_MAX: number;
};

export const MODEL_SCALES: Record<
  string,
  { gen: number; prefill: number; source: string }
>;

export const FALLBACK_SCALE: { gen: number; prefill: number };

/** Scale for a served model name. `isFallback` true when the key is unknown —
 * callers must render the DEFAULT SCALE badge (AT-17). */
export function scaleForModel(modelId: string | null | undefined): {
  gen: number;
  prefill: number;
  isFallback: boolean;
};

export function displayNodeName(name: string | null | undefined): string;

export function fmtTemp(celsius: number): string;
export function fmtPower(watts: number): string;
export function fmtCapacityGb(usedGb: number, totalGb: number): string;
export function fmtGbInteger(gb: number): string;
export function fmtTok(tps: number): string;
export function fmtPct(frac: number): string;
export function fmtSeconds(seconds: number): string;

/**
 * Trend direction over the tail of a metric history ("rising" | "falling" |
 * "steady" | null when too few samples). Slope threshold in units/minute.
 */
export function describeTrend(
  values: readonly number[],
  thresholdPerMin: number,
  windowSamples?: number,
  cadenceS?: number
): "rising" | "falling" | "steady" | null;
