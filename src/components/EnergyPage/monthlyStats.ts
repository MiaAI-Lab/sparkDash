import type { MonthlyEnergyMonth } from "../../api/types";
import type { BarBucket } from "../ui/StackedBarChart";
import { costFor, NODE_COLORS } from "./energyStats";

/**
 * Maths for the permanent monthly energy view. Months are UTC calendar months,
 * exactly as the server rolls them up (server/energy/FleetEnergyMonthly.js).
 */

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "October 2026" for a "YYYY-MM" key. */
export function monthLabel(key: string): string {
  const [year, month] = key.split("-").map(Number);
  return `${MONTH_NAMES[(month || 1) - 1]} ${year}`;
}

const monthKeyOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

/** Month keys for the picker, newest first. The current UTC month is always offered. */
export function monthOptions(months: readonly MonthlyEnergyMonth[], nowMs: number): string[] {
  return [...new Set([monthKeyOf(nowMs), ...months.map((m) => m.month)])].sort().reverse();
}

/** Years for the picker, newest first. The current UTC year is always offered. */
export function yearOptions(months: readonly MonthlyEnergyMonth[], nowMs: number): number[] {
  const years = new Set([new Date(nowMs).getUTCFullYear(), ...months.map((m) => Number(m.month.slice(0, 4)))]);
  return [...years].sort((a, b) => b - a);
}

/** Time the month could have been measured: the whole month, or so far for the open one. */
export function elapsedMs(m: MonthlyEnergyMonth, nowMs: number): number {
  return Math.max(0, Math.min(nowMs, m.endMs) - m.startMs);
}

export interface MonthNodeRow {
  id: string;
  kwh: number;
  /** 0..1 of the month's energy. */
  share: number;
  coverageMs: number;
  /** 0..1 of the elapsed month this node reported. */
  coverage: number;
  cost: number | null;
}

/** Per-node rows for one month, largest consumer first. */
export function monthNodeRows(m: MonthlyEnergyMonth, nowMs: number, price: number | null): MonthNodeRow[] {
  const span = elapsedMs(m, nowMs);
  return m.nodeIds
    .map((id) => {
      const node = m.nodes[id] ?? { wh: 0, coverageMs: 0 };
      return {
        id,
        kwh: node.wh / 1000,
        share: m.totalWh > 0 ? node.wh / m.totalWh : 0,
        coverageMs: node.coverageMs,
        coverage: span > 0 ? Math.min(1, node.coverageMs / span) : 0,
        cost: costFor(node.wh / 1000, price),
      };
    })
    .sort((a, b) => b.kwh - a.kwh);
}

/** Share of the elapsed month during which every tracked node reported. */
export function fleetCoverage(m: MonthlyEnergyMonth, nowMs: number): number {
  const span = elapsedMs(m, nowMs);
  return span > 0 ? Math.min(1, m.fleetCoverageMs / span) : 0;
}

export interface YearBar extends BarBucket {
  month: string;
  hasData: boolean;
  kwh: number;
}

const SHORT = MONTH_NAMES.map((n) => n.slice(0, 3));

/** Twelve bars (Jan to Dec) of kWh per node; months without data are empty bars. */
export function yearBars(months: readonly MonthlyEnergyMonth[], year: number): YearBar[] {
  const byKey = new Map(months.map((m) => [m.month, m]));
  return Array.from({ length: 12 }, (_, i) => {
    const key = `${year}-${String(i + 1).padStart(2, "0")}`;
    const m = byKey.get(key);
    const values = Object.fromEntries(Object.entries(m?.nodes ?? {}).map(([id, n]) => [id, n.wh / 1000]));
    return {
      key,
      month: key,
      label: SHORT[i],
      title: `${MONTH_NAMES[i]} ${year}`,
      values,
      hasData: m != null && m.totalWh > 0,
      kwh: (m?.totalWh ?? 0) / 1000,
    };
  });
}

export function yearTotalKwh(months: readonly MonthlyEnergyMonth[], year: number): number {
  return yearBars(months, year).reduce((sum, b) => sum + b.kwh, 0);
}

/** Stable colour per node across the whole archive: biggest all-time consumer gets the first colour. */
export function nodeColors(months: readonly MonthlyEnergyMonth[]): (id: string) => string {
  const totals = new Map<string, number>();
  for (const m of months) {
    for (const [id, n] of Object.entries(m.nodes)) totals.set(id, (totals.get(id) ?? 0) + n.wh);
  }
  const order = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
  return (id) => {
    const i = order.indexOf(id);
    return NODE_COLORS[(i < 0 ? order.length : i) % NODE_COLORS.length];
  };
}
