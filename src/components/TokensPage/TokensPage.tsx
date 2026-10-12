import { t } from "../../i18n";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
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
} from "./tokenStats";
import "../../styles/tokens.css";

const POLL_MS = 30_000;
const fmt = formatTokensCompact;

const GROUPS: { key: GroupBy; label: string }[] = [
  { key: "type", label: t("tokens.g_type") },
  { key: "model", label: t("tokens.g_model") },
  { key: "spark", label: t("tokens.g_spark") },
];
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
  const [range, setRange] = useState<RangeKey>("7d");
  const [groupBy, setGroupBy] = useState<GroupBy>("type");
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [copyMsg, setCopyMsg] = useState<{ ok: boolean; text: string } | null>(null);

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
          if (!cancelled) setError(e instanceof Error ? e.message : "Could not load token history");
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
    const timer = setTimeout(() => setCopyMsg(null), 4000);
    return () => clearTimeout(timer);
  }, [copyMsg]);

  const sparkNames = useMemo(() => new Map(sparks.map((s) => [s.id, s.name])), [sparks]);
  const tokenResetChoices = useMemo<ClearChoice<string | undefined>[]>(
    () => [
      { id: "all", label: t("tokens.all_sparks"), ask: t("tokens.reset_all_ask"), arg: undefined },
      ...sparks.map((s) => ({ id: s.id, label: s.name, ask: t("tokens.reset_one_ask", { spark: s.name }), arg: s.id })),
    ],
    [sparks]
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
          })
        : [],
    [view, sparkName]
  );

  const copyCsv = async () => {
    if (!view) return;
    const text = buildCsv(view.inRange, sparkName);
    const n = view.inRange.length;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else throw new Error("no clipboard");
      setCopyMsg({ ok: true, text: t("tokens.copied", { n }) });
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
        setCopyMsg(ok ? { ok: true, text: t("tokens.copied", { n }) } : { ok: false, text: t("tokens.copy_failed") });
      } catch {
        setCopyMsg({ ok: false, text: t("tokens.copy_failed") });
      }
    }
  };

  const spec = RANGES.find((r) => r.key === range) ?? RANGES[1];
  const unitWord = spec.unit === "hour" ? t("tokens.hour") : t("tokens.day");

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
      ? t("tokens.empty_hourly")
      : t("tokens.empty_range");

  return (
    <div className="tk">
      <header className="page-head">
        <div>
          <h1>{t("tokens.title")}</h1>
          <p className="page-head__sub">{t("tokens.subtitle")}</p>
        </div>
        <div className="page-head__tools">
          <div className="seg" role="group" aria-label={t("tokens.time_range")}>
            {RANGES.map((r) => (
              <button key={r.key} type="button" className={r.key === range ? "is-on" : undefined} aria-pressed={r.key === range} onClick={() => setRange(r.key)}>
                {r.label}
              </button>
            ))}
          </div>
          <ClearMenu
            label={t("tokens.reset_ellipsis")}
            choices={tokenResetChoices}
            note={t("tokens.reset_note")}
            onRun={async (id) => {
              const { removed } = await resetTokenTotals(id);
              setTick((t) => t + 1);
              return removed;
            }}
          />
          <button type="button" className="btn btn--sm" onClick={copyCsv} disabled={!view || view.inRange.length === 0}>
            {t("tokens.copy_csv")}
          </button>
          <span className={`tk-copymsg${copyMsg && !copyMsg.ok ? " is-err" : ""}`} role="status" aria-live="polite">
            {copyMsg?.text}
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
          <span>{data ? t("tokens.stale_data", { error }) : t("tokens.load_error", { error })}</span>
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
                    {t("tokens.per_unit", { unit: unitWord })}
                  </h2>
                  <p className="tk-card__sub">
                    {spec.unit === "hour" ? t("tokens.sub_hourly") : range === "all" ? t("tokens.sub_daily_all") : t("tokens.sub_daily")}
                  </p>
                </div>
                <div className="tk-card__tools">
                  <span className="eyebrow">{t("tokens.group_by")}</span>
                  <div className="seg" role="group" aria-label={t("tokens.group_by")}>
                    {GROUPS.map((g) => (
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
                ariaLabel={t("tokens.chart_aria", { unit: unitWord, period: spec.phrase })}
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
                <p className="tk-card__sub">{t("tokens.insights_empty", { period: spec.phrase })}</p>
              )}
            </section>
          </div>

          {view.summary.total > 0 ? (
            <>
              <section className="panel tk-card" aria-labelledby="tk-models-title">
                <div className="tk-card__head">
                  <div>
                    <h2 id="tk-models-title" className="tk-card__title">
                      {t("tokens.by_model")}
                    </h2>
                    <p className="tk-card__sub">
                      {t("tokens.models_sub", { n: view.models.length, period: spec.phrase })}
                    </p>
                  </div>
                </div>
                <ModelTable rows={view.models} sparkName={sparkName} nowMs={view.at} />
              </section>

              <section className="panel tk-card" aria-labelledby="tk-eps-title">
                <div className="tk-card__head">
                  <div>
                    <h2 id="tk-eps-title" className="tk-card__title">
                      {t("tokens.by_endpoint")}
                    </h2>
                    <p className="tk-card__sub">{t("tokens.endpoints_sub")}</p>
                  </div>
                </div>
                <EndpointTable rows={view.endpoints} sparkName={sparkName} knownSpark={knownSpark} onSelectSpark={onSelectSpark} />
              </section>
            </>
          ) : (
            <section className="panel tk-note" role="status">
              <b>{t("tokens.no_traffic", { period: spec.phrase })}</b>
              <span>
                {view.hasRetainedHistory
                  ? t("tokens.try_longer")
                  : t("tokens.builds_up")}
              </span>
            </section>
          )}

          <section className="panel tk-card tk-about" aria-labelledby="tk-about-title">
            <h2 id="tk-about-title" className="tk-card__title">
              {t("tokens.h_about")}
            </h2>
            <ul>
              <li>
                {t("tokens.fn_buckets")}
                {data?.history.firstDay ? (
                  <>
                    {" "}
                    {t("tokens.fn_began")}<b>{data.history.firstDay}</b>{t("tokens.fn_began_utc")}
                  </>
                ) : null}
              </li>
              <li>{t("tokens.fn_restart")}</li>
              <li>
                {t("tokens.fn_retention", { hours: data?.history.retention.hours ?? 72, days: data?.history.retention.days ?? 35 })}
              </li>
              <li>
                {t("tokens.fn_alltime", { fallback: data?.lifetime ? "" : t("tokens.fn_alltime_fallback") })}
              </li>
              <li>
                {t("tokens.fn_definitions")}
              </li>
              {view.w.prevKeys.length === 0 && spec.count != null ? <li>{t("tokens.fn_no_prev", { period: spec.phrase })}</li> : null}
            </ul>
          </section>
        </>
      ) : null}
    </div>
  );
}

