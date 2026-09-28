import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { deleteModelJob, fetchModelJob } from "../../../api/modelClient";
import type { ModelAction, ModelJob } from "../../../api/modelTypes";
import { formatLogLine } from "./logFormat";

const POLL_MS = 500;
/** Stick-to-bottom slack, matching TerminalCard's behaviour. */
const BOTTOM_SLACK_PX = 64;

interface LogConsoleProps {
  /** Job whose transcript to follow. null renders an empty console. */
  jobId: string | null;
  /**
   * Called when the transcript reaches a terminal state so the parent can stop
   * showing a spinner. Also fired on the first frame if it already finished.
   */
  onSettled?: (job: ModelJob) => void;
}

/**
 * Delta-polling transcript console.
 *
 * Borrows TerminalCard's stick-to-bottom rule (follow the tail unless the user
 * scrolled more than 64 px up) and Showcase's `rev`/`since` protocol, but not
 * TerminalCard itself — its props are tok/s-specific.
 *
 * Cleanup: `DELETE /jobs/:id` on unmount. For a finished job that drops the
 * in-memory record; for a still-running tail it cancels the tail only, so
 * closing the modal during a `logs` never disturbs the model.
 */
export function LogConsole({ jobId, onSettled }: LogConsoleProps) {
  const [text, setText] = useState("");
  const [job, setJob] = useState<ModelJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  /** Char cursor into the server-side ring buffer. */
  const cursor = useRef<number | null>(null);
  const settledRef = useRef(false);
  const textLengthRef = useRef(0);

  // Reset per job — a new jobId is a new transcript space, not a continuation.
  useEffect(() => {
    cursor.current = null;
    textLengthRef.current = 0;
    settledRef.current = false;
    setText("");
    setJob(null);
    setError(null);
    stickToBottom.current = true;
  }, [jobId]);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const next = await fetchModelJob(jobId, cursor.current);
        if (cancelled) return;
        // Ring buffer trimmed past our cursor → rebuild from what remains.
        if (next.reset) {
          cursor.current = next.since ?? null;
          setText(next.append ?? "");
        } else {
          cursor.current = next.since ?? cursor.current;
          if (next.append) setText((prev) => prev + next.append);
        }
        setJob(next);
        setError(null);
        const terminal = next.status !== "running";
        if (terminal && !settledRef.current) {
          settledRef.current = true;
          onSettled?.(next);
        }
      } catch (err: unknown) {
        // 404 = job record was pruned; treat as ended rather than retrying.
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        return;
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // onSettled is held stable by the caller via useCallback where needed.
  }, [jobId]);

  // Auto-follow the tail unless the user scrolled away.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [textLengthRef.current, text, job?.status]);

  const handleScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX;
  }, []);

  /** Mirror the text length into the scroll effect without an extra render. */
  useEffect(() => {
    textLengthRef.current = text.length;
  }, [text]);

  // Build the coloured transcript from the raw text. The transcript only grows
  // (delta-appended) or resets, so recomputing on `text` change is cheap enough;
  // formatLogLine is a pure per-line function. Every raw line is preserved —
  // nothing is filtered out, only dimmed/coloured.
  const formatted = useMemo(() => {
    const lines = text.split("\n");
    const out: ReactNode[] = [];
    for (let i = 0; i < lines.length; i++) {
      const { base, nodes } = formatLogLine(lines[i]);
      out.push(
        <span key={i} className={base || undefined}>
          {nodes}
          {i < lines.length - 1 ? "\n" : ""}
        </span>
      );
    }
    return out;
  }, [text]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={bodyRef}
        onScroll={handleScroll}
        className="showcase-term__body max-h-[52vh] min-h-[16rem] flex-1 overflow-auto"
      >
        {text ? <pre className="showcase-term__answer">{formatted}</pre> : null}
        {!text && job?.status === "running" && <pre className="showcase-term__answer">…</pre>}
        {!text && !job && error && (
          <pre className="showcase-term__error">{`[error] ${error}`}</pre>
        )}
        {error && text ? <pre className="showcase-term__error">{`[error] ${error}`}</pre> : null}
      </div>
      {job && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted">
          <span
            className={`rounded px-1.5 py-0.5 font-medium ${
              job.status === "running"
                ? "bg-accent/15 text-accent"
                : job.status === "done"
                  ? "bg-success/15 text-success"
                  : "bg-danger/15 text-danger"
            }`}
          >
            {job.status}
          </span>
          {job.script && (
            <span className="font-tabular">
              {job.script.includes(" ") ? job.script : `./${job.script}`}
            </span>
          )}
          {typeof job.exitCode === "number" && <span className="font-tabular">exit {job.exitCode}</span>}
          <span className="font-tabular">{job.totalChars.toLocaleString()} chars</span>
          {job.source === "scheduler" && (
            <span className="rounded bg-border/60 px-1.5 py-0.5" title="Started by the model scheduler, not by a click">
              scheduled
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Tell the server we are done with a transcript.
 *
 * Only a `logs` job is released: a running tail is cancelled (the model is
 * untouched) and a finished one drops its record. A finished start/stop/restart
 * transcript is deliberately left in place so the card's job chip stays
 * clickable — the manager prunes those by TTL/count anyway.
 */
export function releaseJob(jobId: string | null, action: ModelAction | undefined) {
  if (!jobId || action !== "logs") return;
  void deleteModelJob(jobId).catch(() => {
    /* the record is pruned by TTL anyway */
  });
}
