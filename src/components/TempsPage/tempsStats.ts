/**
 * Pure helpers for the Temps page: range definitions and turning the server's
 * `gpu-history` arrays into drawable per-card temperature series (no React, no I/O).
 */
import type { GpuHistoryResponse } from "../../api/client";
import type { Pt } from "../SparkPage/chartMath";

export type TempsRange = "24h" | "7d";

export interface TempsRangeDef {
  id: TempsRange;
  label: string;
  long: string;
  ms: number;
}

export const TEMPS_RANGES: TempsRangeDef[] = [
  { id: "24h", label: "Last 24 h", long: "24 hours", ms: 24 * 3600_000 },
  { id: "7d", label: "Last 7 d", long: "7 days", ms: 7 * 24 * 3600_000 },
];

/** The selected range id, or the default when the stored preference is unknown. */
export function parseTempsRange(raw: string | null): TempsRange {
  return TEMPS_RANGES.some((r) => r.id === raw) ? (raw as TempsRange) : "24h";
}

export interface TempSeries {
  key: string;
  label: string;
  /** Celsius readings parallel to the response's `t` array; null where the card had no reading. */
  c: Array<number | null>;
}

/**
 * One temperature series per card on a multi-GPU host, or a single aggregate series
 * otherwise (a single card IS the aggregate, so "GPU 0" would say nothing new).
 */
export function tempSeriesOf(resp: GpuHistoryResponse): TempSeries[] {
  if (resp.gpus && resp.gpus.length > 1) {
    return resp.gpus.map((g) => ({ key: `gpu${g.index}`, label: g.name || `GPU ${g.index}`, c: g.c }));
  }
  return [{ key: "agg", label: "GPU temperature", c: resp.c }];
}

/** Pair timestamps with temperatures, dropping nulls so gaps become segment breaks. */
export function toPoints(t: readonly number[], c: ReadonlyArray<number | null>): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < t.length; i++) {
    const v = c[i];
    if (v == null || !Number.isFinite(v)) continue;
    out.push({ at: t[i], value: v });
  }
  return out;
}

/** "−24 h" / "−7 d" style relative axis labels: [start, mid]; the page appends "now". */
export function tempsAxisLabels(windowMs: number): [string, string] {
  const fmt = (ms: number) => {
    const hours = ms / 3_600_000;
    if (hours >= 48) return `−${Math.round((hours / 24) * 10) / 10} d`;
    return `−${Math.round(hours)} h`;
  };
  return [fmt(windowMs), fmt(windowMs / 2)];
}
