import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clearFleetEnergy, fetchEnergyHistory, fetchFleetEnergy } from "../../api/client";
import { ClearMenu } from "../ui/ClearMenu";
import type { EnergyHistory, FleetEnergy, Settings, SparkSnapshot } from "../../api/types";
import { StackedBarChart, type BarBucket, type BarSeries } from "../ui/StackedBarChart";
import { LineAreaChart, type LinePoint } from "../ui/LineAreaChart";
import { Tag } from "../ui/Tag";
import {
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
  { id: "7d", label: "Older than 7 days", ask: "Delete energy history older than 7 days?", arg: 7 * DAY_MS },
  { id: "24h", label: "Older than 24 hours", ask: "Delete energy history older than 24 hours?", arg: DAY_MS },
  { id: "all", label: "Everything", ask: "Delete all recorded energy history?", arg: undefined },
] as const;

const HISTORY_POLL_MS = 60_000;
const LIVE_POLL_MS = 15_000;

const RANGES: Array<{ id: EnergyRange; label: string; long: string }> = [
  { id: "24h", label: "24 h", long: "24 hours" },
  { id: "7d", label: "7 d", long: "7 days" },
  { id: "14d", label: "14 d", long: "14 days" },
  { id: "31d", label: "31 d", long: "31 days" },
];

