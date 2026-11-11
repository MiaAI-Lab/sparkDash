import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import "../../styles/dialogs.css";
import {
  clearQualityReference,
  getQualityFidelityCompare,
  cancelQualityBench,
  pauseQualityBench,
  resumeQualityBench,
  clearQualityBenchHistory,
  deleteQualityBenchRun,
  getQualityBench,
  listQualityBench,
  listQualityBenchFleet,
  setQualityReference,
  startQualityBench,
} from "../../api/client";
import type {
  LlmBenchTarget,
  QualityBenchJob,
  QualityCategory,
  QualityCategorySummary,
  QualityFidelityCompare,
  QualityReference,
} from "../../api/types";
import { useModalPresence } from "../../hooks/useModalPresence";
import { BenchCopyButton } from "./BenchCopyButton";
import { BenchSwitcher, type BenchKind } from "./BenchSwitcher";
import { buildQualityShareCard } from "./benchShareCard";
import { useShareCardLabels } from "../bench/tooleval/shareCardLabels";
import {
  categoryVerdictLine,
  deltaPts,
  disagreements,
  formatCi,
  formatDelta,
  formatP,
  noiseBand,
  overallVerdict,
  sharedOverallDelta,
} from "./qualityCompare";
import { CheckIcon, XIcon } from "../ui/icons";
import { Ring } from "../ui/Ring";
import { qualityLongFitsContext } from "../../shared/contextFit.js";
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
  checkQualityComparable,
  compareQualityRuns,
  qualityRowUnscored,
  type QualityCompareRow,
} from "../../shared/qualityBench.js";
import {
  compareQualityOverall,
  engineRecordLine,
  overallBootstrapCi,
  qualityFamilyKey,
  qualityProfile,
  wilsonInterval,
} from "../../shared/qualityBench.js";
import { compareDivergence } from "../../shared/qualityDivergence.js";
import { plainVerdict, type AreaVerdict } from "./qualityVerdict";
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
  qa: "Short factual and arithmetic questions: multiplication, sorting, dates, LCM.",
  reason: "Multi-step word problems in five shapes, each with a two-number answer.",
  arith: "Ten- and twenty-step arithmetic chains, graded by every step's value.",
  track: "Token-transfer stories of 25 and 50 events, graded by every person's total.",
  gsm8k: "Grade-school maths from the GSM8K test set with the GSM8K-Platinum labels (188 items).",
  mmlupro: "MMLU-Pro: ten-option multiple choice that needs reasoning, 300 across 14 categories.",
  math500: "MATH-500: competition maths with LaTeX answers, 500 problems at five levels.",
  mmlu: "Plain MMLU, 5 per subject across 57 subjects: saturated; kept for older comparisons.",
  follow: "Prompts with verifiable formatting rules, checked by code, not a judge.",
  long: "Needle recall: 16 codes, 4 corrected late in the text, at three depths. Sequential.",
  tokenizer: "String reversal, letter counts and binary: decided by how the tokenizer splits text, not by reasoning.",
  fidelity: "Per-token log-probabilities on a fixed 34k-token corpus: NLL, perplexity, and against a reference run ΔNLL, top-1 agreement and tail loss. Engines with prompt logprobs only.",
  divergence: "120 stored replies (prose, code, maths, JSON, tool calls, ten languages, essays): loops, termination, structured output, and reply-by-reply differences against another run.",
};

/** Fixed item counts; long recall depends on the chosen sizes. */
const CATEGORY_ITEMS: Record<Exclude<QualityCategory, "long">, number> = { qa: 150, reason: 200, arith: 200, track: 200, gsm8k: 188, mmlupro: 300, math500: 500, mmlu: 285, follow: 40, tokenizer: 44, fidelity: 9, divergence: 120 };
/** Categories that run with thinking on (slow, many tokens). */
const THINKING_CATEGORIES: readonly QualityCategory[] = ["reason", "arith", "track", "gsm8k", "mmlupro", "math500"];

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
  if (Number.isInteger(job.config.port)) parts.push(`port ${job.config.port}`);
  parts.push(pct(job.results?.overallPct));
  return parts.join(" · ");
}

/** Wilson interval of a category score; computed here for runs saved before the server stored it. */
function categoryCi(s: QualityCategorySummary): [number, number] | null {
  return s.ci ?? wilsonInterval(s.passed, s.scored ?? s.total);
}

/** "default" | "full" | "custom": runs saved before profiles existed are classified by their categories. */
function jobProfile(job: QualityBenchJob): "default" | "full" | "fidelity" | "custom" {
  return job.config.profile ?? qualityProfile(job.config.categories);
}

/** The headline overall and its interval; null for a partial run (WP1). */
function overallOf(job: QualityBenchJob): { pct: number | null; ci: [number, number] | null } {
  if (jobProfile(job) === "custom") return { pct: null, ci: null };
  const pct = job.results.overallPct;
  if (pct == null) return { pct: null, ci: null };
  const ci = job.results.overallCi ?? (job.results.items?.length ? overallBootstrapCi(job.results.items) : null);
  return { pct, ci };
}

/** The verdict line of one category in a comparison, read against the run's noise floor. */
function verdictLine(r: QualityCompareRow, band: number | null = null): string {
  return categoryVerdictLine(r, band);
}

function categoryNotes(cat: QualityCategory, s: QualityCategorySummary): string {
  const notes: string[] = [];
  if (cat === "divergence") {
    const d = s.divergence;
    if (d) {
      notes.push(`terminated ${pct(d.terminatedPct)}`, `loops ${d.loops}`);
      if (d.jsonValidPct != null) notes.push(`JSON schema ${pct(d.jsonSchemaPct)}`);
      if (d.toolOkPct != null) notes.push(`tool calls ${pct(d.toolOkPct)}`);
      if (d.meanChars != null) notes.push(`mean ${d.meanChars.toLocaleString()} chars`);
    }
    if (s.errors > 0) notes.push(`${s.errors} request error${s.errors === 1 ? "" : "s"}`);
    return notes.join(" · ");
  }
  if (cat === "fidelity") {
    const f = s.fidelity;
    if (f?.nll != null) notes.push(`NLL ${f.nll.toFixed(4)} · ppl ${f.ppl?.toFixed(3)} · ${f.tokens.toLocaleString()} tokens · top-${f.k}`);
    if (s.errors > 0) notes.push(`${s.errors} request error${s.errors === 1 ? "" : "s"}`);
    return notes.join(" · ");
  }
  if (cat === "long" && s.keysTotal != null) {
    notes.push(`keys ${s.keysFound ?? 0}/${s.keysTotal}${s.keysCi ? ` (${formatCi(s.keysCi)})` : ""}`);
    notes.push(`${s.stale ?? 0} stale`);
  } else if (s.gradeTotal != null && s.gradeTotal > 0) {
    // Suite v2 grades: steps (arithmetic) or people (tracking) right, beside the all-or-nothing score.
    notes.push(`${cat === "arith" ? "steps" : cat === "track" ? "people" : "graded"} ${s.gradeCorrect ?? 0}/${s.gradeTotal}${s.gradePct != null ? ` = ${s.gradePct.toFixed(1)}%` : ""}${s.gradeCi ? ` (${formatCi(s.gradeCi)})` : ""}`);
  }
  // WP1 coverage beside accuracy: only worth a note when the score does not rest on the whole category.
  if (s.coveragePct != null && s.coveragePct < 100) {
    notes.push(`coverage ${s.coveragePct.toFixed(1)}%`);
    if (s.budgetedPct != null) notes.push(`budgeted ${s.budgetedPct.toFixed(1)}%`);
  }
  if (cat === "reason" || cat === "arith" || cat === "track" || cat === "gsm8k" || cat === "mmlupro" || cat === "math500") {
    notes.push(`mean ${s.meanCompletionTokens.toLocaleString()} tok`);
    notes.push(`${s.hitMaxTokens} hit max_tokens`);
  }
  if (s.errors > 0) notes.push(`${s.errors} request error${s.errors === 1 ? "" : "s"}`);
  // Scoring v3: unscored rows are named, and a category whose replies were cut off is not a clean score.
  if (s.truncated) notes.push(`${s.truncated} ${s.truncated === 1 ? "reply" : "replies"} ran out of token budget before answering, left out`);
  if (s.disputed) notes.push(`${s.disputed} disputed, not scored`);
  if (s.budgetLimited) notes.push("score covers the finished replies; see budgeted for the rate with them counted as failed");
  return notes.join(" · ");
}

