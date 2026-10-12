import { activeLocale } from "../../i18n";
import { localizedServerText } from "../../i18n/messages";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { fetchTokenHistory, resetTokenTotals } from "../../api/client";
import { ClearMenu, type ClearChoice } from "../ui/ClearMenu";
import { fetchLlmTokenTotals } from "../../api/llmTokenClient";
import type { LlmTokenSeriesTotals } from "../../api/llmTokenTypes";
import type { SparkSnapshot, TokenHistory } from "../../api/types";
import { formatTokensCompact } from "../../shared/tokenFormat";
import { StackedBarChart, type BarBucket, type BarSeries } from "../ui/StackedBarChart";
import { EndpointTable, ModelTable } from "./TokenTables";
import {
  OTHER_ID,
  RANGES,
  localizedRange,
  previousRangePhrase,
  bucketLabel,
  bucketTitle,
  bucketTotals,
  buildCsv,
  buildInsights,
  compare,
  endpointRows,
  entriesFromTotals,
  fmtPct,
  groupBuckets,
  lastSeenByModel,
  modelRows,
  rowsIn,
  summarize,
  tallyOf,
  trackedBuckets,
  windowFor,
  type Comparison,
  type GroupBy,
  type RangeKey,
  type Summary,
} from "./tokenStats";
import "../../styles/tokens.css";

const POLL_MS = 30_000;
const fmt = formatTokensCompact;

const GROUPS: { key: GroupBy }[] = [{ key: "type" }, { key: "model" }, { key: "spark" }];
const TYPE_COLORS: Record<string, string> = {
  generated: "var(--color-accent)",
  cached: "var(--color-info)",
  computed: "var(--color-violet)",
};
const GROUP_COLORS = ["var(--color-accent)", "var(--color-info)", "var(--color-violet)", "var(--color-success)", "var(--color-warning)"];

interface Loaded {
  history: TokenHistory;
  /** Lifetime totals; null when that endpoint failed (All time then falls back to retained days). */
  lifetime: LlmTokenSeriesTotals[] | null;
  at: number;
}

