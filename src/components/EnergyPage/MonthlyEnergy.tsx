import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchMonthlyEnergy } from "../../api/client";
import type { MonthlyEnergy as MonthlyEnergyData, MonthlyEnergyMonth } from "../../api/types";
import { StackedBarChart, type BarLine, type BarSeries } from "../ui/StackedBarChart";
import { Tag } from "../ui/Tag";
import { SettingsLink } from "../ui/SettingsLink";
import { formatKwh, formatMoney, type HourPrice } from "./energyStats";
import { wallMonth } from "./wallStats";
import {
  fleetCoverage,
  monthCost,
  type MonthPricing,
  monthLabel,
  monthNodeRows,
  monthOptions,
  nodeColors,
  type YearBar,
  yearBars,
  yearOptions,
  yearTotalKwh,
} from "./monthlyStats";

const REFRESH_MS = 5 * 60_000;
const pct = (v: number) => `${(v * 100).toFixed(v >= 0.995 ? 0 : 1)}%`;

interface ViewProps {
  nameOf: (id: string) => string;
  colorOf: (id: string) => string;
  pricing: MonthPricing;
  currency: string;
}

/** Permanent monthly totals: pick a month for per-node figures, or a year for twelve bars. */
export function MonthlyEnergy({
  nameOf,
  price,
  hourPrice = null,
  currency,
  reloadToken = 0,
}: {
  nameOf: (id: string) => string;
  /** Flat price per kWh; under time of use, the price for other hours. */
  price: number | null;
  /** Time of use: each recorded hour is priced at its own rate. */
  hourPrice?: HourPrice | null;
  currency: string;
  /** Change this value (e.g. after a Reset) to refetch immediately. */
  reloadToken?: number;
}) {
  const { t, i18n } = useTranslation("statistics");
  const pricing = useMemo<MonthPricing>(() => ({ flat: price, hourPrice }), [price, hourPrice]);
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
  // A month with wall power (measured, gaps filled) is shown at the wall; others stay estimated.
  const months = useMemo(() => (data?.months ?? []).map((m) => wallMonth(m) ?? m), [data]);
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
          <h2 id="en-h-monthly">{t("energy.monthly.title")}</h2>
          <p className="en-panel__sub">
            {t("energy.monthly.subtitle")}
          </p>
        </div>
        {data && months.length > 0 ? (
          <div className="en-monthly__tools">
            <div className="seg" role="group" aria-label={t("energy.monthly.viewAria")}>
              <button type="button" aria-pressed={view === "month"} className={view === "month" ? "is-on" : ""} onClick={() => setView("month")}>{t("energy.monthly.month")}</button>
              <button type="button" aria-pressed={view === "year"} className={view === "year" ? "is-on" : ""} onClick={() => setView("year")}>{t("energy.monthly.year")}</button>
            </div>
            {view === "month" ? (
              <select className="en-select" aria-label={t("energy.monthly.month")} value={activeMonth} onChange={(e) => setMonth(e.target.value)}>
                {monthKeys.map((key) => <option key={key} value={key}>{monthLabel(key, i18n.language)}</option>)}
              </select>
            ) : (
              <select className="en-select" aria-label={t("energy.monthly.year")} value={activeYear} onChange={(e) => setYear(Number(e.target.value))}>
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            )}
          </div>
        ) : null}
      </header>

      {error && !data ? (
        <p className="en-panel__sub" role="alert">{t("energy.monthly.loadError", { error })}</p>
      ) : !data ? (
        <p className="en-panel__sub" role="status">{t("energy.monthly.loading")}</p>
      ) : months.length === 0 ? (
        <p className="en-panel__sub" role="status">
          {t("energy.monthly.empty")}
        </p>
      ) : view === "month" ? (
        <MonthView
          month={months.find((m) => m.month === activeMonth) ?? null}
          label={monthLabel(activeMonth, i18n.language)}
          now={now}
          nameOf={nameOf}
          colorOf={colorOf}
          pricing={pricing}
          currency={currency}
        />
      ) : (
        <YearView months={months} year={activeYear} nameOf={nameOf} colorOf={colorOf} pricing={pricing} currency={currency} />
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
  pricing,
  currency,
}: ViewProps & { month: MonthlyEnergyMonth | null; label: string; now: number }) {
  const metered = month?.totalWallWh != null;
  const { t } = useTranslation("statistics");
  if (!month || month.totalWh <= 0) {
    return <p className="en-panel__sub" role="status">{t("energy.monthly.none", { label })}</p>;
  }
  const rows = monthNodeRows(month, now, pricing);
  const kwh = month.totalWh / 1000;
  const { cost, unbinnedKwh } = monthCost(month, pricing);
  const tou = pricing.hourPrice != null;
  const eff = month.whPerOutputToken != null ? month.whPerOutputToken * 1000 : null;
  return (
    <>
      <div className="en-monthly__stats" role="group" aria-label={t("energy.monthly.summaryAria", { label })}>
        <div><span className="eyebrow">{t("energy.energy")}</span><b className="mono">{formatKwh(kwh)} {t("energy.kwh")}</b></div>
        <div><span className="eyebrow">{t("energy.cost")}</span><b className="mono">{cost != null ? formatMoney(cost, currency) : "—"}</b></div>
        <div>
          <span className="eyebrow">{t("energy.efficiency")}</span>
          <b className="mono">{eff != null ? t("energy.efficiencyValue", { value: eff < 10 ? eff.toFixed(2) : eff.toFixed(1) }) : "—"}</b>
        </div>
        <div><span className="eyebrow">{t("energy.fleetCoverage")}</span><b className="mono">{pct(fleetCoverage(month, now))}</b></div>
        <div>
          <span className="eyebrow">{t("energy.status")}</span>
          <Tag tone={month.closed ? "good" : "warn"}>{month.closed ? t("energy.monthly.closed") : t("energy.monthly.open")}</Tag>
        </div>
      </div>
      <div className="en-table-wrap">
        <table className="en-table">
          <caption className="sr-only">{t("energy.monthly.tableCaption", { label })}</caption>
          <thead>
            <tr>
              <th scope="col" className="is-left">{t("energy.spark")}</th>
              <th scope="col">{t("energy.energy")}</th>
              <th scope="col">{t("energy.share")}</th>
              <th scope="col">{t("energy.coverage")}</th>
              <th scope="col">{t("energy.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => (
              <tr key={n.id}>
                <th scope="row" className="en-table__name">
                  <i className="en-swatch" style={{ background: colorOf(n.id) }} aria-hidden="true" />
                  {nameOf(n.id)}
                </th>
                <td className="mono">{formatKwh(n.kwh)} {t("energy.kwh")}</td>
                <td className="mono">{pct(n.share)}</td>
                <td className="mono">{pct(n.coverage)}</td>
                <td className="mono">{n.cost != null ? formatMoney(n.cost, currency) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="en-panel__sub en-panel__foot">
        {t("energy.monthly.tableCaption", { label })}. {t("energy.monthly.coverageNote")}{!month.closed ? t("energy.monthly.soFar") : ""}.{" "}
        {metered
          ? (month.totalWallFilledWh ?? 0) > 0
            ? t("energy.monthly.meteredFilled", { percent: pct((month.totalWallFilledWh ?? 0) / month.totalWh) })
            : t("energy.monthly.metered")
          : t("energy.monthly.estimated")}
        {tou && cost != null && unbinnedKwh > 0 ? (
          <> {t("energy.monthly.unbinned", { kwh: formatKwh(unbinnedKwh), price: `${currency}${pricing.flat}` })}</>
        ) : null}
        {tou && cost == null ? <> <SettingsLink section="energy">{unbinnedKwh > 0 ? t("energy.monthly.unbinnedNoPrice", { kwh: formatKwh(unbinnedKwh) }) : t("energy.setBasePrice")}</SettingsLink></> : null}
      </p>
    </>
  );
}

function YearView({
  months,
  year,
  nameOf,
  colorOf,
  pricing,
  currency,
}: ViewProps & { months: MonthlyEnergyMonth[]; year: number }) {
  const { t, i18n } = useTranslation("statistics");
  const bars = yearBars(months, year, i18n.language);
  const ids = [...new Set(bars.flatMap((b) => Object.keys(b.values)))];
  const series: BarSeries[] = ids.map((id) => ({ id, label: nameOf(id), color: colorOf(id) }));
  const total = yearTotalKwh(months, year);
  const byKey = new Map(months.map((m) => [m.month, m]));
  const costs = bars.map((b) => {
    const m = byKey.get(b.month);
    return m && b.hasData ? monthCost(m, pricing) : null;
  });
  const priced = pricing.flat != null || pricing.hourPrice != null;
  const withData = costs.filter((c) => c != null);
  const yearCost = priced && withData.length > 0 && withData.every((c) => c.cost != null) ? withData.reduce((s, c) => s + c.cost!, 0) : null;
  const unbinned = withData.reduce((s, c) => s + c.unbinnedKwh, 0);
  const tou = pricing.hourPrice != null;
  const costLine: BarLine | undefined = priced
    ? {
        label: t("energy.costLine"),
        color: "var(--color-warning)",
        values: costs.map((c) => c?.cost ?? null),
        format: (v) => formatMoney(v, currency),
        detail: (i) => {
          const c = costs[i]?.cost;
          const kwh = bars[i]?.kwh ?? 0;
          if (c == null || !(kwh > 0)) return null;
          const p = c / kwh;
          return t("energy.priceAverage", { price: `${currency}${p.toFixed(p < 1 ? 3 : 2)}` });
        },
      }
    : undefined;
  return (
    <>
      <p className="en-monthly__year">
        {t("energy.monthly.yearTotal", { total: formatKwh(total), year })}
        {yearCost != null && total > 0 ? <span> · {formatMoney(yearCost, currency)}</span> : null}
      </p>
      <div className="legend" aria-label={t("energy.monthly.nodes")}>
        {series.map((s) => (
          <span key={s.id} style={{ "--c": s.color } as React.CSSProperties}>{s.label}</span>
        ))}
        {costLine ? <span style={{ "--c": costLine.color } as React.CSSProperties}>{t("energy.costLineLegend", { currency })}</span> : null}
      </div>
      <StackedBarChart
        buckets={bars}
        series={series}
        height={220}
        format={formatKwh}
        unit="kWh"
        line={costLine}
        footer={(bucket) => {
          // The year aggregate above is the only money in this view; give each month its own.
          const bar = bucket as YearBar;
          const c = costs[bars.indexOf(bar)]?.cost ?? null;
          return c != null && bar.kwh > 0 ? `≈ ${formatMoney(c, currency)}` : null;
        }}
        empty={t("energy.monthly.yearEmpty", { year })}
        ariaLabel={t("energy.monthly.yearChartAria", { year })}
      />
      {tou && unbinned > 0 ? (
        <p className="en-panel__sub en-panel__foot">
          {yearCost != null
            ? t("energy.monthly.unbinned", { kwh: formatKwh(unbinned), price: `${currency}${pricing.flat}` })
            : <SettingsLink section="energy">{t("energy.monthly.unbinnedNoPrice", { kwh: formatKwh(unbinned) })}</SettingsLink>}
        </p>
      ) : null}
    </>
  );
}
