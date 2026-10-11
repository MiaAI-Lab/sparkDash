import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SparkSnapshot } from "../../api/types";
import { i18next } from "../../i18n";
import { StackedBarChart, type BarBucket, type BarSeries } from "../ui/StackedBarChart";
import { RotateIcon, SearchIcon, XIcon } from "../ui/icons";
import { EventRow } from "./EventRow";
import { ClearMenu } from "../ui/ClearMenu";
import {
  CATEGORIES, EMPTY_FILTER, NO_SPARK, SEVERITIES, categoryLabel, countByCategory, countBySeverity, countBySpark,
  eventsPerDay, exportText, filterEvents, groupByDay, isFilterActive, severityLabel, sparkOptions, summarize,
  type ActivityFilter, type CategoryId, type RangeId, type Severity,
} from "./activityStats";
import { useActivityFeed } from "./useActivityFeed";
import "../../styles/activity.css";

const DAY_MS = 86_400_000;

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

function formatUpdated(ts: number | null, now: number): string {
  if (ts == null) return i18next.t("activity.updated.connecting", "connecting");
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 5
    ? i18next.t("activity.updated.justNow", "just now")
    : s < 60
      ? i18next.t("activity.updated.secondsAgo", "{count} s ago", { count: s })
      : i18next.t("activity.updated.minutesAgo", "{count} min ago", { count: Math.floor(s / 60) });
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
  const { t, i18n } = useTranslation();
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
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
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
  // Language is a dependency: the search haystack includes translated type
  // labels and the day headings are translated.
  const visible = useMemo(() => filterEvents(events, filter, now), [events, filter, now, i18n.language]);
  const groups = useMemo(() => groupByDay(visible, now), [visible, now, i18n.language]);
  const sevCounts = useMemo(() => countBySeverity(events, filter, now), [events, filter, now]);
  const catCounts = useMemo(() => countByCategory(events, filter, now), [events, filter, now]);
  const sparkCounts = useMemo(() => countBySpark(events, filter, now), [events, filter, now]);
  const options = useMemo(() => sparkOptions(sparks, events), [sparks, events]);
  const hasNoSpark = (sparkCounts[NO_SPARK] ?? 0) > 0 || filter.sparkId === NO_SPARK;
  const active = isFilterActive(filter);
  const chartTotal = buckets.reduce((n, b) => n + b.counts.error + b.counts.warn + b.counts.success + b.counts.info, 0);

  // Translated label sets are rebuilt each render (t changes identity with the
  // language), so a language switch is reflected without stale memoised text.
  const clearChoices: readonly { id: string; label: string; ask: string; arg: number | undefined }[] = [
    { id: "7d", label: t("activity.clear.older7d", "Older than 7 days"), ask: t("activity.clear.older7dAsk", "Delete events older than 7 days?"), arg: 7 * DAY_MS },
    { id: "24h", label: t("activity.clear.older24h", "Older than 24 hours"), ask: t("activity.clear.older24hAsk", "Delete events older than 24 hours?"), arg: DAY_MS },
    { id: "all", label: t("activity.clear.everything", "Everything"), ask: t("activity.clear.everythingAsk", "Delete the whole activity history?"), arg: undefined },
  ];
  const series: readonly BarSeries[] = [
    { id: "error", label: t("activity.severity.errors", "Errors"), color: "var(--color-danger)" },
    { id: "warn", label: t("activity.severity.warnings", "Warnings"), color: "var(--color-warning)" },
    { id: "success", label: t("activity.severity.success", "Success"), color: "var(--color-success)" },
    { id: "info", label: t("activity.severity.info", "Info"), color: "var(--color-info)" },
  ];
  const ranges: readonly { id: RangeId; label: string }[] = [
    { id: "24h", label: t("activity.range.h24", "24 h") },
    { id: "7d", label: t("activity.range.d7", "7 d") },
    { id: "all", label: t("activity.range.all", "All") },
  ];
  const sevChips: readonly { id: Severity; label: string }[] = [
    { id: "error", label: t("activity.severity.errors", "Errors") },
    { id: "warn", label: t("activity.severity.warnings", "Warnings") },
    { id: "success", label: t("activity.severity.success", "Success") },
    { id: "info", label: t("activity.severity.info", "Info") },
  ];

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
    setCopyMsg({
      ok,
      text: ok
        ? t("activity.toast.copied", "Copied {count, plural, one {# event} other {# events}}", { count: visible.length })
        : t("activity.toast.copyBlocked", "Couldn't copy (clipboard blocked)"),
    });
    setTimeout(() => setCopyMsg(null), 2500);
  };

  const jumpToNewest = () => {
    rootRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    setUnseen(0);
  };

  const live = feed.pollError ? "warn" : feed.paused ? "off" : "ok";
  const liveText = feed.pollError
    ? t("activity.live.failed", "Update failed, retrying")
    : feed.paused
      ? t("activity.live.paused", "Paused (tab hidden)")
      : t("activity.live.live", "Live · {updated}", { updated: formatUpdated(feed.lastUpdated, now) });

  const tiles = [
    {
      id: "events",
      label: t("activity.tile.events24h", "Events, 24 h"),
      value: String(summary.events24h),
      sub: t("activity.tile.in7d", "{count} in 7 d", { count: summary.events7d }),
      on: filter.range === "24h" && !filter.severities.length && filter.sparkId === "all" && filter.category === "all" && !filter.query,
      run: () => preset({ range: "24h" }),
    },
    {
      id: "errors",
      label: t("activity.tile.errors24h", "Errors, 24 h"),
      value: String(summary.errors24h),
      sub: t("activity.tile.in7d", "{count} in 7 d", { count: summary.errors7d }),
      tone: summary.errors24h > 0 ? "bad" : "",
      on: filter.range === "24h" && sameSet(filter.severities, ["error"]),
      run: () => preset({ range: "24h", severities: ["error"] }),
    },
    {
      id: "warnings",
      label: t("activity.tile.warnings24h", "Warnings, 24 h"),
      value: String(summary.warnings24h),
      sub: t("activity.tile.in7d", "{count} in 7 d", { count: summary.warnings7d }),
      tone: summary.warnings24h > 0 ? "warn" : "",
      on: filter.range === "24h" && sameSet(filter.severities, ["warn"]),
      run: () => preset({ range: "24h", severities: ["warn"] }),
    },
    {
      id: "problems",
      label: t("activity.tile.problems", "Sparks with problems"),
      value: String(summary.problemSparks24h),
      sub: t("activity.tile.in7d", "{count} in 7 d", { count: summary.problemSparks7d }),
      tone: summary.problemSparks24h > 0 ? "warn" : "",
      on: filter.range === "24h" && sameSet(filter.severities, ["error", "warn"]),
      run: () => preset({ range: "24h", severities: ["error", "warn"] }),
    },
    {
      id: "active",
      label: t("activity.tile.mostActive", "Most active Spark"),
      value: summary.mostActive?.name ?? t("activity.tile.none", "None"),
      small: true,
      sub: summary.mostActive
        ? t("activity.tile.eventsCount", "{count, plural, one {# event} other {# events}}", { count: summary.mostActive.count })
        : t("activity.tile.noEventsYet", "no events yet"),
      on: summary.mostActive != null && filter.sparkId === summary.mostActive.sparkId,
      disabled: summary.mostActive == null,
      run: () => summary.mostActive && preset({ range: "24h", sparkId: summary.mostActive.sparkId }),
    },
  ];

  const timeline = (() => {
    if (feed.status === "loading") {
      return (
        <ul className="ac-skel" aria-busy="true" aria-label={t("activity.skel.loading", "Loading activity")}>
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
          <h3>{t("activity.error.title", "Couldn't load activity")}</h3>
          <p>{feed.error}</p>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void feed.reload()}>
            {t("activity.error.retry", "Retry")}
          </button>
        </div>
      );
    }
    if (events.length === 0) {
      return (
        <div className="ac-state">
          <h3>{t("activity.empty.nothing", "Nothing recorded yet")}</h3>
          <p>
            {t(
              "activity.empty.detail",
              "The server logs fleet events as they happen: Sparks going online or offline, GPU thermal throttling, Hermes updates, benchmark runs, shutdown and wake, LLM start and stop runs, and Sparks being added or removed."
            )}
          </p>
        </div>
      );
    }
    if (visible.length === 0) {
      return (
        <div className="ac-state">
          <h3>{t("activity.empty.filtered", "No events match your filters")}</h3>
          <p>{t("activity.empty.filteredHint", "Try a wider time range or clear a filter.")}</p>
          <button type="button" className="btn btn--sm" onClick={() => setFilter(EMPTY_FILTER)}>
            {t("activity.action.resetFilters", "Reset filters")}
          </button>
        </div>
      );
    }
    return (
      <div>
        {groups.map((g) => (
          <section key={g.key} className="ac-day" aria-label={g.label}>
            <h3 className="ac-day__head">
              <span>{g.label}</span>
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
          <h1>{t("activity.title", "Activity")}</h1>
          <p className="page-head__sub">
            {t(
              "activity.header.subtitle",
              "Everything that happened across the fleet: restarts, throttling, updates, benchmarks, power and LLM runs. The server keeps the latest 2,000 events."
            )}
          </p>
        </div>
        <div className="page-head__tools">
          <span className={`ac-live ac-live--${live}`} role="status">
            <i className="ac-live__dot" aria-hidden="true" />
            {liveText}
          </span>
          <button type="button" className="btn btn--sm" onClick={() => void feed.refresh()} disabled={feed.status !== "ready" || feed.refreshing}>
            <RotateIcon className={`h-3.5 w-3.5${feed.refreshing ? " ac-spin" : ""}`} />
            {t("common.action.refresh", "Refresh")}
          </button>
          <button type="button" className="btn btn--sm" onClick={() => void copyAll()} disabled={visible.length === 0}>
            {t("activity.action.copyText", "Copy as text")}
          </button>
          <ClearMenu
            label={t("activity.header.clearMenu", "Clear history…")}
            choices={clearChoices}
            onRun={feed.clear}
            disabled={feed.status !== "ready"}
          />
          <span className={`ac-toast${copyMsg ? (copyMsg.ok ? " is-ok" : " is-err") : ""}`} role="status" aria-live="polite">
            {copyMsg?.text}
          </span>
        </div>
      </header>

      <div className="ac-tiles" role="group" aria-label={t("activity.header.summaryAria", "Summary, click to filter")}>
        {tiles.map((tile) => (
          <button
            key={tile.id}
            type="button"
            className={`panel ac-tile${tile.on ? " is-on" : ""}${tile.tone ? ` ac-tile--${tile.tone}` : ""}`}
            aria-pressed={tile.on}
            disabled={tile.disabled || feed.status !== "ready"}
            onClick={tile.run}
          >
            <span className="eyebrow">{tile.label}</span>
            <span className={`ac-tile__val${tile.small ? " ac-tile__val--text" : " big-num"}`}>{tile.value}</span>
            <span className="ac-tile__sub">{tile.sub}</span>
          </button>
        ))}
      </div>

      <section className="panel ac-chart" aria-label={t("activity.chart.title", "Events per day")}>
        <div className="ac-chart__head">
          <h2 className="panel-title">{t("activity.chart.title", "Events per day")}</h2>
          <ul className="ac-legend">
            {series.map((s) => (
              <li key={s.id}>
                <i className={`ac-sev__dot ac-sev__dot--${s.id}`} aria-hidden="true" />
                {s.label}
              </li>
            ))}
          </ul>
        </div>
        <StackedBarChart
          buckets={chartBuckets}
          series={series}
          height={150}
          format={(n) => String(Math.round(n))}
          unit="events"
          empty={feed.status === "ready" ? t("activity.chart.empty", "No events in the last 14 days.") : t("common.action.loading", "Loading…")}
          ariaLabel={t("activity.chart.aria", "Events per day over the last 14 days, {total} in total", { total: chartTotal })}
        />
      </section>

      <section className="panel ac-filters" aria-label={t("activity.filters.aria", "Filters")}>
        <div className="ac-filters__row">
          <div className="ac-chips" role="group" aria-label={t("activity.filters.severityAria", "Severity")}>
            <button type="button" className="ac-chip" aria-pressed={filter.severities.length === 0} onClick={() => patch({ severities: [] })}>
              {t("activity.filters.all", "All")} <b className="mono">{SEVERITIES.reduce((n, s) => n + sevCounts[s], 0)}</b>
            </button>
            {sevChips.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`ac-chip ac-chip--${c.id}`}
                aria-pressed={filter.severities.includes(c.id)}
                onClick={() => toggleSeverity(c.id)}
                title={t("activity.filters.severityChipTitle", "{severity} events", { severity: severityLabel(c.id) })}
              >
                <i className={`ac-sev__dot ac-sev__dot--${c.id}`} aria-hidden="true" />
                {c.label} <b className="mono">{sevCounts[c.id]}</b>
              </button>
            ))}
          </div>
          <div className="seg" role="group" aria-label={t("activity.filters.rangeAria", "Time range")}>
            {ranges.map((r) => (
              <button key={r.id} type="button" aria-pressed={filter.range === r.id} onClick={() => patch({ range: r.id })}>
                {r.label}
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
              placeholder={t("activity.filters.searchPlaceholder", "Search message, Spark or type")}
              aria-label={t("activity.filters.searchAria", "Search events")}
            />
          </label>
          <label className="ac-select">
            <span className="eyebrow">{t("activity.filters.category", "Category")}</span>
            <select value={filter.category} onChange={(e) => patch({ category: e.target.value as CategoryId | "all" })}>
              <option value="all">{t("activity.filters.allCategories", "All categories")}</option>
              {CATEGORIES.filter((c) => catCounts[c] > 0 || filter.category === c).map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)} ({catCounts[c]})
                </option>
              ))}
            </select>
          </label>
          <label className="ac-select">
            <span className="eyebrow">{t("activity.filters.spark", "Spark")}</span>
            <select value={filter.sparkId} onChange={(e) => patch({ sparkId: e.target.value })}>
              <option value="all">{t("activity.filters.allSparks", "All Sparks")}</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({sparkCounts[o.id] ?? 0})
                </option>
              ))}
              {hasNoSpark ? (
                <option value={NO_SPARK}>
                  {t("activity.filters.fleetWide", "Fleet-wide ({count})", { count: sparkCounts[NO_SPARK] ?? 0 })}
                </option>
              ) : null}
            </select>
          </label>
          <button type="button" className="btn btn--ghost btn--sm ac-reset" onClick={() => setFilter(EMPTY_FILTER)} disabled={!active}>
            <XIcon className="h-3.5 w-3.5" />
            {t("activity.action.resetFilters", "Reset filters")}
          </button>
        </div>
      </section>

      <div className="ac-count" role="status" aria-live="polite">
        {feed.status === "ready" ? (
          <>
            {t("activity.count.showing", "Showing {shown} of {total} loaded events", {
              shown: visible.length,
              total: events.length,
            })}
            {active ? t("activity.count.filtered", " (filtered)") : ""}
          </>
        ) : (
          " "
        )}
      </div>

      <div ref={topRef} />
      {away && unseen > 0 ? (
        <div className="ac-newbar">
          <button type="button" className="btn btn--primary btn--sm" onClick={jumpToNewest}>
            {t("activity.newbar", "{count, plural, one {# new event} other {# new events}}, jump to top", { count: unseen })}
          </button>
        </div>
      ) : null}

      <div className="panel ac-timeline">{timeline}</div>

      {feed.status === "ready" && events.length > 0 ? (
        <div className="ac-more">
          {feed.reachedOldest ? (
            <p className="ac-more__end">{t("activity.more.end", "You've reached the oldest event the server kept.")}</p>
          ) : (
            <>
              <button type="button" className="btn btn--sm" onClick={() => void feed.loadOlder()} disabled={feed.loadingMore}>
                {feed.loadingMore ? t("common.action.loading", "Loading…") : t("activity.more.loadOlder", "Load older")}
              </button>
              {active ? (
                <p className="ac-more__hint">{t("activity.more.filtersHint", "Filters apply to the events loaded so far.")}</p>
              ) : null}
              {feed.moreError ? (
                <p className="ac-more__err" role="alert">
                  {t("activity.more.loadError", "Couldn't load older events: {message}", { message: feed.moreError })}
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
