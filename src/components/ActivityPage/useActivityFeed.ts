import { useCallback, useEffect, useRef, useState } from "react";
import { fetchEvents, fetchEventsPage } from "../../api/client";
import type { ActivityEvent } from "../../api/types";
import { mergeEvents } from "./activityStats";

const FIRST_PAGE = 100;
const OLDER_PAGE = 100;
const BACKFILL_PAGE = 500;
const BACKFILL_MAX = 5;
/** The page keeps loading until the per-day chart (14 days) is covered. */
const COVER_MS = 14 * 86_400_000;
const POLL_MS = 15_000;
const FRESH_MS = 8_000;

export type FeedStatus = "loading" | "ready" | "error";

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Full activity history: first page, a quiet backfill to cover the chart window, "load older"
 * paging by beforeId, and a 15 s sinceId poll (paused while the tab is hidden). Merges by id, so
 * rows already on screen keep their identity (open details and scroll position survive).
 */
export function useActivityFeed(onArrive?: (count: number) => void) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [serverOldest, setServerOldest] = useState<number | null>(null);
  const [status, setStatus] = useState<FeedStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [pollError, setPollError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [paused, setPaused] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<number>>(new Set());

  const ref = useRef<ActivityEvent[]>([]);
  const gen = useRef(0);
  const arrive = useRef(onArrive);
  arrive.current = onArrive;
  const freshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const busy = useRef(false);

  const apply = useCallback((incoming: ActivityEvent[]) => {
    ref.current = mergeEvents(ref.current, incoming);
    setEvents(ref.current);
  }, []);

  const load = useCallback(async () => {
    const mine = ++gen.current;
    setStatus("loading");
    setError(null);
    try {
      const first = await fetchEventsPage({ limit: FIRST_PAGE });
      if (mine !== gen.current) return;
      ref.current = [];
      apply(first.events);
      setServerOldest(first.oldestId);
      setLastUpdated(Date.now());
      setPollError(false);
      setStatus("ready");
      // Quiet backfill so the stats and the chart are not limited to the first page.
      for (let i = 0; i < BACKFILL_MAX; i++) {
        const tail = ref.current[ref.current.length - 1];
        if (!tail || (first.oldestId != null && tail.id <= first.oldestId) || tail.ts <= Date.now() - COVER_MS) break;
        const page = await fetchEventsPage({ limit: BACKFILL_PAGE, beforeId: tail.id });
        if (mine !== gen.current || page.events.length === 0) break;
        apply(page.events);
        setServerOldest(page.oldestId);
      }
    } catch (err) {
      if (mine !== gen.current) return;
      // Backfill failures keep what we have; only a failed first page is an error state.
      if (ref.current.length === 0) {
        setError(msg(err));
        setStatus("error");
      }
    }
  }, [apply]);

  const poll = useCallback(
    async (manual = false) => {
      if (busy.current || status === "loading" || status === "error") return;
      busy.current = true;
      if (manual) setRefreshing(true);
      const mine = gen.current;
      try {
        const newer = await fetchEvents({ limit: BACKFILL_PAGE, sinceId: ref.current[0]?.id ?? 0 });
        if (mine !== gen.current) return;
        const known = new Set(ref.current.map((e) => e.id));
        const added = newer.filter((e) => !known.has(e.id));
        if (added.length > 0) {
          apply(added);
          setFresh(new Set(added.map((e) => e.id)));
          clearTimeout(freshTimer.current);
          freshTimer.current = setTimeout(() => setFresh(new Set()), FRESH_MS);
          arrive.current?.(added.length);
        }
        setPollError(false);
        setLastUpdated(Date.now());
      } catch {
        if (mine === gen.current) setPollError(true);
      } finally {
        busy.current = false;
        if (manual) setRefreshing(false);
      }
    },
    [apply, status]
  );

  const loadOlder = useCallback(async () => {
    const tail = ref.current[ref.current.length - 1];
    if (!tail || loadingMore) return;
    const mine = gen.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await fetchEventsPage({ limit: OLDER_PAGE, beforeId: tail.id });
      if (mine !== gen.current) return;
      apply(page.events);
      setServerOldest(page.oldestId);
    } catch (err) {
      if (mine === gen.current) setMoreError(msg(err));
    } finally {
      setLoadingMore(false);
    }
  }, [apply, loadingMore]);

  useEffect(() => {
    void load();
    return () => {
      gen.current++;
      clearTimeout(freshTimer.current);
    };
  }, [load]);

  // Poll while the tab is visible; catch up immediately when it becomes visible again.
  useEffect(() => {
    if (status !== "ready") return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer == null) timer = setInterval(() => void poll(), POLL_MS);
    };
    const stop = () => {
      if (timer != null) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
        setPaused(true);
      } else {
        setPaused(false);
        void poll();
        start();
      }
    };
    setPaused(document.hidden);
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [status, poll]);

  const tail = events[events.length - 1];
  const reachedOldest = status === "ready" && (tail == null || serverOldest == null || tail.id <= serverOldest);

  return {
    events,
    status,
    error,
    reload: load,
    refresh: () => poll(true),
    refreshing,
    paused,
    pollError,
    lastUpdated,
    fresh,
    loadOlder,
    loadingMore,
    moreError,
    reachedOldest,
  };
}
