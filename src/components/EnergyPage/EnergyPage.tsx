import { t } from "../../i18n";
import { RestartButton } from "../ui/RestartButton";
import { activeTimeZone } from "../../shared/timeZone";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

const DAY_MS = 86_400_000;
const ENERGY_CLEAR = [
  { id: "7d", label: t("energy.older_7d"), ask: t("energy.older_7d_ask"), arg: 7 * DAY_MS },
  { id: "24h", label: t("energy.older_24h"), ask: t("energy.older_24h_ask"), arg: DAY_MS },
  { id: "all", label: t("energy.older_all"), ask: t("energy.older_all_ask"), arg: undefined },
] as const;

const HISTORY_POLL_MS = 60_000;
const LIVE_POLL_MS = 15_000;

const RANGES: Array<{ id: EnergyRange; label: string; long: string }> = [
  { id: "24h", label: "24 h", long: t("energy.long_24h") },
  { id: "7d", label: "7 d", long: t("energy.long_7d") },
  { id: "14d", label: "14 d", long: "14 days" },
  { id: "31d", label: "31 d", long: "31 days" },
];

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
  }, [history, range, price, currency, nameOf, tz]);

  const colorOf = useMemo(() => {
    const map = new Map<string, string>();
    (model?.summary.nodes ?? []).forEach((n, i) => map.set(n.id, NODE_COLORS[i % NODE_COLORS.length]));
    return (id: string) => map.get(id) ?? NODE_COLORS[NODE_COLORS.length - 1];
  }, [model]);

  const rangeInfo = RANGES.find((r) => r.id === range)!;

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
          <h2>{t("energy.load_fail")}</h2>
          <p>{historyError}</p>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void loadHistory()}>Retry</button>
        </section>
      );
    }
    if (!history) {
      return (
        <section className="panel en-state" role="status" aria-live="polite">
          <h2>{t("energy.loading")}</h2>
        </section>
      );
    }
    if (history.membershipChanged) {
      return (
        <section className="panel en-state" role="status">
          <h2>{t("energy.membership")}</h2>
          <p>
            Sparks were added or removed since energy accounting started, so totals would no longer be comparable.
            Restart sparkDash to start a new accounting scope. Previous hourly history is withheld until then.
          </p>
          <RestartButton />
        </section>
      );
    }
    if (!model || history.hourly.length === 0) {
      return (
        <section className="panel en-state" role="status">
          <h2>{t("energy.warming")}</h2>
          <p>{t("energy.warming_sub")}</p>
        </section>
      );
    }
    return (
      <EnergyBody
        model={model}
        live={live}
        nodeTotal={sparks.length || history.nodeIds.length}
        rangeLabel={rangeInfo.long}
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
          <h1>{t("energy.title")}</h1>
          <p className="page-head__sub">
            {t("energy.subtitle")}
            {history ? <span className="mono en-updated"> {t("energy.updated", { time: new Date(history.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: activeTimeZone() }) })}</span> : null}
          </p>
        </div>
        <div className="page-head__tools">
          <div className="seg" role="group" aria-label={t("tokens.time_range")}>
            {RANGES.map((r) => (
              <button key={r.id} type="button" aria-pressed={range === r.id} className={range === r.id ? "is-on" : ""} onClick={() => setRange(r.id)}>
                {r.id === "24h" ? t("energy.last_24h") : r.label}
              </button>
            ))}
          </div>
          <ClearMenu
            label={t("tokens.reset_ellipsis")}
            choices={ENERGY_CLEAR}
            note={t("energy.reset_note")}
            onRun={async (ms) => {
              const { removed } = await clearFleetEnergy(ms);
              await Promise.all([loadHistory(), loadLive()]);
              setMonthlyReload((n) => n + 1);
              return removed;
            }}
          />
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void copyCsv()} disabled={!model || model.inRange.length === 0}>
            {copied === "ok" ? t("tokens.copied_ok") : copied === "fail" ? t("tokens.copy_failed_short") : t("tokens.copy_csv")}
          </button>
          <span className="sr-only" role="status" aria-live="polite">{copied === "ok" ? "CSV copied to clipboard" : ""}</span>
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
  const { summary, win, mode, buckets, powerBuckets, delta, insights } = model;
  const tz = browserTzOffset;
  const noData = !summary.hasData;
  const shortHistory = win.windowStartMs > win.startMs;
  const fresh = live?.freshNodeCount ?? null;
  const total = live?.currentNodeIds.length || nodeTotal;

  const series: BarSeries[] = summary.nodes.map((n) => ({ id: n.id, label: nameOf(n.id), color: colorOf(n.id) }));
  const barBuckets: BarBucket[] = buckets.map((b) => ({ key: b.key, label: b.label, title: b.title, values: b.nodeKwh }));
  const bucketById = new Map(buckets.map((b) => [b.key, b]));
  const unit = mode === "hour" ? t("tokens.hour") : t("tokens.day");

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
      {stale ? <p className="en-banner en-banner--warn" role="status">{t("energy.stale")}</p> : null}
      <p className="en-banner" role="note">
        <b>{t("energy.banner_bold")}</b> {t("energy.banner_body")}
      </p>

      <section className="en-tiles" aria-label="Summary">
        <Tile label={t("energy.tile_current")}>
          <div className="big-num mono">{live?.currentWatts30s != null ? Math.round(live.currentWatts30s) : "—"}<small>W</small></div>
          <div className="en-tile__sub">
            {fresh != null ? (
              <Tag tone={fresh === 0 ? "bad" : fresh < total ? "warn" : "good"}>{t("overview.freshTag", { fresh, total })}</Tag>
            ) : null}
            <span>{t("energy.avg_30s")}</span>
          </div>
        </Tile>
        <Tile label={t("energy.tile_energy", { range: rangeLabel })}>
          <div className="big-num mono">{noData ? "—" : formatKwh(summary.kwh)}<small>kWh</small></div>
          <div className="en-tile__sub">
            {delta ? (
              <span className={delta.ratio >0.02 ? "en-delta en-delta--up" : delta.ratio< -0.02 ? "en-delta en-delta--down" : "en-delta"}>
                {delta.ratio > 0 ? "+" : ""}{Math.round(delta.ratio * 100)}% {t("energy.vs_prev", { range: rangeLabel })}
              </span>
            ) : (
              <span>{t("energy.no_prev")}</span>
            )}
          </div>
        </Tile>
        <Tile label={t("energy.tile_cost")}>
          <div className="big-num mono">{summary.cost != null && !noData ? formatMoney(summary.cost, currency) : "—"}</div>
          <div className="en-tile__sub">
            {price == null ? (
              <span>{t("energy.set_price")}</span>
            ) : (
              <span>{summary.costPerDay != null ? t("energy.per_day", { v: formatMoney(summary.costPerDay, currency) }) : "—"} {t("energy.price_per_kwh", { currency, price })}</span>
            )}
          </div>
        </Tile>
        <Tile label={t("energy.tile_avg_power")}>
          <div className="big-num mono">{summary.avgWatts != null ? Math.round(summary.avgWatts) : "—"}<small>W</small></div>
          <div className="en-tile__sub"><span>{t("energy.whole_fleet", { h: summary.coveredHours >= 10 ? Math.round(summary.coveredHours) : summary.coveredHours.toFixed(1) })}</span></div>
        </Tile>
        <Tile label={t("energy.tile_peak")}>
          <div className="big-num mono">{summary.peak ? Math.round(summary.peak.watts) : "—"}<small>W</small></div>
          <div className="en-tile__sub"><span>{summary.peak ? t("energy.peak_at", { time: formatLocalHour(summary.peak.atMs, tz) }) : t("energy.no_full_hour")}</span></div>
        </Tile>
        <Tile label={t("energy.tile_eff")}>
          <div className="big-num mono">{summary.whPer1kTokens != null ? (summary.whPer1kTokens < 10 ? summary.whPer1kTokens.toFixed(2) : summary.whPer1kTokens.toFixed(1)) : "—"}<small>{t("ui.wh_1k_tok_afd8")}</small></div>
          <div className="en-tile__sub">
            <span>{summary.coveredTokens > 0 ? t("energy.output_tokens", { v: compact(summary.coveredTokens) }) : t("energy.no_token_data")}</span>
          </div>
        </Tile>
        <Tile label={t("energy.tile_coverage")}>
          <div className="big-num mono">{noData ? "—" : pct(summary.coverage, summary.coverage >= 0.995 ? 0 : 1)}</div>
          <div className="en-tile__sub">
            <Tag tone={summary.coverage >= 0.9 ? "good" : summary.coverage >= 0.5 ? "warn" : "bad"}>{summary.coverage >= 0.9 ? t("energy.cov_solid") : summary.coverage >= 0.5 ? t("energy.cov_partial") : t("energy.cov_sparse")}</Tag>
            <span>{shortHistory ? t("energy.since_began") : t("energy.of_range")}</span>
          </div>
        </Tile>
      </section>

      {noData ? (
        <section className="panel en-state" role="status">
          <h2>{t("energy.none_in_range", { range: rangeLabel })}</h2>
          <p>{t("energy.none_hint")}</p>
        </section>
      ) : (
        <>
          <section className="panel en-panel" aria-labelledby="en-h-energy">
            <header className="en-panel__head">
              <div>
                <h2 id="en-h-energy">{t("tokens.per_unit", { unit })}</h2>
                <p className="en-panel__sub">{t("energy.kwh_by_node", { mode: mode === "day" ? t("energy.by_calendar_day") : "" })}</p>
              </div>
              <div className="legend" aria-label="Nodes">
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
              ariaLabel={`Energy in kWh per ${unit} by node, last ${rangeLabel}`}
              footer={(b) => {
                const full = bucketById.get(b.key);
                if (!full || !full.hasData) return t("energy.no_telemetry");
                const c = full.expectedMs > 0 ? Math.min(1, full.fleetCoverageMs / full.expectedMs) : 0;
                return t("energy.fleet_coverage", { pct: pct(c), unit });
              }}
            />
          </section>

          <div className={showEff ? "en-grid2" : ""}>
            <section className="panel en-panel" aria-labelledby="en-h-power">
              <header className="en-panel__head">
                <div>
                  <h2 id="en-h-power">{t("energy.h_avg_power")}</h2>
                  <p className="en-panel__sub">{t("energy.h_avg_power_sub")}</p>
                </div>
              </header>
              <LineAreaChart
                points={powerPoints}
                height={200}
                format={(v) => `${Math.round(v)}`}
                unit="W"
                color="var(--color-info)"
                ariaLabel={`Average fleet power in watts per hour, last ${rangeLabel}`}
              />
            </section>
            {showEff ? (
              <section className="panel en-panel" aria-labelledby="en-h-eff">
                <header className="en-panel__head">
                  <div>
                    <h2 id="en-h-eff">{t("energy.h_eff")}</h2>
                    <p className="en-panel__sub">{t("energy.h_eff_sub", { unit })}</p>
                  </div>
                </header>
                <LineAreaChart
                  points={effPoints}
                  height={200}
                  format={(v) => (v < 10 ? v.toFixed(1) : String(Math.round(v)))}
                  unit="Wh / 1k tok"
                  color="var(--color-violet)"
                  ariaLabel={`Energy per 1,000 generated tokens per ${unit}`}
                />
              </section>
            ) : null}
          </div>

          <section className="panel en-panel" aria-labelledby="en-h-nodes">
            <header className="en-panel__head">
              <div>
                <h2 id="en-h-nodes">{t("energy.h_by_node")}</h2>
                <p className="en-panel__sub">{t("energy.h_by_node_sub")}</p>
              </div>
            </header>
            <div className="en-table-wrap">
              <table className="en-table">
                <caption className="sr-only">{t("energy.table_caption", { range: rangeLabel })}</caption>
                <thead>
                  <tr>
                    <SortTh k="name" label={t("tokens.g_spark")} sort={sort} setSort={setSort} left />
                    <SortTh k="kwh" label={t("energy.col_energy")} sort={sort} setSort={setSort} />
                    <SortTh k="share" label={t("tokens.col_share")} sort={sort} setSort={setSort} wide />
                    <SortTh k="avgWatts" label={t("energy.col_avg_w")} sort={sort} setSort={setSort} />
                    <SortTh k="peakWatts" label={t("energy.tile_peak")} sort={sort} setSort={setSort} />
                    <SortTh k="coverage" label={t("energy.tile_coverage")} sort={sort} setSort={setSort} />
                    <SortTh k="cost" label={t("energy.col_cost")} sort={sort} setSort={setSort} />
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
                      <td className="mono" title={n.peakAtMs != null ? `${formatLocalHour(n.peakAtMs, tz)} local` : undefined}>
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
            {price == null ? <p className="en-panel__sub en-panel__foot">{t("energy.cost_needs_price")}</p> : null}
          </section>
        </>
      )}

      <div className="en-grid2">
        <section className="panel en-panel" aria-labelledby="en-h-insights">
          <header className="en-panel__head"><h2 id="en-h-insights">{t("tokens.insights")}</h2></header>
          {insights.length ? (
            <ul className="en-list">
              {insights.map((line) => <li key={line}>{line}</li>)}
            </ul>
          ) : (
            <p className="en-panel__sub">{t("energy.insights_empty")}</p>
          )}
        </section>
        <section className="panel en-panel" aria-labelledby="en-h-notes">
          <header className="en-panel__head"><h2 id="en-h-notes">{t("energy.h_about")}</h2></header>
          <ul className="en-list en-list--notes">
            <li>{t("energy.note_estimated")}</li>
            <li>{t("energy.note_gaps")}</li>
            <li>{t("energy.note_eff")}</li>
            <li>{t("energy.note_retention")}</li>
            <li>{t("energy.note_local", { tz: activeTimeZone() })}</li>
            <li>{t("energy.note_membership")}</li>
          </ul>
        </section>
      </div>
    </>
  );
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
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
