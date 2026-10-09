import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "../../styles/dialogs.css";
import {
  cancelPrefillBench,
  clearPrefillBenchHistory,
  getPrefillBench,
  listPrefillBench,
  startPrefillBench,
} from "../../api/client";
import type { PrefillBenchJob, LlmBenchTarget } from "../../api/types";
import { useModalPresence } from "../../hooks/useModalPresence";
import { BenchCopyButton } from "./BenchCopyButton";
import { BenchSwitcher, type BenchKind } from "./BenchSwitcher";
import { XIcon } from "../ui/icons";
import { buildPrefillShareCard, shareCardFileName } from "./benchShareCard";
import {
  PREFILL_CONTEXT_SIZES,
  PREFILL_DEFAULT_CONTEXT_SIZES,
  PREFILL_MAX_CONTEXT_SIZE,
  PREFILL_MIN_CONTEXT_SIZE,
  formatContextSize,
  parseContextSize,
} from "../../shared/prefillBench.js";
import { prefillFitsContext } from "../../shared/contextFit.js";
import { HistoryTable, PageCard, PageEmpty, PageLayout } from "../bench/sparkdash/pageParts";
import { prefillHistoryRow } from "../bench/sparkdash/historyRows";
import { formatDuration } from "../../shared/formatDuration";
import { formatLlmBaseUrl } from "../../shared/llmTarget.js";

interface PrefillBenchDialogProps {
  /** Modal only; the page variant is always open. */
  open?: boolean;
  onClose?: () => void;
  /** "page" renders the same content inline (no overlay, close button or switcher). */
  variant?: "modal" | "page";
  sparkId: string;
  llmPort: number;
  modelId: string | null;
  contextLength: number | null;
  remoteTarget?: LlmBenchTarget | null;
  /** Settings → Benchmark share image: the copy button also carries the card. */
  shareImage?: boolean;
  /** Unit display name for the share-card header. */
  sparkName?: string | null;
  /** Probe backend id for the share card's engine chip. */
  engine?: string | null;
  /** Probe exposure/auth posture for the share-card chip. */
  posture?: { label: string; level: "ok" | "warn" | "danger" } | null;
  /** Switch to another benchmark dialog (Decode / Prefill / Quality). Switcher hidden when omitted. */
  onSwitchBench?: (kind: BenchKind) => void;
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
  // Same fit rule as the server (src/shared/contextFit.js): the prompt adds template + reply tokens.
  const fits = (n: number) => prefillFitsContext(n, contextLength);
  const fitted = PREFILL_DEFAULT_CONTEXT_SIZES.filter(fits);
  if (fitted.length) return [...fitted];
  const allowed = PREFILL_CONTEXT_SIZES.filter(fits);
  return allowed.length ? [allowed[allowed.length - 1]] : [PREFILL_CONTEXT_SIZES[0]];
}

function buildShareText(job: PrefillBenchJob, modelId: string | null): string {
  const name = modelId || job.config?.modelId || "unknown model";
  const head = `${name} | prefill tok/s results:`;
  const lines = job.results.map((r) => {
    const label = formatContextSize(r.targetTokens);
    if (rowFailed(r)) {
      return `${label}  failed — ${r.error || "no prefill rate was measured"}`;
    }
    const actual =
      r.promptTokens > 0 ? `${r.promptTokens} tok` : `${r.targetTokens} tok`;
    const flags = [
      r.lowConfidence ? "low confidence" : null,
      r.samples != null && r.samplesRequested != null && r.samples < r.samplesRequested
        ? `${r.samples}/${r.samplesRequested} samples`
        : null,
    ].filter(Boolean);
    return `${label}  ${r.prefillTps.toFixed(1)} tok/s  · TTFT ${formatTtft(r.ttftMs)}  · ${actual}${flags.length ? `  · ${flags.join(", ")}` : ""}`;
  });
  return [head, "", ...lines].join("\n");
}

type PrefillRow = PrefillBenchJob["results"][number];

/** No usable rate: an error, or a zero rate with no explanation (old saved rows). */
function rowFailed(r: PrefillRow): boolean {
  return Boolean(r.error) || !(r.prefillTps > 0);
}

function rowPartial(r: PrefillRow): boolean {
  return !rowFailed(r) && r.samples != null && r.samplesRequested != null && r.samples < r.samplesRequested;
}

function prefillTitle(r: PrefillRow): string | undefined {
  if (!r.method) return undefined;
  const how =
    r.method === "server"
      ? "server-reported prompt timing"
      : `tokens ÷ (TTFT − ${Math.round(r.overheadMs ?? 0)} ms overhead, capped at half the TTFT)`;
  const parts = [`Prefill: ${how}`, `median-rate sample of ${r.samples ?? 1}`];
  if (r.cachedTokens) parts.push(`${r.cachedTokens.toLocaleString()} cached tokens excluded`);
  if (r.lowConfidence) parts.push("overhead was over 30% of the TTFT");
  if (r.notice) parts.push(r.notice);
  return parts.join(" · ");
}

