export type EnergyPeriodDays = "all" | "weekdays" | "weekends";

/** Whole local hours [from, to) at one price; from > to wraps past midnight. */
export interface EnergyPricePeriod {
  from: number;
  to: number;
  price: number;
  days: EnergyPeriodDays;
}

export interface EnergyTariff {
  mode: "flat" | "tou";
  /** Flat price, or the price of hours no period covers. */
  base: number | null;
  periods: readonly EnergyPricePeriod[];
}

export type EnergyPeriodsError = { code: "too-many" } | { code: "invalid"; index: number } | { code: "overlap"; index: number; other: number };

export const ENERGY_PRICE_MAX: number;
export const ENERGY_PERIODS_MAX: number;
export const ENERGY_PERIOD_DAYS: readonly EnergyPeriodDays[];
export function energyPriceValue(value: unknown): number | null;
export function periodHours(period: { from: number; to: number }): number[];
export function periodCoversDay(days: EnergyPeriodDays, weekday: number): boolean;
export function energyPeriodsError(periods: unknown): EnergyPeriodsError | null;
export function normalizeEnergyPeriods(periods: unknown): EnergyPricePeriod[];
export function tariffPriceAt(tariff: EnergyTariff, hour: number, weekday: number): number | null;