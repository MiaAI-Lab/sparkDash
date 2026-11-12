import { describe, expect, it } from "vitest";
import { energyPeriodsError, periodHours, tariffPriceAt, type EnergyTariff } from "./energyTariff";

const tou: EnergyTariff = {
  mode: "tou",
  base: 0.2,
  periods: [
    { from: 14, to: 19, price: 0.42, days: "weekdays" },
    { from: 22, to: 6, price: 0.11, days: "all" },
  ],
};

describe("energy tariff", () => {
  it("covers [from, to) and wraps past midnight", () => {
    expect(periodHours({ from: 14, to: 19 })).toEqual([14, 15, 16, 17, 18]);
    expect(periodHours({ from: 22, to: 6 })).toEqual([22, 23, 0, 1, 2, 3, 4, 5]);
    expect(periodHours({ from: 0, to: 24 })).toHaveLength(24);
  });

  it("prices each hour by its period, and other hours at the base rate", () => {
    expect(tariffPriceAt(tou, 15, 3)).toBe(0.42); // Wednesday peak
    expect(tariffPriceAt(tou, 15, 6)).toBe(0.2); // Saturday: weekday peak does not apply
    expect(tariffPriceAt(tou, 23, 6)).toBe(0.11);
    expect(tariffPriceAt(tou, 3, 1)).toBe(0.11);
    expect(tariffPriceAt(tou, 19, 3)).toBe(0.2); // the end hour is not part of the period
    expect(tariffPriceAt({ ...tou, base: null }, 10, 3)).toBeNull();
  });

  it("flat mode ignores the periods", () => {
    expect(tariffPriceAt({ ...tou, mode: "flat" }, 15, 3)).toBe(0.2);
  });

  it("finds overlaps only between periods that share a day", () => {
    expect(energyPeriodsError(tou.periods)).toBeNull();
    expect(energyPeriodsError([...tou.periods, { from: 5, to: 7, price: 0.3, days: "weekends" }])).toEqual({ code: "overlap", index: 2, other: 1 });
    expect(energyPeriodsError([{ from: 9, to: 9, price: 0.3, days: "all" }])).toEqual({ code: "invalid", index: 0 });
  });
});