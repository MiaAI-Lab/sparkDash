import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { fetchTokenHistory } from "../../api/client";
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
  { key: "type", label: "Type" },
  { key: "model", label: "Model" },
  { key: "spark", label: "Spark" },
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
    const t = setTimeout(() => setCopyMsg(null), 4000);
    return () => clearTimeout(t);
  }, [copyMsg]);

  const sparkNames = useMemo(() => new Map(sparks.map((s) => [s.id, s.name])), [sparks]);
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
      setCopyMsg({ ok: true, text: `Copied ${n} row${n === 1 ? "" : "s"} as CSV` });
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
        setCopyMsg(ok ? { ok: true, text: `Copied ${n} row${n === 1 ? "" : "s"} as CSV` } : { ok: false, text: "Copy failed: the browser blocked clipboard access" });
      } catch {
        setCopyMsg({ ok: false, text: "Copy failed: the browser blocked clipboard access" });
      }
    }
  };

  const spec = RANGES.find((r) => r.key === range) ?? RANGES[1];
  const unitWord = spec.unit === "hour" ? "hour" : "day";

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
      ? "No hourly traffic recorded yet. Hourly history only builds up while sparkDash is running, starting from the update that added it."
      : "No token traffic recorded in this range yet. History builds up while sparkDash is running.";

  return (
    <div className="tk">
      <header className="page-head">
        <div>
          <h1>Token totals</h1>
          <p className="page-head__sub">What your Sparks generated and read, by type, model and endpoint, built from the counters sparkDash polls from each inference engine.</p>
        </div>
        <div className="page-head__tools">
          <div className="seg" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button key={r.key} type="button" className={r.key === range ? "is-on" : undefined} aria-pressed={r.key === range} onClick={() => setRange(r.key)}>
                {r.label}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn--sm" onClick={copyCsv} disabled={!view || view.inRange.length === 0}>
            Copy CSV
          </button>
          <span className={`tk-copymsg${copyMsg && !copyMsg.ok ? " is-err" : ""}`} role="status" aria-live="polite">
            {copyMsg?.text}
          </span>
        </div>
      </header>

      {!data && !error ? (
        <div className="panel tk-note" role="status">
          Loading token history…
        </div>
      ) : null}

      {error ? (
        <div className="panel tk-note tk-note--err" role="alert">
          <span>{data ? `Showing the last loaded data. Refresh failed: ${error}` : `Could not load token history: ${error}`}</span>
          <button type="button" className="btn btn--sm" onClick={() => setTick((t) => t + 1)}>
            Retry
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
                    Tokens per {unitWord}
                  </h2>
                  <p className="tk-card__sub">
                    {spec.unit === "hour" ? "Local-time hours, oldest to newest" : range === "all" ? "UTC days, as far back as history is kept" : "UTC days, oldest to newest"}
                  </p>
                </div>
                <div className="tk-card__tools">
                  <span className="eyebrow">Group by</span>
                  <div className="seg" role="group" aria-label="Group chart by">
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
                ariaLabel={`Stacked bar chart of tokens per ${unitWord} for ${spec.phrase}, grouped by ${groupBy}`}
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
                Insights
              </h2>
              {insights.length > 0 ? (
                <ul className="tk-insights">
                  {insights.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              ) : (
                <p className="tk-card__sub">Insights appear once there is traffic in {spec.phrase}.</p>
              )}
            </section>
          </div>

          {view.summary.total > 0 ? (
            <>
              <section className="panel tk-card" aria-labelledby="tk-models-title">
                <div className="tk-card__head">
                  <div>
                    <h2 id="tk-models-title" className="tk-card__title">
                      By model
                    </h2>
                    <p className="tk-card__sub">
                      {view.models.length} model{view.models.length === 1 ? "" : "s"} in {spec.phrase}. Click a column to sort.
                    </p>
                  </div>
                </div>
                <ModelTable rows={view.models} sparkName={sparkName} nowMs={view.at} />
              </section>

              <section className="panel tk-card" aria-labelledby="tk-eps-title">
                <div className="tk-card__head">
                  <div>
                    <h2 id="tk-eps-title" className="tk-card__title">
                      By Spark and endpoint
                    </h2>
                    <p className="tk-card__sub">One row per Spark and inference port. Select a Spark to open it.</p>
                  </div>
                </div>
                <EndpointTable rows={view.endpoints} sparkName={sparkName} knownSpark={knownSpark} onSelectSpark={onSelectSpark} />
              </section>
            </>
          ) : (
            <section className="panel tk-note" role="status">
              <b>No token traffic in {spec.phrase}.</b>
              <span>
                {view.hasRetainedHistory
                  ? " Try a longer range."
                  : " sparkDash records token counters while it runs, so history builds up over time. Send a request to a local LLM endpoint and check back in a minute or two."}
              </span>
            </section>
          )}

          <section className="panel tk-card tk-about" aria-labelledby="tk-about-title">
            <h2 id="tk-about-title" className="tk-card__title">
              About this data
            </h2>
            <ul>
              <li>
                Daily buckets are <b>UTC days</b>; hourly buckets are UTC hours shown in your local time.
                {data?.history.firstDay ? (
                  <>
                    {" "}
                    Tracking began on <b>{data.history.firstDay}</b> (UTC).
                  </>
                ) : null}
              </li>
              <li>Counters that go backwards (an engine restart) are re-seeded from the new value, so a restart never inflates totals. Tokens served right before a restart can be missed.</li>
              <li>
                Hourly history is kept for {data?.history.retention.hours ?? 72} hours and daily history for {data?.history.retention.days ?? 35} days. The hourly view only has data from when
                it was first recorded.
              </li>
              <li>
                <b>All time</b> is the lifetime total since tracking began{data?.lifetime ? "" : " (unavailable right now, so the retained days are summed instead)"}; its chart shows the retained daily
                buckets.
              </li>
              <li>
                Generated = tokens the model wrote. Prompt = tokens it read. Cached prefill is the part of the prompt served from the prefix cache; computed prefill is the rest. Engines that do not report cache
                hits count as zero cached.
              </li>
              {view.w.prevKeys.length === 0 && spec.count != null ? <li>No change-vs-previous figures are shown because the previous {spec.phrase.replace("the last ", "")} were not fully tracked.</li> : null}
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
      <span aria-hidden="true">{flat ? "→" : value > 0 ? "▲" : "▼"}</span> {flat ? "flat" : fmtPct(Math.abs(value))} {suffix}
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
  const per = spec.unit === "hour" ? "hour" : "day";
  const prevWord = `prev. ${spec.phrase.replace("the last ", "")}`;
  const ratio = s.genPerPrompt != null && s.generated > 0 ? s.prompt / s.generated : null;
  return (
    <section className="tk-tiles" aria-label={`Summary for ${spec.phrase}`}>
      <Tile label="Total tokens" value={fmt(s.total)} sub="Generated plus prompt" title={s.total.toLocaleString()} delta={<Delta value={cmp?.total} suffix={`vs ${prevWord}`} />} />
      <Tile
        label="Generated"
        value={fmt(s.generated)}
        sub={s.total > 0 ? `${fmtPct(s.generated / s.total)} of all tokens` : undefined}
        title={s.generated.toLocaleString()}
        delta={<Delta value={cmp?.generated} suffix={`vs ${prevWord}`} />}
      />
      <Tile
        label="Prompt (input)"
        value={fmt(s.prompt)}
        sub={s.prompt > 0 ? `${fmt(s.computed)} computed, ${fmt(s.cached)} cached` : "No prompt data reported"}
        title={s.prompt.toLocaleString()}
        delta={<Delta value={cmp?.prompt} suffix={`vs ${prevWord}`} />}
      />
      <Tile
        label="Cache hit rate"
        value={s.cacheRate == null ? "—" : fmtPct(s.cacheRate)}
        sub={s.cacheRate == null ? "Needs prompt data" : s.cached > 0 ? `The prefix cache saved ${fmt(s.cached)} prefill tokens` : "The prefix cache saved nothing"}
        delta={cmp?.cachePoints != null ? <span className={`tk-delta ${Math.abs(cmp.cachePoints) < 0.5 ? "" : cmp.cachePoints > 0 ? "is-up" : "is-down"}`}>{cmp.cachePoints >= 0 ? "+" : "−"}{Math.abs(cmp.cachePoints).toFixed(1)} pts vs {prevWord}</span> : null}
      />
      <Tile
        label="Output : input"
        value={ratio == null ? "—" : `1 : ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}`}
        sub={ratio == null ? "Needs generated and prompt tokens" : `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)} prompt tokens read per token generated`}
      />
      <Tile
        label={`Average per ${per}`}
        value={fmt(Math.round(s.avgPerBucket))}
        unit={`/ ${per}`}
        sub={`Over ${s.elapsed} ${per}${s.elapsed === 1 ? "" : "s"} tracked`}
      />
      <Tile
        label={`Busiest ${per}`}
        value={s.busiest ? fmt(s.busiest.total) : "—"}
        sub={s.busiest ? bucketTitle(s.busiest.key, spec.unit).replace(/ \((UTC|local)\)$/, "") : "No traffic yet"}
        title={s.busiest ? s.busiest.total.toLocaleString() : undefined}
      />
    </section>
  );
}
