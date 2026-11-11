import { useCallback, useEffect, useRef, useState } from "react";
import { cancelStorageScan, fetchStorageScan, startStorageScan } from "../../api/client";
import type { StorageScanJob, StorageScanRequest, StorageSession } from "../../api/types";

const POLL_MS = 1500;

export interface StorageScan {
  job: StorageScanJob | null;
  session: StorageSession | null;
  /** The first read of the unit's state is still on its way. */
  loading: boolean;
  /** Could not read the scan state (not a failed scan: that is `job.error`). */
  loadError: string | null;
  /** How long the running scan has been going, by the server's clock. */
  elapsedMs: number | null;
  /**
   * The scan keeps the Spark busy: running, being stopped, or not yet confirmed stopped. Other storage work
   * is refused meanwhile, so the page disables it.
   */
  busy: boolean;
  /** The server's clock now (this browser's clock may be off), for "analysed 3 h ago". */
  serverNow: () => number;
  start: (req: StorageScanRequest) => Promise<void>;
  cancel: () => Promise<void>;
  /** Read the latest result again (after a delete). */
  refresh: () => Promise<void>;
}

/**
 * The scan of one Spark: starts it, follows the running job, and keeps the result the server holds,
 * so leaving the page and coming back finds the same analysis (or the scan still running).
 */
export function useStorageScan(sparkId: string | null): StorageScan {
  const [job, setJob] = useState<StorageScanJob | null>(null);
  const [session, setSession] = useState<StorageSession | null>(null);
  const [loading, setLoading] = useState(Boolean(sparkId));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const clockOffset = useRef(0);
  const revision = useRef(0);
  /** A newer unit or request wins: answers for an older one are dropped. */
  const generation = useRef(0);

  const pull = useCallback(async () => {
    if (!sparkId) return;
    const mine = generation.current;
    try {
      const res = await fetchStorageScan(sparkId, revision.current || undefined);
      if (mine !== generation.current) return;
      if (typeof res.now === "number") clockOffset.current = res.now - Date.now();
      setJob(res.job);
      if (res.session) {
        revision.current = res.revision;
        setSession(res.session);
      }
      setLoadError(null);
    } catch (err) {
      if (mine !== generation.current) return;
      setLoadError(err instanceof Error ? err.message : "Could not read the scan");
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [sparkId]);

  useEffect(() => {
    generation.current += 1;
    revision.current = 0;
    setJob(null);
    setSession(null);
    setLoadError(null);
    setLoading(Boolean(sparkId));
    void pull();
    return () => {
      generation.current += 1;
    };
  }, [sparkId, pull]);

  const running = job?.state === "running" || job?.state === "stopping";
  // Followed until the Spark is free again, also after a failed or unconfirmed stop.
  const busy = running || job?.holdsSpark === true;
  useEffect(() => {
    if (!busy) return;
    const poll = window.setInterval(() => void pull(), POLL_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 500);
    setNow(Date.now());
    return () => {
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, [busy, pull]);

  const start = useCallback(
    async (req: StorageScanRequest) => {
      if (!sparkId) return;
      const mine = generation.current;
      const res = await startStorageScan(sparkId, req);
      if (mine !== generation.current) return;
      setJob(res.job);
    },
    [sparkId]
  );

  const cancel = useCallback(async () => {
    if (!sparkId) return;
    const mine = generation.current;
    const res = await cancelStorageScan(sparkId);
    if (mine === generation.current) setJob(res.job);
  }, [sparkId]);

  const elapsedMs = running && job ? Math.max(0, now + clockOffset.current - job.startedAt) : null;
  const serverNow = useCallback(() => Date.now() + clockOffset.current, []);
  return { job, session, loading, loadError, elapsedMs, busy, serverNow, start, cancel, refresh: pull };
}