function buildShareText(
  job: QualityBenchJob,
  compareJob: QualityBenchJob | null,
  compareRows: QualityCompareRow[]
): string {
  const lines: string[] = [];
  const model = job.config.modelId || "unknown model";
  lines.push(`${model}${job.config.label ? ` [${job.config.label}]` : ""} | quality bench`);
  const overall = overallOf(job);
  lines.push(
    overall.pct == null
      ? `Partial run (${Object.keys(job.results.categories ?? {}).map((c) => QUALITY_CATEGORY_LABELS[c as QualityCategory]).join(", ")}) — no headline overall`
      : `Overall ${pct(overall.pct)}${overall.ci ? ` (95% CI ${formatCi(overall.ci)})` : ""} (mean of category %, ${jobProfile(job)} profile)`
  );
  for (const w of job.results.warnings ?? []) {
    lines.push(`WARNING thinking off not honoured in ${QUALITY_CATEGORY_LABELS[w.category]}: ${w.reasoningRows}/${w.rows} replies carried reasoning, ${w.truncated} cut off`);
  }
  const engineLine = engineRecordLine(job.engine?.record);
  const cap = job.engine?.capabilities;
  if (engineLine || cap) {
    lines.push(
      `Engine ${engineLine || "unknown"}${cap ? ` · prompt logprobs ${cap.promptLogprobs ? `yes (K ≤ ${cap.cap ?? "?"})` : "no"}` : ""}`
    );
  }
  lines.push("");
  for (const cat of QUALITY_CATEGORIES) {
    const s = job.results.categories?.[cat];
    if (!s) continue;
    const notes = categoryNotes(cat, s);
    if (cat === "fidelity" || cat === "divergence") {
      lines.push(`${QUALITY_CATEGORY_LABELS[cat].padEnd(20)} ${`${s.scored ?? s.total} ${cat === "fidelity" ? "docs" : "items"}`.padStart(9)}  ${notes}`);
      continue;
    }
    const ci = categoryCi(s);
    lines.push(
      `${QUALITY_CATEGORY_LABELS[cat].padEnd(20)} ${`${s.passed}/${s.scored ?? s.total}`.padStart(7)}  ${pct(s.pct).padStart(6)}${ci ? ` (${formatCi(ci)})` : ""}${notes ? `  · ${notes}` : ""}`
    );
  }
  if (job.results.fidelityUnsupported) lines.push(`Fidelity skipped: ${job.results.fidelityUnsupported}`);
  if (job.results.skippedLongSizes?.length) {
    lines.push(`Long sizes skipped (above context): ${job.results.skippedLongSizes.map(formatContextSize).join(", ")}`);
  }
  if (compareJob && compareRows.length) {
    lines.push("");
    lines.push(`Compared with: ${runLabel(compareJob)}`);
    const band = noiseBand(job, compareJob);
    const verdict = overallVerdict(compareRows, compareQualityOverall(job, compareJob), band?.overall ?? null);
    if (verdict) lines.push(`Overall: ${verdict.text}`);
    const div = compareDivergence(job, compareJob);
    if (div) {
      lines.push(
        `Divergence: identical ${pct(div.identicalPct)} (${div.identical}/${div.paired}) · median first divergence ${div.medianFirstDivergence == null ? "—" : `${Math.round(div.medianFirstDivergence)} ch`} · edit distance ${div.meanEditNorm.toFixed(3)} · length ratio ${div.meanLenRatio?.toFixed(2) ?? "—"} · loops ${div.loopsA}/${div.loopsB} · terminated ${div.terminatedA}/${div.terminatedB}${div.drift.length ? ` · drift ${div.drift.map((x) => `${pct(x.identicalPct)}@${x.chars}ch`).join(" ")}` : ""}`
      );
    }
    for (const r of compareRows) {
      lines.push(
        `${QUALITY_CATEGORY_LABELS[r.category].padEnd(20)} ${pct(r.pctA).padStart(6)} vs ${pct(r.pctB).padStart(6)}  identical ${r.identical}/${r.paired}  only-this ${r.onlyA}  only-other ${r.onlyB}  p=${formatP(r.p)}  ${verdictLine(r, band?.categories[r.category] ?? null)}`
      );
    }
  }
  const noise = job.results.noise;
  if (noise?.passes.length) {
    lines.push("");
    lines.push(
      `Noise floor: run-to-run ${pct(noise.repeatFlipPct)} flipped${noise.batchFlipPct != null ? ` · batch effect ${pct(noise.batchFlipPct)} flipped` : ""}`
    );
    for (const p of noise.passes) {
      lines.push(
        `${(p.kind === "repeat" ? `repeat @${p.concurrency}` : "serial @1").padEnd(20)} flipped ${p.discordant}/${p.pairs} (${pct(p.flipPct)})  identical replies ${pct(p.identicalPct)}`
      );
    }
  }
  lines.push("");
  lines.push(
    `temp 0 · seed fixed · suite v${job.config.suiteVersion}${job.config.scoringVersion != null ? ` · scoring v${job.config.scoringVersion}` : ""} · concurrency ${job.config.concurrency} · ${job.status} in ${formatDuration(job.durationMs)}`
  );
  return lines.join("\n");
}

