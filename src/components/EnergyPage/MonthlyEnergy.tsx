import { localizedServerText } from "../../i18n/messages";
import { useTranslation } from "react-i18next";
import { i18next } from "../../i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchMonthlyEnergy } from "../../api/client";
import type { MonthlyEnergy as MonthlyEnergyData, MonthlyEnergyMonth } from "../../api/types";
import { StackedBarChart, type BarSeries } from "../ui/StackedBarChart";
import { Tag } from "../ui/Tag";
import { formatKwh, formatMoney } from "./energyStats";
import {
  fleetCoverage,
  monthLabel,
  monthNodeRows,
  monthOptions,
  nodeColors,
  yearBars,
  yearOptions,
  yearTotalKwh,
} from "./monthlyStats";

const t = i18next.t.bind(i18next);

const REFRESH_MS = 5 * 60_000;
const pct = (v: number) => `${(v * 100).toFixed(v >= 0.995 ? 0 : 1)}%`;

interface ViewProps {
  nameOf: (id: string) => string;
  colorOf: (id: string) => string;
  price: number | null;
  currency: string;
}

/** Permanent monthly totals: pick a month for per-node figures, or a year for twelve bars. */
export function MonthlyEnergy({
  nameOf,
  price,
  currency,
  reloadToken = 0,
}: {
  nameOf: (id: string) => string;
  price: number | null;
  currency: string;
  /** Change this value (e.g. after a Reset) to refetch immediately. */
  reloadToken?: number;
}) {
  useTranslation();
  const [data, setData] = useState<MonthlyEnergyData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"month" | "year">("month");
  const [month, setMonth] = useState<string | null>(null);
  const [year, setYear] = useState<number | null>(null);

  const load = useCallback(
    () =>
      fetchMonthlyEnergy()
        .then((next) => {
          setData(next);
          setError(null);
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err))),
    []
  );
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);
  const lastToken = useRef(reloadToken);
  useEffect(() => {
    if (lastToken.current === reloadToken) return;
    lastToken.current = reloadToken;
    void load();
  }, [reloadToken, load]);

  const now = data?.generatedAt ?? 0;
  const months = useMemo(() => data?.months ?? [], [data]);
  const monthKeys = useMemo(() => monthOptions(months, now), [months, now]);
  const years = useMemo(() => yearOptions(months, now), [months, now]);
  const colorOf = useMemo(() => nodeColors(months), [months]);

  // Default to the newest month with data (or the current one), and this year.
  const activeMonth = month && monthKeys.includes(month) ? month : (months.at(-1)?.month ?? monthKeys[0]);
  const activeYear = year != null && years.includes(year) ? year : years[0];

  return (
    <section className="panel en-panel en-monthly" aria-labelledby="en-h-monthly">
      <header className="en-panel__head">
        <div>
          <h2 id="en-h-monthly">{t("energy.text.monthlyHistory", "Monthly history")}</h2>
          <p className="en-panel__sub"> {t("energy.text.totalsPerUTCMonthKeptPermanentlyTheySurviveResetsRestartsAndChangesToTheFleetMon", "Totals per UTC month, kept permanently. They survive resets, restarts and changes to the fleet. Months are UTC, so they will not match a local-time electricity bill.")} </p>
        </div>
        {data && months.length > 0 ? (
          <div className="en-monthly__tools">
            <div className="seg" role="group" aria-label={t("energy.text.monthlyView", "Monthly view")}>
              <button type="button" aria-pressed={view === "month"} className={view === "month" ? "is-on" : ""} onClick={() => setView("month")}>{t("energy.text.month", "Month")}</button>
              <button type="button" aria-pressed={view === "year"} className={view === "year" ? "is-on" : ""} onClick={() => setView("year")}>{t("energy.text.year", "Year")}</button>
            </div>
            {view === "month" ? (
              <select className="en-select" aria-label={t("energy.text.month", "Month")} value={activeMonth} onChange={(e) => setMonth(e.target.value)}>
                {monthKeys.map((key) => <option key={key} value={key}>{monthLabel(key)}</option>)}
              </select>
            ) : (
              <select className="en-select" aria-label={t("energy.text.year", "Year")} value={activeYear} onChange={(e) => setYear(Number(e.target.value))}>
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            )}
          </div>
        ) : null}
      </header>

      {error && !data ? (
        <p className="en-panel__sub" role="alert">{t("energy.text.couldNotLoadMonthlyHistory", "Could not load monthly history:")} {localizedServerText(error)}</p>
      ) : !data ? (
        <p className="en-panel__sub" role="status">{t("energy.text.loadingMonthlyHistory", "Loading monthly history…")}</p>
      ) : months.length === 0 ? (
        <p className="en-panel__sub" role="status"> {t("energy.text.nothingArchivedYetEachFinishedMinuteIsAddedToItsMonthOnceTheSparksHaveBeenReport", "Nothing archived yet. Each finished minute is added to its month once the Sparks have been reporting for a little while.")} </p>
      ) : view === "month" ? (
        <MonthView
          month={months.find((m) => m.month === activeMonth) ?? null}
          label={monthLabel(activeMonth)}
          now={now}
          nameOf={nameOf}
          colorOf={colorOf}
          price={price}
          currency={currency}
        />
      ) : (
        <YearView months={months} year={activeYear} nameOf={nameOf} colorOf={colorOf} price={price} currency={currency} />
      )}
    </section>
  );
}