function ResultRow({ r, max }: { r: PrefillRow; max: number }) {
  const failed = rowFailed(r);
  const partial = rowPartial(r);
  const reason = r.error || "No prefill rate was measured";
  // A failed row has no bar at all (a 2% sliver reads as "very slow", not "failed").
  const pct = !failed && max > 0 ? Math.max(2, Math.round((r.prefillTps / max) * 100)) : 0;
  return (
    <article className={`bench-result-row${failed ? " is-failed" : ""}`} title={failed ? reason : prefillTitle(r)}>
      <div className="bench-result-row__load">
        <span className="bench-result-row__badge">{formatContextSize(r.targetTokens)}</span>
        <div className="bench-result-row__facts">
          <span>
            TTFT <strong>{r.ttftMs > 0 ? formatTtft(r.ttftMs) : "—"}</strong>
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
          {failed ? (
            <span className="bench-result-row__value">failed</span>
          ) : (
            <span className="bench-result-row__value bench-result-row__value--accent">
              {r.prefillTps.toFixed(1)}
              <span className="bench-result-row__unit">tok/s</span>
            </span>
          )}
        </div>
        <div className="bench-result-row__metric">
          <span className="bench-result-row__label">TTFT</span>
          <span className="bench-result-row__value">{r.ttftMs > 0 ? formatTtft(r.ttftMs) : "—"}</span>
        </div>
      </div>

      {failed ? (
        <p className="bench-result-row__note is-error" role="note">
          {reason}
        </p>
      ) : (
        <>
          {(partial || r.lowConfidence) && (
            <p className="bench-result-row__note" role="note">
              {partial ? (r.notice ?? `${r.samples}/${r.samplesRequested} samples`) : null}
              {partial && r.lowConfidence ? " · " : null}
              {r.lowConfidence ? "Low confidence: request overhead was over 30% of the TTFT" : null}
            </p>
          )}
          <div className="bench-result-row__bar" aria-hidden>
            <i style={{ width: `${pct}%` }} />
          </div>
        </>
      )}
    </article>
  );
}

