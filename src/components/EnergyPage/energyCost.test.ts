import { describe, expect, it } from "vitest";
import type { EnergyHistoryRow } from "../../api/types";
import type { EnergyTariff } from "../../shared/energyTariff";
import { HOUR_MS, buildBuckets, fixedTz, floorHour, rangeWindow, summarize, tariffHourPrice } from "./energyStats";

const NOW = Date.UTC(2026, 9, 7, 12, 30); // Wed 7 Oct 2026 12:30 UTC
const NODES = ["a", "b"];
const UTC = fixedTz(0);

function row(t: number, whA: number, whB: number): EnergyHistoryRow {
  return {
    t,
    nodeWh: { a: whA, b: whB },
    nodeCoverageMs: { a: HOUR_MS, b: HOUR_MS },
    avgWatts: whA + whB,
    fleetEnergyWh: whA + whB,
    fleetCoverageMs: HOUR_MS,
    outputTokens: 0,
    coveredOutputTokens: 0,
  };
}

const NOON = floorHour(NOW);
// 11:00 and 12:00: 100 Wh on a, 50 Wh on b each hour.
const ROWS = [row(NOON - HOUR_MS, 100, 50), row(NOON, 100, 50)];
const PEAK_NOON: EnergyTariff = { mode: "tou", base: 0.2, periods: [{ from: 12, to: 13, price: 1, days: "weekdays" }] };

describe("time-of-use cost", () => {
  it("prices each hour at its own rate", () => {
    const win = rangeWindow("24h", NOW, ROWS);
    const s = summarize(ROWS, win, NODES, tariffHourPrice(PEAK_NOON, UTC));
    expect(s.cost).toBeCloseTo(0.15 * 0.2 + 0.15 * 1, 9);
    expect(s.nodes.find((n) => n.id === "a")!.cost).toBeCloseTo(0.1 * 0.2 + 0.1 * 1, 9);
    expect(s.costPerDay).toBeCloseTo(s.cost! / (win.windowMs / (24 * HOUR_MS)), 9);
  });

  it("follows the chart time zone and the day choice", () => {
    const win = rangeWindow("24h", NOW, ROWS);
    // At +60 min the rows are 12:00 and 13:00 local: the peak now prices the first row.
    expect(summarize(ROWS, win, NODES, tariffHourPrice(PEAK_NOON, fixedTz(60))).cost).toBeCloseTo(0.15 * 1 + 0.15 * 0.2, 9);
    const weekend: EnergyTariff = { ...PEAK_NOON, periods: [{ ...PEAK_NOON.periods[0], days: "weekends" }] };
    expect(summarize(ROWS, win, NODES, tariffHourPrice(weekend, UTC)).cost).toBeCloseTo(0.3 * 0.2, 9);
  });

  it("gives no total while an hour that used energy has no price", () => {
    const win = rangeWindow("24h", NOW, ROWS);
    const s = summarize(ROWS, win, NODES, tariffHourPrice({ ...PEAK_NOON, base: null }, UTC));
    expect(s.cost).toBeNull();
    expect(s.costPerDay).toBeNull();
  });

  it("puts the cost and price on every hour bucket, and the average price on a day", () => {
    const price = tariffHourPrice(PEAK_NOON, UTC);
    const win = rangeWindow("24h", NOW, ROWS);
    const hourly = buildBuckets(ROWS, win, "hour", UTC, price);
    const at = (t: number) => hourly.find((b) => b.startMs === t)!;
    expect(at(NOON).cost).toBeCloseTo(0.15, 9);
    expect(at(NOON).pricePerKwh).toBe(1);
    expect(at(NOON - HOUR_MS).cost).toBeCloseTo(0.03, 9);
    // An hour with no data has no cost, but still shows its price.
    expect(at(NOON - 2 * HOUR_MS).cost).toBeNull();
    expect(at(NOON - 2 * HOUR_MS).pricePerKwh).toBe(0.2);
    const daily = buildBuckets(ROWS, rangeWindow("7d", NOW, ROWS), "day", UTC, price);
    const today = daily[daily.length - 1];
    expect(today.cost).toBeCloseTo(0.18, 9);
    expect(today.pricePerKwh).toBeCloseTo(0.6, 9);
  });

  it("leaves buckets without cost when no price is set", () => {
    expect(tariffHourPrice({ mode: "flat", base: null, periods: [] }, UTC)).toBeNull();
    const b = buildBuckets(ROWS, rangeWindow("24h", NOW, ROWS), "hour", UTC);
    expect(b.every((x) => x.cost === null && x.pricePerKwh === null)).toBe(true);
  });
});