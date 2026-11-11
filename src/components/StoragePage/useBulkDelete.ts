import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchStorageDeleteMany, startStorageDeleteMany } from "../../api/client";
import type { StorageBulkDeleteJob, StorageElevation } from "../../api/types";

/** How often a running bulk delete is read again (the first time sooner: short runs end within a second). */
export const BULK_POLL_MS = 1000;
const BULK_FIRST_POLL_MS = 400;

export interface BulkDelete {
  /** The run this page follows: started here, or found still running when the page opened. */
  job: StorageBulkDeleteJob | null;
  /** Start a run and follow it. Rejects when the dashboard refuses it (a bad path, busy, a password problem). */
  start: (paths: string[], elevation: StorageElevation) => Promise<StorageBulkDeleteJob>;
}

/**
 * A bulk delete on one Spark: the server runs it (one item after another, under the Spark's busy lock) and the
 * page only follows it, so a reload or a closed tab does not stop it. Opening the page finds a run that is still
 * going and follows that too. `onFinished(job, startedHere)` is called once when a followed run ends.
 */
export function useBulkDelete(sparkId: string, onFinished: (job: StorageBulkDeleteJob, startedHere: boolean) => void): BulkDelete {
  const [job, setJob] = useState<StorageBulkDeleteJob | null>(null);
  const following = useRef<string | null>(null);
  const timer = useRef<number | null>(null);
  const finished = useRef(onFinished);
  finished.current = onFinished;

  const stopFollowing = useCallback(() => {
    following.current = null;
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const follow = useCallback(
    (id: string, here: boolean) => {
      stopFollowing();
      following.current = id;
      const tick = async () => {
        timer.current = null;
        if (following.current !== id) return;
        try {
          const res = await fetchStorageDeleteMany(sparkId, id);
          if (following.current !== id) return;
          if (res.job) setJob(res.job);
          if (res.job?.state === "done") {
            following.current = null;
            finished.current(res.job, here);
            return;
          }
        } catch (err) {
          if (following.current !== id) return;
          // Not known any more (the dashboard restarted, or a newer run replaced it): nothing left to follow.
          if (err instanceof ApiError && err.status === 404) {
            following.current = null;
            setJob(null);
            return;
          }
          // Anything else (a dropped connection): keep trying; the run goes on on the server.
        }
        timer.current = window.setTimeout(() => void tick(), BULK_POLL_MS);
      };
      timer.current = window.setTimeout(() => void tick(), BULK_FIRST_POLL_MS);
    },
    [sparkId, stopFollowing]
  );

  useEffect(() => {
    let live = true;
    setJob(null);
    void (async () => {
      try {
        const res = await fetchStorageDeleteMany(sparkId);
        if (live && res.job?.state === "running" && following.current == null) {
          setJob(res.job);
          follow(res.job.id, false);
        }
      } catch {
        // Nothing to follow is not an error the page needs to show.
      }
    })();
    return () => {
      live = false;
      stopFollowing();
    };
  }, [sparkId, follow, stopFollowing]);

  const start = useCallback(
    async (paths: string[], elevation: StorageElevation) => {
      const res = await startStorageDeleteMany(sparkId, { paths, ...elevation });
      setJob(res.job);
      follow(res.job.id, true);
      return res.job;
    },
    [sparkId, follow]
  );

  return { job, start };
}
