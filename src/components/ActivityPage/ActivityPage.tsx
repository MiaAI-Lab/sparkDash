import { t } from "../../i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SparkSnapshot } from "../../api/types";
import { StackedBarChart, type BarBucket, type BarSeries } from "../ui/StackedBarChart";
import { RotateIcon, SearchIcon, XIcon } from "../ui/icons";
import { EventRow } from "./EventRow";
import { ClearMenu } from "../ui/ClearMenu";
import {
  CATEGORIES, EMPTY_FILTER, NO_SPARK, SEVERITIES, SEVERITY_LABEL, countByCategory, countBySeverity, countBySpark,
  eventsPerDay, exportText, filterEvents, groupByDay, isFilterActive, sparkOptions, summarize,
  type ActivityFilter, type CategoryId, type RangeId, type Severity,
} from "./activityStats";
import { useActivityFeed } from "./useActivityFeed";
import "../../styles/activity.css";

const DAY_MS = 86_400_000;
const ACTIVITY_CLEAR = [
  { id: "7d", label: t("energy.older_7d"), ask: t("activity.older_7d_ask"), arg: 7 * DAY_MS },
  { id: "24h", label: t("energy.older_24h"), ask: t("activity.older_24h_ask"), arg: DAY_MS },
  { id: "all", label: t("energy.older_all"), ask: t("activity.older_all_ask"), arg: undefined },
] as const;

const SERIES: readonly BarSeries[] = [
  { id: "error", label: "activity.errors", color: "var(--color-danger)" },
  { id: "warn", label: "activity.warnings", color: "var(--color-warning)" },
  { id: "success", label: "activity.success", color: "var(--color-success)" },
  { id: "info", label: "activity.info", color: "var(--color-info)" },
];

const RANGES: readonly { id: RangeId; label: string }[] = [
  { id: "24h", label: "24 h" },
  { id: "7d", label: "7 d" },
  { id: "all", label: "activity.all" },
];

const SEV_CHIPS: readonly { id: Severity; label: string }[] = [
  { id: "error", label: "activity.errors" },
  { id: "warn", label: "activity.warnings" },
  { id: "success", label: "activity.success" },
  { id: "info", label: "activity.info" },
];

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

function formatUpdated(ts: number | null, now: number): string {
  if (ts == null) return t("activity.connecting");
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 5 ? t("tokens.just_now") : s < 60 ? t("activity.sec_ago", { n: s }) : t("tokens.min_ago", { n: Math.floor(s / 60) });
}