/** Node colours in stack order (largest consumer first). */
const NODE_COLORS = [
  "var(--color-accent)",
  "var(--color-info)",
  "var(--color-violet)",
  "var(--color-success)",
  "var(--color-warning)",
  "var(--color-danger)",
  "var(--color-muted-strong)",
  "var(--color-faint)",
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
          <h2>Could not load energy history</h2>
          <p>{historyError}</p>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void loadHistory()}>Retry</button>
        </section>
      );
    }
    if (!history) {
      return (
        <section className="panel en-state" role="status" aria-live="polite">
          <h2>Loading energy history…</h2>
        </section>
      );
    }
    if (history.membershipChanged) {
      return (
        <section className="panel en-state" role="status">
          <h2>Fleet membership changed</h2>
          <p>
            Sparks were added or removed since energy accounting started, so totals would no longer be comparable.
            Restart sparkDash to start a new accounting scope. Previous hourly history is withheld until then.
          </p>
        </section>
      );
    }
    if (!model || history.hourly.length === 0) {
      return (
        <section className="panel en-state" role="status">
          <h2>Warming up</h2>
          <p>No complete energy interval has been recorded yet. Data appears here once every node has reported fresh power telemetry for a little while.</p>
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
          <h1>Fleet energy</h1>
          <p className="page-head__sub">
            Estimated electricity use of your Sparks from GPU and CPU power telemetry. Not wall-metered.
            {history ? <span className="mono en-updated"> Updated {new Date(history.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> : null}
          </p>
        </div>
        <div className="page-head__tools">
          <div className="seg" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button key={r.id} type="button" aria-pressed={range === r.id} className={range === r.id ? "is-on" : ""} onClick={() => setRange(r.id)}>
                {r.id === "24h" ? "Last 24 h" : r.label}
              </button>
            ))}
          </div>
          <ClearMenu
            label="Reset…"
            choices={ENERGY_CLEAR}
            note="Power keeps being recorded from now on. This can't be undone."
            onRun={async (ms) => {
              const { removed } = await clearFleetEnergy(ms);
              await Promise.all([loadHistory(), loadLive()]);
              return removed;
            }}
          />
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void copyCsv()} disabled={!model || model.inRange.length === 0}>
            {copied === "ok" ? "Copied" : copied === "fail" ? "Copy failed" : "Copy CSV"}
          </button>
          <span className="sr-only" role="status" aria-live="polite">{copied === "ok" ? "CSV copied to clipboard" : ""}</span>
        </div>
      </div>
      {body}
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
  const unit = mode === "hour" ? "hour" : "day";

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
      {stale ? <p className="en-banner en-banner--warn" role="status">Could not refresh just now; showing the last data received.</p> : null}
      <p className="en-banner" role="note">
        <b>Estimated, not metered.</b> Figures are integrated from GPU and CPU power readings and leave out power-supply losses and other components, so the wall draw is somewhat higher.
      </p>

      <section className="en-tiles" aria-label="Summary">
        <Tile label="Current draw">
          <div className="big-num mono">{live?.currentWatts30s != null ? Math.round(live.currentWatts30s) : "—"}<small>W</small></div>
          <div className="en-tile__sub">
            {fresh != null ? (
              <Tag tone={fresh === 0 ? "bad" : fresh < total ? "warn" : "good"}>{fresh}/{total} nodes fresh</Tag>
            ) : null}
            <span>30 s average</span>
          </div>
        </Tile>
        <Tile label={`Energy, ${rangeLabel}`}>
          <div className="big-num mono">{noData ? "—" : formatKwh(summary.kwh)}<small>kWh</small></div>
          <div className="en-tile__sub">
            {delta ? (
              <span className={delta.ratio > 0.02 ? "en-delta en-delta--up" : delta.ratio < -0.02 ? "en-delta en-delta--down" : "en-delta"}>
                {delta.ratio > 0 ? "+" : ""}{Math.round(delta.ratio * 100)}% vs previous {rangeLabel}
              </span>
            ) : (
              <span>No earlier period to compare yet</span>
            )}
          </div>
        </Tile>
        <Tile label="Estimated cost">
          <div className="big-num mono">{summary.cost != null && !noData ? formatMoney(summary.cost, currency) : "—"}</div>
          <div className="en-tile__sub">
            {price == null ? (
              <span>Set an electricity price in Settings</span>
            ) : (
              <span>{summary.costPerDay != null ? `${formatMoney(summary.costPerDay, currency)} per day` : "—"} at {currency}{price}/kWh</span>
            )}
          </div>
        </Tile>
        <Tile label="Average power">
          <div className="big-num mono">{summary.avgWatts != null ? Math.round(summary.avgWatts) : "—"}<small>W</small></div>
          <div className="en-tile__sub"><span>Whole fleet, over {summary.coveredHours >= 10 ? Math.round(summary.coveredHours) : summary.coveredHours.toFixed(1)} h covered</span></div>
        </Tile>
        <Tile label="Peak hour">
          <div className="big-num mono">{summary.peak ? Math.round(summary.peak.watts) : "—"}<small>W</small></div>
          <div className="en-tile__sub"><span>{summary.peak ? `${formatLocalHour(summary.peak.atMs, tz)} local` : "No full hour yet"}</span></div>
        </Tile>
        <Tile label="Efficiency">
          <div className="big-num mono">{summary.whPer1kTokens != null ? (summary.whPer1kTokens < 10 ? summary.whPer1kTokens.toFixed(2) : summary.whPer1kTokens.toFixed(1)) : "—"}<small>Wh / 1k tok</small></div>
          <div className="en-tile__sub">
            <span>{summary.coveredTokens > 0 ? `${compact(summary.coveredTokens)} output tokens` : "No token data in this range"}</span>
          </div>
        </Tile>
        <Tile label="Coverage">
          <div className="big-num mono">{noData ? "—" : pct(summary.coverage, summary.coverage >= 0.995 ? 0 : 1)}</div>
          <div className="en-tile__sub">
            <Tag tone={summary.coverage >= 0.9 ? "good" : summary.coverage >= 0.5 ? "warn" : "bad"}>{summary.coverage >= 0.9 ? "Solid" : summary.coverage >= 0.5 ? "Partial" : "Sparse"}</Tag>
            <span>{shortHistory ? "since history began" : "of the range"}</span>
          </div>
        </Tile>
      </section>

      {noData ? (
        <section className="panel en-state" role="status">
          <h2>No energy recorded in the last {rangeLabel}</h2>
          <p>Try a longer range, or check that the Sparks are reporting power telemetry.</p>
        </section>
      ) : (
        <>
          <section className="panel en-panel" aria-labelledby="en-h-energy">
            <header className="en-panel__head">
              <div>
                <h2 id="en-h-energy">Energy per {unit}</h2>
                <p className="en-panel__sub">kWh by node, local time{mode === "day" ? ", grouped by calendar day" : ""}.</p>
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
                if (!full || !full.hasData) return "No telemetry recorded";
                const c = full.expectedMs > 0 ? Math.min(1, full.fleetCoverageMs / full.expectedMs) : 0;
                return `Fleet coverage ${pct(c)} of the ${unit}`;
              }}
            />
          </section>

          <div className={showEff ? "en-grid2" : ""}>
            <section className="panel en-panel" aria-labelledby="en-h-power">
              <header className="en-panel__head">
                <div>
                  <h2 id="en-h-power">Average fleet power</h2>
                  <p className="en-panel__sub">Watts per hour while every node reported. Gaps mean no full-fleet coverage.</p>
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
                    <h2 id="en-h-eff">Efficiency</h2>
                    <p className="en-panel__sub">Wh per 1,000 generated tokens, per {unit}. Lower is better; idle time counts.</p>
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
                <h2 id="en-h-nodes">By node</h2>
                <p className="en-panel__sub">Each node is measured only while it reports, so coverage differs per node.</p>
              </div>
            </header>
            <div className="en-table-wrap">
              <table className="en-table">
                <caption className="sr-only">Energy by node for the last {rangeLabel}</caption>
                <thead>
                  <tr>
                    <SortTh k="name" label="Spark" sort={sort} setSort={setSort} left />
                    <SortTh k="kwh" label="Energy" sort={sort} setSort={setSort} />
                    <SortTh k="share" label="Share" sort={sort} setSort={setSort} wide />
                    <SortTh k="avgWatts" label="Avg W" sort={sort} setSort={setSort} />
                    <SortTh k="peakWatts" label="Peak hour" sort={sort} setSort={setSort} />
                    <SortTh k="coverage" label="Coverage" sort={sort} setSort={setSort} />
                    <SortTh k="cost" label="Cost" sort={sort} setSort={setSort} />
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
            {price == null ? <p className="en-panel__sub en-panel__foot">Cost needs an electricity price; set one in Settings.</p> : null}
          </section>
        </>
      )}

      <div className="en-grid2">
        <section className="panel en-panel" aria-labelledby="en-h-insights">
          <header className="en-panel__head"><h2 id="en-h-insights">Insights</h2></header>
          {insights.length ? (
            <ul className="en-list">
              {insights.map((line) => <li key={line}>{line}</li>)}
            </ul>
          ) : (
            <p className="en-panel__sub">Insights appear once there is enough recorded data in this range.</p>
          )}
        </section>
        <section className="panel en-panel" aria-labelledby="en-h-notes">
          <header className="en-panel__head"><h2 id="en-h-notes">About this data</h2></header>
          <ul className="en-list en-list--notes">
            <li><b>Estimated.</b> Energy is power telemetry (GPU + CPU) integrated over time, not a wall meter reading.</li>
            <li><b>Gaps.</b> Hours with no telemetry are left out, never filled in. Coverage is the share of time every node reported fresh data; per-node coverage is in the table.</li>
            <li><b>Efficiency</b> only counts tokens and energy from time when all nodes were reporting.</li>
            <li><b>Retention.</b> Hourly history is kept for 31 days. Longer ranges show what exists so far.</li>
            <li><b>Local time.</b> Hours and days follow this browser's time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone}). Hourly rows are stored in UTC.</li>
            <li><b>Membership.</b> Adding or removing a Spark starts a new accounting scope after a sparkDash restart.</li>
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