function Delta({ value, suffix }: { value: number | null | undefined; suffix: string }) {
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
  const per = spec.unit === "hour" ? t("tokens.hour") : t("tokens.day");
  const prevWord = t("tokens.prev_word", { period: spec.phrase });
  const ratio = s.genPerPrompt != null && s.generated > 0 ? s.prompt / s.generated : null;
  return (
    <section className="tk-tiles" aria-label={t("tokens.summary_aria", { period: spec.phrase })}>
      <Tile label={t("tokens.tile_total")} value={fmt(s.total)} sub={t("tokens.tile_total_sub")} title={s.total.toLocaleString()} delta={<Delta value={cmp?.total} suffix={t("tokens.vs_prev", { period: prevWord })} />} />
      <Tile
        label={t("tokens.tile_generated")}
        value={fmt(s.generated)}
        sub={s.total > 0 ? t("tokens.pct_of_all", { pct: fmtPct(s.generated / s.total) }) : undefined}
        title={s.generated.toLocaleString()}
        delta={<Delta value={cmp?.generated} suffix={`vs ${prevWord}`} />}
      />
      <Tile
        label={t("tokens.tile_prompt")}
        value={fmt(s.prompt)}
        sub={s.prompt > 0 ? t("tokens.computed_cached", { computed: fmt(s.computed), cached: fmt(s.cached) }) : t("tokens.no_prompt_data")}
        title={s.prompt.toLocaleString()}
        delta={<Delta value={cmp?.prompt} suffix={`vs ${prevWord}`} />}
      />
      <Tile
        label={t("tokens.tile_cache")}
        value={s.cacheRate == null ? "—" : fmtPct(s.cacheRate)}
        sub={s.cacheRate == null ? t("tokens.needs_prompt") : s.cached > 0 ? t("tokens.cache_saved", { v: fmt(s.cached) }) : t("tokens.cache_saved_nothing")}
        delta={cmp?.cachePoints != null ? <span className={`tk-delta ${Math.abs(cmp.cachePoints) < 0.5 ? "" : cmp.cachePoints > 0 ? "is-up" : "is-down"}`}>{cmp.cachePoints >= 0 ? "+" : "−"}{Math.abs(cmp.cachePoints).toFixed(1)} {t("tokens.pts_vs", { period: prevWord })}</span> : null}
      />
      <Tile
        label={t("tokens.tile_ratio")}
        value={ratio == null ? "—" : `1 : ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}`}
        sub={ratio == null ? t("tokens.needs_both") : t("tokens.per_gen", { n: ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1) })}
      />
      <Tile
        label={t("tokens.tile_avg", { unit: per })}
        value={fmt(Math.round(s.avgPerBucket))}
        unit={`/ ${per}`}
        sub={t("tokens.over_tracked", { n: s.elapsed, unit: per })}
      />
      <Tile
        label={t("tokens.tile_busiest", { unit: per })}
        value={s.busiest ? fmt(s.busiest.total) : "—"}
        sub={s.busiest ? bucketTitle(s.busiest.key, spec.unit).replace(/ \((UTC|local)\)$/, "") : t("tokens.no_traffic_yet")}
        title={s.busiest ? s.busiest.total.toLocaleString() : undefined}
      />
    </section>
  );
}
