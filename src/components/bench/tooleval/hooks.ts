import { useCallback, useEffect, useRef, useState } from "react";
import {
  attachToolEvalRun,
  cancelToolEvalWatch,
  deleteToolEvalRun,
  fetchToolEvalResult,
  fetchToolEvalRun,
  fetchToolEvalRuns,
  fetchToolEvalSpec,
  fetchToolEvalStatus,
  previewToolEval,
  readToolEvalInstall,
  readToolEvalRun,
  refreshToolEvalRun,
  startToolEvalInstall,
  startToolEvalRun,
  stopToolEvalRun,
} from "../../../api/client";
import {
  ToolEvalApiError,
  type ToolEvalEvent,
  type ToolEvalJob,
  type ToolEvalLine,
  type ToolEvalProgress,
  type ToolEvalRun,
  type ToolEvalRunRequest,
  type ToolEvalSpec,
  type ToolEvalStatus,
} from "../../../api/types";

const POLL_MS = 700;
const MAX_LINES = 5000;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Merge newly read lines (by sequence number) into the buffer. */
export function mergeLines<T extends { seq: number }>(prev: T[], next: T[], max = MAX_LINES): T[] {
  if (!next.length) return prev;
  const last = prev.length ? prev[prev.length - 1].seq : 0;
  const fresh = next.filter((l) => l.seq > last);
  if (!fresh.length) return prev;
  const merged = prev.concat(fresh);
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

// ── option spec (same for every Spark; fetched once) ──
let specPromise: Promise<ToolEvalSpec> | null = null;

export function useToolEvalSpec() {
  const [spec, setSpec] = useState<ToolEvalSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let off = false;
    specPromise ??= fetchToolEvalSpec();
    specPromise.then((s) => !off && (setSpec(s), setError(null))).catch((e) => {
      specPromise = null;
      if (!off) setError(msg(e));
    });
    return () => {
      off = true;
    };
  }, [attempt]);
  return { spec, error, retry: () => setAttempt((n) => n + 1) };
}