/** WP0: the build a run scored and what the engine was measured to do, one line with the details folded. */
function EngineLine({ job }: { job: QualityBenchJob }) {
  const { t } = useTranslation("benchmarks");
  const eng = job.engine;
  if (!eng) return null;
  const rec = eng.record;
  const cap = eng.capabilities;
  const line = engineRecordLine(rec);
  const fidelity = cap
    ? cap.promptLogprobs
      ? t("quality.fidelityYes", { cap: cap.cap ?? "?" })
      : t("quality.fidelityNo", { reason: cap.reason ?? "unsupported" })
    : null;
  const details: Array<[string, string]> = [];
  const push = (k: string, v: unknown) => {
    if (v != null && v !== "") details.push([k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
  };
  if (rec) {
    push("model", rec.modelId);
    push("backend", rec.backend);
    push("version", rec.engineVersion);
    push("commit", rec.gitCommit);
    push("patches", rec.patches);
    push("device", rec.device);
    push("checkpoint", rec.checkpoint);
    push("checkpoint sha256", rec.checkpointSha256);
    push("quantization", rec.quantization);
    push("compute dtype", rec.computeDtype);
    push("KV cache", rec.kvCacheDtype);
    push("tensor parallel", rec.tensorParallel);
    push("context", rec.contextLength);
    push("speculative", rec.speculative);
    push("tokenizer", rec.tokenizerName);
    push("tokenizer sha256", rec.tokenizerSha256);
    push("BOS on raw prompts", rec.promptBos);
    push("prompt_logprobs cap", rec.promptLogprobsCap);
  }
  if (cap?.promptLogprobs) {
    push("prompt logprobs shape", cap.shape);
    push("actual token outside top-K", cap.actualIncluded);
    push("positions aligned", cap.aligned);
    push("exact mode", cap.exactMode);
  }
  push("concurrency", job.config.concurrency);
  push("suite / scoring", `v${job.config.suiteVersion} / v${job.config.scoringVersion ?? 1}`);
  if (job.results.longTokens) {
    push(
      "measured long prompt tokens",
      Object.entries(job.results.longTokens)
        .map(([s, n]) => `${formatContextSize(Number(s))} → ${n.toLocaleString()}`)
        .join(", ")
    );
  }
  return (
    <details className="q-engine">
      <summary className="q-engine__line" title={t("quality.engineDetails")}>
        <span className="q-engine__label">{t("quality.engine")}</span>
        <span>{line || eng.error || t("quality.engineUnknown")}</span>
        {fidelity ? <span className={`q-engine__cap${cap?.promptLogprobs ? " is-yes" : " is-no"}`}>{fidelity}</span> : null}
      </summary>
      <dl className="q-engine__grid">
        {details.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

const fmtNll = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(4));
const fmtSigned = (v: number | null | undefined, digits = 4) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(digits)}`);

/**
 * WP2: the fidelity category's card — corpus NLL, perplexity and bits per byte with the per-document
 * rows, and, against a compared run that also has fidelity data, the token-by-token comparison
 * fetched from the server (paired ΔNLL with its document bootstrap interval, top-1 agreement, tail
 * loss, truncated divergence).
 */
function FidelityCard({
  job,
  compareJob,
  sparkId,
  onCompare,
}: {
  job: QualityBenchJob;
  compareJob: QualityBenchJob | null;
  sparkId: string;
  /** WP4: the quant dashboard reads the same comparison. */
  onCompare?: (cmp: QualityFidelityCompare | null) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const s = job.results.categories?.fidelity;
  const unsupported = job.results.fidelityUnsupported;
  const bothHave = Boolean(job.results.fidelity?.sideFile && compareJob?.results?.fidelity?.sideFile);
  const [cmp, setCmp] = useState<QualityFidelityCompare | null>(null);
  const [cmpError, setCmpError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setCmp(null);
    setCmpError(null);
    onCompare?.(null);
    if (!compareJob || !bothHave) return;
    let cancelled = false;
    setLoading(true);
    getQualityFidelityCompare(sparkId, job.benchId, compareJob.benchId, compareJob.sparkId)
      .then((r) => {
        if (!cancelled) {
          setCmp(r);
          onCompare?.(r);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setCmpError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // onCompare is a state setter from the parent: stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sparkId, job.benchId, compareJob, bothHave]);
  if (!s && !unsupported) return null;
  const f = s?.fidelity;
  const rows = (job.results.items ?? []).filter((it) => it.category === "fidelity");
  const cmpByDoc = new Map((cmp?.docs ?? []).map((d) => [d.id, d]));
  return (
    <div className="q-fid">
      <div className="q-main__head">
        <h3 className="bench-sheet__section-title">{t("quality.fidelityHead")}</h3>
        {f ? (
          <span className="q-muted">{t("quality.fidelityTokens", { count: f.tokens.toLocaleString(), docs: f.docs, k: f.k })}</span>
        ) : null}
      </div>
      {unsupported ? <p className="bench-sheet__hint q-fid__unsupported">{t("quality.fidelityUnsupported", { reason: unsupported })}</p> : null}
      {f?.nll != null && (
        <div className="q-fid__stats">
          <div className="q-fid__stat">
            <span className="eyebrow">{t("quality.fidelityNll")}</span>
            <b>{fmtNll(f.nll)}</b>
          </div>
          <div className="q-fid__stat">
            <span className="eyebrow">{t("quality.fidelityPpl")}</span>
            <b>{f.ppl?.toFixed(3) ?? "—"}</b>
          </div>
          <div className="q-fid__stat">
            <span className="eyebrow">{t("quality.fidelityBpb")}</span>
            <b>{f.bitsPerByte == null ? "—" : f.bitsPerByte.toFixed(4)}</b>
          </div>
          {cmp?.comparable && (
            <>
              <div className="q-fid__stat q-fid__stat--cmp">
                <span className="eyebrow">{t("quality.fidelityDNll")}</span>
                <b className={cmp.dNll != null && cmp.dNll > 0 ? "is-down" : cmp.dNll != null && cmp.dNll < 0 ? "is-up" : ""}>{fmtSigned(cmp.dNll)}</b>
                <span className="q-ci">{cmp.dNllCi ? `${fmtSigned(cmp.dNllCi[0])} to ${fmtSigned(cmp.dNllCi[1])}` : ""}</span>
              </div>
              <div className="q-fid__stat q-fid__stat--cmp">
                <span className="eyebrow">{t("quality.fidelityAgree")}</span>
                <b>{pct(cmp.top1AgreementPct)}</b>
              </div>
              <div className="q-fid__stat q-fid__stat--cmp">
                <span className="eyebrow">{t("quality.fidelityTail")}</span>
                <b>{pct(cmp.tailLossPct)}</b>
              </div>
              <div className="q-fid__stat q-fid__stat--cmp">
                <span className="eyebrow">{t("quality.fidelityDiv")}</span>
                <b>{fmtNll(cmp.divergence)}</b>
              </div>
            </>
          )}
        </div>
      )}
      {loading && <p className="bench-sheet__hint">{t("quality.fidelityLoading")}</p>}
      {cmpError && <p className="bench-sheet__error">{cmpError}</p>}
      {cmp && !cmp.comparable && <p className="bench-sheet__hint">{t("quality.fidelityNoCompare", { reason: cmp.reason ?? "" })}</p>}
      {cmp?.comparable && (cmp.mismatchedDocs ?? 0) > 0 && (
        <p className="bench-sheet__hint">{t("quality.fidelityMismatch", { count: cmp.mismatchedDocs })}</p>
      )}
      {rows.length > 0 && (
        <table className="q-cat-table q-fid__docs">
          <thead>
            <tr>
              <th>{t("quality.fidelityDoc")}</th>
              <th className="is-num">tokens</th>
              <th className="is-num">{t("quality.fidelityNll")}</th>
              <th className="is-num">{t("quality.fidelityPpl")}</th>
              <th className="is-num">top-1</th>
              {cmp?.comparable && (
                <>
                  <th className="is-num">ΔNLL</th>
                  <th className="is-num">{t("quality.fidelityAgree")}</th>
                  <th className="is-num">{t("quality.fidelityTail")}</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const d = cmpByDoc.get(r.id);
              return (
                <tr key={r.id}>
                  <td className="q-cat-table__name">
                    {r.docId ?? r.id}
                    <small className="q-muted"> {r.kind} · {r.lang}</small>
                  </td>
                  <td className="is-num">{r.error ? <span className="text-danger">{r.error}</span> : r.tokens?.toLocaleString()}</td>
                  <td className="is-num is-strong">{fmtNll(r.nll)}</td>
                  <td className="is-num">{r.ppl?.toFixed(2) ?? "—"}</td>
                  <td className="is-num">{r.top1Pct != null ? `${r.top1Pct.toFixed(1)}%` : "—"}</td>
                  {cmp?.comparable && (
                    <>
                      <td className="is-num">{d?.match ? fmtSigned(d.dNll) : "not paired"}</td>
                      <td className="is-num">{d?.match ? pct(d.top1AgreementPct) : "—"}</td>
                      <td className="is-num">{d?.match ? pct(d.tailLossPct) : "—"}</td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {cmp?.comparable && <p className="bench-sheet__hint">{t("quality.fidelityCompareHint")}</p>}
    </div>
  );
}

/**
 * WP3: the divergence card — the structural rates of this run's stored replies and, against a
 * compared run, the reply-by-reply differences (computed here from both runs' rows).
 */
function DivergenceCard({ job, compareJob }: { job: QualityBenchJob; compareJob: QualityBenchJob | null }) {
  const { t } = useTranslation("benchmarks");
  const s = job.results.categories?.divergence;
  const cmp = useMemo(() => (compareJob ? compareDivergence(job, compareJob) : null), [job, compareJob]);
  if (!s?.divergence) return null;
  const d = s.divergence;
  const stat = (label: string, value: string, extra?: string) => (
    <div className="q-fid__stat" key={label}>
      <span className="eyebrow">{label}</span>
      <b>{value}</b>
      {extra ? <span className="q-ci">{extra}</span> : null}
    </div>
  );
  return (
    <div className="q-fid q-div">
      <div className="q-main__head">
        <h3 className="bench-sheet__section-title">{t("quality.divergenceHead")}</h3>
        <span className="q-muted">{t("quality.divergenceSub", { count: d.rows })}</span>
      </div>
      <div className="q-fid__stats">
        {stat(t("quality.divTerminated"), pct(d.terminatedPct))}
        {stat(t("quality.divLoops"), `${d.loops}`, pct(d.loopPct))}
        {d.jsonSchemaPct != null ? stat(t("quality.divJson"), pct(d.jsonSchemaPct), `${t("quality.divJsonValid")} ${pct(d.jsonValidPct)}`) : null}
        {d.toolOkPct != null ? stat(t("quality.divTool"), pct(d.toolOkPct)) : null}
        {d.meanChars != null ? stat(t("quality.divLength"), d.meanChars.toLocaleString(), d.meanTokens != null ? `${d.meanTokens.toLocaleString()} tok` : undefined) : null}
      </div>
      {compareJob && !cmp && <p className="bench-sheet__hint">{t("quality.divNoCompare")}</p>}
      {cmp && (
        <>
          <div className="q-fid__stats">
            {stat(t("quality.divIdentical"), pct(cmp.identicalPct), `${cmp.identical}/${cmp.paired}`)}
            {stat(t("quality.divFirst"), cmp.medianFirstDivergence == null ? "—" : `${Math.round(cmp.medianFirstDivergence).toLocaleString()} ch`)}
            {stat(t("quality.divEdit"), cmp.meanEditNorm.toFixed(3))}
            {stat(t("quality.divLenRatio"), cmp.meanLenRatio == null ? "—" : cmp.meanLenRatio.toFixed(2))}
            {stat(t("quality.divLoops"), `${cmp.loopsA} / ${cmp.loopsB}`, "A / B")}
            {stat(t("quality.divTerminated"), `${cmp.terminatedA} / ${cmp.terminatedB}`, "A / B")}
          </div>
          {cmp.drift.length > 0 && (
            <p className="q-div__drift">
              {t("quality.divDrift")}:{" "}
              {cmp.drift.map((x) => `${pct(x.identicalPct)} @ ${x.chars.toLocaleString()} ch`).join(" · ")}
            </p>
          )}
          <table className="q-cat-table q-div__kinds">
            <thead>
              <tr>
                <th>{t("quality.divKind")}</th>
                <th className="is-num">{t("quality.items")}</th>
                <th className="is-num">{t("quality.divIdentical")}</th>
                <th className="is-num">{t("quality.divFirst")}</th>
                <th className="is-num">{t("quality.divEdit")}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(cmp.kinds).map(([kind, k]) => (
                <tr key={kind}>
                  <td className="q-cat-table__name">{kind}</td>
                  <td className="is-num">{k.paired}</td>
                  <td className="is-num is-strong">{pct(k.identicalPct)}</td>
                  <td className="is-num">{k.medianFirstDivergence == null ? "—" : `${Math.round(k.medianFirstDivergence).toLocaleString()} ch`}</td>
                  <td className="is-num">{k.meanEditNorm == null ? "—" : k.meanEditNorm.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="bench-sheet__hint">{t("quality.divCompareHint")}</p>
        </>
      )}
    </div>
  );
}

/** The serving configuration of a run, one fact per key, for the comparison header. */
function servingFacts(job: QualityBenchJob): Array<[string, string]> {
  const rec = job.engine?.record;
  const q = rec?.quantization as { quant_method?: string; bits?: number } | null | undefined;
  return [
    ["unit", job.unit?.name || job.sparkId],
    ["model", job.config.modelId || "?"],
    ["engine", [rec?.backend, rec?.engineVersion].filter(Boolean).join(" ") || "?"],
    ["build", [rec?.gitCommit?.slice(0, 8), rec?.patches].filter(Boolean).join(" · ") || "—"],
    ["quantisation", q ? [q.quant_method, q.bits != null ? `${q.bits}-bit` : null].filter(Boolean).join(" ") : "—"],
    ["checkpoint", rec?.checkpointSha256 ? rec.checkpointSha256.slice(0, 12) : "—"],
    ["KV cache", rec?.kvCacheDtype || "—"],
    ["tensor parallel", rec?.tensorParallel != null ? String(rec.tensorParallel) : "—"],
    ["concurrency", String(job.config.concurrency)],
    ["suite / scoring", `v${job.config.suiteVersion} / v${job.config.scoringVersion ?? 1}`],
  ];
}

/** Keys whose difference means the two runs compare serving stacks, not only weights. */
const SERVING_KEYS = new Set(["unit", "engine", "build", "KV cache", "tensor parallel", "concurrency"]);

/**
 * WP4: both runs' serving configurations side by side. A difference in unit, engine, build, KV
 * dtype, tensor parallel or concurrency is named, and the comparison is labelled one of serving
 * configurations rather than of weights.
 */
function ComparisonHeader({ job, compareJob }: { job: QualityBenchJob; compareJob: QualityBenchJob }) {
  const { t } = useTranslation("benchmarks");
  const a = servingFacts(job);
  const b = new Map(servingFacts(compareJob));
  const differing = a.filter(([k, v]) => b.get(k) !== v).map(([k]) => k);
  const serving = differing.filter((k) => SERVING_KEYS.has(k));
  return (
    <div className="q-cmphead">
      <table className="q-cat-table q-cmphead__table">
        <thead>
          <tr>
            <th />
            <th>A · {shortRunName(job, t("quality.thisRun"))}</th>
            <th>B · {shortRunName(compareJob, t("quality.otherRun"))}</th>
          </tr>
        </thead>
        <tbody>
          {a.map(([k, v]) => (
            <tr key={k} className={b.get(k) !== v ? "is-diff" : undefined}>
              <td className="q-cat-table__name">{k}</td>
              <td>{v}</td>
              <td>{b.get(k) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {serving.length > 0 ? (
        <p className="q-warning">{t("quality.servingMismatch", { keys: serving.join(", ") })}</p>
      ) : (
        <p className="bench-sheet__hint">{t("quality.servingSame")}</p>
      )}
    </div>
  );
}

function costLine(c: QualityBenchJob["cost"]): { tps: string; mem: string } {
  const tps = c?.decodeTps1 != null ? `${c.decodeTps1.toFixed(1)} (bench ×1)` : c?.perStreamTps != null ? `${c.perStreamTps.toFixed(1)} (live)` : c?.generationTps != null ? `${c.generationTps.toFixed(1)} (live, aggregate)` : "—";
  const mem = c?.weightsGb != null ? `${c.weightsGb.toFixed(1)} GB weights${c.kvCacheGb != null ? ` + ${c.kvCacheGb.toFixed(1)} KV` : ""}` : c?.vramUsedGb != null ? `${c.vramUsedGb.toFixed(1)} GB VRAM used` : "—";
  return { tps, mem };
}

/**
 * WP4: the quant dashboard — every quality delta between A (this run) and B (the reference) in one
 * table, with the cost side beside it, so quality per GB and per tok/s is visible at a glance.
 */
function QuantDashboard({
  job,
  compareJob,
  compareRows,
  fidelity,
}: {
  job: QualityBenchJob;
  compareJob: QualityBenchJob;
  compareRows: QualityCompareRow[];
  fidelity: QualityFidelityCompare | null;
}) {
  const { t } = useTranslation("benchmarks");
  const div = useMemo(() => compareDivergence(job, compareJob), [job, compareJob]);
  const band = useMemo(() => noiseBand(job, compareJob), [job, compareJob]);
  const rows: Array<{ label: string; a: string; b: string; delta: string; tone?: "up" | "down"; note?: string }> = [];
  const num = (v: number | null | undefined, d = 1, unit = "") => (v == null ? "—" : `${v.toFixed(d)}${unit}`);
  const signed = (v: number | null | undefined, d = 1, unit = "") => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}${unit}`);
  if (fidelity?.comparable) {
    rows.push({ label: t("quality.fidelityNll"), a: num(fidelity.nllA, 4), b: num(fidelity.nllB, 4), delta: `${signed(fidelity.dNll, 4)}${fidelity.dNllCi ? ` (${signed(fidelity.dNllCi[0], 4)} to ${signed(fidelity.dNllCi[1], 4)})` : ""}`, tone: fidelity.dNll != null && fidelity.dNll > 0 ? "down" : fidelity.dNll != null && fidelity.dNll < 0 ? "up" : undefined });
    rows.push({ label: t("quality.fidelityPpl"), a: num(fidelity.pplA, 3), b: num(fidelity.pplB, 3), delta: fidelity.pplA != null && fidelity.pplB != null ? signed(fidelity.pplA - fidelity.pplB, 3) : "—" });
    rows.push({ label: t("quality.fidelityAgree"), a: pct(fidelity.top1AgreementPct), b: "—", delta: "" });
    rows.push({ label: t("quality.fidelityTail"), a: pct(fidelity.tailLossPct), b: "—", delta: "" });
  }
  if (div) {
    rows.push({ label: t("quality.divIdentical"), a: `${div.identical}/${div.paired}`, b: "—", delta: pct(div.identicalPct) });
    rows.push({ label: t("quality.divFirst"), a: div.medianFirstDivergence == null ? "—" : `${Math.round(div.medianFirstDivergence).toLocaleString()} ch`, b: "—", delta: "" });
    rows.push({ label: t("quality.divLoops"), a: String(div.loopsA), b: String(div.loopsB), delta: signed(div.loopsA - div.loopsB, 0), tone: div.loopsA > div.loopsB ? "down" : div.loopsA < div.loopsB ? "up" : undefined });
  }
  // Reasoning tokens, truncations and coverage over the generation categories both runs scored.
  const gen = (j: QualityBenchJob) => (j.results.items ?? []).filter((r) => r.category !== "fidelity" && r.category !== "divergence" && !r.error);
  const ga = gen(job);
  const gb = gen(compareJob);
  const reasoning = (list: typeof ga) => {
    const withR = list.filter((r) => r.reasoningTokens != null);
    return withR.length ? withR.reduce((n, r) => n + (r.reasoningTokens ?? 0), 0) / withR.length : null;
  };
  const ra = reasoning(ga);
  const rb = reasoning(gb);
  if (ra != null || rb != null) rows.push({ label: t("quality.quantReasoning"), a: num(ra, 0), b: num(rb, 0), delta: ra != null && rb != null ? signed(ra - rb, 0) : "—" });
  const cut = (list: typeof ga) => list.filter((r) => qualityRowUnscored(r) === "truncated").length;
  const ca = cut(ga);
  const cb = cut(gb);
  if (ga.length && gb.length) rows.push({ label: t("quality.quantTruncated"), a: String(ca), b: String(cb), delta: signed(ca - cb, 0), tone: ca > cb ? "down" : ca < cb ? "up" : undefined });
  for (const r of compareRows) {
    const inBand = insideNoise(r.deltaPts, band?.categories[r.category] ?? null);
    rows.push({
      label: QUALITY_CATEGORY_LABELS[r.category],
      a: pct(r.pairedPctA),
      b: pct(r.pairedPctB),
      delta: `${signed(r.deltaPts, 1, " pts")}${r.deltaCi ? ` (${signed(r.deltaCi[0], 1)} to ${signed(r.deltaCi[1], 1)})` : ""}`,
      tone: r.verdict === "different" && !inBand ? (r.deltaPts != null && r.deltaPts > 0 ? "up" : "down") : undefined,
      note: r.verdict === "different" && !inBand ? `Holm p ${formatP(r.pAdj)}` : r.equivalent ? `equivalent ±${r.margin}` : inBand ? "inside noise floor" : "insufficient evidence",
    });
  }
  const costA = costLine(job.cost);
  const costB = costLine(compareJob.cost);
  rows.push({ label: t("quality.quantDecode"), a: costA.tps, b: costB.tps, delta: job.cost?.decodeTps1 != null && compareJob.cost?.decodeTps1 != null ? signed(job.cost.decodeTps1 - compareJob.cost.decodeTps1, 1, " tok/s") : "" });
  rows.push({ label: t("quality.quantMemory"), a: costA.mem, b: costB.mem, delta: job.cost?.weightsGb != null && compareJob.cost?.weightsGb != null ? signed(job.cost.weightsGb - compareJob.cost.weightsGb, 1, " GB") : "" });
  return (
    <div className="q-quant">
      <div className="q-main__head">
        <h3 className="bench-sheet__section-title">{t("quality.quantHead")}</h3>
        <span className="q-muted">{t("quality.quantSub")}</span>
      </div>
      <table className="q-cat-table q-quant__table">
        <thead>
          <tr>
            <th />
            <th className="is-num">A</th>
            <th className="is-num">B</th>
            <th className="is-num">Δ (A − B)</th>
            <th>{t("quality.notes")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td className="q-cat-table__name">{r.label}</td>
              <td className="is-num">{r.a}</td>
              <td className="is-num">{r.b}</td>
              <td className={`is-num is-strong${r.tone ? ` is-${r.tone}` : ""}`}>{r.delta}</td>
              <td className="q-cat-table__note">{r.note ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="bench-sheet__hint">{t("quality.quantHint")}</p>
    </div>
  );
}

function insideNoise(delta: number | null | undefined, band: number | null): boolean {
  return delta != null && band != null && Math.abs(delta) <= band;
}

/** WP1 run hygiene: a thinking-off category whose replies carried reasoning or were cut off a lot. */
function RunWarnings({ job }: { job: QualityBenchJob }) {
  const { t } = useTranslation("benchmarks");
  const warnings = job.results.warnings ?? [];
  if (!warnings.length) return null;
  return (
    <div className="q-warnings" role="alert">
      {warnings.map((w) => (
        <p key={`${w.kind}-${w.category}`} className="q-warning">
          {t("quality.thinkingWarning", {
            model: job.config.modelId || "the model",
            category: QUALITY_CATEGORY_LABELS[w.category],
            rows: w.rows,
            reasoningRows: w.reasoningRows,
            truncated: w.truncated,
          })}
        </p>
      ))}
    </div>
  );
}

/** WP0: the noise floor — every extra pass paired with the primary pass item by item. */
function NoiseFloor({ job }: { job: QualityBenchJob }) {
  const { t } = useTranslation("benchmarks");
  const noise = job.results.noise;
  if (!noise || !noise.passes.length) return null;
  const cats = QUALITY_CATEGORIES.filter((c) => noise.passes.some((p) => p.categories[c]));
  return (
    <div className="q-noise">
      <div className="q-noise__head">
        <b>{t("quality.noiseHead")}</b>
        <span>
          {noise.batchFlipPct != null
            ? t("quality.noiseSummary", { repeat: pct(noise.repeatFlipPct), batch: pct(noise.batchFlipPct) })
            : t("quality.noiseRepeatOnly", { repeat: pct(noise.repeatFlipPct) })}
        </span>
      </div>
      <table className="q-cat-table">
        <thead>
          <tr>
            <th>{t("quality.noisePass")}</th>
            <th className="is-num">{t("quality.noiseFlipped")}</th>
            <th className="is-num">{t("quality.noiseIdentical")}</th>
            {cats.map((c) => (
              <th key={c} className="is-num">
                {QUALITY_CATEGORY_LABELS[c]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {noise.passes.map((p) => (
            <tr key={p.index}>
              <td className="q-cat-table__name">
                {p.kind === "repeat" ? t("quality.noisePassRepeat", { concurrency: p.concurrency }) : t("quality.noisePassSerial")}
              </td>
              <td className="is-num is-strong">
                {p.discordant}/{p.pairs} · {pct(p.flipPct)}
              </td>
              <td className="is-num">{pct(p.identicalPct)}</td>
              {cats.map((c) => {
                const s = p.categories[c];
                return (
                  <td key={c} className="is-num">
                    {s ? `${s.discordant}/${s.pairs}` : "—"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="bench-sheet__hint">{t("quality.noiseHint")}</p>
    </div>
  );
}

function CategoryTable({ job }: { job: QualityBenchJob }) {
  const { t } = useTranslation("benchmarks");
  const rows = QUALITY_CATEGORIES.filter((c) => job.results.categories?.[c]);
  if (!rows.length) return null;
  return (
    <div className="bench-results">
      <table className="q-cat-table">
        <thead>
          <tr>
            <th>{t("quality.category")}</th>
            <th className="is-num">{t("quality.score")}</th>
            <th className="is-num">%</th>
            <th className="is-num">{t("quality.ci")}</th>
            <th className="is-num" title={t("quality.coverageTitle")}>{t("quality.coverage")}</th>
            <th>{t("quality.notes")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((cat) => {
            const s = job.results.categories[cat] as QualityCategorySummary;
            const ci = categoryCi(s);
            return (
              <tr key={cat} className={s.budgetLimited ? "is-budget-limited" : undefined}>
                <td className="q-cat-table__name">{QUALITY_CATEGORY_LABELS[cat]}</td>
                <td className="is-num">
                  {s.passed}/{s.scored ?? s.total}
                </td>
                <td className="is-num is-strong" title={s.budgetLimited ? t("quality.budgetLimitedTitle") : undefined}>
                  {pct(s.pct)}
                  {s.budgetLimited ? <span className="q-flag" aria-label={t("quality.budgetLimited")}>*</span> : null}
                </td>
                <td className="is-num q-ci">{ci ? formatCi(ci) : "—"}</td>
                <td className="is-num q-ci" title={t("quality.coverageTitle")}>
                  {s.coveragePct != null ? `${Number.isInteger(s.coveragePct) ? s.coveragePct : s.coveragePct.toFixed(1)}%` : "—"}
                  {s.budgetedPct != null && s.budgetedPct !== s.pct ? ` · ${t("quality.budgeted")} ${s.budgetedPct.toFixed(1)}%` : ""}
                </td>
                <td className="q-cat-table__note">
                  {s.budgetLimited ? <span className="q-note-tag" title={t("quality.budgetLimitedTitle")}>{t("quality.budgetLimited")}</span> : null}
                  {categoryNotes(cat, s)}
                </td>
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
  const { t } = useTranslation("benchmarks");
  const headline = useMemo(() => overallOf(job), [job]);
  const overall = headline.pct;
  const partial = jobProfile(job) === "custom";
  // Overall means over different category sets are not comparable: use the shared categories.
  const shared = compareJob ? sharedOverallDelta(job, compareJob) : null;
  const delta = shared?.delta ?? null;
  const totalCats = Object.keys(job.results.categories ?? {}).length;
  const overallStats = useMemo(() => (compareJob ? compareQualityOverall(job, compareJob) : null), [job, compareJob]);
  const band = useMemo(() => noiseBand(job, compareJob), [job, compareJob]);
  const verdict = compareJob ? overallVerdict(compareRows, overallStats, band?.overall ?? null) : null;
  return (
    <div className="q-side">
      <div className="q-score">
        <span className="eyebrow">{compareJob ? `${t("quality.overall")} · ${t("quality.thisRun")}` : t("quality.overall")}</span>
        {compareJob ? (
          <div className="big-num">
            {overall == null ? "—" : overall.toFixed(1)}
            <small>%</small>
          </div>
        ) : (
          <Ring value={overall ?? 0} size={132} strokeWidth={11} labelSize={30} color={TIER_COLOR[qTier(overall)]} label={overall == null ? "—" : <>{overall.toFixed(1)}<span className="q-ring-pct">%</span></>} className="q-score__ring" />
        )}
        {headline.ci && <span className="q-ci q-score__ci">{t("quality.ci")} {formatCi(headline.ci)}</span>}
        {partial && (
          <span className="q-score__hint q-score__partial" title={t("quality.partialRunHint", { categories: Object.keys(job.results.categories ?? {}).map((c) => QUALITY_CATEGORY_LABELS[c as QualityCategory]).join(", ") })}>
            {t("quality.partialRun")}
          </span>
        )}
        {delta != null && (
          <div className={`q-delta${delta > 0 ? " is-up" : delta < 0 ? " is-down" : ""}`}>
            {delta === 0 ? t("quality.sameScore") : formatDelta(delta)} {t("quality.vsOther")}
            {shared && shared.categories < totalCats ? ` · ${shared.categories} shared categor${shared.categories === 1 ? "y" : "ies"}` : ""}
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
        {!compareJob && !partial && (
          <span className="q-score__hint">
            {t("quality.meanScores", { categories: Object.keys(job.results.categories ?? {}).length, items: (job.results.items?.length ?? 0).toLocaleString() })}
          </span>
        )}
      </div>
      {compareJob && (
        <div className="q-runs">
          <div className="q-run q-run--a">
            <i aria-hidden />
            <span className="q-run__name">A · {shortRunName(job, t("quality.thisRun"))}</span>
            <span className="q-run__val">{pct(overall)}</span>
          </div>
          <div className="q-run q-run--b">
            <i aria-hidden />
            <span className="q-run__name">B · {shortRunName(compareJob, t("quality.otherRun"))}</span>
            <span className="q-run__val">{pct(overallOf(compareJob).pct)}</span>
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
  const { t } = useTranslation("benchmarks");
  // Fidelity and divergence have no pass rate: they get their own cards below the bars.
  const cats = QUALITY_CATEGORIES.filter((c) => c !== "fidelity" && c !== "divergence" && job.results.categories?.[c]);
  const band = useMemo(() => noiseBand(job, compareJob), [job, compareJob]);
  if (!cats.length) return null;
  const rowByCat = new Map(compareRows.map((r) => [r.category, r]));
  return (
    <div className="q-main">
      <div className="q-main__head">
        <h3 className="bench-sheet__section-title">{t("quality.scoreByCategory")}</h3>
        {compareJob && (
          <div className="legend">
            <span className="q-leg-a">{t("quality.runA")}</span>
            <span className="q-leg-b">{t("quality.runB")}</span>
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
                  {s.passed}/{s.scored ?? s.total} {t("quality.items")}
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
                <span className="q-cat__pct" title={s.budgetLimited ? t("quality.budgetLimitedTitle") : undefined}>
                  {pct(s.pct)}
                  {s.budgetLimited ? <span className="q-flag" aria-label={t("quality.budgetLimited")}>*</span> : null}
                  {categoryCi(s) ? <span className="q-ci"> {formatCi(categoryCi(s))}</span> : null}
                </span>
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
                    ? `same reply ${cmp.identical}/${cmp.paired} · only this ${cmp.onlyA} · only other ${cmp.onlyB} · ${verdictLine(cmp, band?.categories[cat] ?? null)}${notes ? ` · ${notes}` : ""}`
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
  const { t } = useTranslation("benchmarks");
  const rows = useMemo(() => disagreements(job, compareJob), [job, compareJob]);
  const paired = useMemo(() => {
    const ok = new Set((compareJob.results?.items ?? []).filter((it) => !it.error).map((it) => it.id));
    return (job.results?.items ?? []).filter((it) => !it.error && ok.has(it.id)).length;
  }, [job, compareJob]);
  const onlyA = rows.filter((r) => r.okA).length;
  const onlyB = rows.length - onlyA;
  return (
    <div className="q-disagree">
      <div className="q-main__head">
        <h3 className="bench-sheet__section-title">
          {t("quality.disagreements")}{" "}
          <span className="q-muted">
            · {rows.length} {t("quality.of")} {paired}
          </span>
        </h3>
        <span className="tag">
          {t("quality.aOnly", { count: onlyA })} · {t("quality.bOnly", { count: onlyB })}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="bench-sheet__hint">{t("quality.sameItems")}</p>
      ) : (
        <div className="q-table-wrap">
          <table className="q-table">
            <thead>
              <tr>
                <th>{t("quality.item")}</th><th>{t("quality.category")}</th><th>{t("quality.runA")}</th><th>{t("quality.runB")}</th><th>{t("quality.runADetail")}</th>
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
  const { t } = useTranslation("benchmarks");
  const [filter, setFilter] = useState<QualityCategory | "all" | "failed">("all");
  const items = job.results.items ?? [];
  const shown = items.filter((it) =>
    filter === "all" ? true : filter === "failed" ? !it.ok : it.category === filter
  );
  const unscoredTitle = (why: ReturnType<typeof qualityRowUnscored>) =>
    why === "error"
      ? t("quality.errorTitle")
      : why === "truncated"
        ? t("quality.truncatedTitle")
        : why === "disputed"
          ? t("quality.disputedTitle")
          : undefined;
  const cats = QUALITY_CATEGORIES.filter((c) => items.some((it) => it.category === c));
  return (
    <details className="rounded border border-border">
      <summary className="cursor-pointer select-none px-2 py-1.5 text-xs text-muted hover:text-text">
        {t("quality.perItem", { count: items.length })}
      </summary>
      <div className="space-y-2 border-t border-border p-2">
        <div className="flex flex-wrap gap-1">
          {(["all", "failed", ...cats] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
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
                <th className="py-1 pr-2 font-medium">{t("quality.id")}</th><th className="py-1 pr-2 font-medium">{t("quality.ok")}</th><th className="py-1 font-medium">{t("quality.reply")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((it) => {
                const why = qualityRowUnscored(it);
                return (
                  <tr key={it.id} className="border-t border-border align-top">
                    <td className="whitespace-nowrap py-1 pr-2 font-tabular text-muted">{it.id}</td>
                    <td
                      className={`py-1 pr-2 font-semibold ${it.ok ? "text-success" : why ? "text-muted" : "text-danger"}`}
                      title={unscoredTitle(why)}
                    >
                      {it.ok ? "✓" : why === "error" ? "err" : why === "truncated" ? "cut" : why === "disputed" ? "n/a" : "✗"}
                    </td>
                    <td className="py-1 break-words text-text [overflow-wrap:anywhere]">
                      {it.error ? <span className="text-danger">{it.error}</span> : it.excerpt}
                      {(it.detail || it.finishReason === "length" || (it.reasoningTokens ?? 0) > 0) && (
                        <span className="block text-[10px] text-muted">
                          {[
                            it.detail,
                            it.finishReason === "length" ? "hit max_tokens" : null,
                            (it.reasoningTokens ?? 0) > 0 ? t("quality.reasoningTok", { count: it.reasoningTokens ?? 0 }) : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      )}
                      {it.reply ? (
                        <details className="q-reply">
                          <summary className="cursor-pointer select-none text-[10px] text-muted hover:text-text">{t("quality.fullReply")}</summary>
                          <pre className="q-reply__text">{it.reply}</pre>
                        </details>
                      ) : null}
                      {it.reasoning ? (
                        <details className="q-reply">
                          <summary className="cursor-pointer select-none text-[10px] text-muted hover:text-text">{t("quality.reasoningTail")}</summary>
                          <pre className="q-reply__text q-reply__text--reasoning">{it.reasoning}</pre>
                        </details>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}

/**
 * WP4: two finished runs side by side, from any units: the plain-words verdict, the score card
 * and bars, the serving configuration header, the quantisation dashboard, the disagreement table,
 * and the fidelity and divergence comparisons. The Quality compare page renders it for the pair
 * the user picked; the run view renders the same pieces inline.
 */
export function QualityRunComparison({ job, compareJob }: { job: QualityBenchJob; compareJob: QualityBenchJob }) {
  const { t } = useTranslation("benchmarks");
  const [fidelityCmp, setFidelityCmp] = useState<QualityFidelityCompare | null>(null);
  const compareRows = useMemo(() => compareQualityRuns(job, compareJob), [job, compareJob]);
  const comparable = useMemo(() => checkQualityComparable(job, compareJob), [job, compareJob]);
  const hasItems = (job.results.items?.length ?? 0) > 0 && (compareJob.results.items?.length ?? 0) > 0;
  return (
    <div className="q-compare">
      {comparable.ok && <PlainVerdictCard job={job} compareJob={compareJob} compareRows={compareRows} fidelity={fidelityCmp} />}
      <div className="q-cmp">
        <ScoreCard job={job} compareJob={comparable.ok ? compareJob : null} compareRows={comparable.ok ? compareRows : []} />
        <CategoryBars job={job} compareJob={comparable.ok ? compareJob : null} compareRows={comparable.ok ? compareRows : []} />
      </div>
      {!comparable.ok && <p className="bench-sheet__error">{comparable.reason}</p>}
      {comparable.ok && <ComparisonHeader job={job} compareJob={compareJob} />}
      {comparable.ok && <QuantDashboard job={job} compareJob={compareJob} compareRows={compareRows} fidelity={fidelityCmp} />}
      {comparable.ok && hasItems && compareRows.length === 0 && <p className="bench-sheet__hint">{t("quality.noSharedItems")}</p>}
      {comparable.ok && compareRows.length > 0 && <DisagreementTable job={job} compareJob={compareJob} />}
      <FidelityCard job={job} compareJob={comparable.ok ? compareJob : null} sparkId={job.sparkId} onCompare={setFidelityCmp} />
      <DivergenceCard job={job} compareJob={comparable.ok ? compareJob : null} />
      <p className="bench-legend">{t("quality.legendV2")}</p>
    </div>
  );
}

/** The plain-text summary of a comparison, for the copy button on the compare page. */
export function qualityComparisonText(job: QualityBenchJob, compareJob: QualityBenchJob): string {
  const rows = checkQualityComparable(job, compareJob).ok ? compareQualityRuns(job, compareJob) : [];
  const verdict = plainVerdict({ job, compareJob, rows, fidelity: null, divergence: compareDivergence(job, compareJob), band: noiseBand(job, compareJob) });
  const lines = buildShareText(job, compareJob, rows).split("\n");
  const head = [`Where it differs (A = ${shortRunName(job, "this run")}, B = ${shortRunName(compareJob, "other run")}): ${verdict.summary}`];
  for (const v of verdict.areas) head.push(`  ${v.area.padEnd(28)} ${v.tag.padEnd(12)} ${v.evidence}`);
  return [...lines.slice(0, 1), ...head, "", ...lines.slice(1)].join("\n");
}

/**
 * WP4: the comparison in ordinary words — one line per area (maths, coding, prose, …) saying which
 * build is better or that they are the same, with the evidence behind it.
 */
function PlainVerdictCard({
  job,
  compareJob,
  compareRows,
  fidelity,
}: {
  job: QualityBenchJob;
  compareJob: QualityBenchJob;
  compareRows: QualityCompareRow[];
  fidelity: QualityFidelityCompare | null;
}) {
  const { t } = useTranslation("benchmarks");
  const divergence = useMemo(() => compareDivergence(job, compareJob), [job, compareJob]);
  const band = useMemo(() => noiseBand(job, compareJob), [job, compareJob]);
  const verdict = useMemo(() => plainVerdict({ job, compareJob, rows: compareRows, fidelity, divergence, band }), [job, compareJob, compareRows, fidelity, divergence, band]);
  const nameA = shortRunName(job, t("quality.thisRun"));
  const nameB = shortRunName(compareJob, t("quality.otherRun"));
  const tagLabel = (tag: AreaVerdict["tag"]) =>
    tag === "A" ? t("quality.verdictA", { name: nameA }) : tag === "B" ? t("quality.verdictB", { name: nameB }) : tag === "same" ? t("quality.verdictSame") : t("quality.verdictUnknown");
  // Static keys only (the i18n check refuses a computed key).
  const areaLabel: Record<AreaVerdict["key"], string> = {
    maths: t("quality.area.maths"),
    knowledge: t("quality.area.knowledge"),
    coding: t("quality.area.coding"),
    prose: t("quality.area.prose"),
    languages: t("quality.area.languages"),
    instructions: t("quality.area.instructions"),
    longdocs: t("quality.area.longdocs"),
    facts: t("quality.area.facts"),
    reliability: t("quality.area.reliability"),
    cost: t("quality.area.cost"),
  };
  return (
    <div className="q-verdicts">
      <div className="q-main__head">
        <h3 className="bench-sheet__section-title">{t("quality.verdictHead")}</h3>
        <span className="q-muted">{verdict.summary}</span>
      </div>
      <ul className="q-verdicts__list">
        {verdict.areas.map((v) => (
          <li key={v.key} className={`q-verdict-row q-verdict-row--${v.tag}`}>
            <span className="q-verdict-row__area">{areaLabel[v.key]}</span>
            <span className="q-verdict-row__tag">{tagLabel(v.tag)}</span>
            <span className="q-verdict-row__ev">{v.evidence}</span>
          </li>
        ))}
      </ul>
      <p className="bench-sheet__hint">{t("quality.verdictHint", { a: nameA, b: nameB })}</p>
    </div>
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
  const { t } = useTranslation("benchmarks");
  const shareCardLabels = useShareCardLabels();
  const historyLabels = { peakAt: t("history.peakAt"), streamAtOne: t("history.streamAtOne"), startContext: t("history.startContext"), bestAt: t("history.bestAt"), category: t("history.category"), categories: t("history.categories") };
  const isPage = variant === "page";
  const open = isPage || openProp;
  const [categories, setCategories] = useState<QualityCategory[]>([...QUALITY_DEFAULT_CATEGORIES]);
  const [longSizes, setLongSizes] = useState<number[]>([...QUALITY_DEFAULT_LONG_SIZES]);
  const [longItems, setLongItems] = useState(String(QUALITY_DEFAULT_LONG_ITEMS));
  const [concurrency, setConcurrency] = useState(String(QUALITY_DEFAULT_CONCURRENCY));
  const [label, setLabel] = useState("");
  const [noiseFloor, setNoiseFloor] = useState(false);
  const [job, setJob] = useState<QualityBenchJob | null>(null);
  const [history, setHistory] = useState<QualityBenchJob[]>([]);
  // WP4: other units' saved runs (compare targets) and the pinned references per model family.
  const [fleetRuns, setFleetRuns] = useState<QualityBenchJob[]>([]);
  const [references, setReferences] = useState<Record<string, QualityReference>>({});
  const autoRefFor = useRef<string | null>(null);
  const [compareId, setCompareId] = useState("");
  const [compareJob, setCompareJob] = useState<QualityBenchJob | null>(null);
  /** WP4: the fidelity comparison the card fetched, shared with the quant dashboard. */
  const [fidelityCmp, setFidelityCmp] = useState<QualityFidelityCompare | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which category's "How it works" panel is open.
  const [infoFor, setInfoFor] = useState<QualityCategory | null>(null);
  const infoRef = useRef<HTMLDivElement | null>(null);
  // The panel sits below the whole grid; on a one-column phone layout that is off screen.
  useEffect(() => {
    if (!infoFor) return;
    const el = infoRef.current;
    if (!el || typeof el.scrollIntoView !== "function") return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [infoFor]);
  const [starting, setStarting] = useState(false);
  const [loadingLast, setLoadingLast] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const benchPort = remoteTarget?.port ?? llmPort;
  // The port picks the endpoint for a new run; which saved runs are listed (and offered
  // for comparison) is a separate choice, "all" by default so other endpoints stay reachable.
  const [historyScope, setHistoryScope] = useState<number | "all">("all");
  const [seenPorts, setSeenPorts] = useState<number[]>([]);
  const scopeRef = useRef<number | "all">("all");
  scopeRef.current = historyScope;

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

  const applyHistory = useCallback((rows: QualityBenchJob[] | undefined) => {
    const list = rows ?? [];
    setHistory(list);
    if (scopeRef.current === "all") {
      setSeenPorts(
        [...new Set(list.map((h) => h.config.port).filter((p): p is number => Number.isInteger(p)))].sort((a, b) => a - b)
      );
    }
  }, []);

  const refreshFleet = useCallback(() => {
    void listQualityBenchFleet()
      .then((data) => {
        setFleetRuns((data.runs ?? []).filter((r) => r.sparkId !== sparkId));
        setReferences(data.references ?? {});
      })
      .catch(() => {
        /* the fleet list is optional */
      });
  }, [sparkId]);

  const refreshHistory = useCallback(() => {
    void listQualityBench(sparkId, benchPort, scopeRef.current)
      .then((data) => applyHistory(data.history))
      .catch(() => {
        /* history is optional */
      });
    refreshFleet();
  }, [sparkId, benchPort, refreshFleet]);

  const scopeMounted = useRef(false);
  useEffect(() => {
    if (!scopeMounted.current) {
      scopeMounted.current = true;
      return;
    }
    if (open) refreshHistory();
    setCompareId("");
  }, [historyScope, open, refreshHistory]);

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
            void listQualityBench(sparkId, benchPort, scopeRef.current)
              .then((data) => {
                applyHistory(data.history);
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
    void listQualityBench(sparkId, benchPort, scopeRef.current)
      .then((data) => {
        if (cancelled) return;
        applyHistory(data.history);
        const current = data.active || data.last;
        if (current) {
          setJob(current);
          // A new run starts from the Defaults preset, not from the last run's categories
          // and settings. Only a run that is live right now is mirrored into the form
          // (its controls are disabled while it runs).
          const c = current.config;
          if (current.status === "running") {
            if (Array.isArray(c?.categories) && c.categories.length) {
              // A saved run may list a category that no longer exists (e.g. the removed Code one).
              const known = c.categories.filter((x) => (QUALITY_CATEGORIES as readonly string[]).includes(x));
              if (known.length) setCategories(known);
            }
            if (Array.isArray(c?.longSizes) && c.longSizes.length) setLongSizes(c.longSizes);
            if (c?.longItems) setLongItems(String(c.longItems));
            if (c?.concurrency) setConcurrency(String(c.concurrency));
          }
          // A finished run's label belongs to that run; a new run starts blank.
          setLabel(current.status === "running" ? (c?.label ?? "") : "");
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
  useEffect(() => {
    if (open) refreshFleet();
  }, [open, refreshFleet]);
  // WP4: a compare target may be on another unit; the fleet list says which.
  const compareSparkOf = useCallback(
    (id: string) => fleetRuns.find((r) => r.benchId === id)?.sparkId ?? sparkId,
    [fleetRuns, sparkId]
  );
  // WP4: a finished run defaults its comparison to the pinned reference of its model family.
  useEffect(() => {
    if (!job || job.status === "running" || compareId || autoRefFor.current === job.benchId) return;
    const ref = references[qualityFamilyKey(job.config.modelId)];
    if (!ref || ref.benchId === job.benchId) return;
    autoRefFor.current = job.benchId;
    setCompareId(ref.benchId);
  }, [job, compareId, references]);
  // Load the full run picked in "compare with".
  useEffect(() => {
    if (!compareId) {
      setCompareJob(null);
      return;
    }
    let cancelled = false;
    void getQualityBench(compareSparkOf(compareId), compareId)
      .then((j) => {
        if (!cancelled) setCompareJob(j);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        // A deleted run can still be the pinned reference of its family: drop it and say so,
        // instead of surfacing the raw 404 and keeping the dead target selected.
        if (err.message === "Benchmark not found") {
          setCompareId("");
          setError(t("quality.compareGone"));
          return;
        }
        setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [sparkId, compareId, compareSparkOf, t]);

  // Only the run picked in "compare with" counts (a stale compareJob must not leak into the card or text).
  const activeCompare = compareJob && compareJob.benchId === compareId ? compareJob : null;
  const compareRows = useMemo(
    () => (job && activeCompare ? compareQualityRuns(job, activeCompare) : []),
    [job, activeCompare]
  );
  const comparable = useMemo(() => checkQualityComparable(job, activeCompare), [job, activeCompare]);

  // Same rule as the server (src/shared/contextFit.js): 1.2x headroom plus the reply budget.
  const sizeFits = (n: number) => qualityLongFitsContext(n, contextLength);
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
      void listQualityBench(sparkId, benchPort, scopeRef.current)
        .then((data) => {
          applyHistory(data.history);
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
        noiseFloor,
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

  const handlePauseResume = async () => {
    if (!job || job.status !== "running") return;
    try {
      const j = job.paused ? await resumeQualityBench(sparkId, job.benchId) : await pauseQualityBench(sparkId, job.benchId);
      setJob(j);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** Relaunch a finished run from its saved rows; the server answers with the live job. */
  const handleResumeRun = async () => {
    if (!job || job.status === "running" || !job.resumable || startLockRef.current) return;
    startLockRef.current = true;
    setStarting(true);
    setError(null);
    try {
      const started = await resumeQualityBench(sparkId, job.benchId);
      setJob(started);
      setCompareId("");
      startPolling(started.benchId);
      if (isPage) refreshHistory();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      startLockRef.current = false;
      setStarting(false);
    }
  };

  const handleNewRun = () => {
    stopPoll();
    setJob(null);
    setError(null);
    setCompareId("");
  };

  const clearLabel = historyScope === "all" ? "Clear all ports" : `Clear port ${historyScope}`;
  const clearTitle =
    historyScope === "all"
      ? "Clear every saved quality run on this unit, on all LLM ports"
      : `Clear the saved quality runs of port ${historyScope} only`;

  const handleClear = async () => {
    if (!job || job.status === "running") return;
    setError(null);
    try {
      await clearQualityBenchHistory(sparkId, historyScope === "all" ? undefined : historyScope);
      stopPoll();
      setJob(null);
      setCompareId("");
      if (historyScope === "all") setHistory([]);
      else refreshHistory();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** Remove one saved run, keeping the rest of the history (and the other ports) intact. */
  const handleDelete = async (id: string) => {
    if (!confirm("Delete this run from the history? This cannot be undone.")) return;
    setError(null);
    try {
      await deleteQualityBenchRun(sparkId, id);
      if (job?.benchId === id) {
        stopPoll();
        setJob(null);
        setCompareId("");
      }
      refreshHistory();
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
  const scopePorts = [...new Set([...seenPorts, benchPort, ...(historyScope === "all" ? [] : [historyScope])])].sort((a, b) => a - b);
  const compareChoices = history.filter((h) => h.benchId !== job?.benchId);
  // WP4: runs on other units, the pinned reference of this run's family, and the pin action.
  const familyKey = qualityFamilyKey(job?.config.modelId);
  const pinnedRef = familyKey ? references[familyKey] : undefined;
  const isReference = Boolean(job && pinnedRef && pinnedRef.benchId === job.benchId);
  const fleetChoices = fleetRuns.filter((r) => r.benchId !== job?.benchId && (r.results?.itemCount ?? 0) > 0);
  const handlePin = async () => {
    if (!job || job.status === "running") return;
    try {
      if (isReference && familyKey) await clearQualityReference(familyKey);
      else await setQualityReference(sparkId, job.benchId);
      refreshFleet();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const pinButton =
    job && job.status !== "running" && (job.results?.items?.length ?? 0) > 0 ? (
      <button type="button" className="btn btn--sm btn--ghost" onClick={() => void handlePin()} title={t("quality.pinTitle")}>
        {isReference ? t("quality.unpinReference") : t("quality.pinReference")}
      </button>
    ) : null;
  const hasItems = (job?.results?.items?.length ?? 0) > 0;

  const pauseLabel = job?.paused ? t("quality.resumeRun") : t("quality.pauseRun");
  const pauseTitle = job?.paused ? t("quality.resumeTitle") : t("quality.pauseTitle");
  const runControl = isRunning ? (
    <>
      <button type="button" className="btn" onClick={() => void handlePauseResume()} title={pauseTitle}>
        {pauseLabel}
      </button>
      <button type="button" className="btn" onClick={() => void handleCancel()}>
        {t("quality.cancelRun")}
      </button>
    </>
  ) : (
    <>
      {job?.resumable ? (
        <button type="button" className="btn btn--primary" onClick={() => void handleResumeRun()} disabled={starting} title={t("quality.resumeRunTitle")}>
          {starting ? "Starting…" : t("quality.resumeSaved", { count: job.progress.done })}
        </button>
      ) : null}
      <button type="button" className={`btn ${job?.resumable ? "" : "btn--primary"}`} onClick={() => void handleStart()} disabled={starting || categories.length === 0}>
        {starting ? "Starting…" : "Run quality bench"}
      </button>
    </>
  );

  const configNode = (
    <>
          {showConfig && (
            <section className="bench-sheet__section">
              <div className="bench-field">
                <div className="bench-field__head">
                  <div className="qsel-head">
                    <h3 className="bench-sheet__section-title">{t("quality.categories")}</h3>
                    <div className="qsel-bulk" role="group" aria-label={t("quality.selectCategories")}>
                      <button
                        type="button"
                        className="qsel-bulk__btn"
                        disabled={starting || isRunning}
                        onClick={() => setCategories([...QUALITY_DEFAULT_CATEGORIES])}
                      >
                        {t("quality.defaults")}
                      </button>
                      <button
                        type="button"
                        className="qsel-bulk__btn"
                        disabled={starting || isRunning}
                        onClick={() => setCategories([...QUALITY_CATEGORIES])}
                      >
                        {t("quality.selectAll")}
                      </button>
                      <button
                        type="button"
                        className="qsel-bulk__btn"
                        disabled={starting || isRunning}
                        title={t("quality.quantPresetTitle")}
                        onClick={() => {
                          // WP4 fidelity preset: the categories that see a quantisation, serially, no batching noise.
                          setCategories(["arith", "track", "long", "fidelity", "divergence"]);
                          setConcurrency("1");
                          setNoiseFloor(false);
                          if (!label.trim()) setLabel("quant check");
                        }}
                      >
                        {t("quality.quantPreset")}
                      </button>
                    </div>
                  </div>
                  <p className="bench-sheet__hint">
                    {t("quality.suiteHint")}
                  </p>
                </div>
                <div className="qsel" role="group" aria-label={t("quality.categories")}>
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
                              {!QUALITY_DEFAULT_CATEGORIES.includes(c) ? <em>{t("quality.optional")}</em> : null}
                            </span>
                            <span className="qsel-card__hint">{CATEGORY_HINTS[c]}</span>
                            <span className="qsel-card__meta">
                              {c === "long" ? `${Number(longItems) || 0} per size` : `${items} items`}
                              {THINKING_CATEGORIES.includes(c) ? <small>{t("quality.thinkingOn")}</small> : null}
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
                          {infoOpen ? t("quality.hideDetails") : t("quality.howItWorks")}
                        </button>
                      </div>
                    );
                  })}
                </div>
                {infoFor ? (
                  <div className="q-info" id="q-info-panel" ref={infoRef} role="region" aria-label={t("quality.howTitle", { category: QUALITY_CATEGORY_LABELS[infoFor] })}>
                    <div className="q-info__head">
                      <b>{t("quality.howTitle", { category: QUALITY_CATEGORY_LABELS[infoFor] })}</b>
                      <button type="button" className="btn btn--sm btn--ghost" onClick={() => setInfoFor(null)}>
                        {t("dialog.close")}
                      </button>
                    </div>
                    <dl className="q-info__grid">
                      <div>
                        <dt>{t("quality.measures")}</dt>
                        <dd>{QUALITY_CATEGORY_INFO[infoFor].measures}</dd>
                      </div>
                      <div>
                        <dt>{t("quality.sends")}</dt>
                        <dd>{QUALITY_CATEGORY_INFO[infoFor].how}</dd>
                      </div>
                      <div>
                        <dt>{t("quality.scored")}</dt>
                        <dd>{QUALITY_CATEGORY_INFO[infoFor].scoring}</dd>
                      </div>
                      <div>
                        <dt>{t("quality.settings")}</dt>
                        <dd>{QUALITY_CATEGORY_INFO[infoFor].settings}</dd>
                      </div>
                      <div className="q-info__wide">
                        <dt>{t("quality.example")}</dt>
                        <dd className="q-info__example">{QUALITY_CATEGORY_INFO[infoFor].example}</dd>
                      </div>
                    </dl>
                  </div>
                ) : null}
              </div>

              {categories.includes("long") && (
                <div className="bench-field">
                  <div className="bench-field__head">
                    <h3 className="bench-sheet__section-title">{t("quality.longSizes")}</h3>
                    <p className="bench-sheet__hint">
                      {contextLength != null && contextLength > 0
                        ? `Model context ${formatContextSize(contextLength)} — larger sizes are disabled.`
                        : "Large sizes can take many minutes per item."}
                    </p>
                  </div>
                  <div className="bench-conc-grid" role="group" aria-label={t("quality.longSizes")}>
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
                    {t("quality.itemsPerSize")}
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
                  <b>{t("quality.selected", { count: categories.length })}</b>
                  <span>{t("quality.aboutRequests", { count: categories
                    .reduce((n, c) => n + (c === "long" ? longSizes.length * (Number(longItems) || 0) : (CATEGORY_ITEMS[c] ?? 0)), 0)
                    .toLocaleString() })}</span>
                </div>
                <label className="qrun__field">
                  <span>{t("quality.concurrency")}</span>
                  <input
                    type="number"
                    min={1}
                    max={QUALITY_MAX_CONCURRENCY}
                    inputMode="numeric"
                    value={concurrency}
                    disabled={starting || isRunning}
                    onChange={(e) => setConcurrency(e.target.value)}
                    className="bench-input"
                    title={t("quality.concurrencyTitle")}
                  />
                </label>
                <label className="qrun__field qrun__check" title={t("quality.noiseFloorTitle")}>
                  <input
                    type="checkbox"
                    checked={noiseFloor}
                    disabled={starting || isRunning}
                    onChange={(e) => setNoiseFloor(e.target.checked)}
                  />
                  <span>{t("quality.noiseFloor")}</span>
                </label>
                <label className="qrun__field qrun__field--grow">
                  <span>{t("quality.runLabel")}</span>
                  <input
                    type="text"
                    value={label}
                    maxLength={QUALITY_LABEL_MAX}
                    disabled={starting || isRunning}
                    placeholder={t("quality.runLabelPlaceholder")}
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
                  <span className="bench-progress__status" role="status" aria-live="polite">
                    {job.paused ? t("dialog.paused") : t("dialog.running")}
                    {job.progress.currentCategory
                      ? ` · ${QUALITY_CATEGORY_LABELS[job.progress.currentCategory]} ${job.progress.categoryDone}/${job.progress.categoryTotal}`
                      : ""}
                  </span>
                  <span className="bench-progress__meta">
                    {job.progress.done}/{job.progress.total || "…"} · {formatDuration(job.durationMs)}
                  </span>
                </div>
                <div
                  className="bench-progress__track"
                  role="progressbar"
                  aria-label={t("quality.progressAria")}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.min(100, progressPct)}
                  aria-valuetext={`${job.progress.done} of ${job.progress.total || "?"} items`}
                >
                  <div className="bench-progress__fill" style={{ width: `${Math.min(100, progressPct)}%` }} />
                </div>
                {job.progress.message ? <p className="bench-sheet__hint">{job.progress.message}</p> : null}
              </div>
              <RunWarnings job={job} />
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

              <EngineLine job={job} />
              <RunWarnings job={job} />

              {hasItems && (compareChoices.length > 0 || fleetChoices.length > 0) && (
                <label className="q-pick">
                  <span>{t("quality.compareWith")}</span>
                  <select value={compareId} onChange={(e) => setCompareId(e.target.value)}>
                    <option value="">{t("quality.pickRun")}</option>
                    {compareChoices.map((h) => (
                      <option key={h.benchId} value={h.benchId}>
                        {runLabel(h)}
                        {pinnedRef?.benchId === h.benchId ? ` · ${t("quality.referenceTag")}` : ""}
                      </option>
                    ))}
                    {fleetChoices.length > 0 && (
                      <optgroup label={t("quality.otherUnits")}>
                        {fleetChoices.map((h) => (
                          <option key={h.benchId} value={h.benchId}>
                            {h.unit?.name || h.sparkId} · {runLabel(h)}
                            {pinnedRef?.benchId === h.benchId ? ` · ${t("quality.referenceTag")}` : ""}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                  {isReference ? <span className="q-ref-badge">{t("quality.referenceTag")}</span> : null}
                </label>
              )}

              {(() => {
                const cmp = activeCompare;
                return (
                  <>
                    <div className="q-cmp">
                      <ScoreCard job={job} compareJob={cmp && comparable.ok ? cmp : null} compareRows={cmp ? compareRows : []} />
                      <CategoryBars job={job} compareJob={cmp && comparable.ok ? cmp : null} compareRows={cmp ? compareRows : []} />
                    </div>
                    {cmp && !comparable.ok && <p className="bench-sheet__error">{comparable.reason}</p>}
                    {cmp && comparable.ok && <PlainVerdictCard job={job} compareJob={cmp} compareRows={compareRows} fidelity={fidelityCmp} />}
                    {cmp && comparable.ok && <ComparisonHeader job={job} compareJob={cmp} />}
                    {cmp && comparable.ok && <QuantDashboard job={job} compareJob={cmp} compareRows={compareRows} fidelity={fidelityCmp} />}
                    {cmp && comparable.ok && compareRows.length === 0 && (
                      <p className="bench-sheet__hint">{t("quality.noSharedItems")}</p>
                    )}
                    {cmp && compareRows.length > 0 && <DisagreementTable job={job} compareJob={cmp} />}
                  </>
                );
              })()}

              <FidelityCard job={job} compareJob={activeCompare && comparable.ok ? activeCompare : null} sparkId={sparkId} onCompare={setFidelityCmp} />
              <DivergenceCard job={job} compareJob={activeCompare && comparable.ok ? activeCompare : null} />
              <NoiseFloor job={job} />

              {job.results.skippedLongSizes?.length > 0 && (
                <p className="bench-sheet__hint">
                  {t("quality.skippedLong", { sizes: job.results.skippedLongSizes.map(formatContextSize).join(", ") })}
                </p>
              )}

              {hasItems && <ItemTable job={job} />}

              <p className="bench-legend">
                {t("quality.legendV2")}
              </p>
            </section>
          )}
    </>
  );

  const copyButton =
    job && hasItems ? (
      <BenchCopyButton
        text={buildShareText(job, activeCompare, compareRows)}
        buildCard={() =>
          buildQualityShareCard(job, activeCompare, {
            llmPort: benchPort,
            modelId: job.config.modelId || modelId,
            sparkName,
            engine,
            posture,
            remoteHost: remoteTarget?.host ?? null,
            labels: shareCardLabels,
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
            {loadingLast && !job && <p className="bench-sheet__hint">{t("dialog.loadingLast")}</p>}
            {configNode}
          </>
        }
        runBar={null}
      >
        {error && <p className="bench-sheet__error">{error}</p>}
        {isRunning && <PageCard title={t("dialog.progress")}>{progressNode}</PageCard>}
        {showResults && (
          <PageCard
            title={t("dialog.results")}
            tools={
              <>
                {pinButton}
                {copyButton}
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => void handleClear()}
                  title={clearTitle}
                >
                  {clearLabel}
                </button>
              </>
            }
          >
            {resultsNode}
          </PageCard>
        )}
        {!job && !loadingLast && (
          <PageEmpty title={t("dialog.noRuns")}>
            {t("quality.emptyBody")}
          </PageEmpty>
        )}
        {(history.length > 0 || historyScope !== "all") && (
          <PageCard
            title={t("dialog.history", { count: history.length })}
            tools={
              <label className="q-pick">
                <span>{t("quality.show")}</span>
                <select
                  value={String(historyScope)}
                  onChange={(e) => setHistoryScope(e.target.value === "all" ? "all" : Number(e.target.value))}
                  aria-label={t("quality.historyScope")}
                >
                  <option value="all">{t("quality.allPorts")}</option>
                  {scopePorts.map((p) => (
                    <option key={p} value={p}>
                      {t("quality.port", { port: p })}
                      {p === benchPort ? " (selected)" : ""}
                    </option>
                  ))}
                </select>
              </label>
            }
          >
            <HistoryTable
              rows={history.map((entry) => qualityHistoryRow(entry, historyLabels))}
              activeId={job?.benchId ?? null}
              labelHeader={t("quality.label")}
              onView={handleView}
              onCompare={showResults && hasItems ? setCompareId : undefined}
              compareId={compareId}
              onDelete={(id) => void handleDelete(id)}
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
        aria-label={t("dialog.closeDialog")}
        onClick={() => {
          if (!isRunning) onClose();
        }}
      />

      <div className="bench-sheet" role="dialog" aria-modal="true" aria-labelledby="quality-bench-title">
        <header className="bench-sheet__header">
          <div className="bench-sheet__header-text">
            <h2 id="quality-bench-title" className="bench-sheet__title">
              {t("quality.title")}
            </h2>
            <p className="bench-sheet__subtitle">
              {remoteTarget ? formatLlmBaseUrl(remoteTarget) : `Port ${llmPort}`}
              {(job?.config.modelId || modelId) ? ` · ${job?.config.modelId || modelId}` : ""}
              {job?.config.label ? ` · ${job.config.label}` : ""}
            </p>
          </div>
          <BenchSwitcher active="quality" onSwitch={onSwitchBench} disabled={isRunning || starting} />
          <button type="button" className="bench-sheet__close" onClick={onClose} aria-label={t("dialog.close")}>
            <XIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="bench-sheet__body">
          {loadingLast && !job && <p className="bench-sheet__hint">{t("dialog.loadingLast")}</p>}

          {configNode}

          {error && <p className="bench-sheet__error">{error}</p>}

          {progressNode}

          {resultsNode}
        </div>

        <footer className="bench-sheet__footer">
          {job?.status === "running" ? (
            <>
              <button type="button" className="bench-btn bench-btn--ghost" onClick={() => void handlePauseResume()} title={pauseTitle}>
                {pauseLabel}
              </button>
              <button type="button" className="bench-btn bench-btn--ghost" onClick={() => void handleCancel()}>
                {t("dialog.cancel")}
              </button>
            </>
          ) : job ? (
            <>
              {job.resumable && (
                <button type="button" className="bench-btn bench-btn--primary" onClick={() => void handleResumeRun()} disabled={starting} title={t("quality.resumeRunTitle")}>
                  {t("quality.resumeSaved", { count: job.progress.done })}
                </button>
              )}
              {hasItems && (
                <button type="button" className="bench-btn bench-btn--ghost" onClick={() => void handlePin()} title={t("quality.pinTitle")}>
                  {isReference ? t("quality.unpinReference") : t("quality.pinReference")}
                </button>
              )}
              <button
                type="button"
                className="bench-btn bench-btn--ghost"
                onClick={() => void handleDelete(job.benchId)}
                title={t("quality.deleteTitle")}
              >
                {t("quality.deleteRun")}
              </button>
              <button
                type="button"
                className="bench-btn bench-btn--ghost"
                onClick={() => void handleClear()}
                title={clearTitle}
              >
                {clearLabel}
              </button>
              {hasItems && (
                <BenchCopyButton
                  text={buildShareText(job, activeCompare, compareRows)}
                  buildCard={() =>
                    buildQualityShareCard(job, activeCompare, {
                      llmPort: benchPort,
                      modelId: job.config.modelId || modelId,
                      sparkName,
                      engine,
                      posture,
                      remoteHost: remoteTarget?.host ?? null,
                      labels: shareCardLabels,
                    })
                  }
                  kind="quality"
                  shareImage
                  onError={setError}
                />
              )}
              <button type="button" className="bench-btn bench-btn--ghost" onClick={onClose}>
                {t("dialog.done")}
              </button>
              <button type="button" className="bench-btn bench-btn--primary" onClick={handleNewRun}>
                {t("dialog.runAgain")}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="bench-btn bench-btn--ghost" onClick={onClose}>
                {t("dialog.close")}
              </button>
              <button
                type="button"
                className="bench-btn bench-btn--primary"
                onClick={() => void handleStart()}
                disabled={starting || categories.length === 0}
              >
                {starting ? t("dialog.starting") : t("quality.run")}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
