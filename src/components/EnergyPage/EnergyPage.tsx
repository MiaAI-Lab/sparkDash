import { localizedServerText } from "../../i18n/messages";
import { i18next } from "../../i18n";
import { RestartButton } from "../ui/RestartButton";
import { activeTimeZone } from "../../shared/timeZone";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { clearFleetEnergy, fetchEnergyHistory, fetchFleetEnergy } from "../../api/client";
import { ClearMenu } from "../ui/ClearMenu";
import type { EnergyHistory, FleetEnergy, Settings, SparkSnapshot } from "../../api/types";
import { StackedBarChart, type BarBucket, type BarSeries } from "../ui/StackedBarChart";
import { LineAreaChart, type LinePoint } from "../ui/LineAreaChart";
import { Tag } from "../ui/Tag";
import { MonthlyEnergy } from "./MonthlyEnergy";
import {
  NODE_COLORS,
  RANGE_DAYS,
  browserTzOffset,
  buildBuckets,
  buildInsights,
  floorHour,
  formatKwh,
  formatLocalHour,
  formatMoney,
  formatShortDay,
  formatWatts,
  previousPeriodDelta,
  rangeWindow,
  rowsInRange,
  sortNodes,
  summarize,
  toCsv,
  type EnergyBucket,
  type EnergyRange,
  type EnergySummary,
  type NodeSortKey,
  type PeriodDelta,
  type RangeWindow,
} from "./energyStats";
import "../../styles/energy.css";

const t = i18next.t.bind(i18next);

const DAY_MS = 86_400_000;
const energyClearChoices = () => [
  { id: "7d", label: t("energy.clear.7d", "Older than 7 days"), ask: t("energy.clear.7dAsk", "Delete energy history older than 7 days?"), arg: 7 * DAY_MS },
  { id: "24h", label: t("energy.clear.24h", "Older than 24 hours"), ask: t("energy.clear.24hAsk", "Delete energy history older than 24 hours?"), arg: DAY_MS },
  { id: "all", label: t("energy.clear.all", "Everything"), ask: t("energy.clear.allAsk", "Delete all recorded energy history?"), arg: undefined },
] as const;

const HISTORY_POLL_MS = 60_000;
const LIVE_POLL_MS = 15_000;

const RANGES: Array<{ id: EnergyRange }> = [{ id: "24h" }, { id: "7d" }, { id: "14d" }, { id: "31d" }];

