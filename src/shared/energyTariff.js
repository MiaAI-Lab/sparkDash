/**
 * Electricity tariff for the Fleet energy cost: one flat price per kWh, or
 * time-of-use periods on top of a base rate. Shared by the settings store
 * (validation on save) and the Fleet energy page (price of each hour).
 *
 * A period covers whole local hours [from, to) on every day, on weekdays
 * (Mon-Fri) or on weekends. `from > to` wraps past midnight (22 -> 6 covers
 * 22:00-06:00). Periods may not overlap, so every hour has exactly one price;
 * an hour no period covers uses the base rate (`energyPricePerKwh`).
 */

export const ENERGY_PRICE_MAX = 100;
export const ENERGY_PERIODS_MAX = 12;
export const ENERGY_PERIOD_DAYS = Object.freeze(["all", "weekdays", "weekends"]);

/** A price per kWh in range, otherwise null. */
export function energyPriceValue(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= ENERGY_PRICE_MAX ? n : null;
}

function hourValue(value, min, max) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** The local hours (0-23) a period covers, in order. */
export function periodHours(period) {
  const out = [];
  const end = period.to % 24;
  let h = period.from;
  do {
    out.push(h);
    h = (h + 1) % 24;
  } while (h !== end && out.length < 24);
  return out;
}

/** Whether a period's day choice includes this weekday (0 = Sunday). */
export function periodCoversDay(days, weekday) {
  if (days === "weekdays") return weekday >= 1 && weekday <= 5;
  if (days === "weekends") return weekday === 0 || weekday === 6;
  return true;
}

const daysOverlap = (a, b) => a === "all" || b === "all" || a === b;

/**
 * Why a list of periods cannot be saved, or null when it can:
 * `{ code: "too-many" }`, `{ code: "invalid", index }` (a bad hour, price or day
 * choice, or from = to), or `{ code: "overlap", index, other }` (two periods share an hour).
 */
export function energyPeriodsError(periods) {
  if (!Array.isArray(periods)) return { code: "invalid", index: -1 };
  if (periods.length > ENERGY_PERIODS_MAX) return { code: "too-many" };
  const hours = [];
  for (let i = 0; i < periods.length; i++) {
    const p = periods[i];
    const from = hourValue(p?.from, 0, 23);
    const to = hourValue(p?.to, 1, 24);
    if (from == null || to == null || (from === to % 24 && to !== 24) || energyPriceValue(p?.price) == null || !ENERGY_PERIOD_DAYS.includes(p?.days)) {
      return { code: "invalid", index: i };
    }
    hours.push(new Set(periodHours({ from, to })));
    for (let j = 0; j < i; j++) {
      if (!daysOverlap(p.days, periods[j].days)) continue;
      for (const h of hours[i]) {
        if (hours[j].has(h)) return { code: "overlap", index: i, other: j };
      }
    }
  }
  return null;
}

/** A saved period list as numbers, or [] when it is not usable (a hand-edited settings.json). */
export function normalizeEnergyPeriods(periods) {
  if (energyPeriodsError(periods)) return [];
  return periods.map((p) => ({ from: Number(p.from), to: Number(p.to), price: Number(p.price), days: p.days }));
}

/**
 * Price per kWh for one local hour, or null when that hour has none.
 * @param {{ mode: "flat" | "tou", base: number | null, periods: readonly { from: number, to: number, price: number, days: string }[] }} tariff
 * @param {number} hour local hour 0-23
 * @param {number} weekday local weekday, 0 = Sunday
 */
export function tariffPriceAt(tariff, hour, weekday) {
  if (tariff.mode === "tou") {
    for (const p of tariff.periods) {
      if (periodCoversDay(p.days, weekday) && periodHours(p).includes(hour)) return p.price;
    }
  }
  return tariff.base;
}