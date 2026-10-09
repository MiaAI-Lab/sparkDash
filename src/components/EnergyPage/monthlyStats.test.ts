import { describe, expect, it } from "vitest";
import type { MonthlyEnergyMonth } from "../../api/types";
import {
  elapsedMs,
  fleetCoverage,
  monthLabel,
  monthNodeRows,
  monthOptions,
  nodeColors,
  yearBars,
  yearOptions,
  yearTotalKwh,
} from "./monthlyStats";

const DAY = 86_400_000;

function month(key: string, nodes: Record<string, number>, over: Partial<MonthlyEnergyMonth> = {}): MonthlyEnergyMonth {
  const [y, m] = key.split("-").map(Number);
  const startMs = Date.UTC(y, m - 1, 1);
  const endMs = Date.UTC(y, m, 1);
  return {
    month: key,
    startMs,
    endMs,
    closed: true,
    nodeIds: Object.keys(nodes).sort(),
    nodes: Object.fromEntries(Object.entries(nodes).map(([id, wh]) => [id, { wh, coverageMs: (endMs - startMs) / 2 }])),
    totalWh: Object.values(nodes).reduce((s, v) => s + v, 0),
    fleetWh: 0,
    fleetCoverageMs: (endMs - startMs) / 4,
    outputTokens: 0,
    coveredOutputTokens: 0,
    whPerOutputToken: null,
    ...over,
  };
}

const NOW = Date.UTC(2026, 9, 16, 12);

describe("month labels and pickers", () => {
  it("names UTC months", () => {
    expect(monthLabel("2026-01")).toBe("January 2026");
    expect(monthLabel("2025-12")).toBe("December 2025");
  });

  it("lists months newest first and always offers the current month and year", () => {
    const months = [month("2025-11", { a: 1000 }), month("2025-12", { a: 1000 })];
    expect(monthOptions(months, NOW)).toEqual(["2026-10", "2025-12", "2025-11"]);
    expect(yearOptions(months, NOW)).toEqual([2026, 2025]);
    expect(monthOptions([], NOW)).toEqual(["2026-10"]);
  });
});

describe("per-month figures", () => {
  it("sorts nodes by energy and shares the total", () => {
    const m = month("2026-09", { a: 1000, b: 3000 });
    const rows = monthNodeRows(m, NOW, 0.2);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(rows[0].kwh).toBe(3);
    expect(rows[0].share).toBeCloseTo(0.75);
    expect(rows[0].cost).toBeCloseTo(0.6);
    expect(rows[0].coverage).toBeCloseTo(0.5);
    expect(monthNodeRows(m, NOW, null)[0].cost).toBeNull();
  });

  it("measures an open month against the time elapsed so far", () => {
    const open = month("2026-10", { a: 100 }, { closed: false, fleetCoverageMs: 5 * DAY });
    expect(elapsedMs(open, NOW)).toBe(15.5 * DAY);
    expect(fleetCoverage(open, NOW)).toBeCloseTo(5 / 15.5);
    expect(fleetCoverage(month("2026-09", { a: 1 }, { fleetCoverageMs: 60 * DAY }), NOW)).toBe(1);
  });
});

describe("year view", () => {
  const months = [month("2026-01", { a: 2000, b: 1000 }), month("2026-03", { a: 500 }), month("2025-12", { a: 9000 })];

  it("returns twelve bars with kWh per node and empty gaps", () => {
    const bars = yearBars(months, 2026);
    expect(bars).toHaveLength(12);
    expect(bars[0].values).toEqual({ a: 2, b: 1 });
    expect(bars[0].title).toBe("January 2026");
    expect(bars[1].hasData).toBe(false);
    expect(bars[2].kwh).toBeCloseTo(0.5);
    expect(yearTotalKwh(months, 2026)).toBeCloseTo(3.5);
    expect(yearTotalKwh(months, 2025)).toBeCloseTo(9);
  });
});

describe("node colours", () => {
  it("gives the all-time biggest consumer the first colour and keeps unknown ids safe", () => {
    const color = nodeColors([month("2026-01", { a: 1, b: 5 })]);
    expect(color("b")).not.toBe(color("a"));
    expect(color("b")).toBe("var(--color-accent)");
    expect(typeof color("zzz")).toBe("string");
  });
});
