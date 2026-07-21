import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  cancelDecodeBench,
  clearDecodeBenchHistory,
  getDecodeBench,
  listDecodeBench,
  startDecodeBench,
} from "../../api/client";
import type { DecodeBenchJob } from "../../api/types";
import { useModalPresence } from "../../hooks/useModalPresence";

const CONCURRENCY_OPTIONS = [1, 2, 3, 4, 6, 8, 16, 32] as const;
const DEFAULT_SELECTED = [1, 2];
const DEFAULT_MAX_TOKENS = 500;

interface BenchmarkDialogProps {
  open: boolean;
  onClose: () => void;
  sparkId: string;
  llmPort: number;
  modelId: string | null;
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

/** Lock body scroll while the modal is open (important on iOS). */
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

function statusLabel(status: DecodeBenchJob["status"]): string {
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

function serverTps(r: DecodeBenchJob["results"][number]): number {
  return r.serverGenerationTps != null ? r.serverGenerationTps : r.aggregateDecodeTps;
}

function ResultRow({ r }: { r: DecodeBenchJob["results"][number] }) {
  const server = serverTps(r);
  const peak =
    r.serverGenerationTpsMax != null &&
    r.serverGenerationTps != null &&
    r.serverGenerationTpsMax > r.serverGenerationTps + 0.5
      ? r.serverGenerationTpsMax
      : null;
  const decodeRange =
    r.minDecodeTps !== r.maxDecodeTps
      ? `${r.minDecodeTps.toFixed(0)}–${r.maxDecodeTps.toFixed(0)}`
      : null;

  return (
    <article className="bench-result-row" title={r.error || undefined}>
      <div className="bench-result-row__load">
        <span className="bench-result-row__badge">×{r.concurrency}</span>
        <div className="bench-result-row__facts">
          <span>
            TTFT <strong>{formatTtft(r.meanTtftMs)}</strong>
          </span>
          <span className="bench-result-row__sep" aria-hidden>
            ·
          </span>
          <span className={r.streamsFailed ? "text-warning" : undefined}>
            <strong>
              {r.streamsOk}/{r.streamsOk + r.streamsFailed}
            </strong>{" "}
            streams
          </span>
        </div>
      </div>

      <div className="bench-result-row__speeds">
        <div className="bench-result-row__metric">
          <span className="bench-result-row__label">Server</span>
          <span className="bench-result-row__value bench-result-row__value--accent">
            {server.toFixed(1)}
            <span className="bench-result-row__unit">tok/s</span>
          </span>
          {peak != null && (
            <span className="bench-result-row__sub">peak {peak.toFixed(0)}</span>
          )}
        </div>
        <div className="bench-result-row__metric bench-result-row__metric--decode">
          <span className="bench-result-row__label">Decode</span>
          <span className="bench-result-row__value">
            {r.meanDecodeTps.toFixed(1)}
            <span className="bench-result-row__unit">tok/s</span>
          </span>
          {decodeRange != null && (
            <span className="bench-result-row__sub">{decodeRange}</span>
          )}
        </div>
      </div>
    </article>
  );
}

export function BenchmarkDialog({
  open,
  onClose,
  sparkId,
  llmPort,
  modelId,
}: BenchmarkDialogProps) {
  const [selected, setSelected] = useState<number[]>([...DEFAULT_SELECTED]);
  const [maxTokensDraft, setMaxTokensDraft] = useState(String(DEFAULT_MAX_TOKENS));
  const [job, setJob] = useState<DecodeBenchJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [loadingLast, setLoadingLast] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const applyJobConfig = useCallback((j: DecodeBenchJob) => {
    if (Array.isArray(j.config?.concurrencies) && j.config.concurrencies.length > 0) {
      setSelected([...j.config.concurrencies].sort((a, b) => a - b));
    }
    if (j.config?.maxTokens != null) {
      setMaxTokensDraft(String(j.config.maxTokens));
    }
  }, []);

  const startPolling = useCallback(
    (benchId: string) => {
      stopPoll();
      pollRef.current = setInterval(() => {
        void getDecodeBench(sparkId, benchId)
          .then((j) => {
            setJob(j);
            if (j.status !== "running") stopPoll();
          })
          .catch((err: Error) => {
            setError(err.message);
            stopPoll();
          });
      }, 800);
    },
    [sparkId, stopPoll]
  );

  useEffect(() => {
    if (!open) {
      stopPoll();
      return;
    }
    setError(null);
    let cancelled = false;
    setLoadingLast(true);
    listDecodeBench(sparkId, llmPort)
      .then((data) => {
        if (cancelled) return;
        if (data.active) {
          setJob(data.active);
          applyJobConfig(data.active);
          if (data.active.status === "running") {
            startPolling(data.active.benchId);
          }
          return;
        }
        if (data.last) {
          setJob(data.last);
          applyJobConfig(data.last);
          return;
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
      stopPoll();
    };
  }, [open, sparkId, llmPort, stopPoll, startPolling, applyJobConfig]);

  useEffect(() => () => stopPoll(), [stopPoll]);

  const toggleConcurrency = (n: number) => {
    if (isRunning || starting) return;
    setSelected((prev) => {
      if (prev.includes(n)) {
        if (prev.length === 1) return prev;
        return prev.filter((x) => x !== n).sort((a, b) => a - b);
      }
      return [...prev, n].sort((a, b) => a - b);
    });
  };

  const handleStart = async () => {
    if (selected.length === 0) {
      setError("Select at least one concurrency level");
      return;
    }
    const maxTokens = parseInt(maxTokensDraft.trim(), 10);
    if (!Number.isInteger(maxTokens) || maxTokens < 64 || maxTokens > 2048) {
      setError("Max tokens must be an integer between 64 and 2048");
      return;
    }
    setStarting(true);
    setError(null);
    setJob(null);
    try {
      const started = await startDecodeBench(sparkId, {
        port: llmPort,
        concurrencies: selected,
        maxTokens,
        modelId: modelId || undefined,
      });
      setJob(started);
      startPolling(started.benchId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const handleCancel = async () => {
    if (!job || job.status !== "running") return;
    try {
      const j = await cancelDecodeBench(sparkId, job.benchId);
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

  const handleClear = async () => {
    if (!job || job.status === "running") return;
    setError(null);
    try {
      await clearDecodeBenchHistory(sparkId, llmPort);
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

  const dialog = (
    <div className={`bench-overlay${visible ? " is-open" : ""}`} role="presentation">
      {/* Scrim — click to close when not running */}
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
        aria-labelledby="bench-title"
      >
        <header className="bench-sheet__header">
          <div className="bench-sheet__header-text">
            <h2 id="bench-title" className="bench-sheet__title">
              Decode benchmark
            </h2>
            <p className="bench-sheet__subtitle">
              Port {llmPort}
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
                  <h3 className="bench-sheet__section-title">Concurrency</h3>
                  <p className="bench-sheet__hint">
                    Levels run sequentially; each opens that many parallel streams.
                  </p>
                </div>
                <div className="bench-conc-grid">
                  {CONCURRENCY_OPTIONS.map((n) => {
                    const on = selected.includes(n);
                    return (
                      <button
                        key={n}
                        type="button"
                        disabled={isRunning || starting}
                        onClick={() => toggleConcurrency(n)}
                        className={`bench-conc-btn${on ? " is-on" : ""}`}
                      >
                        {n}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="bench-field bench-field--inline">
                <div className="bench-field__head">
                  <label htmlFor="bench-max-tokens" className="bench-sheet__section-title">
                    Max tokens / stream
                  </label>
                  <p className="bench-sheet__hint">Default 500 · range 64–2048</p>
                </div>
                <input
                  id="bench-max-tokens"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  disabled={isRunning || starting}
                  value={maxTokensDraft}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "" || /^\d+$/.test(raw)) setMaxTokensDraft(raw);
                  }}
                  className="bench-input"
                />
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
                    {job.progress.currentConcurrency != null
                      ? ` · ×${job.progress.currentConcurrency}`
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
                  <div className="bench-results__caption">Completed levels</div>
                  {job.results.map((r) => (
                    <ResultRow key={r.concurrency} r={r} />
                  ))}
                </div>
              )}
            </section>
          )}

          {showResults && (
            <section className="bench-sheet__section">
              <div className="bench-status-row">
                <span
                  className={`bench-status-pill bench-status-pill--${job.status}`}
                >
                  {statusLabel(job.status)}
                </span>
                <span className="bench-status-meta">
                  {job.config.maxTokens} tok · {job.config.concurrencies.join(", ")}{" "}
                  conc
                  {job.durationMs != null ? ` · ${formatDuration(job.durationMs)}` : ""}
                </span>
              </div>

              {job.error && <p className="bench-sheet__error">{job.error}</p>}

              {job.results.length > 0 && (
                <div className="bench-results bench-results--table">
                  <div className="bench-results__head" aria-hidden="true">
                    <span>Load</span>
                    <span className="bench-results__head-speeds">
                      <span>Server</span>
                      <span>Decode</span>
                    </span>
                  </div>
                  {job.results.map((r) => (
                    <ResultRow key={r.concurrency} r={r} />
                  ))}
                </div>
              )}

              {job.results.length > 0 && (
                <p className="bench-legend">
                  <strong>Server</strong> — engine counters.{" "}
                  <strong>Decode</strong> — client tok/s after first token.
                </p>
              )}
            </section>
          )}
        </div>

        <footer className="bench-sheet__footer">
          {job?.status === "running" ? (
            <button type="button" className="bench-btn bench-btn--ghost" onClick={() => void handleCancel()}>
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
                disabled={starting || selected.length === 0}
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