const pct = (v: number, digits = 0) => `${(v * 100).toFixed(digits)}%`;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Repeating timer that pauses while the tab is hidden and catches up when it returns. */
function useVisiblePoll(load: () => Promise<void>, everyMs: number) {
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let last = 0;
    const run = () => {
      last = Date.now();
      void loadRef.current();
    };
    run();
    const timer = window.setInterval(() => {
      if (!document.hidden) run();
    }, everyMs);
    const onVisible = () => {
      if (!document.hidden && Date.now() - last >= everyMs) run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [everyMs]);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.className = "en-offscreen";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function EnergyPage({
  sparks,
  settings,
  onSelectSpark,
}: {
  sparks: SparkSnapshot[];
  settings: Settings | null;
  onSelectSpark?: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [history, setHistory] = useState<EnergyHistory | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [live, setLive] = useState<FleetEnergy | null>(null);
  const [range, setRange] = useState<EnergyRange>("24h");
  const [monthlyReload, setMonthlyReload] = useState(0);
  const [sort, setSort] = useState<{ key: NodeSortKey; dir: "asc" | "desc" }>({ key: "kwh", dir: "desc" });
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");

  const loadHistory = useCallback(
    () =>
      fetchEnergyHistory()
        .then((next) => {
          setHistory(next);
          setHistoryError(null);
        })
        .catch((err) => setHistoryError(errMsg(err))),
    []
  );
  const loadLive = useCallback(
    () =>
      fetchFleetEnergy()
        .then(setLive)
        .catch(() => undefined),
    []
  );
  useVisiblePoll(loadHistory, HISTORY_POLL_MS);
  useVisiblePoll(loadLive, LIVE_POLL_MS);

  const price = settings?.energyPricePerKwh ?? null;
  const currency = settings?.energyCurrency || "$";
  const names = useMemo(() => new Map(sparks.map((s) => [s.id, s.name])), [sparks]);
  const nameOf = useCallback((id: string) => names.get(id) || id, [names]);
  const tz = browserTzOffset;

  const model = useMemo(() => {
    if (!history || history.membershipChanged) return null;
    const rows = history.hourly;
    const win = rangeWindow(range, history.generatedAt, rows);
    const inRange = rowsInRange(rows, win.startMs, win.endHourMs);
    const nodeIds = history.nodeIds;
    const summary = summarize(rows, win, nodeIds, price);
    const mode: "hour" | "day" = range === "24h" ? "hour" : "day";
    const buckets = buildBuckets(rows, win, mode, tz);
    const hourly = buildBuckets(rows, win, "hour", tz);
    const powerBuckets = range === "24h" ? hourly : hourly.filter((b) => b.startMs >= floorHour(win.windowStartMs));
    const delta = previousPeriodDelta(rows, win, summary.kwh);
    const insights = buildInsights({ summary, buckets, rows: inRange, mode, tz, price, currency, nodeName: nameOf });
    return { rows, inRange, win, summary, mode, buckets, powerBuckets, delta, insights, nodeIds };
  }, [history, range, price, currency, nameOf, tz, i18n.language]);

  const colorOf = useMemo(() => {
    const map = new Map<string, string>();
    (model?.summary.nodes ?? []).forEach((n, i) => map.set(n.id, NODE_COLORS[i % NODE_COLORS.length]));
    return (id: string) => map.get(id) ?? NODE_COLORS[NODE_COLORS.length - 1];
  }, [model]);

    const rangeLong = range === "24h" ? t("energy.range.hours24", "24 hours") : t("energy.range.days", "{count} days", { count: RANGE_DAYS[range] });

  const copyCsv = async () => {
    if (!model) return;
    const ok = await copyText(toCsv(model.inRange, model.nodeIds, nameOf));
    setCopied(ok ? "ok" : "fail");
    window.setTimeout(() => setCopied("idle"), 2000);
  };

  const body = (() => {
    if (historyError && !history) {
      return (
        <section className="panel en-state" role="alert">
          <h2>{t("energy.state.loadFailed", "Could not load energy history")}</h2>
          <p>{localizedServerText(historyError)}</p>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void loadHistory()}>{t("energy.actions.retry", "Retry")}</button>
        </section>
      );
    }
    if (!history) {
      return (
        <section className="panel en-state" role="status" aria-live="polite">
          <h2>{t("energy.state.loading", "Loading energy history…")}</h2>
        </section>
      );
    }
    if (history.membershipChanged) {
      return (
        <section className="panel en-state" role="status">
          <h2>{t("energy.text.fleetMembershipChanged", "Fleet membership changed")}</h2>
          <p> {t("energy.text.sparksWereAddedOrRemovedSinceEnergyAccountingStartedSoTotalsWouldNoLongerBeCompa", "Sparks were added or removed since energy accounting started, so totals would no longer be comparable. Restart sparkDash to start a new accounting scope. Previous hourly history is withheld until then.")} </p>
          <RestartButton />
        </section>
      );
    }
    if (!model || history.hourly.length === 0) {
      return (
        <section className="panel en-state" role="status">
          <h2>{t("energy.text.warmingUp", "Warming up")}</h2>
          <p>{t("energy.text.noCompleteEnergyIntervalHasBeenRecordedYetDataAppearsHereOnceEveryNodeHasReporte", "No complete energy interval has been recorded yet. Data appears here once every node has reported fresh power telemetry for a little while.")}</p>
        </section>
      );
    }
    return (
      <EnergyBody
        model={model}
        live={live}
        nodeTotal={sparks.length || history.nodeIds.length}
        rangeLabel={rangeLong}
        price={price}
        currency={currency}
        nameOf={nameOf}
        colorOf={colorOf}
        sort={sort}
        setSort={setSort}
        onSelectSpark={onSelectSpark}
        stale={Boolean(historyError)}
      />
    );
  })();

  return (
    <div className="en">
      <div className="page-head">
        <div>
          <h1>{t("energy.title", "Fleet energy")}</h1>
          <p className="page-head__sub">
            {t("energy.subtitle", "Estimated electricity use of your Sparks from GPU and CPU power telemetry. Not wall-metered.")}
            {history ? <span className="mono en-updated"> {t("energy.updated", "Updated {time}", { time: new Date(history.generatedAt).toLocaleTimeString(i18n.language === "zh-Hans" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit", timeZone: activeTimeZone() }) })}</span> : null}
          </p>
        </div>
        <div className="page-head__tools">
          <div className="seg" role="group" aria-label={t("energy.range.aria", "Time range")}>
            {RANGES.map((r) => (
              <button key={r.id} type="button" aria-pressed={range === r.id} className={range === r.id ? "is-on" : ""} onClick={() => setRange(r.id)}>
                {r.id === "24h" ? t("energy.range.last24", "Last 24 h") : t("energy.range.shortDays", "{count} d", { count: RANGE_DAYS[r.id] })}
              </button>
            ))}
          </div>
          <ClearMenu
            label={t("energy.actions.reset", "Reset…")}
            choices={energyClearChoices()}
            note={t("energy.actions.resetNote", "Power keeps being recorded from now on, and Monthly history is kept. This can't be undone.")}
            onRun={async (ms) => {
              const { removed } = await clearFleetEnergy(ms);
              await Promise.all([loadHistory(), loadLive()]);
              setMonthlyReload((n) => n + 1);
              return removed;
            }}
          />
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void copyCsv()} disabled={!model || model.inRange.length === 0}>
            {copied === "ok" ? t("energy.actions.copied", "Copied") : copied === "fail" ? t("energy.actions.copyFailed", "Copy failed") : t("energy.actions.copyCsv", "Copy CSV")}
          </button>
          <span className="sr-only" role="status" aria-live="polite">{copied === "ok" ? t("energy.actions.copiedStatus", "CSV copied to clipboard") : ""}</span>
        </div>
      </div>
      {body}
      <MonthlyEnergy nameOf={nameOf} price={price} currency={currency} reloadToken={monthlyReload} />
    </div>
  );
}

interface Model {
  rows: EnergyHistory["hourly"];
  inRange: EnergyHistory["hourly"];
  win: RangeWindow;
  summary: EnergySummary;
  mode: "hour" | "day";
  buckets: EnergyBucket[];
  powerBuckets: EnergyBucket[];
  delta: PeriodDelta | null;
  insights: string[];
  nodeIds: string[];
}

function EnergyBody({
  model,
  live,
  nodeTotal,
  rangeLabel,
  price,
  currency,
  nameOf,
  colorOf,
  sort,
  setSort,
  onSelectSpark,
  stale,
}: {
  model: Model;
  live: FleetEnergy | null;
  nodeTotal: number;
  rangeLabel: string;
  price: number | null;
  currency: string;
  nameOf: (id: string) => string;
  colorOf: (id: string) => string;
  sort: { key: NodeSortKey; dir: "asc" | "desc" };
  setSort: (s: { key: NodeSortKey; dir: "asc" | "desc" }) => void;
  onSelectSpark?: (id: string) => void;
  stale: boolean;
}) {
  useTranslation();
  const { summary, win, mode, buckets, powerBuckets, delta, insights } = model;
  const tz = browserTzOffset;
  const noData = !summary.hasData;
  const shortHistory = win.windowStartMs > win.startMs;
  const fresh = live?.freshNodeCount ?? null;
  const total = live?.currentNodeIds.length || nodeTotal;

  const series: BarSeries[] = summary.nodes.map((n) => ({ id: n.id, label: nameOf(n.id), color: colorOf(n.id) }));
  const barBuckets: BarBucket[] = buckets.map((b) => ({ key: b.key, label: b.label, title: b.title, values: b.nodeKwh }));
  const bucketById = new Map(buckets.map((b) => [b.key, b]));
  const unit = mode === "hour" ? t("energy.unit.hour", "hour") : t("energy.unit.day", "day");

  const powerPoints: LinePoint[] = powerBuckets.map((b) => ({
    key: b.key,
    label: win.range === "24h" ? b.label : `${formatShortDay(b.startMs, tz)}`,
    title: formatLocalHour(b.startMs, tz),
    value: b.avgWatts,
  }));
  const effBuckets = mode === "hour" ? powerBuckets : buckets;
  const effPoints: LinePoint[] = effBuckets.map((b) => ({ key: b.key, label: b.label, title: b.title, value: b.whPer1kTokens }));
  const showEff = effPoints.filter((p) => p.value != null).length >= 2;

  const sortedNodes = sortNodes(summary.nodes, sort.key, sort.dir, nameOf);
  const maxShare = Math.max(0.0001, ...summary.nodes.map((n) => n.share));

  return (
    <>
      {stale ? <p className="en-banner en-banner--warn" role="status">{t("energy.text.couldNotRefreshJustNowShowingTheLastDataReceived", "Could not refresh just now; showing the last data received.")}</p> : null}
      <p className="en-banner" role="note">
        <b>{t("energy.text.estimatedNotMetered", "Estimated, not metered.")}</b> {t("energy.text.figuresAreIntegratedFromGPUAndCPUPowerReadingsAndLeaveOutPowerSupplyLossesAndOth", "Figures are integrated from GPU and CPU power readings and leave out power-supply losses and other components, so the wall draw is somewhat higher.")} </p>

      <section className="en-tiles" aria-label={t("energy.text.summary", "Summary")}>
        <Tile label={t("energy.text.currentDraw", "Current draw")}>
          <div className="big-num mono">{live?.currentWatts30s != null ? Math.round(live.currentWatts30s) : "—"}<small>W</small></div>
          <div className="en-tile__sub">
            {fresh != null ? (
              <Tag tone={fresh === 0 ? "bad" : fresh < total ? "warn" : "good"}>{fresh}/{total} {t("energy.text.nodesFresh", "nodes fresh")}</Tag>
            ) : null}
            <span>{t("energy.text.30SAverage", "30 s average")}</span>
          </div>
        </Tile>
        <Tile label={t("energy.text.energy0", "Energy, {value0}", { value0: rangeLabel })}>
          <div className="big-num mono">{noData ? "—" : formatKwh(summary.kwh)}<small>kWh</small></div>
          <div className="en-tile__sub">
            {delta ? (
              <span className={delta.ratio > 0.02 ? "en-delta en-delta--up" : delta.ratio < -0.02 ? "en-delta en-delta--down" : "en-delta"}>
                {t("energy.summary.delta", "{change}% vs previous {period}", { change: `${delta.ratio > 0 ? "+" : ""}${Math.round(delta.ratio * 100)}`, period: rangeLabel })}
              </span>
            ) : (
              <span>{t("energy.text.noEarlierPeriodToCompareYet", "No earlier period to compare yet")}</span>
            )}
          </div>
        </Tile>
        <Tile label={t("energy.text.estimatedCost", "Estimated cost")}>
          <div className="big-num mono">{summary.cost != null && !noData ? formatMoney(summary.cost, currency) : "—"}</div>
          <div className="en-tile__sub">
            {price == null ? (
              <span>{t("energy.text.setAnElectricityPriceInSettings", "Set an electricity price in Settings")}</span>
            ) : (
              <span>{summary.costPerDay != null ? t("energy.text.0PerDay", "{value0} per day", { value0: formatMoney(summary.costPerDay, currency) }) : "—"} {t("energy.text.at", "at")} {currency}{price}/kWh</span>
            )}
          </div>
        </Tile>
        <Tile label={t("energy.text.averagePower", "Average power")}>
          <div className="big-num mono">{summary.avgWatts != null ? Math.round(summary.avgWatts) : "—"}<small>W</small></div>
          <div className="en-tile__sub"><span>{t("energy.summary.coveredHours", "Whole fleet, over {hours} h covered", { hours: summary.coveredHours >= 10 ? Math.round(summary.coveredHours) : summary.coveredHours.toFixed(1) })}</span></div>
        </Tile>
        <Tile label={t("energy.text.peakHour", "Peak hour")}>
          <div className="big-num mono">{summary.peak ? Math.round(summary.peak.watts) : "—"}<small>W</small></div>
          <div className="en-tile__sub"><span>{summary.peak ? t("energy.text.0Local", "{value0} local", { value0: formatLocalHour(summary.peak.atMs, tz) }) : t("energy.text.noFullHourYet", "No full hour yet")}</span></div>
        </Tile>
        <Tile label={t("energy.text.efficiency", "Efficiency")}>
          <div className="big-num mono">{summary.whPer1kTokens != null ? (summary.whPer1kTokens < 10 ? summary.whPer1kTokens.toFixed(2) : summary.whPer1kTokens.toFixed(1)) : "—"}<small>Wh / 1k tok</small></div>
          <div className="en-tile__sub">
            <span>{summary.coveredTokens > 0 ? t("energy.text.0OutputTokens", "{value0} output tokens", { value0: compact(summary.coveredTokens) }) : t("energy.text.noTokenDataInThisRange", "No token data in this range")}</span>
          </div>
        </Tile>
        <Tile label={t("energy.text.coverage", "Coverage")}>
          <div className="big-num mono">{noData ? "—" : pct(summary.coverage, summary.coverage >= 0.995 ? 0 : 1)}</div>
          <div className="en-tile__sub">
            <Tag tone={summary.coverage >= 0.9 ? "good" : summary.coverage >= 0.5 ? "warn" : "bad"}>{summary.coverage >= 0.9 ? t("energy.text.solid", "Solid") : summary.coverage >= 0.5 ? t("energy.text.partial", "Partial") : t("energy.text.sparse", "Sparse")}</Tag>
            <span>{shortHistory ? t("energy.text.sinceHistoryBegan", "since history began") : t("energy.text.ofTheRange", "of the range")}</span>
          </div>
        </Tile>
      </section>

      {noData ? (
        <section className="panel en-state" role="status">
          <h2>{t("energy.empty.period", "No energy recorded in the last {period}", { period: rangeLabel })}</h2>
          <p>{t("energy.text.tryALongerRangeOrCheckThatTheSparksAreReportingPowerTelemetry", "Try a longer range, or check that the Sparks are reporting power telemetry.")}</p>
        </section>
      ) : (
        <>
          <section className="panel en-panel" aria-labelledby="en-h-energy">
            <header className="en-panel__head">
              <div>
                <h2 id="en-h-energy">{t("energy.chart.energyPer", "Energy per {unit}", { unit })}</h2>
                <p className="en-panel__sub">{t("energy.text.kwhByNodeLocalTime", "kWh by node, local time")}{mode === "day" ? t("energy.text.groupedByCalendarDay", ", grouped by calendar day") : ""}.</p>
              </div>
              <div className="legend" aria-label={t("energy.text.nodes", "Nodes")}>
                {series.map((s) => (
                  <span key={s.id} style={{ "--c": s.color } as React.CSSProperties}>{s.label}</span>
                ))}
              </div>
            </header>
            <StackedBarChart
              buckets={barBuckets}
              series={series}
              height={240}
              format={formatKwh}
              unit="kWh"
              ariaLabel={t("energy.text.energyInKWhPer0ByNodeLast1", "Energy in kWh per {value0} by node, last {value1}", { value0: unit, value1: rangeLabel })}
              footer={(b) => {
                const full = bucketById.get(b.key);
                if (!full || !full.hasData) return t("energy.text.noTelemetryRecorded", "No telemetry recorded");
                const c = full.expectedMs > 0 ? Math.min(1, full.fleetCoverageMs / full.expectedMs) : 0;
                return t("energy.text.fleetCoverage0OfThe1", "Fleet coverage {value0} of the {value1}", { value0: pct(c), value1: unit });
              }}
            />
          </section>

          <div className={showEff ? "en-grid2" : ""}>
            <section className="panel en-panel" aria-labelledby="en-h-power">
              <header className="en-panel__head">
                <div>
                  <h2 id="en-h-power">{t("energy.text.averageFleetPower", "Average fleet power")}</h2>
                  <p className="en-panel__sub">{t("energy.text.wattsPerHourWhileEveryNodeReportedGapsMeanNoFullFleetCoverage", "Watts per hour while every node reported. Gaps mean no full-fleet coverage.")}</p>
                </div>
              </header>
              <LineAreaChart
                points={powerPoints}
                height={200}
                format={(v) => `${Math.round(v)}`}
                unit="W"
                color="var(--color-info)"
                ariaLabel={t("energy.text.averageFleetPowerInWattsPerHourLast0", "Average fleet power in watts per hour, last {value0}", { value0: rangeLabel })}
              />
            </section>
            {showEff ? (
              <section className="panel en-panel" aria-labelledby="en-h-eff">
                <header className="en-panel__head">
                  <div>
                    <h2 id="en-h-eff">{t("energy.text.efficiency", "Efficiency")}</h2>
                    <p className="en-panel__sub">{t("energy.chart.efficiencyHint", "Wh per 1,000 generated tokens, per {unit}. Lower is better; idle time counts.", { unit })}</p>
                  </div>
                </header>
                <LineAreaChart
                  points={effPoints}
                  height={200}
                  format={(v) => (v < 10 ? v.toFixed(1) : String(Math.round(v)))}
                  unit="Wh / 1k tok"
                  color="var(--color-violet)"
                  ariaLabel={t("energy.text.energyPer1000GeneratedTokensPer0", "Energy per 1,000 generated tokens per {value0}", { value0: unit })}
                />
              </section>
            ) : null}
          </div>

          <section className="panel en-panel" aria-labelledby="en-h-nodes">
            <header className="en-panel__head">
              <div>
                <h2 id="en-h-nodes">{t("energy.text.byNode", "By node")}</h2>
                <p className="en-panel__sub">{t("energy.text.eachNodeIsMeasuredOnlyWhileItReportsSoCoverageDiffersPerNode", "Each node is measured only while it reports, so coverage differs per node.")}</p>
              </div>
            </header>
            <div className="en-table-wrap">
              <table className="en-table">
                <caption className="sr-only">{t("energy.table.caption", "Energy by node for the last {period}", { period: rangeLabel })}</caption>
                <thead>
                  <tr>
                    <SortTh k="name" label="Spark" sort={sort} setSort={setSort} left />
                    <SortTh k="kwh" label={t("energy.text.energy", "Energy")} sort={sort} setSort={setSort} />
                    <SortTh k="share" label={t("energy.text.share", "Share")} sort={sort} setSort={setSort} wide />
                    <SortTh k="avgWatts" label={t("energy.text.avgW", "Avg W")} sort={sort} setSort={setSort} />
                    <SortTh k="peakWatts" label={t("energy.text.peakHour", "Peak hour")} sort={sort} setSort={setSort} />
                    <SortTh k="coverage" label={t("energy.text.coverage", "Coverage")} sort={sort} setSort={setSort} />
                    <SortTh k="cost" label={t("energy.text.cost", "Cost")} sort={sort} setSort={setSort} />
                  </tr>
                </thead>
                <tbody>
                  {sortedNodes.map((n) => (
                    <tr key={n.id}>
                      <th scope="row" className="en-table__name">
                        <i className="en-swatch" style={{ background: colorOf(n.id) }} aria-hidden="true" />
                        {onSelectSpark ? (
                          <button type="button" className="en-link" onClick={() => onSelectSpark(n.id)}>{nameOf(n.id)}</button>
                        ) : (
                          nameOf(n.id)
                        )}
                      </th>
                      <td className="mono">{formatKwh(n.kwh)} kWh</td>
                      <td className="en-table__share">
                        <span className="en-share">
                          <span className="en-share__bar" aria-hidden="true"><i style={{ width: `${(n.share / maxShare) * 100}%`, background: colorOf(n.id) }} /></span>
                          <span className="mono">{pct(n.share, 1)}</span>
                        </span>
                      </td>
                      <td className="mono">{formatWatts(n.avgWatts)}</td>
                      <td className="mono" title={n.peakAtMs != null ? t("energy.text.0Local", "{value0} local", { value0: formatLocalHour(n.peakAtMs, tz) }) : undefined}>
                        {formatWatts(n.peakWatts)}
                        {n.peakAtMs != null ? <span className="en-table__when"> {formatLocalHour(n.peakAtMs, tz)}</span> : null}
                      </td>
                      <td className="mono">{pct(n.coverage, 1)}</td>
                      <td className="mono">{n.cost != null ? formatMoney(n.cost, currency) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {price == null ? <p className="en-panel__sub en-panel__foot">{t("energy.text.costNeedsAnElectricityPriceSetOneInSettings", "Cost needs an electricity price; set one in Settings.")}</p> : null}
          </section>
        </>
      )}

      <div className="en-grid2">
        <section className="panel en-panel" aria-labelledby="en-h-insights">
          <header className="en-panel__head"><h2 id="en-h-insights">{t("energy.text.insights", "Insights")}</h2></header>
          {insights.length ? (
            <ul className="en-list">
              {insights.map((line) => <li key={line}>{line}</li>)}
            </ul>
          ) : (
            <p className="en-panel__sub">{t("energy.text.insightsAppearOnceThereIsEnoughRecordedDataInThisRange", "Insights appear once there is enough recorded data in this range.")}</p>
          )}
        </section>
        <section className="panel en-panel" aria-labelledby="en-h-notes">
          <header className="en-panel__head"><h2 id="en-h-notes">{t("energy.text.aboutThisData", "About this data")}</h2></header>
          <ul className="en-list en-list--notes">
            <li><b>{t("energy.text.estimated", "Estimated.")}</b> {t("energy.text.energyIsPowerTelemetryGPUCPUIntegratedOverTimeNotAWallMeterReading", "Energy is power telemetry (GPU + CPU) integrated over time, not a wall meter reading.")}</li>
            <li><b>{t("energy.text.gaps", "Gaps.")}</b> {t("energy.text.hoursWithNoTelemetryAreLeftOutNeverFilledInCoverageIsTheShareOfTimeEveryNodeRepo", "Hours with no telemetry are left out, never filled in. Coverage is the share of time every node reported fresh data; per-node coverage is in the table.")}</li>
            <li><b>{t("energy.text.efficiency", "Efficiency")}</b> {t("energy.text.onlyCountsTokensAndEnergyFromTimeWhenAllNodesWereReporting", "only counts tokens and energy from time when all nodes were reporting.")}</li>
            <li><b>{t("energy.text.retention", "Retention.")}</b> {t("energy.text.hourlyHistoryIsKeptFor31DaysLongerRangesShowWhatExistsSoFar", "Hourly history is kept for 31 days. Longer ranges show what exists so far.")}</li>
            <li><b>{t("energy.text.localTime", "Local time.")}</b> {t("energy.text.hoursAndDaysFollowTheTimeZoneInSettingsOrThisBrowserSByDefault", "Hours and days follow the time zone in Settings, or this browser's by default (")}{activeTimeZone()}{t("energy.text.hourlyRowsAreStoredInUTC", "). Hourly rows are stored in UTC.")}</li>
            <li><b>{t("energy.text.membership", "Membership.")}</b> {t("energy.text.addingOrRemovingASparkStartsANewAccountingScopeAfterASparkDashRestart", "Adding or removing a Spark starts a new accounting scope after a sparkDash restart.")}</li>
          </ul>
        </section>
      </div>
    </>
  );
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  useTranslation();
  return (
    <div className="panel en-tile">
      <div className="eyebrow">{label}</div>
      {children}
    </div>
  );
}

function SortTh({
  k,
  label,
  sort,
  setSort,
  left,
  wide,
}: {
  k: NodeSortKey;
  label: string;
  sort: { key: NodeSortKey; dir: "asc" | "desc" };
  setSort: (s: { key: NodeSortKey; dir: "asc" | "desc" }) => void;
  left?: boolean;
  wide?: boolean;
}) {
  useTranslation();
  const active = sort.key === k;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={`${left ? "is-left" : ""} ${wide ? "en-table__share" : ""}`}
    >
      <button
        type="button"
        className="en-sort"
        onClick={() => setSort({ key: k, dir: active ? (sort.dir === "asc" ? "desc" : "asc") : k === "name" ? "asc" : "desc" })}
      >
        {label}
        <span aria-hidden="true" className="en-sort__arrow">{active ? (sort.dir === "asc" ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)} k`;
  return String(n);
}