/** Fallback for browsers or contexts without the async clipboard API. */
function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.className = "ac-offscreen";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function ActivityPage({ sparks, onSelectSpark }: { sparks: SparkSnapshot[]; onSelectSpark?: (id: string) => void }) {
  const [filter, setFilter] = useState<ActivityFilter>(EMPTY_FILTER);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const [copyMsg, setCopyMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const awayRef = useRef(false);

  const onArrive = useCallback((n: number) => {
    if (awayRef.current) setUnseen((c) => c + n);
  }, []);
  const feed = useActivityFeed(onArrive);
  const { events } = feed;

  // Clock for relative labels and the Today/Yesterday headings.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  // "Scrolled away" = the timeline's top edge has left the viewport (any scroll container).
  useEffect(() => {
    const check = () => {
      const top = topRef.current?.getBoundingClientRect().top ?? 0;
      const isAway = top < -120;
      awayRef.current = isAway;
      setAway(isAway);
      if (!isAway) setUnseen(0);
    };
    window.addEventListener("scroll", check, { passive: true, capture: true });
    return () => window.removeEventListener("scroll", check, { capture: true });
  }, []);

  const toggle = useCallback((id: number) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const summary = useMemo(() => summarize(events, now), [events, now]);
  const buckets = useMemo(() => eventsPerDay(events, now), [events, now]);
  const chartBuckets: BarBucket[] = useMemo(
    () => buckets.map((b) => ({ key: b.key, label: b.label, title: b.title, values: b.counts })),
    [buckets]
  );
  const visible = useMemo(() => filterEvents(events, filter, now), [events, filter, now]);
  const groups = useMemo(() => groupByDay(visible, now), [visible, now]);
  const sevCounts = useMemo(() => countBySeverity(events, filter, now), [events, filter, now]);
  const catCounts = useMemo(() => countByCategory(events, filter, now), [events, filter, now]);
  const sparkCounts = useMemo(() => countBySpark(events, filter, now), [events, filter, now]);
  const options = useMemo(() => sparkOptions(sparks, events), [sparks, events]);
  const hasNoSpark = (sparkCounts[NO_SPARK] ?? 0) > 0 || filter.sparkId === NO_SPARK;
  const active = isFilterActive(filter);
  const chartTotal = buckets.reduce((n, b) => n + b.counts.error + b.counts.warn + b.counts.success + b.counts.info, 0);

  const patch = (p: Partial<ActivityFilter>) => setFilter((f) => ({ ...f, ...p }));
  const preset = (p: Partial<ActivityFilter>) => setFilter({ ...EMPTY_FILTER, ...p });
  const toggleSeverity = (s: Severity) =>
    patch({ severities: filter.severities.includes(s) ? filter.severities.filter((x) => x !== s) : [...filter.severities, s] });

  const copyAll = async () => {
    const text = exportText(visible);
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = legacyCopy(text);
    }
    setCopyMsg({ ok, text: ok ? t("activity.copied", { n: visible.length }) : t("activity.copy_blocked") });
    setTimeout(() => setCopyMsg(null), 2500);
  };

  const jumpToNewest = () => {
    rootRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    setUnseen(0);
  };

  const live = feed.pollError ? "warn" : feed.paused ? "off" : "ok";
  const liveText = feed.pollError ? t("activity.poll_error") : feed.paused ? t("activity.paused") : t("activity.live_updated", { time: formatUpdated(feed.lastUpdated, now) });

  const tiles = [
    {
      id: "events",
      label: t("activity.tile_events"),
      value: String(summary.events24h),
      sub: t("activity.in_7d", { n: summary.events7d }),
      on: filter.range === "24h" && !filter.severities.length && filter.sparkId === "all" && filter.category === "all" && !filter.query,
      run: () => preset({ range: "24h" }),
    },
    {
      id: "errors",
      label: t("activity.tile_errors"),
      value: String(summary.errors24h),
      sub: t("activity.in_7d", { n: summary.errors7d }),
      tone: summary.errors24h > 0 ? "bad" : "",
      on: filter.range === "24h" && sameSet(filter.severities, ["error"]),
      run: () => preset({ range: "24h", severities: ["error"] }),
    },
    {
      id: "warnings",
      label: t("activity.tile_warnings"),
      value: String(summary.warnings24h),
      sub: t("activity.in_7d", { n: summary.warnings7d }),
      tone: summary.warnings24h > 0 ? "warn" : "",
      on: filter.range === "24h" && sameSet(filter.severities, ["warn"]),
      run: () => preset({ range: "24h", severities: ["warn"] }),
    },
    {
      id: "problems",
      label: t("activity.tile_problems"),
      value: String(summary.problemSparks24h),
      sub: t("activity.in_7d", { n: summary.problemSparks7d }),
      tone: summary.problemSparks24h > 0 ? "warn" : "",
      on: filter.range === "24h" && sameSet(filter.severities, ["error", "warn"]),
      run: () => preset({ range: "24h", severities: ["error", "warn"] }),
    },
    {
      id: "active",
      label: t("activity.tile_most_active"),
      value: summary.mostActive?.name ?? t("activity.none"),
      small: true,
      sub: summary.mostActive ? t("activity.n_events", { n: summary.mostActive.count }) : t("activity.no_events_yet"),
      on: summary.mostActive != null && filter.sparkId === summary.mostActive.sparkId,
      disabled: summary.mostActive == null,
      run: () => summary.mostActive && preset({ range: "24h", sparkId: summary.mostActive.sparkId }),
    },
  ];

  const timeline = (() => {
    if (feed.status === "loading") {
      return (
        <ul className="ac-skel" aria-busy="true" aria-label={t("overview.activityLoading")}>
          {Array.from({ length: 8 }, (_, i) => (
            <li key={i} className="ac-skel__row">
              <i className="ac-skel__bar ac-skel__bar--s" />
              <i className="ac-skel__bar ac-skel__bar--s" />
              <i className="ac-skel__bar" />
            </li>
          ))}
        </ul>
      );
    }
    if (feed.status === "error") {
      return (
        <div className="ac-state" role="alert">
          <h3>{t("overview.activityError")}</h3>
          <p>{feed.error}</p>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void feed.reload()}>
            Retry
          </button>
        </div>
      );
    }
    if (events.length === 0) {
      return (
        <div className="ac-state">
          <h3>{t("activity.nothing_yet")}</h3>
          <p>{t("activity.nothing_yet_sub")}</p>
        </div>
      );
    }
    if (visible.length === 0) {
      return (
        <div className="ac-state">
          <h3>{t("activity.no_match")}</h3>
          <p>{t("activity.no_match_hint")}</p>
          <button type="button" className="btn btn--sm" onClick={() => setFilter(EMPTY_FILTER)}>
            {t("activity.reset_filters")}
          </button>
        </div>
      );
    }
    return (
      <div>
        {groups.map((g) => (
          <section key={g.key} className="ac-day" aria-label={g.label}>
            <h3 className="ac-day__head">
              <span>
                {g.label === "Today"
                  ? t("activity.day_today")
                  : g.label === "Yesterday"
                    ? t("activity.day_yesterday")
                    : g.label}
              </span>
              <span className="ac-day__count mono">{g.events.length}</span>
            </h3>
            <ul className="ac-list">
              {g.events.map((e) => (
                <EventRow
                  key={e.id}
                  event={e}
                  open={open.has(e.id)}
                  fresh={feed.fresh.has(e.id)}
                  now={now}
                  onToggle={toggle}
                  onSelectSpark={onSelectSpark}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  })();

  return (
    <div className="ac" ref={rootRef}>
      <header className="page-head">
        <div>
          <h1>{t("activity.title")}</h1>
          <p className="page-head__sub">
            {t("activity.subtitle")}
          </p>
        </div>
        <div className="page-head__tools">
          <span className={`ac-live ac-live--${live}`} role="status">
            <i className="ac-live__dot" aria-hidden="true" />
            {liveText}
          </span>
          <button type="button" className="btn btn--sm" onClick={() => void feed.refresh()} disabled={feed.status !== "ready" || feed.refreshing}>
            <RotateIcon className={`h-3.5 w-3.5${feed.refreshing ? " ac-spin" : ""}`} />
            {t("activity.refresh")}
          </button>
          <button type="button" className="btn btn--sm" onClick={() => void copyAll()} disabled={visible.length === 0}>
            {t("activity.copy_text")}
          </button>
          <ClearMenu
            label={t("activity.clear_history")}
            choices={ACTIVITY_CLEAR}
            onRun={feed.clear}
            disabled={feed.status !== "ready"}
          />
          <span className={`ac-toast${copyMsg ? (copyMsg.ok ? " is-ok" : " is-err") : ""}`} role="status" aria-live="polite">
            {copyMsg?.text}
          </span>
        </div>
      </header>

      <div className="ac-tiles" role="group" aria-label={t("activity.tiles_aria")}>
        {tiles.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`panel ac-tile${t.on ? " is-on" : ""}${t.tone ? ` ac-tile--${t.tone}` : ""}`}
            aria-pressed={t.on}
            disabled={t.disabled || feed.status !== "ready"}
            onClick={t.run}
          >
            <span className="eyebrow">{t.label}</span>
            <span className={`ac-tile__val${t.small ? " ac-tile__val--text" : " big-num"}`}>{t.value}</span>
            <span className="ac-tile__sub">{t.sub}</span>
          </button>
        ))}
      </div>

      <section className="panel ac-chart" aria-label={t("activity.per_day")}>
        <div className="ac-chart__head">
          <h2 className="panel-title">{t("activity.per_day")}</h2>
          <ul className="ac-legend">
            {SERIES.map((s) => (
              <li key={s.id}>
                <i className={`ac-sev__dot ac-sev__dot--${s.id}`} aria-hidden="true" />
                {t(s.label)}
              </li>
            ))}
          </ul>
        </div>
        <StackedBarChart
          buckets={chartBuckets}
          series={SERIES}
          height={150}
          format={(n) => String(Math.round(n))}
          unit="events"
          empty={feed.status === "ready" ? t("activity.none_14d") : t("overview.activityLoading")}
          ariaLabel={`Events per day over the last 14 days, ${chartTotal} in total`}
        />
      </section>

      <section className="panel ac-filters" aria-label={t("activity.filters")}>
        <div className="ac-filters__row">
          <div className="ac-chips" role="group" aria-label={t("activity.severity")}>
            <button type="button" className="ac-chip" aria-pressed={filter.severities.length === 0} onClick={() => patch({ severities: [] })}>
              All <b className="mono">{SEVERITIES.reduce((n, s) => n + sevCounts[s], 0)}</b>
            </button>
            {SEV_CHIPS.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`ac-chip ac-chip--${c.id}`}
                aria-pressed={filter.severities.includes(c.id)}
                onClick={() => toggleSeverity(c.id)}
                title={`${t(SEVERITY_LABEL[c.id])}`}
              >
                <i className={`ac-sev__dot ac-sev__dot--${c.id}`} aria-hidden="true" />
                {t(c.label)} <b className="mono">{sevCounts[c.id]}</b>
              </button>
            ))}
          </div>
          <div className="seg" role="group" aria-label={t("tokens.time_range")}>
            {RANGES.map((r) => (
              <button key={r.id} type="button" aria-pressed={filter.range === r.id} onClick={() => patch({ range: r.id })}>
                {t(`activity.range_${r.id}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="ac-filters__row">
          <label className="ac-search">
            <SearchIcon className="h-4 w-4" />
            <input
              type="search"
              value={filter.query}
              onChange={(e) => patch({ query: e.target.value })}
              placeholder={t("activity.search_placeholder")}
              aria-label={t("activity.search_events")}
            />
          </label>
          <label className="ac-select">
            <span className="eyebrow">{t("activity.category")}</span>
            <select value={filter.category} onChange={(e) => patch({ category: e.target.value as CategoryId | "all" })}>
              <option value="all">{t("activity.all_categories")}</option>
              {CATEGORIES.filter((c) => catCounts[c.id] > 0 || filter.category === c.id).map((c) => (
                <option key={c.id} value={c.id}>
                  {t(c.label)} ({catCounts[c.id]})
                </option>
              ))}
            </select>
          </label>
          <label className="ac-select">
            <span className="eyebrow">{t("tokens.g_spark")}</span>
            <select value={filter.sparkId} onChange={(e) => patch({ sparkId: e.target.value })}>
              <option value="all">{t("tokens.all_sparks")}</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({sparkCounts[o.id] ?? 0})
                </option>
              ))}
              {hasNoSpark ? <option value={NO_SPARK}>{t("activity.fleet_wide", { n: sparkCounts[NO_SPARK] ?? 0 })}</option> : null}
            </select>
          </label>
          <button type="button" className="btn btn--ghost btn--sm ac-reset" onClick={() => setFilter(EMPTY_FILTER)} disabled={!active}>
            <XIcon className="h-3.5 w-3.5" />
            {t("activity.reset_filters")}
          </button>
        </div>
      </section>

      <div className="ac-count" role="status" aria-live="polite">
        {feed.status === "ready" ? (
          <>
            {t("activity.showing_loaded", { shown: visible.length, total: events.length })}
            {active ? " (filtered)" : ""}
          </>
        ) : (
          " "
        )}
      </div>

      <div ref={topRef} />
      {away && unseen > 0 ? (
        <div className="ac-newbar">
          <button type="button" className="btn btn--primary btn--sm" onClick={jumpToNewest}>
            {unseen} new event{unseen === 1 ? "" : "s"}, jump to top
          </button>
        </div>
      ) : null}

      <div className="panel ac-timeline">{timeline}</div>

      {feed.status === "ready" && events.length > 0 ? (
        <div className="ac-more">
          {feed.reachedOldest ? (
            <p className="ac-more__end">{t("activity.oldest_reached")}</p>
          ) : (
            <>
              <button type="button" className="btn btn--sm" onClick={() => void feed.loadOlder()} disabled={feed.loadingMore}>
                {feed.loadingMore ? t("overview.activityLoading") : t("activity.load_older")}
              </button>
              {active ? <p className="ac-more__hint">{t("activity.filters_partial")}</p> : null}
              {feed.moreError ? (
                <p className="ac-more__err" role="alert">
                  Couldn't load older events: {feed.moreError}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default ActivityPage;
