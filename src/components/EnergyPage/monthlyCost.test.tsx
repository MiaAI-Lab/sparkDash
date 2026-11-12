import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { MonthlyEnergy } from "./MonthlyEnergy";
import { monthCost, monthNodeRows, nodeMonthCost } from "./monthlyStats";
import { wallMonth } from "./wallStats";
import { flush, render } from "../../testing/render";
import type { MonthlyEnergyMonth } from "../../api/types";
import type { HourPrice } from "./energyStats";

vi.mock("../../api/client", () => ({ fetchMonthlyEnergy: vi.fn() }));
vi.mock("../ui/useElementWidth", () => ({ useElementWidth: () => [() => undefined, 600] }));

import { fetchMonthlyEnergy } from "../../api/client";

const OCT = Date.UTC(2026, 9, 1);
const H = 3_600_000;
/** 1.00/kWh before noon UTC, 0.10 after. */
const peakMornings: HourPrice = (ms) => (new Date(ms).getUTCHours() < 12 ? 1 : 0.1);
const hoursAt = (entries: Record<number, number>) => {
  const out = new Array(Math.max(...Object.keys(entries).map(Number)) + 1).fill(0);
  for (const [i, wh] of Object.entries(entries)) out[Number(i)] = wh;
  return out;
};

function october(over: Partial<MonthlyEnergyMonth> = {}): MonthlyEnergyMonth {
  return {
    month: "2026-10",
    startMs: OCT,
    endMs: Date.UTC(2026, 10, 1),
    closed: true,
    nodeIds: ["a", "b"],
    nodes: {
      // a: 1 kWh in a morning hour, 1 kWh in an afternoon hour, 1 kWh from before hourly records.
      a: { wh: 3000, coverageMs: 10 * H, hourWh: hoursAt({ 0: 1000, 13: 1000 }) },
      // b: every Wh has its hour (hour 24 is 1 Oct + 1 day, 00:00).
      b: { wh: 500, coverageMs: 10 * H, hourWh: hoursAt({ 24: 500 }) },
    },
    totalWh: 3500,
    fleetWh: 3500,
    fleetCoverageMs: 10 * H,
    outputTokens: 0,
    coveredOutputTokens: 0,
    whPerOutputToken: null,
    binnedFromMs: OCT + 5 * H,
    ...over,
  };
}

describe("monthly cost under time of use", () => {
  it("prices each recorded hour at its own rate and the rest at the other-hours price", () => {
    const m = october();
    const pricing = { flat: 0.2, hourPrice: peakMornings };
    expect(nodeMonthCost(m, 3000, m.nodes.a.hourWh, pricing).cost).toBeCloseTo(1 + 0.1 + 0.2, 9);
    expect(nodeMonthCost(m, 500, m.nodes.b.hourWh, pricing)).toEqual({ cost: 0.5, unbinnedKwh: 0 });
    const all = monthCost(m, pricing);
    expect(all.cost).toBeCloseTo(1.8, 9);
    expect(all.unbinnedKwh).toBeCloseTo(1, 9);
    expect(monthNodeRows(m, Date.UTC(2026, 11, 1), pricing).map((r) => r.cost)).toEqual([expect.closeTo(1.3, 9), 0.5]);
  });

  it("re-prices history when the tariff changes, since only energy is stored", () => {
    const m = october();
    const allDay1 = monthCost(m, { flat: 0.2, hourPrice: () => 1 }).cost!;
    expect(allDay1).toBeCloseTo(2 + 0.5 + 0.2, 9);
  });

  it("has no cost while unrecorded energy has no price, or a used hour has none", () => {
    const m = october();
    expect(monthCost(m, { flat: null, hourPrice: peakMornings })).toEqual({ cost: null, unbinnedKwh: 1 });
    expect(monthCost(m, { flat: 0.2, hourPrice: (ms) => (ms === OCT + 13 * H ? null : 1) }).cost).toBeNull();
  });

  it("ignores the hourly rounding and keeps a flat price exact", () => {
    const m = october({ nodes: { a: { wh: 1000.004, coverageMs: H, hourWh: [1000] }, b: { wh: 0, coverageMs: 0 } } });
    expect(monthCost(m, { flat: 0.2, hourPrice: peakMornings }).unbinnedKwh).toBe(0);
    expect(monthCost(october(), { flat: 0.2 })).toEqual({ cost: 3.5 * 0.2, unbinnedKwh: 0 });
  });

  it("uses the wall hours in a metered month", () => {
    const m = october({
      totalWallWh: 2000,
      nodes: { a: { wh: 3000, coverageMs: H, wallWh: 2000, wallCoverageMs: H, wallHourWh: hoursAt({ 13: 2000 }) }, b: { wh: 500, coverageMs: H } },
    });
    expect(monthCost(wallMonth(m)!, { flat: 0.2, hourPrice: peakMornings }).cost).toBeCloseTo(0.2, 9);
  });
});

describe("MonthlyEnergy under time of use", () => {
  const data = { estimated: true, generatedAt: Date.UTC(2026, 10, 2), foldedThroughMs: 0, months: [october()] };

  it("shows the month's cost and says how much was priced at the other-hours price", async () => {
    vi.mocked(fetchMonthlyEnergy).mockResolvedValue(data);
    const { container } = render(<MonthlyEnergy nameOf={(id) => id} price={0.2} hourPrice={peakMornings} currency="$" />);
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("$1.80");
    expect(text).toContain("$1.30");
    expect(text).toContain("1.00 kWh was recorded before hourly records began, so it is estimated at the other-hours price ($0.2/kWh).");
  });

  it("asks for the other-hours price instead of guessing", async () => {
    vi.mocked(fetchMonthlyEnergy).mockResolvedValue(data);
    const { container } = render(<MonthlyEnergy nameOf={(id) => id} price={null} hourPrice={peakMornings} currency="$" />);
    await flush();
    expect(container.textContent).toContain("set the price for other hours in Settings to cost it");
    expect(container.textContent).toContain("$0.50");
  });

  it("draws the cost of each month on the year chart", async () => {
    vi.mocked(fetchMonthlyEnergy).mockResolvedValue(data);
    const { container } = render(<MonthlyEnergy nameOf={(id) => id} price={0.2} hourPrice={peakMornings} currency="$" />);
    await flush();
    act(() => [...container.querySelectorAll("button")].find((b) => b.textContent === "Year")!.click());
    expect(container.textContent).toContain("3.50 kWh in 2026");
    expect(container.textContent).toContain("$1.80");
    expect(container.textContent).toContain("Cost ($, right axis)");
    expect(container.querySelector('svg[aria-label="Energy in kWh per month, 2026"] circle')).not.toBeNull();
  });
});