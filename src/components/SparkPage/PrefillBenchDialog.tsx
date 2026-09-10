import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  cancelPrefillBench,
  clearPrefillBenchHistory,
  getPrefillBench,
  listPrefillBench,
  startPrefillBench,
} from "../../api/client";
import type { PrefillBenchJob, LlmBenchTarget } from "../../api/types";
import { useModalPresence } from "../../hooks/useModalPresence";
import {
  PREFILL_CONTEXT_SIZES,
  PREFILL_DEFAULT_CONTEXT_SIZES,
  formatContextSize,
} from "../../shared/prefillBench.js";
import { formatLlmBaseUrl } from "../../shared/llmTarget.js";

interface PrefillBenchDialogProps {
  open: boolean;
  onClose: () => void;
  sparkId: string;
  llmPort: number;
  modelId: string | null;
  contextLength: number | null;
  remoteTarget?: LlmBenchTarget | null;
}

function useEscape(onClose: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, enabled]);
}

function useBodyScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [locked]);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}m ${rem.toFixed(0)}s`;
}

function statusLabel(status: PrefillBenchJob["status"]): string {
  switch (status) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}

function formatTtft(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

function defaultSelected(contextLength: number | null): number[] {
  const cap =
    contextLength != null && contextLength > 0 ? contextLength : Number.POSITIVE_INFINITY;
  const fitted = PREFILL_DEFAULT_CONTEXT_SIZES.filter((n: number) => n <= cap);
  if (fitted.length) return [...fitted];
  const allowed = PREFILL_CONTEXT_SIZES.filter((n: number) => n <= cap);
  return allowed.length ? [allowed[allowed.length - 1]] : [PREFILL_CONTEXT_SIZES[0]];
}

function buildShareText(job: PrefillBenchJob, modelId: string | null): string {
  const name = modelId || job.config?.modelId || "unknown model";
  const head = `${name} | prefill tok/s results:`;
  const lines = job.results.map((r) => {
    const label = formatContextSize(r.targetTokens);
    if (r.error && r.prefillTps <= 0) {
      return `${label}  failed${r.error ? ` — ${r.error}` : ""}`;
    }
    const actual =
      r.promptTokens > 0 ? `${r.promptTokens} tok` : `${r.targetTokens} tok`;
    return `${label}  ${r.prefillTps.toFixed(1)} tok/s  · TTFT ${formatTtft(r.ttftMs)}  · ${actual}`;
  });
  return [head, "", ...lines].join("\n");
}

function ResultRow({ r }: { r: PrefillBenchJob["results"][number] }) {
  return (
    <article className="bench-result-row" title={r.error || undefined}>
      <div className="bench-result-row__load">
        <span className="bench-result-row__badge">{formatContextSize(r.targetTokens)}</span>
        <div className="bench-result-row__facts">
          <span>
            TTFT <strong>{formatTtft(r.ttftMs)}</strong>
          </span>
          <span className="bench-result-row__sep" aria-hidden>
            ·
          </span>
          <span>
            <strong>{r.promptTokens > 0 ? r.promptTokens.toLocaleString() : "—"}</strong>{" "}
            tokens
          </span>
        </div>
      </div>

      <div className="bench-result-row__speeds">
        <div className="bench-result-row__metric">
          <span className="bench-result-row__label">Prefill</span>
          <span className="bench-result-row__value bench-result-row__value--accent">
            {r.prefillTps.toFixed(1)}
            <span className="bench-result-row__unit">tok/s</span>
          </span>
        </div>
        <div className="bench-result-row__metric">
          <span className="bench-result-row__label">TTFT</span>
          <span className="bench-result-row__value">
            {formatTtft(r.ttftMs)}
          </span>
        </div>
      </div>
    </article>
  );
}

export function PrefillBenchDialog({
  open,
  onClose,
  sparkId,
  llmPort,
  modelId,
  contextLength,
  remoteTarget = null,
}: PrefillBenchDialogProps) {
  const [selected, setSelected] = useState<number[]>(() => defaultSelected(contextLength));
  const [job, setJob] = useState<PrefillBenchJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [loadingLast, setLoadingLast] = useState(false);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const benchPort = remoteTarget?.port ?? llmPort;

  const stopPoll = useCallback(() => {
    if (pollRef.current != null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const isRunning = job?.status === "running";
  const { mounted, visible } = useModalPresence(open);

  useEscape(onClose, open && !starting);
  useBodyScrollLock(mounted);

  const startPolling = useCallback(
    (benchId: string) => {
      stopPoll();
      pollRef.current = setInterval(() => {
        void getPrefillBench(sparkId, benchId)
          .then((j) => {
            setJob(j);
            setError(null);
            if (j.status !== "running") stopPoll();
          })
          .catch((err: Error) => {
            void listPrefillBench(sparkId, benchPort)
              .then((data) => {
                if (data.active) {
                  setJob(data.active);
                  setError(null);
                  if (data.active.benchId !== benchId) {
                    startPolling(data.active.benchId);
                  } else if (data.active.status !== "running") {
                    stopPoll();
                  }
                  return;
                }
                const recovered =
                  data.history?.find((j) => j.benchId === benchId) ||
                  (data.last?.benchId === benchId ? data.last : null);
                if (recovered) {
                  setJob(recovered);
                  setError(null);
                  stopPoll();
                  return;
                }
                setError(
                  err.message === "Benchmark not found"
                    ? "Benchmark interrupted — server restarted during the run"
                    : err.message
                );
                stopPoll();
              })
              .catch(() => {
                setError(
                  err.message === "Benchmark not found"
                    ? "Benchmark interrupted — server restarted during the run"
                    : err.message
                );
                stopPoll();
              });
          });
      }, 800);
    },
    [sparkId, benchPort, stopPoll]
  );

  useEffect(() => {
    if (!open) {
      stopPoll();
      return;
    }
    let cancelled = false;
    setLoadingLast(true);
    setError(null);
    void listPrefillBench(sparkId, benchPort)
      .then((data) => {
        if (cancelled) return;
        if (data.active) {
          setJob(data.active);
          if (Array.isArray(data.active.config?.contextSizes)) {
            setSelected(
              data.active.config.contextSizes.filter(
                (n) => contextLength == null || contextLength <= 0 || n <= contextLength
              )
            );
          }
          if (data.active.status === "running") startPolling(data.active.benchId);
        } else if (data.last) {
          setJob(data.last);
          if (Array.isArray(data.last.config?.contextSizes)) {
            const next = data.last.config.contextSizes.filter(
              (n) => contextLength == null || contextLength <= 0 || n <= contextLength
            );
            setSelected(next.length ? next : defaultSelected(contextLength));
          }
        } else {
          setJob(null);
          setSelected(defaultSelected(contextLength));
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingLast(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sparkId, benchPort, contextLength, startPolling, stopPoll]);

  useEffect(() => () => stopPoll(), [stopPoll]);
  useEffect(
    () => () => {
      if (copyResetRef.current != null) clearTimeout(copyResetRef.current);
    },
    []
  );

  const sizeFits = (n: number) =>
    contextLength == null || contextLength <= 0 || n <= contextLength;

  const toggleSize = (n: number) => {
    if (isRunning || starting || !sizeFits(n)) return;
    setSelected((prev) => {
      if (prev.includes(n)) {
        if (prev.length === 1) return prev;
        return prev.filter((x) => x !== n).sort((a, b) => a - b);
      }
      return [...prev, n].sort((a, b) => a - b);
    });
  };

  const startLockRef = useRef(false);
  const handleStart = async () => {
    if (startLockRef.current) return;
    const sizes = selected.filter(sizeFits);
    if (sizes.length === 0) {
      setError("Select at least one context size that fits this model");
      return;
    }
    startLockRef.current = true;
    setStarting(true);
    setError(null);
    setJob(null);
    try {
      const started = await startPrefillBench(sparkId, {
        port: benchPort,
        contextSizes: sizes,
        modelId: modelId || undefined,
        ...(remoteTarget
          ? { host: remoteTarget.host, tls: remoteTarget.tls }
          : {}),
      });
      setJob(started);
      startPolling(started.benchId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      startLockRef.current = false;
      setStarting(false);
    }
  };

  const handleCancel = async () => {
    if (!job || job.status !== "running") return;
    try {
      const j = await cancelPrefillBench(sparkId, job.benchId);
      setJob(j);
      startPolling(job.benchId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleNewRun = () => {
    stopPoll();
    setJob(null);
    setError(null);
  };

  const handleCopyResults = async () => {
    if (!job || job.results.length === 0) return;
    const text = buildShareText(job, modelId);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      if (copyResetRef.current != null) clearTimeout(copyResetRef.current);
      copyResetRef.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Could not copy results to clipboard");
    }
  };

  const handleClear = async () => {
    if (!job || job.status === "running") return;
    setError(null);
    try {
      await clearPrefillBenchHistory(sparkId, benchPort);
      stopPoll();
      setJob(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!mounted) return null;

  const progressPct =
    job && job.progress.totalLevels > 0
      ? Math.round(
          ((job.progress.completedLevels + (job.status === "running" ? 0.35 : 0)) /
            job.progress.totalLevels) *
            100
        )
      : 0;

  const showConfig = (!job || job.status === "running") && !loadingLast;
  const showResults = job && job.status !== "running";
  const ctxHint =
    contextLength != null && contextLength > 0
      ? `Model context ${formatContextSize(contextLength)} — larger sizes are disabled.`
      : "Unique-prefix prompts; TTFT is time to first token. 128k–300k can take tens of minutes.";

  const dialog = (
    <div className={`bench-overlay${visible ? " is-open" : ""}`} role="presentation">
      <button
        type="button"
        className="bench-overlay__scrim"
        aria-label="Close dialog"
        onClick={() => {
          if (!isRunning) onClose();
        }}
      />

      <div
        className="bench-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="prefill-bench-title"
      >
        <header className="bench-sheet__header">
          <div className="bench-sheet__header-text">
            <h2 id="prefill-bench-title" className="bench-sheet__title">
              Prefill benchmark
            </h2>
            <p className="bench-sheet__subtitle">
              {remoteTarget
                ? formatLlmBaseUrl(remoteTarget)
                : `Port ${llmPort}`}
              {modelId ? ` · ${modelId}` : ""}
            </p>
          </div>
          <button
            type="button"
            className="bench-sheet__close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="bench-sheet__body">
          {loadingLast && !job && (
            <p className="bench-sheet__hint">Loading last results…</p>
          )}

          {showConfig && (
            <section className="bench-sheet__section">
              <div className="bench-field">
                <div className="bench-field__head">
                  <h3 className="bench-sheet__section-title">Context size</h3>
                  <p className="bench-sheet__hint">{ctxHint}</p>
                </div>
                <div className="bench-conc-grid" role="group" aria-label="Context sizes">
                  {PREFILL_CONTEXT_SIZES.map((n: number) => {
                    const on = selected.includes(n);
                    const fits = sizeFits(n);
                    return (
                      <button
                        key={n}
                        type="button"
                        disabled={isRunning || starting || !fits}
                        title={
                          fits
                            ? `${n.toLocaleString()} tokens`
                            : `Exceeds model context (${contextLength?.toLocaleString()} tokens)`
                        }
                        onClick={() => toggleSize(n)}
                        className={`bench-conc-btn${on ? " is-on" : ""}`}
                      >
                        {formatContextSize(n)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>
          )}

          {error && <p className="bench-sheet__error">{error}</p>}

          {job && job.status === "running" && (
            <section className="bench-sheet__section">
              <div className="bench-progress">
                <div className="bench-progress__row">
                  <span className="bench-progress__status">
                    Running
                    {job.progress.currentContext != null
                      ? ` · ${formatContextSize(job.progress.currentContext)}`
                      : ""}
                  </span>
                  <span className="bench-progress__meta">
                    {job.progress.completedLevels}/{job.progress.totalLevels}
                    {job.durationMs != null ? ` · ${formatDuration(job.durationMs)}` : ""}
                  </span>
                </div>
                <div className="bench-progress__track">
                  <div
                    className="bench-progress__fill"
                    style={{ width: `${Math.min(100, progressPct)}%` }}
                  />
                </div>
                {job.progress.message ? (
                  <p className="bench-sheet__hint">{job.progress.message}</p>
                ) : null}
              </div>
              {job.results.length > 0 && (
                <div className="bench-results">
                  <div className="bench-results__caption">Completed sizes</div>
                  {job.results.map((r) => (
                    <ResultRow key={r.targetTokens} r={r} />
                  ))}
                </div>
              )}
            </section>
          )}

          {showResults && (
            <section className="bench-sheet__section">
              <div className="bench-status-row">
                <span className={`bench-status-pill bench-status-pill--${job.status}`}>
                  {statusLabel(job.status)}
                </span>
                <span className="bench-status-meta">
                  {job.config.contextSizes.map(formatContextSize).join(", ")}
                  {job.durationMs != null ? ` · ${formatDuration(job.durationMs)}` : ""}
                </span>
              </div>

              {job.error && <p className="bench-sheet__error">{job.error}</p>}

              {job.results.length > 0 && (
                <div className="bench-results bench-results--table">
                  <div className="bench-results__head" aria-hidden="true">
                    <span>Context</span>
                    <span className="bench-results__head-speeds">
                      <span>Prefill</span>
                      <span>TTFT</span>
                    </span>
                  </div>
                  {job.results.map((r) => (
                    <ResultRow key={r.targetTokens} r={r} />
                  ))}
                </div>
              )}

              {job.results.length > 0 && (
                <p className="bench-legend">
                  <strong>Prefill</strong> — prompt tokens ÷ time to first token.{" "}
                  <strong>TTFT</strong> — request start to first streamed token. Each size
                  uses a unique prefix so prefix-cache does not inflate later sizes.
                </p>
              )}
            </section>
          )}
        </div>

        <footer className="bench-sheet__footer">
          {job?.status === "running" ? (
            <button
              type="button"
              className="bench-btn bench-btn--ghost"
              onClick={() => void handleCancel()}
            >
              Cancel
            </button>
          ) : job ? (
            <>
              {job.results.length > 0 && (
                <button
                  type="button"
                  className="bench-btn bench-btn--ghost"
                  onClick={() => void handleClear()}
                  title="Clear saved results for this port"
                >
                  Clear
                </button>
              )}
              {job.results.length > 0 && (
                <button
                  type="button"
                  className="bench-btn bench-btn--ghost"
                  onClick={() => void handleCopyResults()}
                  title="Copy a plain-text summary to the clipboard"
                >
                  {copied ? "Copied!" : "Copy results"}
                </button>
              )}
              <button type="button" className="bench-btn bench-btn--ghost" onClick={handleNewRun}>
                New run
              </button>
              <button type="button" className="bench-btn bench-btn--primary" onClick={onClose}>
                Done
              </button>
            </>
          ) : (
            <>
              <button type="button" className="bench-btn bench-btn--ghost" onClick={onClose}>
                Close
              </button>
              <button
                type="button"
                className="bench-btn bench-btn--primary"
                onClick={() => void handleStart()}
                disabled={starting || selected.filter(sizeFits).length === 0}
              >
                {starting ? "Starting…" : "Run benchmark"}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