export function TokensPage({ sparks, onSelectSpark }: { sparks: SparkSnapshot[]; onSelectSpark?: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const [range, setRange] = useState<RangeKey>("7d");
  const [groupBy, setGroupBy] = useState<GroupBy>("type");
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [copyMsg, setCopyMsg] = useState<{ ok: boolean; rows?: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      Promise.all([fetchTokenHistory(), fetchLlmTokenTotals("all").then((r) => r.series || []).catch(() => null)])
        .then(([history, lifetime]) => {
          if (cancelled) return;
          setData({ history, lifetime, at: Date.now() });
          setError(null);
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : t("tokens.error.load", "Could not load token history"));
        });
    };
    run();
    const id = setInterval(() => {
      if (!document.hidden) run();
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tick, t]);

  useEffect(() => {
    if (!copyMsg) return;
    const t = setTimeout(() => setCopyMsg(null), 4000);
    return () => clearTimeout(t);
  }, [copyMsg]);

  const sparkNames = useMemo(() => new Map(sparks.map((s) => [s.id, s.name])), [sparks]);
  const tokenResetChoices = useMemo<ClearChoice<string | undefined>[]>(
    () => [
      { id: "all", label: t("tokens.reset.all", "All Sparks"), ask: t("tokens.reset.allAsk", "Reset the token totals of every Spark?"), arg: undefined },
      ...sparks.map((s) => ({ id: s.id, label: s.name, ask: t("tokens.reset.sparkAsk", "Reset the token totals of {name}?", { name: s.name }), arg: s.id })),
    ],
    [sparks, t]
  );
  const sparkName = useCallback((id: string) => sparkNames.get(id) || id, [sparkNames]);
  const knownSpark = useCallback((id: string) => sparkNames.has(id), [sparkNames]);

  const view = useMemo(() => {
    if (!data) return null;
    const { history, lifetime, at } = data;
    const w = windowFor(range, history, at);
    const unit = w.spec.unit;
    const source = unit === "hour" ? history.hour : history.day;
    const inRange = rowsIn(source, w.keys);
    const useLifetime = range === "all" && lifetime != null;
    const entries = useLifetime ? entriesFromTotals(lifetime) : inRange;
    const tally = tallyOf(entries);
    const totals = bucketTotals(inRange, w.keys);
    const elapsed = range === "all" ? trackedBuckets(w.firstKey, "day", at) ?? undefined : undefined;
    const summary = summarize(tally, totals, w.firstKey, elapsed);
    const comparison = w.prevKeys.length ? compare(tally, tallyOf(rowsIn(source, w.prevKeys))) : null;
    const models = modelRows(entries, lifetime ? lastSeenByModel(lifetime) : undefined);
    const endpoints = endpointRows(entries);
    const hasRetainedHistory = history.day.length > 0 || history.hour.length > 0;
    return { w, unit, inRange, tally, totals, summary, comparison, models, endpoints, at, hasRetainedHistory, useLifetime };
  }, [data, range, i18n.language]);

  const grouped = useMemo(
    () => (view ? groupBuckets(view.inRange, view.w.keys, groupBy, { sparkName }) : null),
    [view, groupBy, sparkName, i18n.language]
  );

  const insights = useMemo(
    () =>
      view
        ? buildInsights({
            spec: view.w.spec,
            summary: view.summary,
            comparison: view.comparison,
            models: view.models,
            endpoints: view.endpoints,
            totals: view.totals,
            firstKey: view.w.firstKey,
            sparkName,
            t,
          })
        : [],
    [view, sparkName, t]
  );

  const copyCsv = async () => {
    if (!view) return;
    const text = buildCsv(view.inRange, sparkName);
    const n = view.inRange.length;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else throw new Error("no clipboard");
      setCopyMsg({ ok: true, rows: n });
    } catch {
      // Insecure origins block the async clipboard API; fall back to a hidden textarea.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.className = "tk-sr";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        setCopyMsg(ok ? { ok: true, rows: n } : { ok: false });
      } catch {
        setCopyMsg({ ok: false });
      }
    }
  };

  const spec = localizedRange(range);
  const unitWord = spec.unit === "hour" ? t("tokens.unit.hour", "hour") : t("tokens.unit.day", "day");

  const series: BarSeries[] = (grouped?.series ?? []).map((s, i) => ({
    id: s.id,
    label: s.label,
    color: groupBy === "type" ? TYPE_COLORS[s.id] : s.id === OTHER_ID ? "var(--color-faint)" : GROUP_COLORS[i % GROUP_COLORS.length],
  }));
  const buckets: BarBucket[] = (grouped?.buckets ?? []).map((b) => ({
    key: b.key,
    label: bucketLabel(b.key, spec.unit),
    title: bucketTitle(b.key, spec.unit),
    values: b.values,
  }));
  const chartEmpty =
    range === "24h"
      ? t("tokens.chart.emptyHourly", "No hourly traffic recorded yet. Hourly history only builds up while sparkDash is running, starting from the update that added it.")
      : t("tokens.chart.empty", "No token traffic recorded in this range yet. History builds up while sparkDash is running.");

  return (
    <div className="tk">
      <header className="page-head">
        <div>
          <h1>{t("tokens.title", "Token totals")}</h1>
          <p className="page-head__sub">{t("tokens.subtitle", "What your Sparks generated and read, by type, model and endpoint, built from the counters sparkDash polls from each inference engine.")}</p>
        </div>
        <div className="page-head__tools">
          <div className="seg" role="group" aria-label={t("tokens.range.aria", "Time range")}>
            {RANGES.map((r) => (
              <button key={r.key} type="button" className={r.key === range ? "is-on" : undefined} aria-pressed={r.key === range} onClick={() => setRange(r.key)}>
                {localizedRange(r.key).label}
              </button>
            ))}
          </div>
          <ClearMenu
            label={t("tokens.reset.label", "Reset…")}
            choices={tokenResetChoices}
            note={t("tokens.reset.note", "Counting restarts from zero; the engines themselves are not touched. This can't be undone.")}
            onRun={async (id) => {
              const { removed } = await resetTokenTotals(id);
              setTick((t) => t + 1);
              return removed;
            }}
          />
          <button type="button" className="btn btn--sm" onClick={copyCsv} disabled={!view || view.inRange.length === 0}>
            {t("tokens.copy.button", "Copy CSV")}
          </button>
          <span className={`tk-copymsg${copyMsg && !copyMsg.ok ? " is-err" : ""}`} role="status" aria-live="polite">
            {copyMsg ? copyMsg.ok ? t("tokens.copy.ok", "Copied {count} rows as CSV", { count: copyMsg.rows }) : t("tokens.copy.blocked", "Copy failed: the browser blocked clipboard access") : null}
          </span>
        </div>
      </header>

      {!data && !error ? (
        <div className="panel tk-note" role="status">
          {t("tokens.loading", "Loading token history…")}
        </div>
      ) : null}

      {error ? (
        <div className="panel tk-note tk-note--err" role="alert">
          <span>{data ? t("tokens.error.stale", "Showing the last loaded data. Refresh failed: {error}", { error: localizedServerText(error) }) : t("tokens.error.withDetail", "Could not load token history: {error}", { error: localizedServerText(error) })}</span>
          <button type="button" className="btn btn--sm" onClick={() => setTick((t) => t + 1)}>
            {t("tokens.retry", "Retry")}
          </button>
        </div>
      ) : null}

      {view ? (
        <>
          {view.summary.total > 0 ? <Tiles s={view.summary} cmp={view.comparison} spec={spec} /> : null}

          <div className="tk-grid">
            <section className="panel tk-card" aria-labelledby="tk-chart-title">
              <div className="tk-card__head">
                <div>
                  <h2 id="tk-chart-title" className="tk-card__title">
                    {t("tokens.chart.title", "Tokens per {unit}", { unit: unitWord })}
                  </h2>
                  <p className="tk-card__sub">
                    {spec.unit === "hour" ? t("tokens.chart.localHours", "Local-time hours, oldest to newest") : range === "all" ? t("tokens.chart.retainedDays", "UTC days, as far back as history is kept") : t("tokens.chart.utcDays", "UTC days, oldest to newest")}
                  </p>
                </div>
                <div className="tk-card__tools">
                  <span className="eyebrow">{t("tokens.group.title", "Group by")}</span>
                  <div className="seg" role="group" aria-label={t("tokens.group.aria", "Group chart by")}>
                    {GROUPS.map((g) => (
                      <button key={g.key} type="button" className={g.key === groupBy ? "is-on" : undefined} aria-pressed={g.key === groupBy} onClick={() => setGroupBy(g.key)}>
                        {g.key === "type" ? t("tokens.group.type", "Type") : g.key === "model" ? t("tokens.group.model", "Model") : t("tokens.group.spark", "Spark")}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <StackedBarChart
                buckets={buckets}
                series={series}
                height={260}
                format={fmt}
                unit="tokens"
                empty={chartEmpty}
                ariaLabel={t("tokens.chart.aria", "Stacked bar chart of tokens per {unit} for {period}, grouped by {group}", { unit: unitWord, period: spec.phrase, group: groupBy === "type" ? t("tokens.group.type", "Type") : groupBy === "model" ? t("tokens.group.model", "Model") : t("tokens.group.spark", "Spark") })}
              />
              <ul className="legend tk-legend">
                {series.map((s, i) => (
                  <li key={s.id} style={{ "--c": s.color } as CSSProperties}>
                    <span>{s.label}</span>
                    <em className="mono">{fmt(grouped?.series[i].total ?? 0)}</em>
                  </li>
                ))}
              </ul>
            </section>

            <section className="panel tk-card" aria-labelledby="tk-insights-title">
              <h2 id="tk-insights-title" className="tk-card__title">
                {t("tokens.insights.title", "Insights")}
              </h2>
              {insights.length > 0 ? (
                <ul className="tk-insights">
                  {insights.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              ) : (
                <p className="tk-card__sub">{t("tokens.insights.empty", "Insights appear once there is traffic in {period}.", { period: spec.phrase })}</p>
              )}
            </section>
          </div>

          {view.summary.total > 0 ? (
            <>
              <section className="panel tk-card" aria-labelledby="tk-models-title">
                <div className="tk-card__head">
                  <div>
                    <h2 id="tk-models-title" className="tk-card__title">
                      {t("tokens.models.title", "By model")}
                    </h2>
                    <p className="tk-card__sub">
                      {t("tokens.models.summary", "{count} models in {period}. Click a column to sort.", { count: view.models.length, period: spec.phrase })}
                    </p>
                  </div>
                </div>
                <ModelTable rows={view.models} sparkName={sparkName} nowMs={view.at} />
              </section>

              <section className="panel tk-card" aria-labelledby="tk-eps-title">
                <div className="tk-card__head">
                  <div>
                    <h2 id="tk-eps-title" className="tk-card__title">
                      {t("tokens.endpoints.title", "By Spark and endpoint")}
                    </h2>
                    <p className="tk-card__sub">{t("tokens.endpoints.summary", "One row per Spark and inference port. Select a Spark to open it.")}</p>
                  </div>
                </div>
                <EndpointTable rows={view.endpoints} sparkName={sparkName} knownSpark={knownSpark} onSelectSpark={onSelectSpark} />
              </section>
            </>
          ) : (
            <section className="panel tk-note" role="status">
              <b>{t("tokens.empty.title", "No token traffic in {period}.", { period: spec.phrase })}</b>
              <span>
                {view.hasRetainedHistory
                  ? t("tokens.empty.longer", " Try a longer range.")
                  : t("tokens.empty.explain", " sparkDash records token counters while it runs, so history builds up over time. Send a request to a local LLM endpoint and check back in a minute or two.")}
              </span>
            </section>
          )}

          <section className="panel tk-card tk-about" aria-labelledby="tk-about-title">
            <h2 id="tk-about-title" className="tk-card__title">
              {t("tokens.about.title", "About this data")}
            </h2>
            <ul>
              <li>
                {t("tokens.about.buckets", "Daily buckets are UTC days; hourly buckets are UTC hours shown in the time zone from Settings (browser default).")}
                {data?.history.firstDay ? (
                  <>
                    {" "}
                    {t("tokens.about.started", "Tracking began on {date} (UTC).", { date: data.history.firstDay })}
                  </>
                ) : null}
              </li>
              <li>{t("tokens.about.restart", "Counters that go backwards (an engine restart) are re-seeded from the new value, so a restart never inflates totals. Tokens served right before a restart can be missed.")}</li>
              <li>
                {t("tokens.about.retention", "Hourly history is kept for {hours} hours and daily history for {days} days. The hourly view only has data from when it was first recorded.", { hours: data?.history.retention.hours ?? 72, days: data?.history.retention.days ?? 35 })}
              </li>
              <li>
                {t("tokens.about.allTime", "All time is the lifetime total since tracking began{unavailable}; its chart shows the retained daily buckets.", { unavailable: data?.lifetime ? "" : t("tokens.about.unavailable", " (unavailable right now, so the retained days are summed instead)") })}
              </li>
              <li>
                {t("tokens.about.definitions", "Generated = tokens the model wrote. Prompt = tokens it read. Cached prefill is the part of the prompt served from the prefix cache; computed prefill is the rest. Engines that do not report cache hits count as zero cached.")}
              </li>
              {view.w.prevKeys.length === 0 && spec.count != null ? <li>{t("tokens.about.noPrevious", "No change-vs-previous figures are shown because {period} were not fully tracked.", { period: previousRangePhrase(spec.key) })}</li> : null}
            </ul>
          </section>
        </>
      ) : null}
    </div>
  );
}

function Delta({ value, suffix }: { value: number | null | undefined; suffix: string }) {
  const { t } = useTranslation();
  if (value == null || !Number.isFinite(value)) return null;
  const flat = Math.abs(value) < 0.005;
  return (
    <span className={`tk-delta ${flat ? "" : value > 0 ? "is-up" : "is-down"}`}>
      <span aria-hidden="true">{flat ? "→" : value > 0 ? "▲" : "▼"}</span> {flat ? t("tokens.delta.flat", "flat") : fmtPct(Math.abs(value))} {suffix}
    </span>
  );
}

function Tile({ label, value, unit, sub, delta, title }: { label: string; value: string; unit?: string; sub?: string; delta?: React.ReactNode; title?: string }) {
  return (
    <div className="tk-tile" title={title}>
      <span className="eyebrow">{label}</span>
      <div className="big-num">
        {value}
        {unit ? <small>{unit}</small> : null}
      </div>
      {sub ? <p className="tk-tile__sub">{sub}</p> : null}
      {delta}
    </div>
  );
}

function Tiles({ s, cmp, spec }: { s: Summary; cmp: Comparison | null; spec: (typeof RANGES)[number] }) {
  const { t } = useTranslation();
  const per = spec.unit === "hour" ? "hour" : "day";
  const prevWord = previousRangePhrase(spec.key);
  const ratio = s.genPerPrompt != null && s.generated > 0 ? s.prompt / s.generated : null;
  return (
    <section className="tk-tiles" aria-label={t("tokens.tiles.aria", "Summary for {period}", { period: spec.phrase })}>
      <Tile label={t("tokens.tiles.total", "Total tokens")} value={fmt(s.total)} sub={t("tokens.tiles.totalSub", "Generated plus prompt")} title={s.total.toLocaleString(activeLocale())} delta={<Delta value={cmp?.total} suffix={t("tokens.tiles.vs", "vs {period}", { period: prevWord })} />} />
      <Tile
        label={t("tokens.tiles.generated", "Generated")}
        value={fmt(s.generated)}
        sub={s.total > 0 ? t("tokens.tiles.share", "{ratio} of all tokens", { ratio: fmtPct(s.generated / s.total) }) : undefined}
        title={s.generated.toLocaleString(activeLocale())}
        delta={<Delta value={cmp?.generated} suffix={t("tokens.tiles.vs", "vs {period}", { period: prevWord })} />}
      />
      <Tile
        label={t("tokens.tiles.prompt", "Prompt (input)")}
        value={fmt(s.prompt)}
        sub={s.prompt > 0 ? t("tokens.tiles.promptSub", "{computed} computed, {cached} cached", { computed: fmt(s.computed), cached: fmt(s.cached) }) : t("tokens.tiles.noPrompt", "No prompt data reported")}
        title={s.prompt.toLocaleString(activeLocale())}
        delta={<Delta value={cmp?.prompt} suffix={t("tokens.tiles.vs", "vs {period}", { period: prevWord })} />}
      />
      <Tile
        label={t("tokens.tiles.cache", "Cache hit rate")}
        value={s.cacheRate == null ? "—" : fmtPct(s.cacheRate)}
        sub={s.cacheRate == null ? t("tokens.tiles.needsPrompt", "Needs prompt data") : s.cached > 0 ? t("tokens.tiles.cacheSaved", "The prefix cache saved {tokens} prefill tokens", { tokens: fmt(s.cached) }) : t("tokens.tiles.cacheNone", "The prefix cache saved nothing")}
        delta={cmp?.cachePoints != null ? <span className={`tk-delta ${Math.abs(cmp.cachePoints) < 0.5 ? "" : cmp.cachePoints > 0 ? "is-up" : "is-down"}`}>{cmp.cachePoints >= 0 ? "+" : "−"}{Math.abs(cmp.cachePoints).toFixed(1)} {t("tokens.tiles.pointsVs", "pts vs {period}", { period: prevWord })}</span> : null}
      />
      <Tile
        label={t("tokens.tiles.outputInput", "Output : input")}
        value={ratio == null ? "—" : `1 : ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}`}
        sub={ratio == null ? t("tokens.tiles.needsBoth", "Needs generated and prompt tokens") : t("tokens.tiles.ratioSub", "{ratio} prompt tokens read per token generated", { ratio: ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1) })}
      />
      <Tile
        label={t("tokens.tiles.average", "Average per {unit}", { unit: per })}
        value={fmt(Math.round(s.avgPerBucket))}
        unit={`/ ${per}`}
        sub={t("tokens.tiles.tracked", "Over {buckets} {unit} tracked", { buckets: s.elapsed, unit: per })}
      />
      <Tile
        label={t("tokens.tiles.busiest", "Busiest {unit}", { unit: per })}
        value={s.busiest ? fmt(s.busiest.total) : "—"}
        sub={s.busiest ? bucketTitle(s.busiest.key, spec.unit).replace(/ \((UTC|local)\)$/, "") : t("tokens.tiles.noTraffic", "No traffic yet")}
        title={s.busiest ? s.busiest.total.toLocaleString(activeLocale()) : undefined}
      />
    </section>
  );
}
