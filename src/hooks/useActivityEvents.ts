import { useEffect, useState } from "react";
import { fetchEvents } from "../api/client";
import type { ActivityEvent } from "../api/types";

const POLL_MS = 15_000;
const KEEP = 50;

/**
 * Fleet activity events (newest first). Fetches once, then polls every 15 s
 * while the tab is visible (the snapshot WebSocket is deliberately untouched).
 */
export function useActivityEvents(opts?: { sparkId?: string }) {
  const sparkId = opts?.sparkId;
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const load = async () => {
      try {
        const next = await fetchEvents({ limit: KEEP, sparkId });
        if (cancelled) return;
        setEvents(next.slice(0, KEEP));
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    const start = () => {
      if (timer == null) timer = setInterval(() => void load(), POLL_MS);
    };
    const stop = () => {
      if (timer != null) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        void load();
        start();
      }
    };

    void load();
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [sparkId]);

  return { events, loading, error };
}
