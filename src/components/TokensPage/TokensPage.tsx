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
  type TokenInsightLabels,
} from "./tokenStats";
import "../../styles/tokens.css";

const POLL_MS = 30_000;
const fmt = formatTokensCompact;

const TYPE_COLORS: Record<string, string> = {
  generated: "var(--color-accent)",
  cached: "var(--color-info)",
  computed: "var(--color-violet)",
  unreported: "var(--color-faint)",
};
const GROUP_COLORS = ["var(--color-accent)", "var(--color-info)", "var(--color-violet)", "var(--color-success)", "var(--color-warning)"];

interface Loaded {
  history: TokenHistory;
  /** Lifetime totals; null when that endpoint failed (All time then falls back to retained days). */
  lifetime: LlmTokenSeriesTotals[] | null;
  at: number;
}

export function TokensPage({ sparks, onSelectSpark }: { sparks: SparkSnapshot[]; onSelectSpark?: (id: string) => void }) {
  const { t } = useTranslation("statistics");
  const [range, setRange] = useState<RangeKey>("7d");
  const [groupBy, setGroupBy] = useState<GroupBy>("type");
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [copyMsg, setCopyMsg] = useState<{ ok: boolean; count: number } | null>(null);

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
          if (!cancelled) setError(e instanceof Error ? e.message : "");
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
  }, [tick]);

  useEffect(() => {
    if (!copyMsg) return;
    const t = setTimeout(() => setCopyMsg(null), 4000);
    return () => clearTimeout(t);
  }, [copyMsg]);

  const sparkNames = useMemo(() => new Map(sparks.map((s) => [s.id, s.name])), [sparks]);
  const tokenResetChoices = useMemo<ClearChoice<string | undefined>[]>(
    () => [
      { id: "all", label: t("tokens.allSparks"), ask: t("tokens.resetAll"), arg: undefined },
      ...sparks.map((s) => ({ id: s.id, label: s.name, ask: t("tokens.resetSpark", { name: s.name }), arg: s.id })),
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
  }, [data, range]);

  const grouped = useMemo(
    () => (view ? groupBuckets(view.inRange, view.w.keys, groupBy, { sparkName }) : null),
    [view, groupBy, sparkName]
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
            labels: tokenInsightLabels(t, view.w.spec, view.summary),
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
      setCopyMsg({ ok: true, count: n });
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
        setCopyMsg(ok ? { ok: true, count: n } : { ok: false, count: n });
      } catch {
        setCopyMsg({ ok: false, count: n });
      }
    }
  };

  const spec = RANGES.find((r) => r.key === range) ?? RANGES[1];
  const rangeLabel = (key: RangeKey) => key === "24h" ? t("tokens.range24h") : key === "7d" ? t("tokens.range7d") : key === "14d" ? t("tokens.range14d") : key === "30d" ? t("tokens.range30d") : t("tokens.rangeAll");
  const period = range === "24h" ? t("tokens.period24h") : range === "7d" ? t("tokens.period7d") : range === "14d" ? t("tokens.period14d") : range === "30d" ? t("tokens.period30d") : t("tokens.periodAll");
  const typeLabels: Record<string, string> = { generated: t("tokens.generated"), cached: t("tokens.cachedPrefill"), computed: t("tokens.computedPrefill"), unreported: t("tokens.unreportedPrompt") };
  const unitWord = spec.unit === "hour" ? t("tokens.hour") : t("tokens.day");
  const chartSubtitle = spec.unit === "hour" ? t("tokens.hourlySubtitle") : range === "all" ? t("tokens.allSubtitle") : t("tokens.dailySubtitle");
  const groups: { key: GroupBy; label: string }[] = [
    { key: "type", label: t("tokens.groupType") },
    { key: "model", label: t("tokens.groupModel") },
    { key: "spark", label: t("tokens.groupSpark") },
  ];

  const series: BarSeries[] = (grouped?.series ?? []).map((s, i) => ({
    id: s.id,
    label: groupBy === "type" ? typeLabels[s.id] ?? s.label : s.id === OTHER_ID ? t("tokens.other") : s.label,
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
      ? t("tokens.emptyHourly")
      : t("tokens.empty");

  return (
    <div className="tk">
      <header className="page-head">
        <div>
          <h1>{t("tokens.title")}</h1>
          <p className="page-head__sub">{t("tokens.subtitle")}</p>
        </div>
        <div className="page-head__tools">
          <div className="seg" role="group" aria-label={t("tokens.rangeAria")}>
            {RANGES.map((r) => (
              <button key={r.key} type="button" className={r.key === range ? "is-on" : undefined} aria-pressed={r.key === range} onClick={() => setRange(r.key)}>
                {rangeLabel(r.key)}
              </button>
            ))}
          </div>
          <ClearMenu
            label={t("tokens.reset.label")}
            choices={tokenResetChoices}
            note={t("tokens.reset.note")}
            copy={{ cancel: t("clear.cancel"), delete: t("clear.delete"), deleting: t("clear.deleting"), irreversible: t("clear.irreversible"), nothing: t("clear.nothing"), deleted: (count) => t("clear.deleted", { count }), failed: t("clear.failed") }}
            onRun={async (id) => {
              const { removed } = await resetTokenTotals(id);
              setTick((t) => t + 1);
              return removed;
            }}
          />
          <button type="button" className="btn btn--sm" onClick={copyCsv} disabled={!view || view.inRange.length === 0}>
            {t("tokens.copyCsv")}
          </button>
          <span className={`tk-copymsg${copyMsg && !copyMsg.ok ? " is-err" : ""}`} role="status" aria-live="polite">
            {copyMsg ? copyMsg.ok ? t("tokens.copySuccess", { count: copyMsg.count }) : t("tokens.copyFailed") : null}
          </span>
        </div>
      </header>

      {!data && !error ? (
        <div className="panel tk-note" role="status">
          {t("tokens.loading")}
        </div>
      ) : null}

      {error ? (
        <div className="panel tk-note tk-note--err" role="alert">
          <span>{data ? t("tokens.staleError", { error }) : error ? `${t("tokens.loadError")}: ${error}` : t("tokens.loadError")}</span>
          <button type="button" className="btn btn--sm" onClick={() => setTick((t) => t + 1)}>
            {t("tokens.retry")}
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
                    {t("tokens.chartTitle", { unit: unitWord })}
                  </h2>
                  <p className="tk-card__sub">
                    {chartSubtitle}
                  </p>
                </div>
                <div className="tk-card__tools">
                  <span className="eyebrow">{t("tokens.groupBy")}</span>
                  <div className="seg" role="group" aria-label={t("tokens.groupChartBy")}>
                    {groups.map((g) => (
                      <button key={g.key} type="button" className={g.key === groupBy ? "is-on" : undefined} aria-pressed={g.key === groupBy} onClick={() => setGroupBy(g.key)}>
                        {g.label}
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
              totalLabel={t("tokens.table.total")}
                ariaLabel={t("tokens.chartAria", { unit: unitWord, period, group: groups.find((g) => g.key === groupBy)?.label })}
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
                {t("tokens.insights")}
              </h2>
              {insights.length > 0 ? (
                <ul className="tk-insights">
                  {insights.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              ) : (
                <p className="tk-card__sub">{t("tokens.insightsEmpty", { period })}</p>
              )}
            </section>
          </div>

          {view.summary.total > 0 ? (
            <>
              <section className="panel tk-card" aria-labelledby="tk-models-title">
                <div className="tk-card__head">
                  <div>
                    <h2 id="tk-models-title" className="tk-card__title">
                      {t("tokens.byModel")}
                    </h2>
                    <p className="tk-card__sub">
                      {t("tokens.modelsSummary", { count: view.models.length, period })}
                    </p>
                  </div>
                </div>
                <ModelTable rows={view.models} sparkName={sparkName} nowMs={view.at} />
              </section>

              <section className="panel tk-card" aria-labelledby="tk-eps-title">
                <div className="tk-card__head">
                  <div>
                    <h2 id="tk-eps-title" className="tk-card__title">
                      {t("tokens.byEndpoint")}
                    </h2>
                    <p className="tk-card__sub">{t("tokens.endpointSummary")}</p>
                  </div>
                </div>
                <EndpointTable rows={view.endpoints} sparkName={sparkName} knownSpark={knownSpark} onSelectSpark={onSelectSpark} />
              </section>
            </>
          ) : (
            <section className="panel tk-note" role="status">
              <b>{t("tokens.noTraffic", { period })}</b>
              <span>
                {view.hasRetainedHistory
                  ? t("tokens.tryLonger")
                  : t("tokens.historyBuilds")}
              </span>
            </section>
          )}

          <section className="panel tk-card tk-about" aria-labelledby="tk-about-title">
            <h2 id="tk-about-title" className="tk-card__title">
              {t("tokens.about")}
            </h2>
            <ul>
              <li>
                {t("tokens.aboutBuckets")}
                {data?.history.firstDay ? (
                  <>
                    {" "}
                    {t("tokens.trackingBegan", { date: data.history.firstDay })}
                  </>
                ) : null}
              </li>
              <li>{t("tokens.aboutRestart")}</li>
              <li>
                {t("tokens.retention", { hours: data?.history.retention.hours ?? 72, days: data?.history.retention.days ?? 35 })}
              </li>
              <li>
                {data?.lifetime ? t("tokens.aboutLifetime") : t("tokens.aboutLifetimeFallback")}
              </li>
              <li>
                {t("tokens.accounting")}
              </li>
              {view.w.prevKeys.length === 0 && spec.count != null ? <li>{t("tokens.previousIncomplete")}</li> : null}
            </ul>
          </section>
        </>
      ) : null}
    </div>
  );
}

function tokenInsightLabels(t: ReturnType<typeof useTranslation>["t"], spec: (typeof RANGES)[number], summary: Summary): TokenInsightLabels {
  const unit = spec.unit === "hour" ? t("tokens.hour") : t("tokens.day");
  const period = spec.key === "all" ? t("tokens.retainedHistory") : rangePhrase(t, spec.key);
  const ratio = summary.genPerPrompt ?? 0;
  const shape = ratio < 0.1 ? t("tokens.shapeVeryInput") : ratio < 0.5 ? t("tokens.shapeInput") : ratio <= 1.5 ? t("tokens.shapeBalanced") : t("tokens.shapeOutput");
  return {
    busiest: (v) => t("tokens.insightBusiest", { ...v, unit, period }), cacheUnmeasured: (v) => t("tokens.insightCacheUnmeasured", v), cacheUnavailable: () => t("tokens.insightCacheUnavailable"), cachePartial: (v) => t("tokens.insightCachePartial", v), cacheSaved: (v) => t("tokens.insightCacheSaved", v), cacheNone: () => t("tokens.insightCacheNone"),
    onlyModel: (v) => t("tokens.insightOnlyModel", v), dominantModel: (v) => t("tokens.insightDominantModel", v), spreadModels: (v) => t("tokens.insightSpreadModels", v), workload: (v) => t("tokens.insightWorkload", { ...v, shape }), idle: (v) => t("tokens.insightIdle", { ...v, unit, period }), topSpark: (v) => t("tokens.insightTopSpark", v), flat: (v) => t("tokens.insightFlat", { ...v, period }), changed: (v) => t("tokens.insightChanged", { ...v, direction: v.direction === "up" ? t("tokens.up") : t("tokens.down"), period }),
  };
}

function Delta({ value, suffix }: { value: number | null | undefined; suffix: string }) {
  const { t } = useTranslation("statistics");
  if (value == null || !Number.isFinite(value)) return null;
  const flat = Math.abs(value) < 0.005;
  return (
    <span className={`tk-delta ${flat ? "" : value > 0 ? "is-up" : "is-down"}`}>
      <span aria-hidden="true">{flat ? "→" : value > 0 ? "▲" : "▼"}</span> {flat ? t("tokens.flat") : fmtPct(Math.abs(value))} {suffix}
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
  const { t } = useTranslation("statistics");
  const per = spec.unit === "hour" ? t("tokens.hour") : t("tokens.day");
  const period = rangePhrase(t, spec.key);
  const prevWord = t("tokens.previousPeriod", { period: spec.count == null ? t("tokens.periodAll") : `${spec.count} ${spec.unit === "hour" ? t("tokens.hour", { count: spec.count }) : t("tokens.day", { count: spec.count })}` });
  const ratio = s.genPerPrompt != null && s.generated > 0 ? s.prompt / s.generated : null;
  return (
    <section className="tk-tiles" aria-label={t("tokens.summaryFor", { period })}>
      <Tile label={t("tokens.totalTokens")} value={fmt(s.total)} sub={t("tokens.generatedPlusPrompt")} title={s.total.toLocaleString()} delta={<Delta value={cmp?.total} suffix={prevWord} />} />
      <Tile
        label={t("tokens.generated")}
        value={fmt(s.generated)}
        sub={s.total > 0 ? t("tokens.shareOfAll", { share: fmtPct(s.generated / s.total) }) : undefined}
        title={s.generated.toLocaleString()}
        delta={<Delta value={cmp?.generated} suffix={prevWord} />}
      />
      <Tile
        label={t("tokens.promptInput")}
        value={fmt(s.prompt)}
        sub={
          s.prompt <= 0
            ? t("tokens.noPromptData")
            : s.unreported > 0
              ? t("tokens.promptBreakdownUnreported", { computed: fmt(s.computed), cached: fmt(s.cached), unreported: fmt(s.unreported) })
              : t("tokens.promptBreakdown", { computed: fmt(s.computed), cached: fmt(s.cached) })
        }
        title={s.prompt.toLocaleString()}
        delta={<Delta value={cmp?.prompt} suffix={prevWord} />}
      />
      <Tile
        label={t("tokens.cacheHitRate")}
        value={s.cacheRate == null ? "—" : fmtPct(s.cacheRate)}
        sub={
          s.prompt <= 0
            ? t("tokens.needsPrompt")
            : s.cacheReported === false
              ? t("tokens.noCacheHits")
              : s.unreported > 0
                ? t("tokens.cacheMeasured", { measured: fmt(s.prompt - s.unreported), prompt: fmt(s.prompt) })
                : s.cached > 0
                ? t("tokens.cacheSaved", { cached: fmt(s.cached) })
                : t("tokens.cacheSavedNone")
        }
        delta={cmp?.cachePoints != null ? <span className={`tk-delta ${Math.abs(cmp.cachePoints) < 0.5 ? "" : cmp.cachePoints > 0 ? "is-up" : "is-down"}`}>{cmp.cachePoints >= 0 ? "+" : "−"}{Math.abs(cmp.cachePoints).toFixed(1)} {t("tokens.points")} {prevWord}</span> : null}
      />
      <Tile
        label={t("tokens.outputInput")}
        value={ratio == null ? "—" : `1 : ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}`}
        sub={ratio == null ? t("tokens.needsGeneratedPrompt") : t("tokens.promptPerGenerated", { value: ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1) })}
      />
      <Tile
        label={t("tokens.averagePer", { unit: per })}
        value={fmt(Math.round(s.avgPerBucket))}
        unit={`/ ${per}`}
        sub={t("tokens.trackedOver", { count: s.elapsed, unit: spec.unit === "hour" ? t("tokens.hour", { count: s.elapsed }) : t("tokens.day", { count: s.elapsed }) })}
      />
      <Tile
        label={t("tokens.busiest", { unit: per })}
        value={s.busiest ? fmt(s.busiest.total) : "—"}
        sub={s.busiest ? bucketTitle(s.busiest.key, spec.unit).replace(/ \((UTC|local)\)$/, "") : t("tokens.noTrafficYet")}
        title={s.busiest ? s.busiest.total.toLocaleString() : undefined}
      />
    </section>
  );
}

function rangePhrase(t: ReturnType<typeof useTranslation>["t"], key: RangeKey): string {
  return key === "24h" ? t("tokens.period24h") : key === "7d" ? t("tokens.period7d") : key === "14d" ? t("tokens.period14d") : key === "30d" ? t("tokens.period30d") : t("tokens.periodAll");
}