function MonthView({
  month,
  label,
  now,
  nameOf,
  colorOf,
  price,
  currency,
}: ViewProps & { month: MonthlyEnergyMonth | null; label: string; now: number }) {
  useTranslation();
  if (!month || month.totalWh <= 0) {
    return <p className="en-panel__sub" role="status">{t("energy.monthly.noEnergy", "No energy was recorded in {month}.", { month: label })}</p>;
  }
  const rows = monthNodeRows(month, now, price);
  const kwh = month.totalWh / 1000;
  const cost = price != null ? kwh * price : null;
  const eff = month.whPerOutputToken != null ? month.whPerOutputToken * 1000 : null;
  return (
    <>
      <div className="en-monthly__stats" role="group" aria-label={t("energy.text.0Summary", "{value0} summary", { value0: label })}>
        <div><span className="eyebrow">{t("energy.text.energy", "Energy")}</span><b className="mono">{formatKwh(kwh)} kWh</b></div>
        <div><span className="eyebrow">{t("energy.text.cost", "Cost")}</span><b className="mono">{cost != null ? formatMoney(cost, currency) : "—"}</b></div>
        <div>
          <span className="eyebrow">{t("energy.text.efficiency", "Efficiency")}</span>
          <b className="mono">{eff != null ? `${eff < 10 ? eff.toFixed(2) : eff.toFixed(1)} Wh / 1k tok` : "—"}</b>
        </div>
        <div><span className="eyebrow">{t("energy.text.fleetCoverage", "Fleet coverage")}</span><b className="mono">{pct(fleetCoverage(month, now))}</b></div>
        <div>
          <span className="eyebrow">{t("energy.text.status", "Status")}</span>
          <Tag tone={month.closed ? "good" : "warn"}>{month.closed ? t("energy.text.closed", "Closed") : t("energy.text.openStillCounting", "Open, still counting")}</Tag>
        </div>
      </div>
      <div className="en-table-wrap">
        <table className="en-table">
          <caption className="sr-only">{t("energy.monthly.caption", "Energy by node for {month}", { month: label })}</caption>
          <thead>
            <tr>
              <th scope="col" className="is-left">Spark</th>
              <th scope="col">{t("energy.text.energy", "Energy")}</th>
              <th scope="col">{t("energy.text.share", "Share")}</th>
              <th scope="col">{t("energy.text.coverage", "Coverage")}</th>
              <th scope="col">{t("energy.text.cost", "Cost")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => (
              <tr key={n.id}>
                <th scope="row" className="en-table__name">
                  <i className="en-swatch" style={{ background: colorOf(n.id) }} aria-hidden="true" />
                  {nameOf(n.id)}
                </th>
                <td className="mono">{formatKwh(n.kwh)} kWh</td>
                <td className="mono">{pct(n.share)}</td>
                <td className="mono">{pct(n.coverage)}</td>
                <td className="mono">{n.cost != null ? formatMoney(n.cost, currency) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="en-panel__sub en-panel__foot">{month.closed ? t("energy.monthly.closedNote", "Only the Sparks that reported in {month} are listed. Coverage is the share of the month each one was measured. Estimated, not metered.", { month: label }) : t("energy.monthly.openNote", "Only the Sparks that reported in {month} are listed. Coverage is the share of the month each one was measured so far. Estimated, not metered.", { month: label })}</p>
    </>
  );
}

function YearView({
  months,
  year,
  nameOf,
  colorOf,
  price,
  currency,
}: ViewProps & { months: MonthlyEnergyMonth[]; year: number }) {
  useTranslation();
  const bars = yearBars(months, year);
  const ids = [...new Set(bars.flatMap((b) => Object.keys(b.values)))];
  const series: BarSeries[] = ids.map((id) => ({ id, label: nameOf(id), color: colorOf(id) }));
  const total = yearTotalKwh(months, year);
  return (
    <>
      <p className="en-monthly__year">
        <b className="mono">{formatKwh(total)} kWh</b> {t("energy.monthly.inYear", "in {year}", { year })}
        {price != null && total > 0 ? <span> {t("energy.text.about", "· about")} {formatMoney(total * price, currency)}</span> : null}
      </p>
      <div className="legend" aria-label={t("energy.text.nodes", "Nodes")}>
        {series.map((s) => (
          <span key={s.id} style={{ "--c": s.color } as React.CSSProperties}>{s.label}</span>
        ))}
      </div>
      <StackedBarChart
        buckets={bars}
        series={series}
        height={220}
        format={formatKwh}
        unit="kWh"
        empty={t("energy.text.noEnergyRecordedIn0", "No energy recorded in {value0}.", { value0: year })}
        ariaLabel={t("energy.text.energyInKWhPerMonth0", "Energy in kWh per month, {value0}", { value0: year })}
      />
    </>
  );
}
