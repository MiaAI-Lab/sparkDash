import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "../../styles/dialogs.css";
import {
  cancelQualityBench,
  clearQualityBenchHistory,
  getQualityBench,
  listQualityBench,
  startQualityBench,
} from "../../api/client";
import type {
  LlmBenchTarget,
  QualityBenchJob,
  QualityCategory,
  QualityCategorySummary,
} from "../../api/types";
import { useModalPresence } from "../../hooks/useModalPresence";
import { BenchCopyButton } from "./BenchCopyButton";
import { BenchSwitcher, type BenchKind } from "./BenchSwitcher";
import { buildQualityShareCard } from "./benchShareCard";
import { deltaPts, disagreements, formatDelta, overallVerdict } from "./qualityCompare";
import { CheckIcon, XIcon } from "../ui/icons";
import { Ring } from "../ui/Ring";
import {
  QUALITY_CATEGORIES,
  QUALITY_CATEGORY_LABELS,
  QUALITY_DEFAULT_CATEGORIES,
  QUALITY_DEFAULT_CONCURRENCY,
  QUALITY_DEFAULT_LONG_ITEMS,
  QUALITY_DEFAULT_LONG_SIZES,
  QUALITY_LABEL_MAX,
  QUALITY_LONG_SIZES,
  QUALITY_MAX_CONCURRENCY,
  QUALITY_MAX_LONG_ITEMS,
  compareQualityRuns,
  type QualityCompareRow,
} from "../../shared/qualityBench.js";
import { QUALITY_CATEGORY_INFO } from "./qualityCategoryInfo";
import { HistoryTable, PageCard, PageEmpty, PageLayout } from "../bench/sparkdash/pageParts";
import { qualityHistoryRow } from "../bench/sparkdash/historyRows";
import { formatContextSize } from "../../shared/prefillBench.js";
import { formatLlmBaseUrl } from "../../shared/llmTarget.js";

interface QualityBenchDialogProps {
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
  /** Unit display name for the share-card header. */
  sparkName?: string | null;
  /** Probe backend id for the share card's engine chip. */
  engine?: string | null;
  /** Probe exposure/auth posture for the share-card chip. */
  posture?: { label: string; level: "ok" | "warn" | "danger" } | null;
  /** Switch to another benchmark dialog (Decode / Prefill / Quality). Switcher hidden when omitted. */
  onSwitchBench?: (kind: BenchKind) => void;
}

const CATEGORY_HINTS: Record<QualityCategory, string> = {
  qa: "Short factual and arithmetic questions: multiplication, strings, dates, LCM.",
  reason: "Multi-step word problems with a two-part answer.",
  arith: "Ten-step arithmetic chains.",
  track: "Token-transfer stories, 25 events each.",
  gsm8k: "Grade-school maths from the public GSM8K test set (fixed sample).",
  mmlu: "Multiple choice from the public MMLU test set, 5 per subject across 57 subjects.",
  follow: "Prompts with verifiable formatting rules, checked by code, not a judge.",
  long: "Needle recall: 16 codes, 4 corrected late in the text. Sequential.",
};