export function PrefillBenchDialog({
  open: openProp = true,
  onClose = () => {},
  variant = "modal",
  sparkId,
  llmPort,
  modelId,
  contextLength,
  remoteTarget = null,
  shareImage = false,
  sparkName = null,
  engine = null,
  posture = null,
  onSwitchBench,
}: PrefillBenchDialogProps) {
  const isPage = variant === "page";
  const open = isPage || openProp;
  const [history, setHistory] = useState<PrefillBenchJob[]>([]);
  const [selected, setSelected] = useState<number[]>(() => defaultSelected(contextLength));
  const [customDraft, setCustomDraft] = useState("");
  const [job, setJob] = useState<PrefillBenchJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [loadingLast, setLoadingLast] = useState(false);
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
  // A saved run belongs to the model it ran against, which may not be the one loaded now (or any).
  const resultModelId = job?.config?.modelId || modelId;
  const { mounted, visible } = useModalPresence(open);

  useEscape(onClose, open && !starting && !isPage);
  useBodyScrollLock(mounted && !isPage);

  const refreshHistory = useCallback(() => {
    void listPrefillBench(sparkId, benchPort)
      .then((data) => setHistory(data.history ?? []))
      .catch(() => {
        /* history is optional */
      });
  }, [sparkId, benchPort]);

  const startPolling = useCallback(
    (benchId: string) => {
      stopPoll();
      pollRef.current = setInterval(() => {
        void getPrefillBench(sparkId, benchId)
          .then((j) => {
            setJob(j);
            setError(null);
            if (j.status !== "running") {
              stopPoll();
              refreshHistory();
            }
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
    [sparkId, benchPort, stopPoll, refreshHistory]
  );

  useEffect(() => {
    if (!open) {
      stopPoll();
      setCustomDraft("");
      return;
    }
    let cancelled = false;
    setLoadingLast(true);
    setError(null);
    void listPrefillBench(sparkId, benchPort)
      .then((data) => {
        if (cancelled) return;
        setHistory(data.history ?? []);
        if (data.active) {
          setJob(data.active);
          if (Array.isArray(data.active.config?.contextSizes)) {
            setSelected(
              data.active.config.contextSizes.filter(
                (n) => prefillFitsContext(n, contextLength)
              )
            );
          }
          if (data.active.status === "running") startPolling(data.active.benchId);
        } else if (data.last) {
          setJob(data.last);
          if (Array.isArray(data.last.config?.contextSizes)) {
            const next = data.last.config.contextSizes.filter(
              (n) => prefillFitsContext(n, contextLength)
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

  const sizeFits = (n: number) => prefillFitsContext(n, contextLength);

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

  const addCustomSize = () => {
    if (isRunning || starting) return;
    const n = parseContextSize(customDraft);
    if (n == null) {
      setError(
        `Custom size must be an integer between ${PREFILL_MIN_CONTEXT_SIZE.toLocaleString()} and ${PREFILL_MAX_CONTEXT_SIZE.toLocaleString()} tokens`
      );
      return;
    }
    if (!sizeFits(n)) {
      setError(
        `Custom size plus template and reply does not fit the model context (${contextLength?.toLocaleString()} tokens)`
      );
      return;
    }
    setError(null);
    setSelected((prev) => (prev.includes(n) ? prev : [...prev, n].sort((a, b) => a - b)));
    setCustomDraft("");
  };

  const customSizes = selected.filter((n) => !PREFILL_CONTEXT_SIZES.includes(n));

  const startLockRef = useRef(false);

  // Page only: a run started from the Spark page's dialog (or another tab) shows up here too.
  useEffect(() => {
    if (!isPage) return;
    const t = setInterval(() => {
      if (pollRef.current != null || startLockRef.current) return;
      void listPrefillBench(sparkId, benchPort)
        .then((data) => {
          setHistory(data.history ?? []);
          if (data.active?.status === "running" && pollRef.current == null && !startLockRef.current) {
            setJob(data.active);
            startPolling(data.active.benchId);
          }
        })
        .catch(() => {
          /* next tick */
        });
    }, 5000);
    return () => clearInterval(t);
  }, [isPage, sparkId, benchPort, startPolling]);

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
      if (isPage) refreshHistory();
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

  const handleClear = async () => {
    if (!job || job.status === "running") return;
    setError(null);
    try {
      await clearPrefillBenchHistory(sparkId, benchPort);
      stopPoll();
      setJob(null);
      setHistory([]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleView = (id: string) => {
    const found = history.find((h) => h.benchId === id);
    if (!found || isRunning) return;
    stopPoll();
    setError(null);
    setJob(found);
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

  const maxPrefill = job ? Math.max(0, ...job.results.map((r) => r.prefillTps)) : 0;
  const showConfig = (isPage || !job || job.status === "running") && !loadingLast;
  const showResults = job && job.status !== "running";
  const ctxHint =
    contextLength != null && contextLength > 0
      ? `Model context ${formatContextSize(contextLength)} — larger sizes are disabled.`
      : "Unique-prefix prompts; TTFT is time to first token. 128k–300k can take tens of minutes.";

  const configNode = (
    <>
          {showConfig && (
            <section className="bench-sheet__section">
              <div className="bench-field">
                <div className="bench-field__head">
                  <h3 className="bench-sheet__section-title">Context size</h3>
                  <p className="bench-sheet__hint">{ctxHint} Type a custom token count to add it.</p>
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
                        aria-pressed={on}
                        title={
                          fits
                            ? `${n.toLocaleString()} tokens`
                            : `Does not fit the model context (${contextLength?.toLocaleString()} tokens) once the template and reply are added`
                        }
                        onClick={() => toggleSize(n)}
                        className={`bench-conc-btn${on ? " is-on" : ""}`}
                      >
                        {formatContextSize(n)}
                      </button>
                    );
                  })}
                  {customSizes.map((n) => (
                    <button
                      key={n}
                      type="button"
                      disabled={isRunning || starting}
                      aria-pressed
                      title={`${n.toLocaleString()} tokens — click to remove`}
                      onClick={() => toggleSize(n)}
                      className="bench-conc-btn is-on"
                    >
                      {formatContextSize(n)}
                    </button>
                  ))}
                </div>
                <div className="bench-custom-size">
                  <label htmlFor="prefill-custom-size" className="sr-only">
                    Custom context size in tokens
                  </label>
                  <input
                    id="prefill-custom-size"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    disabled={isRunning || starting}
                    value={customDraft}
                    placeholder="Custom"
                    aria-label="Custom context size in tokens"
                    onChange={(e) => {
                      const raw = e.target.value;
                      if (raw === "" || /^\d+$/.test(raw)) setCustomDraft(raw);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addCustomSize();
                      }
                    }}
                    className="bench-input"
                    size={8}
                  />
                  <button
                    type="button"
                    className="bench-btn bench-btn--ghost"
                    disabled={isRunning || starting || customDraft.trim() === ""}
                    onClick={addCustomSize}
                  >
                    Add
                  </button>
                </div>
              </div>
            </section>
          )}

    </>
  );
  const progressNode = (
    <>
          {job && job.status === "running" && (
            <section className="bench-sheet__section">
              <div className="bench-progress">
                <div className="bench-progress__row">
                  <span className="bench-progress__status" role="status" aria-live="polite">
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
                <div
                  className="bench-progress__track"
                  role="progressbar"
                  aria-label="Prefill benchmark progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.min(100, progressPct)}
                  aria-valuetext={`${job.progress.completedLevels} of ${job.progress.totalLevels} sizes`}
                >
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
                    <ResultRow key={r.targetTokens} r={r} max={maxPrefill} />
                  ))}
                </div>
              )}
            </section>
          )}

    </>
  );
  const resultsNode = (
    <>
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
                    <ResultRow key={r.targetTokens} r={r} max={maxPrefill} />
                  ))}
                </div>
              )}

              {job.results.length > 0 && (
                <p className="bench-legend">
                  <strong>Prefill</strong> — the server&apos;s own prompt-processing timing when it
                  reports one, otherwise tokens computed ÷ (TTFT − calibrated request overhead),
                  with prefix-cache hits excluded and the correction capped at half the TTFT.{" "}
                  <strong>TTFT</strong> — request start to first streamed token. Tokens, TTFT and
                  tok/s are from the median-rate sample of each size. Each size uses a unique
                  prefix so prefix-cache does not inflate later sizes.{" "}
                  <strong>Low confidence</strong> — the overhead was over 30% of the TTFT, so the
                  rate leans on the calibration; <strong>n/m samples</strong> — some repeats failed.
                </p>
              )}
            </section>
          )}
    </>
  );

  const copyButton =
    job && job.results.length > 0 ? (
      <BenchCopyButton
        text={buildShareText(job, resultModelId)}
        buildCard={() =>
          buildPrefillShareCard(job, {
            llmPort: benchPort,
            modelId: resultModelId,
            sparkName,
            engine,
            posture,
            remoteHost: remoteTarget?.host ?? null,
          })
        }
        kind="prefill"
        shareImage={shareImage}
        onError={setError}
      />
    ) : null;

  if (isPage) {
    return (
      <PageLayout
        config={
          <>
            {loadingLast && !job && <p className="bench-sheet__hint">Loading last results…</p>}
            {configNode}
          </>
        }
        runBar={
          isRunning ? (
            <button type="button" className="btn" onClick={() => void handleCancel()}>
              Cancel run
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void handleStart()}
              disabled={starting || selected.filter(sizeFits).length === 0}
            >
              {starting ? "Starting…" : "Run benchmark"}
            </button>
          )
        }
      >
        {error && <p className="bench-sheet__error">{error}</p>}
        {isRunning && <PageCard title="Progress">{progressNode}</PageCard>}
        {showResults && (
          <PageCard
            title="Results"
            tools={
              <>
                {copyButton}
                {job.results.length > 0 && (
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={() => void handleClear()}
                    title="Clear saved results for this port"
                  >
                    Clear history
                  </button>
                )}
              </>
            }
          >
            {resultsNode}
          </PageCard>
        )}
        {!job && !loadingLast && (
          <PageEmpty title="No runs yet">
            Choose the context sizes to test, then run. Each size sends a unique prompt and reports prefill tok/s and
            time to first token.
          </PageEmpty>
        )}
        {history.length > 0 && (
          <PageCard title={`History · ${history.length}`}>
            <HistoryTable
              rows={history.map(prefillHistoryRow)}
              activeId={job?.benchId ?? null}
              labelHeader="Context sizes"
              onView={handleView}
              busy={isRunning || starting}
            />
          </PageCard>
        )}
      </PageLayout>
    );
  }

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
              {resultModelId ? ` · ${resultModelId}` : ""}
            </p>
          </div>
          <BenchSwitcher active="prefill" onSwitch={onSwitchBench} disabled={isRunning || starting} />
          <button
            type="button"
            className="bench-sheet__close"
            onClick={onClose}
            aria-label="Close"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="bench-sheet__body">
          {loadingLast && !job && (
            <p className="bench-sheet__hint">Loading last results…</p>
          )}

          {configNode}

          {error && <p className="bench-sheet__error">{error}</p>}

          {progressNode}

          {resultsNode}
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
                <BenchCopyButton
                  text={buildShareText(job, resultModelId)}
                  buildCard={() =>
                    buildPrefillShareCard(job, {
                      llmPort: benchPort,
                      modelId: resultModelId,
                      sparkName,
                      engine,
                      posture,
                      remoteHost: remoteTarget?.host ?? null,
                    })
                  }
                  kind="prefill"
                  shareImage={shareImage}
                  onError={setError}
                />
              )}
              <button type="button" className="bench-btn bench-btn--ghost" onClick={onClose}>
                Done
              </button>
              <button type="button" className="bench-btn bench-btn--primary" onClick={handleNewRun}>
                Run again
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
