import { useCallback, useEffect, useRef, useState } from "react";
import { cancelLauncherJob, readLauncherJob } from "../api/client";
import type { LauncherJob } from "../api/types";

export const MAX_TERMINAL_LINES = 5000;
const POLL_MS = 700;

export interface JobLine {
  seq: number;
  text: string;
}

/** Merge newly read lines into the buffer, keeping at most MAX_TERMINAL_LINES. Exported for tests. */
export function appendLines(prev: JobLine[], next: JobLine[], max = MAX_TERMINAL_LINES): JobLine[] {
  if (next.length === 0) return prev;
  const lastSeq = prev.length ? prev[prev.length - 1].seq : 0;
  const fresh = next.filter((l) => l.seq > lastSeq);
  if (fresh.length === 0) return prev;
  const merged = prev.concat(fresh);
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

/**
 * Follows one launcher job: loads its output from the start, then polls for new
 * lines while it runs. Plain polling, because the WebSocket carries snapshots only.
 */
export function useLauncherJob(sparkId: string) {
  const [job, setJob] = useState<LauncherJob | null>(null);
  const [lines, setLines] = useState<JobLine[]>([]);
  const [partial, setPartial] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sinceRef = useRef(0);
  const runningId = job?.status === "running" ? job.id : null;
  const jobId = job?.id ?? null;

  const apply = useCallback((read: Awaited<ReturnType<typeof readLauncherJob>>) => {
    sinceRef.current = Math.max(sinceRef.current, read.nextSeq);
    setLines((prev) => appendLines(prev, read.lines));
    setPartial(read.partial);
    setTruncated(read.truncated);
    setJob(read.job);
  }, []);

  /** Start following a job (resets the terminal). */
  const follow = useCallback((next: LauncherJob) => {
    sinceRef.current = 0;
    setLines([]);
    setPartial("");
    setTruncated(false);
    setError(null);
    setJob(next);
  }, []);

  // One initial full read per followed job, so finished jobs and re-opened pages show their output too.
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    readLauncherJob(sparkId, jobId, 0)
      .then((read) => {
        if (!cancelled) apply(read);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sparkId, jobId, apply]);

  // While the job runs, poll for new lines.
  useEffect(() => {
    if (!runningId) return;
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const read = await readLauncherJob(sparkId, runningId, sinceRef.current);
        if (stopped) return;
        apply(read);
        setError(null);
        if (read.job.status !== "running") return;
      } catch (e) {
        if (stopped) return;
        setError(e instanceof Error ? e.message : String(e));
      }
      timer = window.setTimeout(tick, POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [sparkId, runningId, apply]);

  const cancel = useCallback(async () => {
    try {
      await cancelLauncherJob(sparkId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sparkId]);

  const clear = useCallback(() => {
    setJob(null);
    setLines([]);
    setPartial("");
    setError(null);
    sinceRef.current = 0;
  }, []);

  return { job, lines, partial, truncated, error, follow, cancel, clear };
}