/** Fixed item counts; long recall depends on the chosen sizes. */
const CATEGORY_ITEMS: Record<Exclude<QualityCategory, "long">, number> = { qa: 150, reason: 40, arith: 40, track: 40, gsm8k: 200, mmlu: 285, follow: 40 };
/** Categories that run with thinking on (slow, many tokens). */
const THINKING_CATEGORIES: readonly QualityCategory[] = ["reason", "arith", "track", "gsm8k"];

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
  if (m < 60) return `${m}m ${Math.round(s - m * 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function statusLabel(status: QualityBenchJob["status"]): string {
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

function pct(v: number | null | undefined): string {
  return v == null ? "—" : `${v.toFixed(1)}%`;
}

function formatP(p: number): string {
  if (p >= 0.995) return "1.00";
  if (p < 0.001) return "<0.001";
  return p.toFixed(3);
}

function runLabel(job: QualityBenchJob): string {
  const when = new Date(job.startedAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = [when];
  if (job.config.label) parts.push(job.config.label);
  parts.push(job.config.modelId || "unknown model");
  parts.push(pct(job.results?.overallPct));
  return parts.join(" · ");
}

function categoryNotes(cat: QualityCategory, s: QualityCategorySummary): string {
  const notes: string[] = [];
  if (cat === "long" && s.keysTotal != null) {
    notes.push(`keys ${s.keysFound ?? 0}/${s.keysTotal}`);
    notes.push(`${s.stale ?? 0} stale`);
  }
  if (cat === "reason" || cat === "arith" || cat === "track" || cat === "gsm8k") {
    notes.push(`mean ${s.meanCompletionTokens.toLocaleString()} tok`);
    notes.push(`${s.hitMaxTokens} hit max_tokens`);
  }
  if (s.errors > 0) notes.push(`${s.errors} request error${s.errors === 1 ? "" : "s"}`);
  return notes.join(" · ");
}

function verdictLine(r: QualityCompareRow): string {
  if (r.onlyA + r.onlyB === 0) return "no discordant items";
  if (r.withinNoise) return "difference within noise";
  return `significant (p ${formatP(r.p)})`;
}

function buildShareText(
  job: QualityBenchJob,
  compareJob: QualityBenchJob | null,
  compareRows: QualityCompareRow[]
): string {
  const lines: string[] = [];
  const model = job.config.modelId || "unknown model";
  lines.push(`${model}${job.config.label ? ` [${job.config.label}]` : ""} | quality bench`);
  lines.push(`Overall ${pct(job.results.overallPct)} (mean of category %)`);
  lines.push("");
  for (const cat of QUALITY_CATEGORIES) {
    const s = job.results.categories?.[cat];
    if (!s) continue;
    const notes = categoryNotes(cat, s);
    lines.push(
      `${QUALITY_CATEGORY_LABELS[cat].padEnd(20)} ${`${s.passed}/${s.total}`.padStart(7)}  ${pct(s.pct).padStart(6)}${notes ? `  · ${notes}` : ""}`
    );
  }
  if (job.results.skippedLongSizes?.length) {
    lines.push(`Long sizes skipped (above context): ${job.results.skippedLongSizes.map(formatContextSize).join(", ")}`);
  }
  if (compareJob && compareRows.length) {
    lines.push("");
    lines.push(`Compared with: ${runLabel(compareJob)}`);
    for (const r of compareRows) {
      lines.push(
        `${QUALITY_CATEGORY_LABELS[r.category].padEnd(20)} ${pct(r.pctA).padStart(6)} vs ${pct(r.pctB).padStart(6)}  identical ${r.identical}/${r.paired}  only-this ${r.onlyA}  only-other ${r.onlyB}  p=${formatP(r.p)}  ${verdictLine(r)}`
      );
    }
  }
  lines.push("");
  lines.push(
    `temp 0 · seed fixed · suite v${job.config.suiteVersion} · ${job.status} in ${formatDuration(job.durationMs)}`
  );
  return lines.join("\n");
}

function CategoryTable({ job }: { job: QualityBenchJob }) {
  const rows = QUALITY_CATEGORIES.filter((c) => job.results.categories?.[c]);
  if (!rows.length) return null;
  return (
    <div className="bench-results">
      <table className="q-cat-table">
        <thead>
          <tr>
            <th>Category</th>
            <th className="is-num">Score</th>
            <th className="is-num">%</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((cat) => {
            const s = job.results.categories[cat] as QualityCategorySummary;
            return (
              <tr key={cat}>
                <td className="q-cat-table__name">{QUALITY_CATEGORY_LABELS[cat]}</td>
                <td className="is-num">
                  {s.passed}/{s.total}
                </td>
                <td className="is-num is-strong">{pct(s.pct)}</td>
                <td className="q-cat-table__note">{categoryNotes(cat, s)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Colour band for a percentage score. */
function qTier(p: number | null | undefined): "good" | "ok" | "low" | "none" {
  if (p == null || !Number.isFinite(p)) return "none";
  return p >= 90 ? "good" : p >= 70 ? "ok" : "low";
}
const TIER_COLOR = { good: "var(--color-success)", ok: "var(--color-accent)", low: "var(--color-danger)", none: "var(--color-muted)" } as const;

function shortRunName(job: QualityBenchJob, fallback: string): string {
  return job.config.label || new Date(job.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) || fallback;
}

function ScoreCard({
  job,
  compareJob,
  compareRows,
}: {
  job: QualityBenchJob;
  compareJob: QualityBenchJob | null;
  compareRows: QualityCompareRow[];
}) {
  const overall = job.results.overallPct;
  const delta = compareJob ? deltaPts(overall, compareJob.results?.overallPct) : null;
  const verdict = compareJob ? overallVerdict(compareRows) : null;
  return (
    <div className="q-side">
      <div className="q-score">
        <span className="eyebrow">{compareJob ? "Overall · this run" : "Overall"}</span>
        {compareJob ? (
          <div className="big-num">
            {overall == null ? "—" : overall.toFixed(1)}
            <small>%</small>
          </div>
        ) : (
          <Ring value={overall ?? 0} size={132} strokeWidth={11} labelSize={30} color={TIER_COLOR[qTier(overall)]} label={overall == null ? "—" : <>{overall.toFixed(1)}<span className="q-ring-pct">%</span></>} className="q-score__ring" />
        )}
        {delta != null && (
          <div className={`q-delta${delta > 0 ? " is-up" : delta < 0 ? " is-down" : ""}`}>
            {delta === 0 ? "Same score" : formatDelta(delta)} vs other run
          </div>
        )}
        {verdict && (
          <div className={`q-verdict q-verdict--${verdict.tone}`}>
            {verdict.tone === "same" || verdict.tone === "noise" ? (
              <CheckIcon className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <XIcon className="h-3.5 w-3.5 shrink-0" />
            )}
            <span>{verdict.text}</span>
          </div>
        )}
        {!compareJob && (
          <span className="q-score__hint">
            Mean of {Object.keys(job.results.categories ?? {}).length} category scores · {(job.results.items?.length ?? 0).toLocaleString()} items
          </span>
        )}
      </div>
      {compareJob && (
        <div className="q-runs">
          <div className="q-run q-run--a">
            <i aria-hidden />
            <span className="q-run__name">A · {shortRunName(job, "this run")}</span>
            <span className="q-run__val">{pct(job.results.overallPct)}</span>
          </div>
          <div className="q-run q-run--b">
            <i aria-hidden />
            <span className="q-run__name">B · {shortRunName(compareJob, "other run")}</span>
            <span className="q-run__val">{pct(compareJob.results?.overallPct)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function CategoryBars({
  job,
  compareJob,
  compareRows,
}: {
  job: QualityBenchJob;
  compareJob: QualityBenchJob | null;
  compareRows: QualityCompareRow[];
}) {
  const cats = QUALITY_CATEGORIES.filter((c) => job.results.categories?.[c]);
  if (!cats.length) return null;
  const rowByCat = new Map(compareRows.map((r) => [r.category, r]));
  return (
    <div className="q-main">
      <div className="q-main__head">
        <h3 className="bench-sheet__section-title">Score by category</h3>
        {compareJob && (
          <div className="legend">
            <span className="q-leg-a">Run A</span>
            <span className="q-leg-b">Run B</span>
          </div>
        )}
      </div>
      <div className="q-cats">
        {cats.map((cat) => {
          const s = job.results.categories[cat] as QualityCategorySummary;
          const cmp = rowByCat.get(cat);
          const other = compareJob?.results?.categories?.[cat];
          const delta = cmp ? deltaPts(cmp.pctA, cmp.pctB) : null;
          const notes = categoryNotes(cat, s);
          return (
            <div key={cat} className="q-cat">
              <div className="q-cat__name">
                {QUALITY_CATEGORY_LABELS[cat]}
                <small>
                  {s.passed}/{s.total} items
                </small>
              </div>
              <div className="q-cat__pair">
                <div className={`q-bar q-bar--a${compareJob ? "" : ` is-${qTier(s.pct)}`}`}>
                  <i style={{ width: `${Math.max(0, Math.min(100, s.pct ?? 0))}%` }} />
                </div>
                {compareJob && (
                  <div className="q-bar q-bar--b">
                    <i style={{ width: `${Math.max(0, Math.min(100, other?.pct ?? 0))}%` }} />
                  </div>
                )}
              </div>
              <div className="q-cat__val">
                <span className="q-cat__pct">{pct(s.pct)}</span>
                {cmp && (
                  <span className={delta != null && delta > 0 ? "is-up" : delta != null && delta < 0 ? "is-down" : ""}>
                    {pct(cmp.pctB)}
                    {delta != null ? ` · ${formatDelta(delta)}` : ""}
                  </span>
                )}
              </div>
              {(cmp || notes) && (
                <div className="q-cat__note">
                  {cmp
                    ? `same reply ${cmp.identical}/${cmp.paired} · only this ${cmp.onlyA} · only other ${cmp.onlyB} · p ${formatP(cmp.p)} · ${verdictLine(cmp)}`
                    : notes}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DisagreementTable({ job, compareJob }: { job: QualityBenchJob; compareJob: QualityBenchJob }) {
  const rows = useMemo(() => disagreements(job, compareJob), [job, compareJob]);
  const paired = useMemo(() => {
    const ids = new Set((compareJob.results?.items ?? []).map((it) => it.id));
    return (job.results?.items ?? []).filter((it) => ids.has(it.id)).length;
  }, [job, compareJob]);
  const onlyA = rows.filter((r) => r.okA).length;
  const onlyB = rows.length - onlyA;
  return (
    <div className="q-disagree">
      <div className="q-main__head">
        <h3 className="bench-sheet__section-title">
          Items where the runs disagree{" "}
          <span className="q-muted">
            · {rows.length} of {paired}
          </span>
        </h3>
        <span className="tag">
          A only {onlyA} · B only {onlyB}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="bench-sheet__hint">Both runs passed and failed the same items.</p>
      ) : (
        <div className="q-table-wrap">
          <table className="q-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Category</th>
                <th>Run A</th>
                <th>Run B</th>
                <th>Run A detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.id}</td>
                  <td>{QUALITY_CATEGORY_LABELS[r.category]}</td>
                  <td className={r.okA ? "is-ok" : "is-no"}>{r.okA ? "✓ pass" : "✕ fail"}</td>
                  <td className={r.okB ? "is-ok" : "is-no"}>{r.okB ? "✓ pass" : "✕ fail"}</td>
                  <td className="q-table__note">{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ItemTable({ job }: { job: QualityBenchJob }) {
  const [filter, setFilter] = useState<QualityCategory | "all" | "failed">("all");
  const items = job.results.items ?? [];
  const shown = items.filter((it) =>
    filter === "all" ? true : filter === "failed" ? !it.ok : it.category === filter
  );
  const cats = QUALITY_CATEGORIES.filter((c) => items.some((it) => it.category === c));
  return (
    <details className="rounded border border-border">
      <summary className="cursor-pointer select-none px-2 py-1.5 text-xs text-muted hover:text-text">
        Per-item results ({items.length})
      </summary>
      <div className="space-y-2 border-t border-border p-2">
        <div className="flex flex-wrap gap-1">
          {(["all", "failed", ...cats] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                filter === f
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border text-muted hover:text-text"
              }`}
            >
              {f === "all" || f === "failed" ? f : QUALITY_CATEGORY_LABELS[f]}
            </button>
          ))}
        </div>
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-muted">
                <th className="py-1 pr-2 font-medium">Id</th>
                <th className="py-1 pr-2 font-medium">Ok</th>
                <th className="py-1 font-medium">Reply</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((it) => (
                <tr key={it.id} className="border-t border-border align-top">
                  <td className="whitespace-nowrap py-1 pr-2 font-tabular text-muted">{it.id}</td>
                  <td className={`py-1 pr-2 font-semibold ${it.ok ? "text-success" : "text-danger"}`}>
                    {it.ok ? "✓" : "✗"}
                  </td>
                  <td className="py-1 break-words text-text [overflow-wrap:anywhere]">
                    {it.error ? <span className="text-danger">{it.error}</span> : it.excerpt}
                    {(it.detail || it.finishReason === "length") && (
                      <span className="block text-[10px] text-muted">
                        {[it.detail, it.finishReason === "length" ? "hit max_tokens" : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}

export function QualityBenchDialog({
  open: openProp = true,
  onClose = () => {},
  variant = "modal",
  sparkId,
  llmPort,
  modelId,
  contextLength,
  remoteTarget = null,
  sparkName = null,
  engine = null,
  posture = null,
  onSwitchBench,
}: QualityBenchDialogProps) {
  const isPage = variant === "page";
  const open = isPage || openProp;
  const [categories, setCategories] = useState<QualityCategory[]>([...QUALITY_DEFAULT_CATEGORIES]);
  const [longSizes, setLongSizes] = useState<number[]>([...QUALITY_DEFAULT_LONG_SIZES]);
  const [longItems, setLongItems] = useState(String(QUALITY_DEFAULT_LONG_ITEMS));
  const [concurrency, setConcurrency] = useState(String(QUALITY_DEFAULT_CONCURRENCY));
  const [label, setLabel] = useState("");
  const [job, setJob] = useState<QualityBenchJob | null>(null);
  const [history, setHistory] = useState<QualityBenchJob[]>([]);
  const [compareId, setCompareId] = useState("");
  const [compareJob, setCompareJob] = useState<QualityBenchJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which category's "How it works" panel is open.
  const [infoFor, setInfoFor] = useState<QualityCategory | null>(null);
  const [starting, setStarting] = useState(false);
  const [loadingLast, setLoadingLast] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const benchPort = remoteTarget?.port ?? llmPort;

  const stopPoll = useCallback(() => {
    if (pollRef.current != null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const isRunning = job?.status === "running";
  const { mounted, visible } = useModalPresence(open);

  useEscape(onClose, open && !starting && !isPage);
  useBodyScrollLock(mounted && !isPage);

  const refreshHistory = useCallback(() => {
    void listQualityBench(sparkId, benchPort)
      .then((data) => setHistory(data.history ?? []))
      .catch(() => {
        /* history is optional */
      });
  }, [sparkId, benchPort]);

  const startPolling = useCallback(
    (benchId: string) => {
      stopPoll();
      pollRef.current = setInterval(() => {
        void getQualityBench(sparkId, benchId)
          .then((j) => {
            setJob(j);
            setError(null);
            if (j.status !== "running") {
              stopPoll();
              refreshHistory();
            }
          })
          .catch((err: Error) => {
            void listQualityBench(sparkId, benchPort)
              .then((data) => {
                setHistory(data.history ?? []);
                if (data.active) {
                  setJob(data.active);
                  setError(null);
                  if (data.active.benchId !== benchId) startPolling(data.active.benchId);
                  else if (data.active.status !== "running") stopPoll();
                  return;
                }
                if (data.last?.benchId === benchId) {
                  setJob(data.last);
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
                setError(err.message);
                stopPoll();
              });
          });
      }, 1000);
    },
    [sparkId, benchPort, stopPoll, refreshHistory]
  );

  useEffect(() => {
    if (!open) {
      stopPoll();
      return;
    }
    let cancelled = false;
    setLoadingLast(true);
    setError(null);
    void listQualityBench(sparkId, benchPort)
      .then((data) => {
        if (cancelled) return;
        setHistory(data.history ?? []);
        const current = data.active || data.last;
        if (current) {
          setJob(current);
          const c = current.config;
          if (Array.isArray(c?.categories) && c.categories.length) {
            // A saved run may list a category that no longer exists (e.g. the removed Code one).
            const known = c.categories.filter((x) => (QUALITY_CATEGORIES as readonly string[]).includes(x));
            if (known.length) setCategories(known);
          }
          if (Array.isArray(c?.longSizes) && c.longSizes.length) setLongSizes(c.longSizes);
          if (c?.longItems) setLongItems(String(c.longItems));
          if (c?.concurrency) setConcurrency(String(c.concurrency));
          setLabel(c?.label ?? "");
          if (current.status === "running") startPolling(current.benchId);
        } else {
          setJob(null);
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
  }, [open, sparkId, benchPort, startPolling, stopPoll]);

  useEffect(() => () => stopPoll(), [stopPoll]);
  // Load the full run picked in "compare with".
  useEffect(() => {
    if (!compareId) {
      setCompareJob(null);
      return;
    }
    let cancelled = false;
    void getQualityBench(sparkId, compareId)
      .then((j) => {
        if (!cancelled) setCompareJob(j);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [sparkId, compareId]);

  const compareRows = useMemo(
    () => (job && compareJob ? compareQualityRuns(job, compareJob) : []),
    [job, compareJob]
  );

  const sizeFits = (n: number) => contextLength == null || contextLength <= 0 || n + 512 <= contextLength;
  const toggleCategory = (c: QualityCategory) => {
    if (isRunning || starting) return;
    setCategories((prev) => {
      if (prev.includes(c)) return prev.length === 1 ? prev : prev.filter((x) => x !== c);
      return QUALITY_CATEGORIES.filter((x) => x === c || prev.includes(x));
    });
  };
  const toggleSize = (n: number) => {
    if (isRunning || starting || !sizeFits(n)) return;
    setLongSizes((prev) => {
      if (prev.includes(n)) return prev.length === 1 ? prev : prev.filter((x) => x !== n);
      return [...prev, n].sort((a, b) => a - b);
    });
  };

  const startLockRef = useRef(false);

  // Page only: a run started from the Spark page's dialog (or another tab) shows up here too.
  useEffect(() => {
    if (!isPage) return;
    const t = setInterval(() => {
      if (pollRef.current != null || startLockRef.current || document.hidden) return;
      void listQualityBench(sparkId, benchPort)
        .then((data) => {
          setHistory(data.history ?? []);
          if (data.active?.status === "running" && pollRef.current == null && !startLockRef.current) {
            setJob(data.active);
            setCompareId("");
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
    const sizes = longSizes.filter(sizeFits);
    if (categories.includes("long") && sizes.length === 0) {
      setError("Select at least one long-context size that fits this model");
      return;
    }
    const conc = Math.min(QUALITY_MAX_CONCURRENCY, Math.max(1, parseInt(concurrency, 10) || 1));
    const items = Math.min(QUALITY_MAX_LONG_ITEMS, Math.max(1, parseInt(longItems, 10) || 1));
    startLockRef.current = true;
    setStarting(true);
    setError(null);
    setJob(null);
    setCompareId("");
    try {
      const started = await startQualityBench(sparkId, {
        port: benchPort,
        categories,
        longSizes: sizes,
        longItems: items,
        concurrency: conc,
        label: label.trim(),
        modelId: modelId || undefined,
        ...(remoteTarget ? { host: remoteTarget.host, tls: remoteTarget.tls } : {}),
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
      const j = await cancelQualityBench(sparkId, job.benchId);
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
    setCompareId("");
  };

  const handleClear = async () => {
    if (!job || job.status === "running") return;
    setError(null);
    try {
      await clearQualityBenchHistory(sparkId, benchPort);
      stopPoll();
      setJob(null);
      setHistory([]);
      setCompareId("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // History rows are summaries; fetch the full run (per-item rows) before showing it.
  const handleView = (id: string) => {
    if (isRunning) return;
    setError(null);
    void getQualityBench(sparkId, id)
      .then((j) => {
        stopPoll();
        setJob(j);
        setCompareId("");
      })
      .catch((err: Error) => setError(err.message));
  };

  if (!mounted) return null;

  const progressPct =
    job && job.progress.total > 0 ? Math.round((job.progress.done / job.progress.total) * 100) : 0;
  const showConfig = (isPage || !job) && !loadingLast;
  const showResults = job && job.status !== "running";
  const compareChoices = history.filter((h) => h.benchId !== job?.benchId);
  const hasItems = (job?.results?.items?.length ?? 0) > 0;

  const runControl = isRunning ? (
    <button type="button" className="btn" onClick={() => void handleCancel()}>
      Cancel run
    </button>
  ) : (
    <button type="button" className="btn btn--primary" onClick={() => void handleStart()} disabled={starting || categories.length === 0}>
      {starting ? "Starting…" : "Run quality bench"}
    </button>
  );

  const configNode = (
    <>
          {showConfig && (
            <section className="bench-sheet__section">
              <div className="bench-field">
                <div className="bench-field__head">
                  <div className="qsel-head">
                    <h3 className="bench-sheet__section-title">Categories</h3>
                    <div className="qsel-bulk" role="group" aria-label="Select categories">
                      <button
                        type="button"
                        className="qsel-bulk__btn"
                        disabled={starting || isRunning}
                        onClick={() => setCategories([...QUALITY_DEFAULT_CATEGORIES])}
                      >
                        Defaults
                      </button>
                      <button
                        type="button"
                        className="qsel-bulk__btn"
                        disabled={starting || isRunning}
                        onClick={() => setCategories([...QUALITY_CATEGORIES])}
                      >
                        Select all
                      </button>
                    </div>
                  </div>
                  <p className="bench-sheet__hint">
                    Fixed, seeded suite at temperature 0 — the same items every run, so runs pair item by item.
                  </p>
                </div>
                <div className="qsel" role="group" aria-label="Categories">
                  {QUALITY_CATEGORIES.map((c) => {
                    const on = categories.includes(c);
                    const items = c === "long" ? longSizes.length * (Number(longItems) || 0) : CATEGORY_ITEMS[c];
                    const infoOpen = infoFor === c;
                    return (
                      <div key={c} className={`qsel-item${on ? " is-on" : ""}${infoOpen ? " is-info" : ""}`}>
                        <button
                          type="button"
                          aria-pressed={on}
                          disabled={starting || isRunning}
                          onClick={() => toggleCategory(c)}
                          className="qsel-card"
                        >
                          <span className="qsel-card__check" aria-hidden>
                            {on ? "✓" : ""}
                          </span>
                          <span className="qsel-card__body">
                            <span className="qsel-card__name">
                              {QUALITY_CATEGORY_LABELS[c]}
                              {!QUALITY_DEFAULT_CATEGORIES.includes(c) ? <em>optional</em> : null}
                            </span>
                            <span className="qsel-card__hint">{CATEGORY_HINTS[c]}</span>
                            <span className="qsel-card__meta">
                              {c === "long" ? `${Number(longItems) || 0} per size` : `${items} items`}
                              {THINKING_CATEGORIES.includes(c) ? <small>thinking on</small> : null}
                            </span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="qsel-card__more"
                          aria-expanded={infoOpen}
                          aria-controls="q-info-panel"
                          onClick={() => setInfoFor(infoOpen ? null : c)}
                        >
                          {infoOpen ? "Hide details" : "How it works"}
                        </button>
                      </div>
                    );
                  })}
                </div>
                {infoFor ? (
                  <div className="q-info" id="q-info-panel" role="region" aria-label={`How ${QUALITY_CATEGORY_LABELS[infoFor]} works`}>
                    <div className="q-info__head">
                      <b>{QUALITY_CATEGORY_LABELS[infoFor]}: how it works</b>
                      <button type="button" className="btn btn--sm btn--ghost" onClick={() => setInfoFor(null)}>
                        Close
                      </button>
                    </div>
                    <dl className="q-info__grid">
                      <div>
                        <dt>What it measures</dt>
                        <dd>{QUALITY_CATEGORY_INFO[infoFor].measures}</dd>
                      </div>
                      <div>
                        <dt>What it sends</dt>
                        <dd>{QUALITY_CATEGORY_INFO[infoFor].how}</dd>
                      </div>
                      <div>
                        <dt>How it is scored</dt>
                        <dd>{QUALITY_CATEGORY_INFO[infoFor].scoring}</dd>
                      </div>
                      <div>
                        <dt>Settings and cost</dt>
                        <dd>{QUALITY_CATEGORY_INFO[infoFor].settings}</dd>
                      </div>
                      <div className="q-info__wide">
                        <dt>Example (the shape of the real prompts)</dt>
                        <dd className="q-info__example">{QUALITY_CATEGORY_INFO[infoFor].example}</dd>
                      </div>
                    </dl>
                  </div>
                ) : null}
              </div>

              {categories.includes("long") && (
                <div className="bench-field">
                  <div className="bench-field__head">
                    <h3 className="bench-sheet__section-title">Long-context sizes</h3>
                    <p className="bench-sheet__hint">
                      {contextLength != null && contextLength > 0
                        ? `Model context ${formatContextSize(contextLength)} — larger sizes are disabled.`
                        : "Large sizes can take many minutes per item."}
                    </p>
                  </div>
                  <div className="bench-conc-grid" role="group" aria-label="Long-context sizes">
                    {QUALITY_LONG_SIZES.map((n: number) => (
                      <button
                        key={n}
                        type="button"
                        aria-pressed={longSizes.includes(n)}
                        disabled={starting || isRunning || !sizeFits(n)}
                        onClick={() => toggleSize(n)}
                        className={`bench-conc-btn${longSizes.includes(n) && sizeFits(n) ? " is-on" : ""}`}
                      >
                        {formatContextSize(n)}
                      </button>
                    ))}
                  </div>
                  <label className="flex items-center gap-2 text-xs text-muted">
                    Items per size
                    <input
                      type="number"
                      min={1}
                      max={QUALITY_MAX_LONG_ITEMS}
                      inputMode="numeric"
                      value={longItems}
                      disabled={starting || isRunning}
                      onChange={(e) => setLongItems(e.target.value)}
                      className="bench-input"
                    />
                  </label>
                </div>
              )}

              <div className="qrun">
                <div className="qrun__sum">
                  <b>{categories.length} selected</b>
                  <span>
                    about{" "}
                    {categories
                      .reduce((n, c) => n + (c === "long" ? longSizes.length * (Number(longItems) || 0) : (CATEGORY_ITEMS[c] ?? 0)), 0)
                      .toLocaleString()}{" "}
                    requests
                  </span>
                </div>
                <label className="qrun__field">
                  <span>Concurrency</span>
                  <input
                    type="number"
                    min={1}
                    max={QUALITY_MAX_CONCURRENCY}
                    inputMode="numeric"
                    value={concurrency}
                    disabled={starting || isRunning}
                    onChange={(e) => setConcurrency(e.target.value)}
                    className="bench-input"
                    title="How many questions are sent to the model at the same time"
                  />
                </label>
                <label className="qrun__field qrun__field--grow">
                  <span>Run label</span>
                  <input
                    type="text"
                    value={label}
                    maxLength={QUALITY_LABEL_MAX}
                    disabled={starting || isRunning}
                    placeholder="e.g. fp4 KV"
                    onChange={(e) => setLabel(e.target.value)}
                    className="bench-input bench-input--wide"
                  />
                </label>
                {isPage ? <div className="qrun__go">{runControl}</div> : null}
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
                  <span className="bench-progress__status">
                    Running
                    {job.progress.currentCategory
                      ? ` · ${QUALITY_CATEGORY_LABELS[job.progress.currentCategory]} ${job.progress.categoryDone}/${job.progress.categoryTotal}`
                      : ""}
                  </span>
                  <span className="bench-progress__meta">
                    {job.progress.done}/{job.progress.total || "…"} · {formatDuration(job.durationMs)}
                  </span>
                </div>
                <div className="bench-progress__track">
                  <div className="bench-progress__fill" style={{ width: `${Math.min(100, progressPct)}%` }} />
                </div>
                {job.progress.message ? <p className="bench-sheet__hint">{job.progress.message}</p> : null}
              </div>
              <CategoryTable job={job} />
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
                  {new Date(job.startedAt).toLocaleString()} · {formatDuration(job.durationMs)}
                </span>
              </div>

              {job.error && <p className="bench-sheet__error">{job.error}</p>}

              {hasItems && compareChoices.length > 0 && (
                <label className="q-pick">
                  <span>Compare with</span>
                  <select value={compareId} onChange={(e) => setCompareId(e.target.value)}>
                    <option value="">— pick a previous run —</option>
                    {compareChoices.map((h) => (
                      <option key={h.benchId} value={h.benchId}>
                        {runLabel(h)}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {(() => {
                const cmp = compareJob && compareJob.benchId === compareId ? compareJob : null;
                return (
                  <>
                    <div className="q-cmp">
                      <ScoreCard job={job} compareJob={cmp} compareRows={cmp ? compareRows : []} />
                      <CategoryBars job={job} compareJob={cmp} compareRows={cmp ? compareRows : []} />
                    </div>
                    {cmp && compareRows.length === 0 && (
                      <p className="bench-sheet__hint">No shared items between these runs.</p>
                    )}
                    {cmp && compareRows.length > 0 && <DisagreementTable job={job} compareJob={cmp} />}
                  </>
                );
              })()}

              {job.results.skippedLongSizes?.length > 0 && (
                <p className="bench-sheet__hint">
                  Skipped long sizes above the model context:{" "}
                  {job.results.skippedLongSizes.map(formatContextSize).join(", ")}
                </p>
              )}

              {hasItems && <ItemTable job={job} />}

              <p className="bench-legend">
                <strong>Score</strong> — items passed. <strong>p</strong> — exact McNemar test on items only one
                run got right; p ≥ 0.05 means the difference is within noise.
              </p>
            </section>
          )}
    </>
  );

  const copyButton =
    job && hasItems ? (
      <BenchCopyButton
        text={buildShareText(job, compareJob, compareRows)}
        buildCard={() =>
          buildQualityShareCard(job, compareJob && compareJob.benchId === compareId ? compareJob : null, {
            llmPort: benchPort,
            modelId: job.config.modelId || modelId,
            sparkName,
            engine,
            posture,
            remoteHost: remoteTarget?.host ?? null,
          })
        }
        kind="quality"
        shareImage
        onError={setError}
      />
    ) : null;

  if (isPage) {
    return (
      <PageLayout
        stacked
        config={
          <>
            {loadingLast && !job && <p className="bench-sheet__hint">Loading last results…</p>}
            {configNode}
          </>
        }
        runBar={null}
      >
        {error && <p className="bench-sheet__error">{error}</p>}
        {isRunning && <PageCard title="Progress">{progressNode}</PageCard>}
        {showResults && (
          <PageCard
            title="Results"
            tools={
              <>
                {copyButton}
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => void handleClear()}
                  title="Clear saved quality runs for this port"
                >
                  Clear history
                </button>
              </>
            }
          >
            {resultsNode}
          </PageCard>
        )}
        {!job && !loadingLast && (
          <PageEmpty title="No runs yet">
            Pick the categories to score, give the run a label (for example the quantisation or KV-cache format) and
            run. The suite is fixed and seeded, so any two runs can be compared item by item.
          </PageEmpty>
        )}
        {history.length > 0 && (
          <PageCard title={`History · ${history.length}`}>
            <HistoryTable
              rows={history.map(qualityHistoryRow)}
              activeId={job?.benchId ?? null}
              labelHeader="Label"
              onView={handleView}
              onCompare={showResults && hasItems ? setCompareId : undefined}
              compareId={compareId}
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

      <div className="bench-sheet" role="dialog" aria-modal="true" aria-labelledby="quality-bench-title">
        <header className="bench-sheet__header">
          <div className="bench-sheet__header-text">
            <h2 id="quality-bench-title" className="bench-sheet__title">
              Quality benchmark
            </h2>
            <p className="bench-sheet__subtitle">
              {remoteTarget ? formatLlmBaseUrl(remoteTarget) : `Port ${llmPort}`}
              {(job?.config.modelId || modelId) ? ` · ${job?.config.modelId || modelId}` : ""}
              {job?.config.label ? ` · ${job.config.label}` : ""}
            </p>
          </div>
          <BenchSwitcher active="quality" onSwitch={onSwitchBench} disabled={isRunning || starting} />
          <button type="button" className="bench-sheet__close" onClick={onClose} aria-label="Close">
            <XIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="bench-sheet__body">
          {loadingLast && !job && <p className="bench-sheet__hint">Loading last results…</p>}

          {configNode}

          {error && <p className="bench-sheet__error">{error}</p>}

          {progressNode}

          {resultsNode}
        </div>

        <footer className="bench-sheet__footer">
          {job?.status === "running" ? (
            <button type="button" className="bench-btn bench-btn--ghost" onClick={() => void handleCancel()}>
              Cancel
            </button>
          ) : job ? (
            <>
              <button
                type="button"
                className="bench-btn bench-btn--ghost"
                onClick={() => void handleClear()}
                title="Clear saved quality runs for this port"
              >
                Clear
              </button>
              {hasItems && (
                <BenchCopyButton
                  text={buildShareText(job, compareJob, compareRows)}
                  buildCard={() =>
                    buildQualityShareCard(job, compareJob && compareJob.benchId === compareId ? compareJob : null, {
                      llmPort: benchPort,
                      modelId: job.config.modelId || modelId,
                      sparkName,
                      engine,
                      posture,
                      remoteHost: remoteTarget?.host ?? null,
                    })
                  }
                  kind="quality"
                  shareImage
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
                disabled={starting || categories.length === 0}
              >
                {starting ? "Starting…" : "Run quality bench"}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