// ── install state of the tool on the Spark ──
export function useToolEvalStatus(sparkId: string | null) {
  const [status, setStatus] = useState<ToolEvalStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);
  const reload = useCallback(async () => {
    if (!sparkId) return;
    const id = ++reqRef.current;
    setLoading(true);
    try {
      const s = await fetchToolEvalStatus(sparkId);
      if (id === reqRef.current) (setStatus(s), setError(null));
    } catch (e) {
      if (id === reqRef.current) setError(msg(e));
    } finally {
      if (id === reqRef.current) setLoading(false);
    }
  }, [sparkId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { status, error, loading, reload };
}

// ── install / upgrade job ──
export function useToolEvalInstall(sparkId: string, onFinished: () => void) {
  const [job, setJob] = useState<ToolEvalJob | null>(null);
  const [lines, setLines] = useState<ToolEvalLine[]>([]);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const sinceRef = useRef(0);
  const doneRef = useRef(onFinished);
  doneRef.current = onFinished;
  const running = job?.status === "running";

  const follow = useCallback((j: ToolEvalJob) => {
    sinceRef.current = 0;
    setLines([]);
    setPartial("");
    setError(null);
    setJob(j);
  }, []);

  // Pick up an install that is already running (page reloaded mid-install).
  useEffect(() => {
    let off = false;
    readToolEvalInstall(sparkId, 0)
      .then((r) => {
        if (off || r.job.status !== "running") return;
        sinceRef.current = r.nextLine;
        setLines(r.lines);
        setJob(r.job);
      })
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [sparkId]);

  useEffect(() => {
    if (!running) return;
    let off = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const r = await readToolEvalInstall(sparkId, sinceRef.current);
        if (off) return;
        sinceRef.current = Math.max(sinceRef.current, r.nextLine);
        setLines((p) => mergeLines(p, r.lines));
        setPartial(r.partial ?? "");
        setJob(r.job);
        setError(null);
        if (r.job.status !== "running") {
          doneRef.current();
          return;
        }
      } catch (e) {
        if (off) return;
        setError(msg(e));
      }
      timer = window.setTimeout(tick, POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);
    return () => {
      off = true;
      window.clearTimeout(timer);
    };
  }, [sparkId, running]);

  const start = useCallback(
    async (extras: string[], upgrade: boolean) => {
      try {
        const r = await startToolEvalInstall(sparkId, extras, upgrade);
        setCommand(r.command);
        follow(r.job);
      } catch (e) {
        setError(msg(e));
      }
    },
    [sparkId, follow]
  );

  return { job, lines, partial, error, command, running, start };
}

// ── live command line + validation ──
export interface PreviewState {
  status: "idle" | "loading" | "ok" | "invalid" | "error";
  command: string | null;
  usesSavedKey: boolean;
  errors: string[];
  error: string | null;
}
const IDLE: PreviewState = { status: "idle", command: null, usesSavedKey: false, errors: [], error: null };

/** Debounced POST /preview whenever the request changes. Pass null to pause (e.g. while the form has client-side errors). */
export function useToolEvalPreview(sparkId: string, req: ToolEvalRunRequest | null, delay = 450): PreviewState {
  const [state, setState] = useState<PreviewState>(IDLE);
  const key = req ? JSON.stringify(req) : "";
  useEffect(() => {
    if (!req) {
      setState(IDLE);
      return;
    }
    let off = false;
    setState((s) => ({ ...s, status: "loading" }));
    const t = window.setTimeout(() => {
      previewToolEval(sparkId, req)
        .then((r) => !off && setState({ status: "ok", command: r.command, usesSavedKey: Boolean(r.usesSavedKey), errors: [], error: null }))
        .catch((e) => {
          if (off) return;
          if (e instanceof ToolEvalApiError && e.status === 400) setState({ status: "invalid", command: null, usesSavedKey: false, errors: e.errors.length ? e.errors : [e.message], error: null });
          else setState({ status: "error", command: null, usesSavedKey: false, errors: [], error: msg(e) });
        });
    }, delay);
    return () => {
      off = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sparkId, key, delay]);
  return state;
}

// ── runs: history, the followed run and its live stream ──
export interface Followed {
  run: ToolEvalRun;
  job: ToolEvalJob | null;
  lines: ToolEvalLine[];
  events: ToolEvalEvent[];
  partial: string;
  progress: ToolEvalProgress | null;
  /** The server has no live job for this run (restart, or finished long ago). */
  noLive: boolean;
}

export function useToolEvalRunner(sparkId: string, type: string, onSettled: (run: ToolEvalRun) => void) {
  const [runs, setRuns] = useState<ToolEvalRun[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [active, setActive] = useState<ToolEvalJob | null>(null);
  const [followed, setFollowed] = useState<Followed | null>(null);
  const [polling, setPolling] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ToolEvalJob | null>(null);
  /** A run of another page type is active on this Spark (not followed here). */
  const [elsewhere, setElsewhere] = useState<{ id: string; type: string | null } | null>(null);
  const lineRef = useRef(0);
  const eventRef = useRef(0);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const followId = followed?.run.id ?? null;

  const reloadRuns = useCallback(async () => {
    try {
      const r = await fetchToolEvalRuns(sparkId, type);
      setRuns(r.runs);
      setActive(r.active);
      setListError(null);
      return r;
    } catch (e) {
      setListError(msg(e));
      return null;
    }
  }, [sparkId, type]);

  const follow = useCallback((run: ToolEvalRun) => {
    lineRef.current = 0;
    eventRef.current = 0;
    setPollError(null);
    setFollowed({ run, job: null, lines: [], events: [], partial: "", progress: null, noLive: false });
    setPolling(true);
  }, []);

  // First load: history, and pick up whatever is running on this Spark.
  useEffect(() => {
    let off = false;
    void (async () => {
      const r = await reloadRuns();
      if (off || !r) return;
      if (r.active && (r.active.kind === "run" || r.active.kind === "attach")) {
        const known = r.runs.find((x) => x.id === r.active?.id);
        const run = known ?? (await fetchToolEvalRun(sparkId, r.active.id).then((x) => x.run).catch(() => null));
        if (off) return;
        if (run && run.type === type) follow(run);
        else setElsewhere({ id: r.active.id, type: run?.type ?? r.active.type });
        return;
      }
      const stale = r.runs.find((x) => x.status === "running");
      if (stale) {
        try {
          await attachToolEvalRun(sparkId, stale.id);
          if (!off) follow(stale);
        } catch {
          /* busy or gone: it stays listed with a refresh action */
        }
      }
    })();
    return () => {
      off = true;
    };
  }, [sparkId, type, reloadRuns, follow]);

  // Poll the followed run.
  useEffect(() => {
    if (!followId || !polling) return;
    let off = false;
    let timer: number | undefined;
    let settleTries = 0;
    let fails = 0;
    const finish = (run: ToolEvalRun | null) => {
      setPolling(false);
      void reloadRuns();
      if (run) settledRef.current(run);
    };
    const tick = async () => {
      let next = POLL_MS;
      try {
        const read = await readToolEvalRun(sparkId, followId, lineRef.current, eventRef.current);
        if (off) return;
        fails = 0;
        setPollError(null);
        const live = read.live;
        if (live) {
          lineRef.current = Math.max(lineRef.current, live.nextLine);
          eventRef.current = Math.max(eventRef.current, live.nextEvent);
        }
        setFollowed((p) =>
          p && p.run.id === followId
            ? {
                run: read.run ?? p.run,
                job: live?.job ?? p.job,
                lines: live ? mergeLines(p.lines, live.lines) : p.lines,
                events: live ? mergeLines(p.events, live.events, 2000) : p.events,
                partial: live?.partial ?? "",
                progress: live?.progress ?? p.progress,
                noLive: !live,
              }
            : p
        );
        if (!live) {
          if (read.run?.status === "running") setPolling(false); // nobody is watching it
          else finish(read.run);
          return;
        }
        if (live.job.status !== "running") {
          // The run record is settled shortly after the job ends (result capture).
          settleTries += 1;
          next = 1000;
          const settled = read.run && read.run.status !== "running";
          if (settled || live.job.status === "cancelled" || live.job.status === "detached" || settleTries > 25) return finish(read.run);
        }
      } catch (e) {
        if (off) return;
        fails += 1;
        setPollError(msg(e));
        next = Math.min(5000, POLL_MS * (fails + 1));
      }
      timer = window.setTimeout(tick, next);
    };
    timer = window.setTimeout(tick, 150);
    return () => {
      off = true;
      window.clearTimeout(timer);
    };
  }, [sparkId, followId, polling, reloadRuns]);

  const start = useCallback(
    async (req: ToolEvalRunRequest): Promise<boolean> => {
      setActionError(null);
      setBusy(null);
      try {
        const r = await startToolEvalRun(sparkId, req);
        follow(r.run);
        void reloadRuns();
        return true;
      } catch (e) {
        if (e instanceof ToolEvalApiError && e.status === 409) setBusy(e.active);
        setActionError(msg(e));
        return false;
      }
    },
    [sparkId, follow, reloadRuns]
  );

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setActionError(null);
      try {
        await fn();
        return true;
      } catch (e) {
        setActionError(msg(e));
        return false;
      }
    },
    []
  );

  const stop = useCallback((r: ToolEvalRun) => run(() => stopToolEvalRun(sparkId, r.id)), [sparkId, run]);
  const stopWatching = useCallback(async () => {
    await run(() => cancelToolEvalWatch(sparkId));
  }, [sparkId, run]);
  const attach = useCallback(
    async (r: ToolEvalRun) => {
      const ok = await run(() => attachToolEvalRun(sparkId, r.id));
      if (ok) follow(r);
      return ok;
    },
    [sparkId, run, follow]
  );
  /** Ask the Spark whether a run has finished; resolves with the refreshed run (null when the call failed). */
  const refreshRun = useCallback(
    async (r: ToolEvalRun): Promise<ToolEvalRun | null> => {
      let fresh: ToolEvalRun | null = null;
      const ok = await run(async () => {
        fresh = (await refreshToolEvalRun(sparkId, r.id)).run;
      });
      await reloadRuns();
      if (ok && fresh) {
        const next: ToolEvalRun = fresh;
        setFollowed((p) => (p?.run.id === r.id ? { ...p, run: next } : p));
      }
      return ok ? fresh : null;
    },
    [sparkId, run, reloadRuns]
  );
  const refresh = useCallback(async (r: ToolEvalRun) => (await refreshRun(r)) !== null, [refreshRun]);
  const remove = useCallback(
    async (r: ToolEvalRun) => {
      const ok = await run(() => deleteToolEvalRun(sparkId, r.id));
      if (ok) {
        setFollowed((p) => (p?.run.id === r.id ? null : p));
        await reloadRuns();
      }
      return ok;
    },
    [sparkId, run, reloadRuns]
  );

  return {
    runs,
    listError,
    active,
    followed,
    polling,
    pollError,
    actionError,
    busy,
    reloadRuns,
    follow,
    unfollow: () => setFollowed(null),
    start,
    stop,
    stopWatching,
    attach,
    refresh,
    refreshRun,
    elsewhere,
    remove,
    clearError: () => setActionError(null),
  };
}

// ── one run's stored result ──
export interface ResultState {
  loading: boolean;
  error: string | null;
  result: unknown;
  run: ToolEvalRun | null;
}

export function useToolEvalResult(sparkId: string, runId: string | null, version = 0): ResultState & { reload: () => void } {
  const [state, setState] = useState<ResultState & { forId: string | null }>({ loading: false, error: null, result: null, run: null, forId: null });
  const [attempt, setAttempt] = useState(0);
  const shownFor = useRef<string | null>(null);
  useEffect(() => {
    if (!runId) {
      shownFor.current = null;
      setState({ loading: false, error: null, result: null, run: null, forId: null });
      return;
    }
    let off = false;
    // A different run must never show the previous run's result while loading; a reload of the same run keeps it.
    const same = shownFor.current === runId;
    shownFor.current = runId;
    setState((s) => (same ? { ...s, loading: true, error: null } : { loading: true, error: null, result: null, run: null, forId: runId }));
    fetchToolEvalResult(sparkId, runId)
      .then((r) => !off && setState({ loading: false, error: null, result: r.result, run: r.run, forId: runId }))
      .catch((e) => !off && setState({ loading: false, error: msg(e), result: null, run: null, forId: runId }));
    return () => {
      off = true;
    };
  }, [sparkId, runId, version, attempt]);
  // Until the effect has switched to a new run, never hand out the previous run's result.
  const out: ResultState = !runId || state.forId === runId ? state : { loading: true, error: null, result: null, run: null };
  return { loading: out.loading, error: out.error, result: out.result, run: out.run, reload: () => setAttempt((n) => n + 1) };
}
