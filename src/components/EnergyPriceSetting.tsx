import { useTranslation } from "react-i18next";
import type { Settings } from "../api/types";
import { ENERGY_PERIODS_MAX, energyPeriodsError, type EnergyPeriodDays, type EnergyPricePeriod } from "../shared/energyTariff";
import { SettingRow } from "./SettingRows";

const DAY_CHOICES: EnergyPeriodDays[] = ["all", "weekdays", "weekends"];
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;
const FROM_HOURS = Array.from({ length: 24 }, (_, h) => h);
const TO_HOURS = Array.from({ length: 24 }, (_, h) => h + 1);

/** Why the time-of-use periods cannot be saved, in the reader's language; null when they can (or flat pricing is on). */
export function energyPeriodsMessage(settings: Settings, t: (key: string, opts?: Record<string, unknown>) => string): string | null {
  if (settings.energyPriceMode !== "tou") return null;
  const err = energyPeriodsError(settings.energyPricePeriods ?? []);
  if (!err) return null;
  if (err.code === "overlap") return t("electricityPrice.errorOverlap", { period: err.index + 1, other: err.other + 1 });
  if (err.code === "too-many") return t("electricityPrice.errorTooMany", { max: ENERGY_PERIODS_MAX });
  return t("electricityPrice.errorInvalid", { period: err.index + 1 });
}

/**
 * Electricity price: one flat price per kWh, or time of use, where hour ranges
 * (optionally weekdays or weekends only) have their own price and every other
 * hour costs the base price.
 */
export function EnergyPriceSetting({ settings, update }: { settings: Settings; update: (patch: Partial<Settings>) => void }) {
  const { t } = useTranslation("settings");
  const tou = settings.energyPriceMode === "tou";
  const periods = settings.energyPricePeriods ?? [];
  const setPeriod = (i: number, patch: Partial<EnergyPricePeriod>) =>
    update({ energyPricePeriods: periods.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const message = energyPeriodsMessage(settings, t);

  return (
    <SettingRow title={t("electricityPrice.title")} help={tou ? t("electricityPrice.touHelp") : t("electricityPrice.help")} htmlFor="settings-energy-price" stack>
      <div className="set-tariff">
        <div className="seg" role="radiogroup" aria-label={t("electricityPrice.mode")}>
          {(["flat", "tou"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={(settings.energyPriceMode ?? "flat") === mode}
              className={(settings.energyPriceMode ?? "flat") === mode ? "is-on" : ""}
              onClick={() => update({ energyPriceMode: mode })}
            >
              {mode === "flat" ? t("electricityPrice.modeFlat") : t("electricityPrice.modeTou")}
            </button>
          ))}
        </div>
        <div className="set-price">
          <input
            id="settings-energy-currency"
            type="text"
            aria-label={t("electricityPrice.currency")}
            maxLength={4}
            value={settings.energyCurrency ?? "$"}
            onChange={(e) => update({ energyCurrency: e.target.value })}
            className="field-input field-input--currency"
          />
          <input
            id="settings-energy-price"
            type="number"
            min={0}
            max={100}
            step="0.01"
            inputMode="decimal"
            placeholder="0.15"
            aria-label={tou ? t("electricityPrice.otherHours") : t("electricityPrice.perKwh")}
            value={settings.energyPricePerKwh ?? ""}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") return update({ energyPricePerKwh: null });
              const val = parseFloat(raw);
              if (!isNaN(val)) update({ energyPricePerKwh: val });
            }}
            className="field-input field-input--price"
          />
          <span className="set-tariff__unit">{tou ? t("electricityPrice.otherHours") : t("electricityPrice.perKwh")}</span>
        </div>
        {tou ? (
          <>
            {periods.map((p, i) => (
              <div key={i} className="set-tariff__period" data-period={i}>
                <select aria-label={t("electricityPrice.from", { period: i + 1 })} value={p.from} onChange={(e) => setPeriod(i, { from: Number(e.target.value) })}>
                  {FROM_HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
                </select>
                <span aria-hidden="true">–</span>
                <select aria-label={t("electricityPrice.to", { period: i + 1 })} value={p.to} onChange={(e) => setPeriod(i, { to: Number(e.target.value) })}>
                  {TO_HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
                </select>
                <select aria-label={t("electricityPrice.days", { period: i + 1 })} value={p.days} onChange={(e) => setPeriod(i, { days: e.target.value as EnergyPeriodDays })}>
                  {DAY_CHOICES.map((d) => <option key={d} value={d}>{d === "weekdays" ? t("electricityPrice.daysWeekdays") : d === "weekends" ? t("electricityPrice.daysWeekends") : t("electricityPrice.daysAll")}</option>)}
                </select>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  inputMode="decimal"
                  aria-label={t("electricityPrice.periodPrice", { period: i + 1 })}
                  value={Number.isFinite(p.price) ? p.price : ""}
                  onChange={(e) => setPeriod(i, { price: e.target.value === "" ? NaN : parseFloat(e.target.value) })}
                  className="field-input field-input--price"
                />
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-label={t("electricityPrice.remove", { period: i + 1 })}
                  onClick={() => update({ energyPricePeriods: periods.filter((_, j) => j !== i) })}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn btn--ghost btn--sm set-tariff__add"
              disabled={periods.length >= ENERGY_PERIODS_MAX}
              onClick={() => update({ energyPricePeriods: [...periods, { from: 14, to: 19, price: settings.energyPricePerKwh ?? 0, days: "all" }] })}
            >
              {t("electricityPrice.add")}
            </button>
            {message ? <p className="field-hint is-warn" role="alert">{message}</p> : null}
          </>
        ) : null}
      </div>
    </SettingRow>
  );
}