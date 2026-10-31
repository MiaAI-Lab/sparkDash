/**
 * Benchmark share card — the image behind "Copy image".
 *
 * Hand-painted on a canvas instead of screenshotting the DOM: the dashboard
 * ships without UI dependencies, and a card laid out for a timeline (fixed
 * width, one row per level, no modal chrome) reads better than a capture of a
 * scrolling dialog with its Clear/New run/Done buttons. The model is a pure
 * function of the bench job, so every number and label is unit-testable
 * without a real canvas context.
 */
import { decodeBenchSamplingLabel } from "./decodeSampling";
import { formatDuration } from "../../shared/formatDuration";
import { decodeBenchTypeLabel } from "../../shared/llmPrompts.js";
import { backendLabel } from "../../shared/llmBackends.js";
import { formatContextSize } from "../../shared/prefillBench.js";
import { QUALITY_CATEGORIES, QUALITY_CATEGORY_LABELS, checkQualityComparable } from "../../shared/qualityBench.js";
import type { DecodeBenchJob, PrefillBenchJob, QualityBenchJob, ToolEvalRun } from "../../api/types";
import { compareToolResults, configCaveats, type Delta as CompareDelta } from "../bench/tooleval/compare";
import { scoreTier } from "../bench/tooleval/format";
import { CATEGORY_NAMES, type NormToolResult } from "../bench/tooleval/normalize";
import type { ToolEvalPresentation } from "../bench/tooleval/presentation";

/** Fixed width; height grows with the number of result rows. */
export const SHARE_CARD_WIDTH = 1200;
/** A one- or two-row run still exports as a 16:9 card, which crops well on X. */
export const SHARE_CARD_MIN_HEIGHT = 675;
/** Canvas element scale — 2× keeps the PNG crisp when X scales it down. */
export const SHARE_CARD_SCALE = 2;

export type ShareCardTone = "ok" | "warn" | "bad" | "muted" | "accent";

export interface ShareCardRow {
  /** Concurrency (`×1`) or context size (`32k`). */
  load: string;
  /** Facts next to the badge — TTFT, stream count, measured prompt tokens. */
  detail: string;
  /** Headline number: aggregate decode tok/s, or prefill tok/s. */
  primary: string;
  /** Supporting number: per-stream decode tok/s, or TTFT. */
  secondary: string;
  primaryUnit: string;
  secondaryUnit: string;
  tone: ShareCardTone;
}

/** Small pills on the card, mirroring the LLM panel's badges. */
export interface ShareCardChip {
  label: string;
  tone: ShareCardTone;
}

/** One category tile on the Quality card. */
export interface ShareCardTile {
  label: string;
  /** Pass rate 0–100, or null when the category has no score. */
  pct: number | null;
  /** `133/150 items`. */
  detail: string;
  /** Points against the compared run, when there is one. */
  delta: number | null;
}

/** Quality card payload: an overall ring plus a grid of category tiles (replaces the row table). */
export interface ShareCardQuality {
  overall: number | null;
  /** Model under test (large, next to the ring); empty when unknown. */
  modelName: string;
  /** `Port 8888` or the remote host. */
  target: string;
  /** The run's label, e.g. `fp8 KV`; empty when none. */
  runLabel: string;
  /** One-line summary under the model, e.g. `6 categories · 755 items · 41m 54s`. */
  summary: string;
  tiles: ShareCardTile[];
}

/** One category tile on the Tool Eval card. */
export interface ShareCardToolEvalCategory {
  /** The tool's category letter (A–P). */
  id: string;
  name: string;
  /** Score 0–100, or null when the category has none. */
  pct: number | null;
  /** `18/20 pts`, or empty when the result carries no points. */
  detail: string;
}

/** A labelled score next to the ring (Deployability, Responsiveness). */
export interface ShareCardToolEvalStat {
  label: string;
  value: string;
  /** `/100`, or empty. */
  suffix: string;
  tone: ShareCardTone;
}

/** Tool Eval card payload: a score hero, an outcome strip, optional safety warnings and a category grid. */
export interface ShareCardToolEval {
  /** Final score 0–100, or null when the run produced none. */
  score: number | null;
  /** Rating word under the stars (`Good`); empty when unrated. */
  rating: string;
  /** 0–5 filled stars. */
  stars: number;
  tone: ShareCardTone;
  /** Model under test (large, next to the ring); empty when unknown. */
  modelName: string;
  /** `llama.cpp · tool-eval-bench 1.4.0`. */
  subline: string;
  stats: ShareCardToolEvalStat[];
  counts: { pass: number; partial: number; fail: number; other: number; total: number };
  /** `65 scenarios · 12m 03s`. */
  summary: string;
  /** First few warnings, as the tool words them; `safetyTotal` counts all of them. */
  safety: string[];
  safetyTotal: number;
  categories: ShareCardToolEvalCategory[];
}

/** One run's column in the Tool Eval comparison hero. */
export interface ShareCardCompareSide {
  /** `RUN A · 2026-10-14` — the run's label when it has one. */
  heading: string;
  model: string;
  score: number | null;
  rating: string;
  tone: ShareCardTone;
  /** `52 pass · 11 partial`; empty when the result has no scenarios. */
  summary: string;
  safety: number;
}

/** A metric tile on the comparison card: A → B and the change. */
export interface ShareCardCompareStat {
  label: string;
  a: string;
  b: string;
  delta: string;
  tone: ShareCardTone;
}

export interface ShareCardCompareCategory {
  id: string;
  name: string;
  a: number | null;
  b: number | null;
  delta: string;
  tone: ShareCardTone;
}

/** Tool Eval comparison payload: two score columns, metric tiles, scenario changes and a per-category list. */
export interface ShareCardToolEvalCompare {
  a: ShareCardCompareSide;
  b: ShareCardCompareSide;
  scoreDelta: string;
  scoreDeltaTone: ShareCardTone;
  stats: ShareCardCompareStat[];
  /** Scenario status changes B vs A; null when either result has no per-scenario data. */
  changes: { improved: number; regressed: number; unchanged: number } | null;
  categories: ShareCardCompareCategory[];
  /** First reason the runs are not directly comparable (plus a count of the rest); empty when they are. */
  caveat: string;
}

export interface ShareCardModel {
  brand: string;
  /** Unit name, right-aligned on the brand line. Empty when unknown. */
  host: string;
  title: string;
  subtitle: string;
  /** Engine + exposure, as the LLM panel shows them. Empty when unknown. */
  chips: ShareCardChip[];
  status: { label: string; tone: ShareCardTone };
  meta: string;
  columns: { load: string; primary: string; secondary: string };
  rows: ShareCardRow[];
  legend: string;
  footer: string;
  /** Epoch ms the card was produced — footer stamp and filename. */
  generatedAt: number;
  /** Optional caller-owned UI copy; absent preserves the historic English card. */
  labels?: ShareCardLabels;
  /** Set for the Quality card: painted as a ring and tiles instead of the row table. */
  quality?: ShareCardQuality;
  /** Set for the Tool Eval card: painted as a score hero, outcome strip and category grid. */
  toolEval?: ShareCardToolEval;
  /** Set for the Tool Eval comparison card: two runs side by side. */
  toolEvalCompare?: ShareCardToolEvalCompare;
}

export interface ShareCardSource {
  llmPort: number;
  modelId: string | null;
  /** Backend id from the probe (`tensorfold`, `sglang`, …). */
  engine?: string | null;
  /** Probe exposure/auth posture, as shown on the LLM panel. */
  posture?: { label: string; level: "ok" | "warn" | "danger" } | null;
  labels?: BenchmarkShareCardLabels & Partial<ShareCardLabels>;
  /** Unit display name, when the caller knows it. */
  sparkName?: string | null;
  /** Remote bench host (hostname / URL) instead of this Spark's LAN path. */
  remoteHost?: string | null;
}

/** `2026-09-17` in local time. */
export function shareCardDate(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `sparkdash-decode-spark-38bd-2026-09-17.png` */
export function shareCardFileName(model: ShareCardModel, kind: "decode" | "prefill" | "quality" | "tool-eval" | "tool-eval-compare"): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);
  return `sparkdash-${kind}-${slug(model.host) || "spark"}-${shareCardDate(model.generatedAt)}.png`;
}

export interface BenchmarkShareCardLabels {
  completed: string;
  running: string;
  failed: string;
  cancelled: string;
  decodeTitle: string;
  prefillTitle: string;
  qualityTitle: string;
  load: string;
  aggregate: string;
  stream: string;
  context: string;
  prefill: string;
  score: string;
  category: string;
  versusOther: string;
}

/** Labels and small formatters for all hand-painted card chrome. Raw model/rating/safety text stays outside this contract. */
export interface ShareCardLabels extends BenchmarkShareCardLabels {
  qualityBenchmark: string;
  overall: string;
  unknownModel: string;
  same: string;
  pts: string;
  toolEvalBench: string;
  toolEvalComparison: string;
  score: string;
  category: string;
  scenarioOutcomes: string;
  safetyWarnings: (count: number) => string;
  more: (count: number) => string;
  pass: string;
  fail: string;
  partial: string;
  other: string;
  scoreChange: string;
  runBVsA: string;
  scenarioChanges: string;
  better: string;
  worse: string;
  unchanged: (count: number) => string;
  runA: string;
  runB: string;
  change: string;
  decodeDetail: (ttft: string, ok: number, total: number) => string;
  decodeMeta: (prompt: string, tokens: string | number, sampling: string, context: string, concurrency: string, duration: string) => string;
  decodeLegend: string;
  prefillFailed: string;
  prefillDetail: (ttft: string, tokens: string, flags: string) => string;
  samples: (actual: number, requested: number) => string;
  lowConfidence: string;
  prefillMeta: (contexts: string, duration: string) => string;
  prefillLegend: string;
  qualityDetail: (passed: number, scored: number, errors: number) => string;
  qualitySummary: (categories: number, items: string, duration: string) => string;
  qualityMeta: (overall: string, runLabel: string, duration: string) => string;
  qualityLegend: string;
  presentation?: ToolEvalPresentation;
  categoryName: (id: string, fallback: string) => string;
  deployability: string;
  responsiveness: string;
  scenariosPassed: string;
  points: (value: string, max: string) => string;
  scenarioSummary: (total: string, duration: string) => string;
  safetyChip: (count: number) => string;
  scoreMeta: (score: string, rating: string, summary: string) => string;
  scoreLegend: string;
  runHeading: (tag: "A" | "B", spark: string, label: string) => string;
  sideSummary: (pass: number, partial: number) => string;
  differentSetup: string;
  sameSetup: string;
  comparisonMeta: (score: string, a: string, b: string) => string;
  comparisonLegend: string;
  caveat: (text: string, extra: number) => string;
}

export const DEFAULT_SHARE_CARD_LABELS: ShareCardLabels = {
  completed: "COMPLETED", running: "RUNNING", failed: "FAILED", cancelled: "CANCELLED",
  decodeTitle: "Decode benchmark", prefillTitle: "Prefill benchmark", qualityTitle: "Quality benchmark",
  load: "Load", aggregate: "Aggregate", stream: "Stream", context: "Context", prefill: "Prefill", versusOther: "vs other",
  qualityBenchmark: "Quality benchmark", overall: "OVERALL", unknownModel: "Unknown model", same: "same", pts: "pts",
  toolEvalBench: "Tool Eval Bench", toolEvalComparison: "Tool Eval Comparison", score: "SCORE", category: "CATEGORY",
  scenarioOutcomes: "SCENARIO OUTCOMES", safetyWarnings: (count) => `SAFETY WARNINGS (${count}) · the rating is capped`, more: (count) => `+${count} more`,
  pass: "pass", fail: "fail", partial: "partial", other: "other", scoreChange: "SCORE CHANGE", runBVsA: "run B vs run A",
  scenarioChanges: "SCENARIO CHANGES", better: "better", worse: "worse", unchanged: (count) => `${count} unchanged`, runA: "RUN A", runB: "RUN B", change: "CHANGE",
  decodeDetail: (ttft, ok, total) => `TTFT ${ttft} · ${ok}/${total} streams`,
  decodeMeta: (prompt, tokens, sampling, context, concurrency, duration) => `${prompt} · ${tokens} tok · ${sampling}${context ? ` · ${context} start ctx` : ""} · ${concurrency || "—"}${duration ? ` · ${duration}` : ""}`,
  decodeLegend: "Aggregate — total decode tok/s across all concurrent streams. Stream — per-stream average decode.",
  prefillFailed: "No prefill rate was measured",
  prefillDetail: (ttft, tokens, flags) => `TTFT ${ttft} · ${tokens}${flags ? ` · ${flags}` : ""}`,
  samples: (actual, requested) => `${actual}/${requested} samples`, lowConfidence: "low confidence",
  prefillMeta: (contexts, duration) => `${contexts || "—"}${duration ? ` · ${duration}` : ""}`,
  prefillLegend: "Prefill — server prompt timing, else tokens ÷ (TTFT − request overhead), cache hits excluded. TTFT — time to first token. Median-rate sample.",
  qualityDetail: (passed, scored, errors) => `${passed}/${scored} items${errors > 0 ? ` · ${errors} error${errors === 1 ? "" : "s"}` : ""}`,
  qualitySummary: (categories, items, duration) => `${categories} ${categories === 1 ? "category" : "categories"} · ${items} items${duration ? ` · ${duration}` : ""}`,
  qualityMeta: (overall, runLabel, duration) => `Overall ${overall}${runLabel ? ` · ${runLabel}` : ""}${duration ? ` · ${duration}` : ""}`,
  qualityLegend: "Score — share of items passed. Temperature 0, fixed seed.",
  categoryName: (_id, fallback) => fallback, deployability: "Deployability", responsiveness: "Responsiveness", scenariosPassed: "Scenarios passed",
  points: (value, max) => `${value}/${max} pts`, scenarioSummary: (total, duration) => `${total} ${total === "1" ? "scenario" : "scenarios"}${duration ? ` · ${duration}` : ""}`,
  safetyChip: (count) => `${count} safety ${count === 1 ? "warning" : "warnings"}`, scoreMeta: (score, rating, summary) => `Score ${score}${rating ? ` · ${rating}` : ""} · ${summary}`,
  scoreLegend: "Score 0–100. Tiers: 90+ Excellent, 75+ Good, 60+ Adequate, 40+ Weak, else Poor.",
  runHeading: (tag, spark, label) => `RUN ${tag} · ${spark ? `${spark} · ` : ""}${label}`, sideSummary: (pass, partial) => `${pass} pass · ${partial} partial`,
  differentSetup: "DIFFERENT SETUP", sameSetup: "SAME SETUP", comparisonMeta: (score, a, b) => `Score ${score} · ${a || "run A"} → ${b || "run B"}`,
  comparisonLegend: "Run B against run A, the baseline. Green is better, red is worse. Scores 0–100.", caveat: (text, extra) => `${text}${extra > 0 ? ` (+${extra} more)` : ""}`,
};

const DEFAULT_BENCHMARK_SHARE_CARD_LABELS: BenchmarkShareCardLabels = {
  completed: "COMPLETED", running: "RUNNING", failed: "FAILED", cancelled: "CANCELLED",
  decodeTitle: "Decode benchmark", prefillTitle: "Prefill benchmark", qualityTitle: "Quality benchmark",
  load: "Load", aggregate: "Aggregate", stream: "Stream", context: "Context", prefill: "Prefill", score: "Score", category: "Category", versusOther: "vs other",
};

export function shareCardStatus(
  status: DecodeBenchJob["status"] | PrefillBenchJob["status"] | QualityBenchJob["status"],
  labels: BenchmarkShareCardLabels = DEFAULT_BENCHMARK_SHARE_CARD_LABELS,
): { label: string; tone: ShareCardTone } {
  switch (status) {
    case "completed":
      return { label: labels.completed, tone: "ok" };
    case "running":
      return { label: labels.running, tone: "warn" };
    case "failed":
      return { label: labels.failed, tone: "bad" };
    case "cancelled":
      return { label: labels.cancelled, tone: "muted" };
    default:
      return { label: String(status).toUpperCase(), tone: "muted" };
  }
}

/** Same shapes the dialogs show, so the card reads as the same run. */
function formatTtft(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

/**
 * The engine and exposure pills, in the panel's own words and colours: the
 * backend label in the accent tone, the posture in its level's tone.
 */
export function shareCardChips(src: ShareCardSource): ShareCardChip[] {
  const chips: ShareCardChip[] = [];
  const engine = backendLabel(src.engine);
  if (engine) chips.push({ label: engine, tone: "accent" });
  if (src.posture?.label) {
    chips.push({
      label: src.posture.label,
      tone: src.posture.level === "ok" ? "ok" : src.posture.level === "warn" ? "warn" : "bad",
    });
  }
  return chips;
}

/** `Port 8888 · org/model`, or the remote host when the run used one. */
export function shareCardSubtitle(src: ShareCardSource): string {
  const target = src.remoteHost ? src.remoteHost : `Port ${src.llmPort}`;
  return src.modelId ? `${target} · ${src.modelId}` : target;
}

/**
 * Decode card — mirrors the dialog table: LOAD · AGGREGATE · STREAM, with TTFT
 * and the ok/total stream count as the row detail.
 */
export function buildDecodeShareCard(
  job: DecodeBenchJob,
  src: ShareCardSource,
  now: number = Date.now(),
): ShareCardModel {
  const labels = src.labels ?? DEFAULT_BENCHMARK_SHARE_CARD_LABELS;
  const painterLabels: ShareCardLabels = { ...DEFAULT_SHARE_CARD_LABELS, ...src.labels };
  const rows = job.results
    .slice()
    .sort((a, b) => a.concurrency - b.concurrency)
    .map<ShareCardRow>((r) => {
      const failed = r.totalDecodeTokens <= 0 && r.totalCompletionTokens <= 0;
      const streams = r.streamsOk + r.streamsFailed;
      const agg = r.aggregateDecodeTps > 0 ? r.aggregateDecodeTps : r.meanDecodeTps;
      return {
        load: `×${r.concurrency}`,
        detail: failed
          ? r.error || "failed"
          : painterLabels.decodeDetail(formatTtft(r.meanTtftMs), r.streamsOk, streams),
        primary: failed ? "—" : agg.toFixed(1),
        secondary: failed ? "—" : r.meanDecodeTps.toFixed(1),
        primaryUnit: "tok/s",
        secondaryUnit: "tok/s",
        tone: failed ? "bad" : "ok",
      };
    });

  const concurrencies = job.config?.concurrencies ?? [];
  return {
    brand: "sparkDash",
    host: src.sparkName || "",
    title: labels.decodeTitle,
    subtitle: shareCardSubtitle(src),
    chips: shareCardChips(src),
    status: shareCardStatus(job.status, labels),
    meta: painterLabels.decodeMeta(decodeBenchTypeLabel(job.config?.promptType), job.config?.maxTokens ?? "?", decodeBenchSamplingLabel(job.config), job.config?.contextTokens ? formatContextSize(job.config.contextTokens) : "", concurrencies.length ? `${concurrencies.join(", ")} conc` : "", job.durationMs != null ? formatDuration(job.durationMs) : ""),
    columns: { load: labels.load, primary: labels.aggregate, secondary: labels.stream },
    rows,
    legend: painterLabels.decodeLegend,
    footer: "github.com/MiaAI-Lab/sparkDash",
    generatedAt: now,
    labels: painterLabels,
  };
}

/**
 * Prefill card — LOAD · PREFILL · TTFT, with the measured prompt size as the
 * row detail, exactly like the prefill dialog.
 */
export function buildPrefillShareCard(
  job: PrefillBenchJob,
  src: ShareCardSource,
  now: number = Date.now(),
): ShareCardModel {
  const labels = src.labels ?? DEFAULT_BENCHMARK_SHARE_CARD_LABELS;
  const painterLabels: ShareCardLabels = { ...DEFAULT_SHARE_CARD_LABELS, ...src.labels };
  const rows = job.results
    .slice()
    .sort((a, b) => a.targetTokens - b.targetTokens)
    .map<ShareCardRow>((r) => {
      const failed = Boolean(r.error) || r.prefillTps <= 0;
      const partial = !failed && r.samples != null && r.samplesRequested != null && r.samples < r.samplesRequested;
      const flags = [partial ? painterLabels.samples(r.samples!, r.samplesRequested!) : null, !failed && r.lowConfidence ? painterLabels.lowConfidence : null].filter(Boolean);
      return {
        load: formatContextSize(r.targetTokens),
        detail: failed
          ? r.error || painterLabels.prefillFailed
          : painterLabels.prefillDetail(formatTtft(r.ttftMs), r.promptTokens > 0 ? `${r.promptTokens.toLocaleString("en-US")} tokens` : "—", flags.join(", ")),
        primary: failed ? "—" : r.prefillTps.toFixed(1),
        secondary: failed ? "—" : formatTtft(r.ttftMs),
        primaryUnit: "tok/s",
        secondaryUnit: "",
        tone: failed ? "bad" : partial || r.lowConfidence ? "warn" : "ok",
      };
    });

  const sizes = job.config?.contextSizes ?? [];
  return {
    brand: "sparkDash",
    host: src.sparkName || "",
    title: labels.prefillTitle,
    subtitle: shareCardSubtitle(src),
    chips: shareCardChips(src),
    status: shareCardStatus(job.status, labels),
    meta: painterLabels.prefillMeta(sizes.length ? `${sizes.map(formatContextSize).join(", ")} ctx` : "", job.durationMs != null ? formatDuration(job.durationMs) : ""),
    columns: { load: labels.context, primary: labels.prefill, secondary: "TTFT" },
    rows,
    legend: painterLabels.prefillLegend,
    footer: "github.com/MiaAI-Lab/sparkDash",
    generatedAt: now,
    labels: painterLabels,
  };
}

/**
 * Quality card — one row per category: SCORE (pass %) and, when a previous run
 * is compared, the points delta against it. Reuses the generic row layout.
 */
export function buildQualityShareCard(
  job: QualityBenchJob,
  compare: QualityBenchJob | null,
  src: ShareCardSource,
  now: number = Date.now(),
): ShareCardModel {
  const labels = src.labels ?? DEFAULT_BENCHMARK_SHARE_CARD_LABELS;
  const painterLabels: ShareCardLabels = { ...DEFAULT_SHARE_CARD_LABELS, ...src.labels };
  // Runs from different suite/scoring versions are not comparable: show the plain card.
  if (compare && !checkQualityComparable(job, compare).ok) compare = null;
  const rows: ShareCardRow[] = [];
  for (const cat of QUALITY_CATEGORIES) {
    const s = job.results?.categories?.[cat];
    if (!s) continue;
    const other = compare?.results?.categories?.[cat];
    const delta = s.pct != null && other?.pct != null ? Math.round((s.pct - other.pct) * 10) / 10 : null;
    rows.push({
      load: QUALITY_CATEGORY_LABELS[cat],
      detail: painterLabels.qualityDetail(s.passed, s.scored ?? s.total, s.errors),
      primary: s.pct == null ? "—" : s.pct.toFixed(1),
      secondary: delta == null ? "" : `${delta > 0 ? "+" : ""}${delta.toFixed(1)}`,
      primaryUnit: "%",
      secondaryUnit: delta == null ? "" : "pts",
      tone: s.pct == null ? "bad" : delta != null && delta < 0 ? "warn" : "ok",
    });
  }
  const overall = job.results?.overallPct;
  const tiles: ShareCardTile[] = rows.map((r, i) => {
    const cat = QUALITY_CATEGORIES.filter((c) => job.results?.categories?.[c])[i];
    const s = job.results?.categories?.[cat];
    const other = compare?.results?.categories?.[cat];
    return {
      label: r.load,
      pct: s?.pct ?? null,
      detail: r.detail,
      delta: s?.pct != null && other?.pct != null ? Math.round((s.pct - other.pct) * 10) / 10 : null,
    };
  });
  const catKeys = QUALITY_CATEGORIES.filter((c) => job.results?.categories?.[c]);
  const itemTotal = catKeys.reduce((n, c) => n + (job.results?.categories?.[c]?.total ?? 0), 0);
  const summary = painterLabels.qualitySummary(tiles.length, itemTotal.toLocaleString("en-US"), job.durationMs != null ? formatDuration(job.durationMs) : "");
  return {
    quality: {
      overall: overall ?? null,
      modelName: src.modelId || "",
      target: src.remoteHost ? src.remoteHost : `Port ${src.llmPort}`,
      runLabel: job.config?.label || "",
      summary,
      tiles,
    },
    brand: "sparkDash",
    host: src.sparkName || "",
    title: labels.qualityTitle,
    subtitle: shareCardSubtitle(src),
    chips: shareCardChips(src),
    status: shareCardStatus(job.status, labels),
    meta: painterLabels.qualityMeta(overall == null ? "—" : `${overall.toFixed(1)}%`, job.config?.label || "", job.durationMs != null ? formatDuration(job.durationMs) : ""),
    columns: { load: labels.category, primary: labels.score, secondary: compare ? labels.versusOther : "" },
    rows,
    legend: painterLabels.qualityLegend,
    footer: "github.com/MiaAI-Lab/sparkDash",
    generatedAt: now,
    labels: painterLabels,
  };
}

/** Score band → card tone, following the tool's tiers (75+ good, 60+ adequate, 40+ weak, below poor). */
function toolEvalTone(score: number | null | undefined, presentation?: ToolEvalPresentation): ShareCardTone {
  const tier = scoreTier(score, presentation);
  if (!tier) return "muted";
  return tier.tone === "good" ? "ok" : tier.tone === "info" ? "accent" : tier.tone === "warn" ? "warn" : "bad";
}

/** Most safety warnings the card lists; the rest become a "+N more" line. */
const TOOL_EVAL_SAFETY_SHOWN = 3;

function toolEvalStatus(status: ToolEvalRun["status"], labels: ShareCardLabels): { label: string; tone: ShareCardTone } {
  switch (status) {
    case "completed":
      return { label: labels.completed, tone: "ok" };
    case "running":
      return { label: labels.running, tone: "warn" };
    case "failed":
      return { label: labels.failed, tone: "bad" };
    case "stopped":
      return { label: labels.cancelled, tone: "warn" };
    default:
      return { label: String(status).toUpperCase(), tone: "muted" };
  }
}

/**
 * Tool Eval card — the headline of a tool-eval-bench run: final score and rating,
 * deployability / responsiveness, the pass–partial–fail split, safety warnings and
 * one tile per category. Reads the same normalised result the Results tab shows.
 */
export function buildToolEvalShareCard(
  data: NormToolResult,
  run: Pick<ToolEvalRun, "status" | "startedAt" | "finishedAt" | "model">,
  src: { sparkName?: string | null; labels?: ShareCardLabels },
  now: number = Date.now()
): ShareCardModel {
  const labels = src.labels ?? DEFAULT_SHARE_CARD_LABELS;
  const tier = scoreTier(data.score, labels.presentation);
  const ratingStars = (data.rating?.match(/★/g) ?? []).length || tier?.stars || 0;
  const rating = data.rating?.replace(/[★☆]+/g, "").trim() || tier?.label || "";
  const done = data.counts.pass + data.counts.partial + data.counts.fail + data.counts.other;
  const total = data.total ?? done;
  const ms = run.finishedAt != null ? run.finishedAt - run.startedAt : null;
  const stat = (label: string, v: number | null): ShareCardToolEvalStat => ({
    label,
    value: v == null ? "—" : v.toFixed(1),
    suffix: v == null ? "" : "/100",
    tone: toolEvalTone(v, labels.presentation),
  });
  const modelName = data.model || run.model || "";
  const categories = data.categories.map<ShareCardToolEvalCategory>((c) => ({
    id: c.id,
    name: c.name ?? labels.categoryName(c.id, CATEGORY_NAMES[c.id] ?? labels.category),
    pct: c.percent == null ? null : Math.max(0, Math.min(100, c.percent)),
    detail:
      c.points != null && c.maxPoints != null
        ? labels.points(String(Number(c.points.toFixed(1))), String(Number(c.maxPoints.toFixed(1))))
        : "",
  }));
  const summary = labels.scenarioSummary(total.toLocaleString("en-US"), ms != null && ms >= 0 ? formatDuration(ms) : "");
  const chips: ShareCardChip[] = [];
  if (data.backend) chips.push({ label: backendLabel(data.backend) || data.backend, tone: "accent" });
  if (data.safety.length) {
    chips.push({ label: labels.safetyChip(data.safety.length), tone: "warn" });
  }
  return {
    toolEval: {
      score: data.score,
      rating,
      stars: Math.max(0, Math.min(5, ratingStars)),
      tone: data.safety.length ? "warn" : toolEvalTone(data.score, labels.presentation),
      modelName,
      subline: [data.backend ? backendLabel(data.backend) || data.backend : "", data.version ? `tool-eval-bench ${data.version}` : ""]
        .filter(Boolean)
        .join(" · "),
      stats: [stat(labels.deployability, data.deployability), stat(labels.responsiveness, data.responsiveness)],
      counts: { ...data.counts, total },
      summary,
      safety: data.safety.slice(0, TOOL_EVAL_SAFETY_SHOWN),
      safetyTotal: data.safety.length,
      categories,
    },
    brand: "sparkDash",
    host: src.sparkName || "",
    title: labels.toolEvalBench,
    subtitle: modelName,
    chips,
    status: toolEvalStatus(run.status, labels),
    meta: labels.scoreMeta(data.score == null ? "—" : data.score.toFixed(1), rating, summary),
    columns: { load: labels.category, primary: labels.score, secondary: "" },
    rows: [],
    legend: labels.scoreLegend,
    footer: "github.com/MiaAI-Lab/sparkDash",
    generatedAt: now,
    labels: src.labels,
  };
}

/** `+4.2` / `−1.0` / `±0`, coloured by whether the change is for the better. */
function compareDelta(d: CompareDelta, suffix = ""): { text: string; tone: ShareCardTone } {
  if (d.delta == null) return { text: "—", tone: "muted" };
  if (Math.abs(d.delta) < 10 ** -d.digits / 2) return { text: "±0", tone: "muted" };
  const better = d.higherIsBetter ? d.delta > 0 : d.delta < 0;
  return {
    text: `${d.delta > 0 ? "+" : "−"}${Math.abs(d.delta).toFixed(d.digits)}${suffix}`,
    tone: better ? "ok" : "bad",
  };
}

function compareSide(
  tag: "A" | "B",
  data: NormToolResult,
  run: Pick<ToolEvalRun, "label" | "startedAt" | "model">,
  sparkName: string | null | undefined, labels: ShareCardLabels
): ShareCardCompareSide {
  const tier = scoreTier(data.score, labels.presentation);
  return {
    heading: labels.runHeading(tag, sparkName || "", run.label || shareCardDate(run.startedAt)),
    model: data.model || run.model || "",
    score: data.score,
    rating: data.rating?.replace(/[★☆]+/g, "").trim() || tier?.label || "",
    tone: data.safety.length ? "warn" : toolEvalTone(data.score, labels.presentation),
    // Failures are left off the card, as on the single-run card.
    summary: data.scenarios.length ? labels.sideSummary(data.counts.pass, data.counts.partial) : "",
    safety: data.safety.length,
  };
}

/**
 * Tool Eval comparison card: run B against baseline run A — score change, metric tiles,
 * how many scenarios moved, and every category side by side. Uses the same comparison
 * the History tab shows, so the card and the panel always agree.
 */
export function buildToolEvalCompareShareCard(
  a: NormToolResult,
  b: NormToolResult,
  runA: Pick<ToolEvalRun, "label" | "startedAt" | "model" | "baseUrl" | "options" | "type">,
  runB: Pick<ToolEvalRun, "label" | "startedAt" | "model" | "baseUrl" | "options" | "type">,
  src: { sparkName?: string | null; sparkNameA?: string | null; sparkNameB?: string | null; labels?: ShareCardLabels },
  now: number = Date.now()
): ShareCardModel {
  const labels = src.labels ?? DEFAULT_SHARE_CARD_LABELS;
  const cmp = compareToolResults(a, b, labels.presentation);
  // Runs from two Sparks: each side names its Spark and the card's host reads "spark1 vs spark3".
  const cross = Boolean(src.sparkNameA && src.sparkNameB && src.sparkNameA !== src.sparkNameB);
  const head = (id: string) => cmp.headline.find((h) => h.id === id)!;
  const score = compareDelta(head("score"));
  const stat = (label: string, d: CompareDelta, digits: number): ShareCardCompareStat | null => {
    if (d.a == null && d.b == null) return null;
    const { text, tone } = compareDelta(d);
    const v = (n: number | null) => (n == null ? "—" : n.toFixed(digits));
    return { label, a: v(d.a), b: v(d.b), delta: text, tone };
  };
  const stats = [
    stat(labels.deployability, head("deployability"), 1),
    stat(labels.responsiveness, head("responsiveness"), 1),
    stat(labels.scenariosPassed, head("passed"), 0),
  ].filter((x): x is ShareCardCompareStat => x != null);
  const changes =
    cmp.hasScenarios.a && cmp.hasScenarios.b
      ? {
          improved: cmp.changes.filter((c) => c.kind === "improvement").length,
          regressed: cmp.changes.filter((c) => c.kind === "regression").length,
          unchanged: cmp.unchanged,
        }
      : null;
  const caveats = configCaveats(runA, runB, labels.presentation);
  const caveat = caveats.length ? labels.caveat(caveats[0], caveats.length - 1) : "";
  const sideA = compareSide("A", a, runA, cross ? src.sparkNameA : null, labels);
  const sideB = compareSide("B", b, runB, cross ? src.sparkNameB : null, labels);
  return {
    toolEvalCompare: {
      a: sideA,
      b: sideB,
      scoreDelta: score.text,
      scoreDeltaTone: score.tone,
      stats,
      changes,
      categories: cmp.categories.map((c) => {
        const clamp = (v: number | null) => (v == null ? null : Math.max(0, Math.min(100, v)));
        const d = compareDelta(c, " pts");
        return { id: c.id, name: c.name ?? labels.categoryName(c.id, CATEGORY_NAMES[c.id] ?? labels.category), a: clamp(c.a), b: clamp(c.b), delta: d.text, tone: d.tone };
      }),
      caveat,
    },
    brand: "sparkDash",
    host: cross ? `${src.sparkNameA} vs ${src.sparkNameB}` : src.sparkName || "",
    title: labels.toolEvalComparison,
    subtitle: "",
    chips: [],
    status: caveat ? { label: labels.differentSetup, tone: "warn" } : { label: labels.sameSetup, tone: "ok" },
    meta: labels.comparisonMeta(score.text, sideA.model, sideB.model),
    columns: { load: labels.category, primary: labels.runA, secondary: labels.runB },
    rows: [],
    legend: labels.comparisonLegend,
    footer: "github.com/MiaAI-Lab/sparkDash",
    generatedAt: now,
    labels: src.labels,
  };
}

// ─── Painting ────────────────────────────────────────────────
// The painter touches a narrow slice of the 2D context, which keeps it testable
// with a recording fake — no canvas backend needed in the test environment.

export type ShareCardContext = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "beginPath"
  | "closePath"
  | "moveTo"
  | "lineTo"
  | "arc"
  | "fill"
  | "stroke"
  | "fillRect"
  | "fillText"
  | "measureText"
  | "roundRect"
  | "createLinearGradient"
  | "fillStyle"
  | "strokeStyle"
  | "lineWidth"
  | "lineCap"
  | "font"
  | "textAlign"
  | "textBaseline"
>;

/**
 * Brand mark, as the vertices of `assets/bolt.svg` (that file is the source of
 * truth; the unit test fails if its path stops matching these points). The card
 * draws the polygon rather than loading the SVG, so the paint stays synchronous
 * and cannot fail on a fetch.
 */
export const BOLT_POINTS: ReadonlyArray<readonly [number, number]> = [
  [13, 2],
  [3, 14],
  [12, 14],
  [11, 22],
  [21, 10],
  [12, 10],
];

export type ShareCardTheme = "dark" | "light" | "white";

interface Palette {
  /** Card background. */
  bg: string;
  panel: string;
  panelBorder: string;
  rowBorder: string;
  /** Row badge and bar-track fill. */
  badge: string;
  text: string;
  textStrong: string;
  muted: string;
  /** Brand colour for fills (logo, bars). */
  accent: string;
  /** Brand colour for text; darker on the light card so it stays readable. */
  accentText: string;
  /** Text / icon colour on an accent fill. */
  onAccent: string;
  success: string;
  warning: string;
  danger: string;
}

/**
 * The app's own theme tokens (src/index.css), so the card looks like the dashboard
 * it came from: Dark/OLED produce the dark card, White/Light the light one.
 */
const PALETTES: Record<ShareCardTheme, Palette> = {
  dark: {
    bg: "#0a0c0f",
    panel: "#12151a",
    panelBorder: "#232830",
    rowBorder: "#232830",
    badge: "#1f242b",
    text: "#e9ecf0",
    textStrong: "#ffffff",
    muted: "#8a919c",
    accent: "#f0b03a",
    accentText: "#f4b942",
    onAccent: "#1c1404",
    success: "#3fd08f",
    warning: "#ff914d",
    danger: "#ff5d62",
  },
  light: {
    bg: "#dce0e7",
    panel: "#ffffff",
    panelBorder: "#cfd5de",
    rowBorder: "#e3e7ed",
    badge: "#eceff4",
    text: "#12161c",
    textStrong: "#000000",
    muted: "#5a6370",
    accent: "#e8a21c",
    accentText: "#8c5a00",
    onAccent: "#1c1404",
    success: "#12915f",
    warning: "#c85a10",
    danger: "#cf3038",
  },
  // The app's first light theme ("White"): near-white page, white panels.
  white: {
    bg: "#f3f4f6",
    panel: "#ffffff",
    panelBorder: "#e1e4e9",
    rowBorder: "#eceef2",
    badge: "#eceef2",
    text: "#14181e",
    textStrong: "#000000",
    muted: "#5c6470",
    accent: "#e8a21c",
    accentText: "#8c5a00",
    onAccent: "#1c1404",
    success: "#12915f",
    warning: "#c85a10",
    danger: "#cf3038",
  },
};

/**
 * Card theme for the page as it is right now. The active app theme decides:
 * "dark" and "oled" give the dark card, "light" the light card, "white" the near-white
 * card (matching that theme's lighter page), and anything unknown falls back to dark.
 */
export function detectShareCardTheme(): ShareCardTheme {
  if (typeof document === "undefined") return "dark";
  const t = document.documentElement.getAttribute("data-theme");
  return t === "light" || t === "white" ? t : "dark";
}

/** Geist is bundled with the app; the rest is a safe fallback for odd environments. */
const FONT_STACK =
  '"Geist Variable", "Geist", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const PAD = 56;
const HEADER_BLOCK = 318;
const CHIP_HEIGHT = 30;
const PANEL_HEADER_HEIGHT = 44;
const PANEL_ROW_HEIGHT = 92;
const LEGEND_BLOCK = 130;
/** Where the Quality card's hero panel starts (below the brand line and the title row). */
const QUALITY_TOP = 156;
const QUALITY_HERO_HEIGHT = 224;
const QUALITY_TILE_HEIGHT = 108;
const QUALITY_TILE_GAP = 16;
/** Tool Eval card geometry: hero, outcome strip, optional safety panel, then the category grid. */
const TE_HERO_HEIGHT = 224;
const TE_STRIP_HEIGHT = 112;
const TE_GAP = 18;
const TE_SAFETY_HEAD = 58;
const TE_SAFETY_LINE = 30;
const TE_TILE_HEIGHT = 88;
const TE_TILE_GAP = 14;
/** Tool Eval comparison card geometry. */
const TC_HERO_HEIGHT = 262;
const TC_CAVEAT_HEIGHT = 44;
const TC_TILE_HEIGHT = 124;
const TC_CATS_HEAD = 52;
const TC_CATS_ROW = 54;

function font(weight: number, size: number): string {
  return `${weight} ${size}px ${FONT_STACK}`;
}

function toneColor(P: Palette, tone: ShareCardTone): string {
  switch (tone) {
    case "ok":
      return P.success;
    case "warn":
      return P.warning;
    case "bad":
      return P.danger;
    case "accent":
      return P.accentText;
    default:
      return P.muted;
  }
}

/** Trim to `maxWidth` with an ellipsis — the card has a fixed width. */
function fitText(ctx: ShareCardContext, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

/** Largest font size from `start` down to `min` at which `text` fits `maxWidth` (the caller still `fitText`s at `min`). */
function shrinkToFit(ctx: ShareCardContext, text: string, weight: number, start: number, min: number, maxWidth: number): number {
  let size = start;
  ctx.font = font(weight, size);
  while (size > min && ctx.measureText(text).width > maxWidth) {
    size -= 2;
    ctx.font = font(weight, size);
  }
  return size;
}

/** Panel height is one row per level, so a 12-level sweep grows, not clips. */
export function shareCardHeight(model: ShareCardModel): number {
  if (model.toolEvalCompare) {
    return Math.max(SHARE_CARD_MIN_HEIGHT, toolEvalCompareLayout(model.toolEvalCompare).bottom + 120);
  }
  if (model.toolEval) {
    return Math.max(SHARE_CARD_MIN_HEIGHT, toolEvalLayout(model.toolEval).bottom + 120);
  }
  if (model.quality) {
    const rows = Math.max(1, Math.ceil(model.quality.tiles.length / 2));
    const tilesBottom = QUALITY_TOP + QUALITY_HERO_HEIGHT + 22 + rows * (QUALITY_TILE_HEIGHT + QUALITY_TILE_GAP) - QUALITY_TILE_GAP;
    return Math.max(SHARE_CARD_MIN_HEIGHT, tilesBottom + 120);
  }
  const panel = PANEL_HEADER_HEIGHT + Math.max(1, model.rows.length) * PANEL_ROW_HEIGHT;
  return Math.max(SHARE_CARD_MIN_HEIGHT, HEADER_BLOCK + panel + LEGEND_BLOCK);
}

/**
 * Per-row bar lengths (0–1) relative to the largest headline number, like the bars
 * under each row in the app. Null when any row has no plain number (e.g. a failed level).
 */
export function shareCardBarFractions(rows: readonly ShareCardRow[]): number[] | null {
  if (!rows.length) return null;
  const values = rows.map((r) => {
    const digits = String(r.primary).replace(/[^0-9.]/g, "");
    return /\d/.test(digits) ? Number(digits) : Number.NaN; // "—" is "no number", not 0
  });
  if (values.some((v) => !Number.isFinite(v))) return null;
  const max = Math.max(...values);
  if (!(max > 0)) return null;
  return values.map((v) => v / max);
}

/** The brand tile: accent rounded square with the bolt outlined inside, like the sidebar logo. */
function drawLogo(ctx: ShareCardContext, P: Palette, x: number, y: number, size: number): void {
  ctx.save();
  ctx.fillStyle = P.accent;
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, size * 0.3);
  ctx.fill();
  const inner = size * 0.6;
  const ox = x + (size - inner) / 2;
  const oy = y + (size - inner) / 2;
  ctx.beginPath();
  BOLT_POINTS.forEach(([px, py], i) => {
    const cx = ox + (px / 24) * inner;
    const cy = oy + (py / 24) * inner;
    if (i === 0) ctx.moveTo(cx, cy);
    else ctx.lineTo(cx, cy);
  });
  ctx.closePath();
  ctx.strokeStyle = P.onAccent;
  ctx.lineWidth = 2.4;
  ctx.stroke();
  ctx.restore();
}

/** One tag-style pill: tone at ~14% behind, tone for the dot and text (same recipe as the app's `.tag--*`). */
function drawChip(ctx: ShareCardContext, P: Palette, x: number, y: number, chip: ShareCardChip): number {
  ctx.save();
  ctx.font = font(600, 19);
  const textWidth = ctx.measureText(chip.label).width;
  const width = textWidth + 46;
  const tone = toneColor(P, chip.tone);
  ctx.fillStyle = `${tone}24`;
  ctx.beginPath();
  ctx.roundRect(x, y, width, CHIP_HEIGHT, CHIP_HEIGHT / 2);
  ctx.fill();
  ctx.fillStyle = tone;
  ctx.beginPath();
  ctx.arc(x + 18, y + CHIP_HEIGHT / 2, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(chip.label, x + 28, y + CHIP_HEIGHT / 2 + 1);
  ctx.restore();
  return width;
}

function drawPill(ctx: ShareCardContext, P: Palette, x: number, y: number, label: string, tone: ShareCardTone): number {
  ctx.save();
  ctx.font = font(700, 20);
  const width = ctx.measureText(label).width + 40;
  const height = 40;
  ctx.fillStyle = tone === "muted" ? P.badge : `${toneColor(P, tone)}24`;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 20);
  ctx.fill();
  ctx.fillStyle = toneColor(P, tone);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + 20, y + height / 2 + 1);
  ctx.restore();
  return width;
}

/** Draw the card. Call with a context scaled to `SHARE_CARD_WIDTH`. */
export function paintShareCard(
  ctx: ShareCardContext,
  model: ShareCardModel,
  theme: ShareCardTheme = "dark"
): void {
  const P = PALETTES[theme] ?? PALETTES.dark;
  const width = SHARE_CARD_WIDTH;
  const height = shareCardHeight(model);
  const inner = width - PAD * 2;

  // Flat page colour, like the app's body.
  ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, width, height);

  // Brand line: logo tile + two-tone wordmark on the left, unit name on the right
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const logo = 40;
  drawLogo(ctx, P, PAD, PAD - 24, logo);
  ctx.font = font(700, 26);
  ctx.fillStyle = P.textStrong;
  const wordX = PAD + logo + 14;
  ctx.fillText("spark", wordX, PAD + 6);
  const sparkWidth = ctx.measureText("spark").width;
  ctx.font = font(400, 26);
  ctx.fillStyle = P.muted;
  ctx.fillText("Dash", wordX + sparkWidth, PAD + 6);
  if (model.host) {
    ctx.textAlign = "right";
    ctx.fillStyle = P.muted;
    ctx.font = font(500, 22);
    ctx.fillText(fitText(ctx, model.host, inner / 2), width - PAD, PAD + 6);
    ctx.textAlign = "left";
  }

  if (model.quality) {
    const bottom = paintQualityCard(ctx, P, model);
    paintFooter(ctx, P, model, bottom + 42, height);
    return;
  }

  if (model.toolEvalCompare) {
    const bottom = paintToolEvalCompareCard(ctx, P, model);
    paintFooter(ctx, P, model, bottom + 42, height);
    return;
  }

  if (model.toolEval) {
    const bottom = paintToolEvalCard(ctx, P, model);
    paintFooter(ctx, P, model, bottom + 42, height);
    return;
  }

  // Title + subtitle
  ctx.fillStyle = P.textStrong;
  ctx.font = font(700, 46);
  ctx.fillText(fitText(ctx, model.title, inner), PAD, PAD + 78);
  ctx.fillStyle = P.muted;
  ctx.font = font(400, 24);
  ctx.fillText(fitText(ctx, model.subtitle, inner), PAD, PAD + 120);

  // Engine + exposure pills, on their own row like the panel's badge row
  let chipX = PAD;
  const chipY = PAD + 140;
  model.chips.forEach((chip) => {
    const w = drawChip(ctx, P, chipX, chipY, chip);
    chipX += w + 10;
  });

  // Status pill + run meta
  const statusY = PAD + 198;
  const pillWidth = drawPill(ctx, P, PAD, statusY, model.status.label, model.status.tone);
  ctx.fillStyle = P.text;
  ctx.font = font(400, 24);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(fitText(ctx, model.meta, inner - pillWidth - 20), PAD + pillWidth + 20, statusY + 21);
  ctx.textBaseline = "alphabetic";

  // Results panel
  const panelY = HEADER_BLOCK;
  const panelHeight = PANEL_HEADER_HEIGHT + Math.max(1, model.rows.length) * PANEL_ROW_HEIGHT;
  ctx.fillStyle = P.panel;
  ctx.beginPath();
  ctx.roundRect(PAD, panelY, inner, panelHeight, 18);
  ctx.fill();
  ctx.strokeStyle = P.panelBorder;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Column headers
  const colLoad = PAD + 32;
  const colPrimary = PAD + inner - 320;
  const colSecondary = PAD + inner - 32;
  ctx.font = font(600, 18);
  ctx.fillStyle = P.muted;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(model.columns.load.toUpperCase(), colLoad, panelY + PANEL_HEADER_HEIGHT / 2 + 2);
  ctx.textAlign = "right";
  ctx.fillText(model.columns.primary.toUpperCase(), colPrimary, panelY + PANEL_HEADER_HEIGHT / 2 + 2);
  ctx.fillText(model.columns.secondary.toUpperCase(), colSecondary, panelY + PANEL_HEADER_HEIGHT / 2 + 2);

  const bars = shareCardBarFractions(model.rows);

  // Rows
  model.rows.forEach((row, i) => {
    const rowTop = panelY + PANEL_HEADER_HEIGHT + i * PANEL_ROW_HEIGHT;
    const centerY = rowTop + 38;

    ctx.save();
    ctx.strokeStyle = P.rowBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD + 1, rowTop);
    ctx.lineTo(PAD + inner - 1, rowTop);
    ctx.stroke();
    ctx.restore();

    // Load badge
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = font(700, 22);
    const badgeWidth = Math.max(56, ctx.measureText(row.load).width + 28);
    ctx.fillStyle = P.badge;
    ctx.beginPath();
    ctx.roundRect(colLoad, centerY - 22, badgeWidth, 44, 10);
    ctx.fill();
    ctx.fillStyle = P.text;
    ctx.fillText(row.load, colLoad + (badgeWidth - ctx.measureText(row.load).width) / 2, centerY + 1);

    // Row detail
    ctx.font = font(400, 21);
    ctx.fillStyle = P.muted;
    ctx.fillText(
      fitText(ctx, row.detail, colPrimary - 140 - (colLoad + badgeWidth + 20)),
      colLoad + badgeWidth + 20,
      centerY + 1
    );

    // Primary number, unit right-aligned after it
    ctx.textAlign = "right";
    ctx.fillStyle = row.tone === "bad" ? P.danger : P.accentText;
    if (row.primaryUnit) {
      ctx.font = font(400, 18);
      const unitWidth = ctx.measureText(row.primaryUnit).width;
      ctx.font = font(700, 34);
      ctx.fillText(row.primary, colPrimary - unitWidth - 10, centerY + 2);
      ctx.font = font(400, 18);
      ctx.fillStyle = P.muted;
      ctx.fillText(row.primaryUnit, colPrimary, centerY + 6);
    } else {
      ctx.font = font(700, 34);
      ctx.fillText(row.primary, colPrimary, centerY + 2);
    }

    // Secondary number, same treatment
    ctx.fillStyle = row.tone === "bad" ? P.danger : P.textStrong;
    if (row.secondaryUnit) {
      ctx.font = font(400, 18);
      const unitWidth = ctx.measureText(row.secondaryUnit).width;
      ctx.font = font(600, 30);
      ctx.fillText(row.secondary, colSecondary - unitWidth - 10, centerY + 2);
      ctx.font = font(400, 18);
      ctx.fillStyle = P.muted;
      ctx.fillText(row.secondaryUnit, colSecondary, centerY + 6);
    } else {
      ctx.font = font(600, 30);
      ctx.fillText(row.secondary, colSecondary, centerY + 2);
    }

    // Bar under the row, as in the app's results list
    if (bars) {
      const barY = rowTop + 70;
      const barW = colSecondary - colLoad;
      ctx.fillStyle = P.badge;
      ctx.beginPath();
      ctx.roundRect(colLoad, barY, barW, 6, 3);
      ctx.fill();
      ctx.fillStyle = row.tone === "bad" ? P.danger : P.accent;
      ctx.beginPath();
      ctx.roundRect(colLoad, barY, Math.max(6, barW * bars[i]), 6, 3);
      ctx.fill();
    }
  });

  paintFooter(ctx, P, model, panelY + panelHeight + 42, height);
}

/** Legend line under the body, then the repo link and date at the bottom. */
function paintFooter(ctx: ShareCardContext, P: Palette, model: ShareCardModel, legendY: number, height: number): void {
  const width = SHARE_CARD_WIDTH;
  const inner = width - PAD * 2;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = font(400, 20);
  ctx.fillStyle = P.muted;
  ctx.fillText(fitText(ctx, model.legend, inner), PAD, legendY);
  ctx.font = font(400, 19);
  ctx.fillText(model.footer, PAD, height - PAD + 6);
  ctx.textAlign = "right";
  ctx.fillText(shareCardDate(model.generatedAt), width - PAD, height - PAD + 6);
}

/** Score band colours, like the app's results page: green from 90, amber from 70, red below. */
export function qualityTierColor(P: { success: string; accent: string; danger: string; muted: string }, pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return P.muted;
  return pct >= 90 ? P.success : pct >= 70 ? P.accent : P.danger;
}

/** Text colour for a score: the band's colour, using the darker amber so it reads on light cards. */
function qualityTextColor(P: Palette, pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return P.muted;
  return pct >= 90 ? P.success : pct >= 70 ? P.accentText : P.danger;
}

/**
 * The Quality card from the title down: title + status, a hero with the overall ring and the
 * model under test, then a two-column grid of category tiles. Returns the bottom edge's y.
 */
function paintQualityCard(ctx: ShareCardContext, P: Palette, model: ShareCardModel): number {
  const q = model.quality as ShareCardQuality;
  const labels = model.labels ?? DEFAULT_SHARE_CARD_LABELS;
  const inner = SHARE_CARD_WIDTH - PAD * 2;

  // Title, with the run status at the right on the same line
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = P.textStrong;
  ctx.font = font(700, 44);
  ctx.fillText(labels.qualityBenchmark, PAD, PAD + 78);
  ctx.font = font(700, 20);
  const pillW = ctx.measureText(model.status.label).width + 40;
  drawPill(ctx, P, PAD + inner - pillW, PAD + 46, model.status.label, model.status.tone);

  // Hero panel
  const top = QUALITY_TOP;
  ctx.fillStyle = P.panel;
  ctx.beginPath();
  ctx.roundRect(PAD, top, inner, QUALITY_HERO_HEIGHT, 20);
  ctx.fill();
  ctx.strokeStyle = P.panelBorder;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Overall ring
  const radius = 76;
  const cx = PAD + 48 + radius + 8;
  const cy = top + QUALITY_HERO_HEIGHT / 2;
  const tier = qualityTierColor(P, q.overall);
  ctx.lineWidth = 16;
  ctx.lineCap = "butt";
  ctx.strokeStyle = P.badge;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  if (q.overall != null && q.overall > 0) {
    ctx.strokeStyle = tier;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + (Math.min(100, q.overall) / 100) * Math.PI * 2);
    ctx.stroke();
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = P.muted;
  ctx.font = font(600, 15);
  ctx.fillText(labels.overall, cx, cy - 30);
  ctx.fillStyle = P.textStrong;
  ctx.font = font(700, 48);
  const score = q.overall == null ? "—" : q.overall.toFixed(1);
  ctx.fillText(score, cx - (q.overall == null ? 0 : 8), cy + 18);
  if (q.overall != null) {
    ctx.font = font(500, 22);
    ctx.fillStyle = P.muted;
    ctx.textAlign = "left";
    ctx.font = font(700, 48);
    const w = ctx.measureText(score).width;
    ctx.font = font(500, 22);
    ctx.fillText("%", cx - 8 + w / 2 + 3, cy + 18);
  }

  // The model under test, big, with where it ran and what it is
  const textX = cx + radius + 64;
  const textW = PAD + inner - 40 - textX;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = P.textStrong;
  ctx.font = font(700, 36);
  ctx.fillText(fitText(ctx, q.modelName || labels.unknownModel, textW), textX, cy - 40);
  ctx.fillStyle = P.muted;
  ctx.font = font(500, 22);
  const where = [q.target, q.runLabel].filter(Boolean).join(" · ");
  ctx.fillText(fitText(ctx, where, textW), textX, cy - 8);

  // Engine and exposure pills
  let chipX = textX;
  const chipY = cy + 8;
  for (const chip of model.chips) {
    const w = drawChip(ctx, P, chipX, chipY, chip);
    chipX += w + 10;
  }
  ctx.fillStyle = P.text;
  ctx.font = font(400, 22);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(fitText(ctx, q.summary, textW), textX, cy + 78);

  // Tiles
  const gap = 20;
  const tileW = (inner - gap) / 2;
  const gridTop = top + QUALITY_HERO_HEIGHT + 22;
  q.tiles.forEach((tile, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = PAD + col * (tileW + gap);
    const y = gridTop + row * (QUALITY_TILE_HEIGHT + QUALITY_TILE_GAP);
    ctx.fillStyle = P.panel;
    ctx.beginPath();
    ctx.roundRect(x, y, tileW, QUALITY_TILE_HEIGHT, 16);
    ctx.fill();
    ctx.strokeStyle = P.panelBorder;
    ctx.lineWidth = 1;
    ctx.stroke();

    const bar = qualityTierColor(P, tile.pct);
    const text = qualityTextColor(P, tile.pct);
    const left = x + 26;
    const right = x + tileW - 26;

    // Name + items on the left, score on the right, sharing one baseline row
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = P.textStrong;
    ctx.font = font(700, 26);
    ctx.fillText(fitText(ctx, tile.label, tileW - 230), left, y + 42);
    ctx.fillStyle = P.muted;
    ctx.font = font(400, 20);
    ctx.fillText(fitText(ctx, tile.detail, tileW - 230), left, y + 70);

    ctx.textAlign = "right";
    ctx.font = font(500, 20);
    const unitW = tile.pct == null ? 0 : ctx.measureText("%").width + 4;
    ctx.fillStyle = text;
    ctx.font = font(700, 44);
    ctx.fillText(tile.pct == null ? "—" : tile.pct.toFixed(1), right - unitW, y + 50);
    if (tile.pct != null) {
      ctx.font = font(500, 20);
      ctx.fillStyle = P.muted;
      ctx.fillText("%", right, y + 50);
    }
    if (tile.delta != null) {
      ctx.font = font(600, 19);
      ctx.fillStyle = tile.delta > 0 ? P.success : tile.delta < 0 ? P.danger : P.muted;
      ctx.fillText(tile.delta === 0 ? labels.same : `${tile.delta > 0 ? "+" : ""}${tile.delta.toFixed(1)} ${labels.pts}`, right, y + 76);
    }

    // Bar
    const barW = right - left;
    const barY = y + QUALITY_TILE_HEIGHT - 22;
    ctx.fillStyle = P.badge;
    ctx.beginPath();
    ctx.roundRect(left, barY, barW, 8, 4);
    ctx.fill();
    if (tile.pct != null && tile.pct > 0) {
      ctx.fillStyle = bar;
      ctx.beginPath();
      ctx.roundRect(left, barY, Math.max(8, (barW * Math.min(100, tile.pct)) / 100), 8, 4);
      ctx.fill();
    }
  });
  const rows = Math.max(1, Math.ceil(q.tiles.length / 2));
  return gridTop + rows * (QUALITY_TILE_HEIGHT + QUALITY_TILE_GAP) - QUALITY_TILE_GAP;
}

/** Vertical positions of the Tool Eval card's blocks; shared by the height calculation and the painter. */
function toolEvalLayout(te: ShareCardToolEval): {
  heroY: number;
  stripY: number;
  safetyY: number | null;
  safetyHeight: number;
  gridY: number | null;
  bottom: number;
} {
  const heroY = QUALITY_TOP;
  const stripY = heroY + TE_HERO_HEIGHT + TE_GAP;
  let bottom = stripY + TE_STRIP_HEIGHT;
  let safetyY: number | null = null;
  let safetyHeight = 0;
  if (te.safetyTotal > 0) {
    safetyY = bottom + TE_GAP;
    const lines = te.safety.length + (te.safetyTotal > te.safety.length ? 1 : 0);
    safetyHeight = TE_SAFETY_HEAD + lines * TE_SAFETY_LINE;
    bottom = safetyY + safetyHeight;
  }
  let gridY: number | null = null;
  if (te.categories.length) {
    gridY = bottom + 22;
    const rows = Math.ceil(te.categories.length / 2);
    bottom = gridY + rows * (TE_TILE_HEIGHT + TE_TILE_GAP) - TE_TILE_GAP;
  }
  return { heroY, stripY, safetyY, safetyHeight, gridY, bottom };
}

/** Five-point star centred on (cx, cy), as a filled path. */
function drawStar(ctx: ShareCardContext, cx: number, cy: number, outer: number, fill: string): void {
  const inner = outer * 0.42;
  ctx.fillStyle = fill;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

/** Fill colour for a bar or ring in a tone: the brand amber stays the fill colour, not the darker text one. */
function toolEvalFill(P: Palette, tone: ShareCardTone): string {
  return tone === "accent" ? P.accent : toneColor(P, tone);
}

function panelBox(ctx: ShareCardContext, P: Palette, x: number, y: number, w: number, h: number, radius: number): void {
  ctx.fillStyle = P.panel;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fill();
  ctx.strokeStyle = P.panelBorder;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/**
 * The Tool Eval card from the title down: score hero (ring, stars, model, deployability and
 * responsiveness), the pass/partial/fail strip, safety warnings when there are any, then a
 * two-column grid of category tiles. Returns the bottom edge's y.
 */
function paintToolEvalCard(ctx: ShareCardContext, P: Palette, model: ShareCardModel): number {
  const te = model.toolEval as ShareCardToolEval;
  const labels = model.labels ?? DEFAULT_SHARE_CARD_LABELS;
  const inner = SHARE_CARD_WIDTH - PAD * 2;
  const L = toolEvalLayout(te);

  // Title, with the run status at the right on the same line
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = P.textStrong;
  ctx.font = font(700, 44);
  ctx.fillText(model.title, PAD, PAD + 78);
  ctx.font = font(700, 20);
  const pillW = ctx.measureText(model.status.label).width + 40;
  drawPill(ctx, P, PAD + inner - pillW, PAD + 46, model.status.label, model.status.tone);

  // Hero panel
  const top = L.heroY;
  panelBox(ctx, P, PAD, top, inner, TE_HERO_HEIGHT, 20);

  // Score ring
  const radius = 76;
  const cx = PAD + 48 + radius + 8;
  const cy = top + TE_HERO_HEIGHT / 2;
  const heroTone = toolEvalFill(P, te.tone);
  ctx.lineWidth = 16;
  ctx.lineCap = "butt";
  ctx.strokeStyle = P.badge;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  if (te.score != null && te.score > 0) {
    ctx.strokeStyle = heroTone;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + (Math.min(100, te.score) / 100) * Math.PI * 2);
    ctx.stroke();
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = P.muted;
  ctx.font = font(600, 15);
  ctx.fillText(labels.score, cx, cy - 30);
  ctx.fillStyle = P.textStrong;
  ctx.font = font(700, 48);
  ctx.fillText(te.score == null ? "—" : te.score.toFixed(1), cx, cy + 18);

  // Right column: deployability and responsiveness, behind a divider
  const statX = PAD + inner - 260;
  ctx.strokeStyle = P.rowBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(statX - 30, top + 28);
  ctx.lineTo(statX - 30, top + TE_HERO_HEIGHT - 28);
  ctx.stroke();
  te.stats.forEach((stat, i) => {
    const labelY = top + 52 + i * 84;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = P.muted;
    ctx.font = font(600, 16);
    ctx.fillText(stat.label.toUpperCase(), statX, labelY);
    ctx.fillStyle = stat.tone === "muted" ? P.muted : toneColor(P, stat.tone);
    ctx.font = font(700, 44);
    ctx.fillText(stat.value, statX, labelY + 46);
    if (stat.suffix) {
      const w = ctx.measureText(stat.value).width;
      ctx.fillStyle = P.muted;
      ctx.font = font(500, 20);
      ctx.fillText(stat.suffix, statX + w + 8, labelY + 46);
    }
  });

  // Middle column: stars + rating, the model under test, its engine, then chips
  const textX = cx + radius + 56;
  const textW = statX - 48 - textX;
  const starY = cy - 62;
  for (let i = 0; i < 5; i++) drawStar(ctx, textX + 14 + i * 34, starY, 14, i < te.stars ? P.accent : P.badge);
  if (te.rating) {
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = P.textStrong;
    ctx.font = font(700, 26);
    ctx.fillText(te.rating, textX + 5 * 34 + 4, starY + 1);
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = P.textStrong;
  // Long model ids shrink to fit before they are cut.
  const modelName = te.modelName || labels.unknownModel;
  shrinkToFit(ctx, modelName, 700, 34, 24, textW);
  ctx.fillText(fitText(ctx, modelName, textW), textX, cy - 8);
  ctx.fillStyle = P.muted;
  ctx.font = font(500, 21);
  ctx.fillText(fitText(ctx, te.subline, textW), textX, cy + 22);
  let chipX = textX;
  for (const chip of model.chips) {
    const w = drawChip(ctx, P, chipX, cy + 42, chip);
    chipX += w + 10;
  }

  // Outcome strip: one segment per outcome, sized by count
  const stripY = L.stripY;
  panelBox(ctx, P, PAD, stripY, inner, TE_STRIP_HEIGHT, 16);
  const sx = PAD + 28;
  const sw = inner - 56;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = P.muted;
  ctx.font = font(600, 16);
  ctx.fillText(labels.scenarioOutcomes, sx, stripY + 34);
  ctx.textAlign = "right";
  ctx.font = font(400, 20);
  ctx.fillText(te.summary, sx + sw, stripY + 34);
  // Failures are left off the card: the bar keeps its full scale (so pass/partial show their
  // real share of all scenarios) but only pass, partial and other are drawn and listed.
  const outcomes: { label: string; n: number; color: string; shown: boolean }[] = [
    { label: labels.pass, n: te.counts.pass, color: P.success, shown: true },
    { label: labels.partial, n: te.counts.partial, color: P.warning, shown: true },
    { label: labels.fail, n: te.counts.fail, color: P.danger, shown: false },
    { label: labels.other, n: te.counts.other, color: P.muted, shown: te.counts.other > 0 },
  ];
  const barY = stripY + 50;
  ctx.fillStyle = P.badge;
  ctx.beginPath();
  ctx.roundRect(sx, barY, sw, 14, 7);
  ctx.fill();
  const counted = outcomes.reduce((n, o) => n + o.n, 0);
  if (counted > 0) {
    const gap = 3;
    const live = outcomes.filter((o) => o.n > 0);
    const usable = sw - gap * (live.length - 1);
    let segX = sx;
    for (const o of live) {
      const w = (usable * o.n) / counted;
      if (o.shown) {
        ctx.fillStyle = o.color;
        ctx.beginPath();
        ctx.roundRect(segX, barY, w, 14, Math.min(7, w / 2));
        ctx.fill();
      }
      segX += w + gap;
    }
  }
  let legendX = sx;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  for (const o of outcomes.filter((x) => x.shown)) {
    ctx.fillStyle = o.color;
    ctx.beginPath();
    ctx.arc(legendX + 6, stripY + 91, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = font(700, 22);
    ctx.fillStyle = P.textStrong;
    const count = String(o.n);
    ctx.fillText(count, legendX + 20, stripY + 98);
    const cw = ctx.measureText(count).width;
    ctx.font = font(400, 20);
    ctx.fillStyle = P.muted;
    ctx.fillText(o.label, legendX + 20 + cw + 7, stripY + 98);
    legendX += 20 + cw + 7 + ctx.measureText(o.label).width + 34;
  }

  // Safety warnings: a warning-tinted panel, since they cap the rating
  if (L.safetyY != null) {
    const y = L.safetyY;
    ctx.fillStyle = `${P.warning}1a`;
    ctx.beginPath();
    ctx.roundRect(PAD, y, inner, L.safetyHeight, 16);
    ctx.fill();
    ctx.strokeStyle = `${P.warning}66`;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = P.warning;
    ctx.font = font(700, 20);
    ctx.fillText(
      labels.safetyWarnings(te.safetyTotal),
      PAD + 28,
      y + 38
    );
    ctx.font = font(400, 20);
    ctx.fillStyle = P.text;
    te.safety.forEach((w, i) => {
      ctx.fillText(fitText(ctx, `•  ${w}`, inner - 56), PAD + 28, y + TE_SAFETY_HEAD + 16 + i * TE_SAFETY_LINE);
    });
    if (te.safetyTotal > te.safety.length) {
      ctx.fillStyle = P.muted;
      ctx.fillText(
        labels.more(te.safetyTotal - te.safety.length),
        PAD + 28,
        y + TE_SAFETY_HEAD + 16 + te.safety.length * TE_SAFETY_LINE
      );
    }
  }

  // Category tiles
  const gridY = L.gridY;
  if (gridY != null) {
    const gap = 20;
    const tileW = (inner - gap) / 2;
    te.categories.forEach((cat, i) => {
      const x = PAD + (i % 2) * (tileW + gap);
      const y = gridY + Math.floor(i / 2) * (TE_TILE_HEIGHT + TE_TILE_GAP);
      panelBox(ctx, P, x, y, tileW, TE_TILE_HEIGHT, 16);
      const tone = cat.pct == null ? "muted" : toolEvalTone(cat.pct);
      const left = x + 22;
      const right = x + tileW - 22;

      // Letter badge, tinted by the score band
      ctx.fillStyle = tone === "muted" ? P.badge : `${toolEvalFill(P, tone)}24`;
      ctx.beginPath();
      ctx.roundRect(left, y + 14, 44, 44, 11);
      ctx.fill();
      ctx.fillStyle = tone === "muted" ? P.muted : toneColor(P, tone);
      ctx.font = font(700, 22);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(cat.id, left + 22, y + 37);

      // Name and points on the left, score on the right
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = P.textStrong;
      ctx.font = font(700, 23);
      ctx.fillText(fitText(ctx, cat.name, tileW - 44 - 16 - 22 - 150), left + 60, y + 32);
      ctx.fillStyle = P.muted;
      ctx.font = font(400, 18);
      ctx.fillText(cat.detail, left + 60, y + 54);

      ctx.textAlign = "right";
      const pctText = cat.pct == null ? "—" : String(Number(cat.pct.toFixed(1)));
      ctx.font = font(500, 18);
      const unitW = cat.pct == null ? 0 : ctx.measureText("%").width + 3;
      ctx.fillStyle = tone === "muted" ? P.muted : toneColor(P, tone);
      ctx.font = font(700, 36);
      ctx.fillText(pctText, right - unitW, y + 46);
      if (cat.pct != null) {
        ctx.font = font(500, 18);
        ctx.fillStyle = P.muted;
        ctx.fillText("%", right, y + 46);
      }

      // Bar
      const barW = right - left;
      ctx.fillStyle = P.badge;
      ctx.beginPath();
      ctx.roundRect(left, y + TE_TILE_HEIGHT - 16, barW, 6, 3);
      ctx.fill();
      if (cat.pct != null && cat.pct > 0) {
        ctx.fillStyle = toolEvalFill(P, tone);
        ctx.beginPath();
        ctx.roundRect(left, y + TE_TILE_HEIGHT - 16, Math.max(6, (barW * cat.pct) / 100), 6, 3);
        ctx.fill();
      }
    });
  }
  return L.bottom;
}

/** Vertical positions of the comparison card's blocks; shared by the height calculation and the painter. */
function toolEvalCompareLayout(c: ShareCardToolEvalCompare): {
  heroY: number;
  caveatY: number | null;
  tilesY: number | null;
  tileCount: number;
  catsY: number | null;
  catsHeight: number;
  bottom: number;
} {
  const heroY = QUALITY_TOP;
  let bottom = heroY + TC_HERO_HEIGHT;
  let caveatY: number | null = null;
  if (c.caveat) {
    caveatY = bottom;
    bottom += TC_CAVEAT_HEIGHT;
  }
  const tileCount = c.stats.length + (c.changes ? 1 : 0);
  let tilesY: number | null = null;
  if (tileCount > 0) {
    tilesY = bottom + TE_GAP;
    bottom = tilesY + TC_TILE_HEIGHT;
  }
  let catsY: number | null = null;
  let catsHeight = 0;
  if (c.categories.length) {
    catsY = bottom + 22;
    catsHeight = TC_CATS_HEAD + c.categories.length * TC_CATS_ROW + 8;
    bottom = catsY + catsHeight;
  }
  return { heroY, caveatY, tilesY, tileCount, catsY, catsHeight, bottom };
}

/** `72.5%`, or an em dash for a missing score. */
function pctText(v: number | null): string {
  return v == null ? "—" : `${Number(v.toFixed(1))}%`;
}

/**
 * The comparison card from the title down: a hero with both runs' scores around the change,
 * a caveat line when the setups differ, metric tiles, then every category with both bars and
 * the change in points. Returns the bottom edge's y.
 */
function paintToolEvalCompareCard(ctx: ShareCardContext, P: Palette, model: ShareCardModel): number {
  const c = model.toolEvalCompare as ShareCardToolEvalCompare;
  const labels = model.labels ?? DEFAULT_SHARE_CARD_LABELS;
  const inner = SHARE_CARD_WIDTH - PAD * 2;
  const L = toolEvalCompareLayout(c);

  // Title, with whether the two runs share a setup at the right
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = P.textStrong;
  ctx.font = font(700, 44);
  ctx.fillText(model.title, PAD, PAD + 78);
  ctx.font = font(700, 20);
  const pillW = ctx.measureText(model.status.label).width + 40;
  drawPill(ctx, P, PAD + inner - pillW, PAD + 46, model.status.label, model.status.tone);

  // Hero: run A | change | run B
  const top = L.heroY;
  panelBox(ctx, P, PAD, top, inner, TC_HERO_HEIGHT, 20);
  const colW = 360;
  const centerX = PAD + inner / 2;
  const drawSide = (side: ShareCardCompareSide, x: number) => {
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = P.muted;
    ctx.font = font(600, 16);
    ctx.fillText(fitText(ctx, side.heading.toUpperCase(), colW), x, top + 44);
    ctx.fillStyle = P.textStrong;
    const modelName = side.model || labels.unknownModel;
    shrinkToFit(ctx, modelName, 700, 26, 18, colW);
    ctx.fillText(fitText(ctx, modelName, colW), x, top + 84);
    ctx.fillStyle = side.score == null ? P.muted : toneColor(P, side.tone);
    ctx.font = font(700, 64);
    const scoreText = side.score == null ? "—" : side.score.toFixed(1);
    ctx.fillText(scoreText, x, top + 160);
    if (side.rating) {
      const w = ctx.measureText(scoreText).width;
      ctx.fillStyle = P.text;
      ctx.font = font(600, 24);
      ctx.fillText(fitText(ctx, side.rating, colW - w - 18), x + w + 18, top + 160);
    }
    ctx.fillStyle = P.muted;
    ctx.font = font(400, 20);
    if (side.summary) ctx.fillText(side.summary, x, top + 200);
    if (side.safety > 0) {
      ctx.fillStyle = P.warning;
      ctx.font = font(600, 20);
      ctx.fillText(labels.safetyWarnings(side.safety), x, top + (side.summary ? 232 : 200));
    }
  };
  drawSide(c.a, PAD + 36);
  drawSide(c.b, PAD + inner - 36 - colW);

  ctx.strokeStyle = P.rowBorder;
  ctx.lineWidth = 1;
  for (const dx of [-130, 130]) {
    ctx.beginPath();
    ctx.moveTo(centerX + dx, top + 30);
    ctx.lineTo(centerX + dx, top + TC_HERO_HEIGHT - 30);
    ctx.stroke();
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = P.muted;
  ctx.font = font(600, 16);
  ctx.fillText(labels.scoreChange, centerX, top + 96);
  ctx.fillStyle = c.scoreDeltaTone === "muted" ? P.muted : toneColor(P, c.scoreDeltaTone);
  ctx.font = font(700, 58);
  ctx.fillText(c.scoreDelta, centerX, top + 160);
  ctx.fillStyle = P.muted;
  ctx.font = font(400, 18);
  ctx.fillText(labels.runBVsA, centerX, top + 196);

  // Caveat
  if (L.caveatY != null) {
    ctx.textAlign = "left";
    ctx.fillStyle = P.warning;
    ctx.font = font(500, 20);
    ctx.fillText(fitText(ctx, `⚠  ${c.caveat}`, inner), PAD, L.caveatY + 30);
  }

  // Metric tiles, one more for the scenario changes
  if (L.tilesY != null) {
    const gap = 16;
    const tileW = (inner - gap * (L.tileCount - 1)) / L.tileCount;
    const tileAt = (i: number) => PAD + i * (tileW + gap);
    c.stats.forEach((st, i) => {
      const x = tileAt(i);
      panelBox(ctx, P, x, L.tilesY!, tileW, TC_TILE_HEIGHT, 16);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = P.muted;
      ctx.font = font(600, 15);
      ctx.fillText(st.label.toUpperCase(), x + 24, L.tilesY! + 34);
      ctx.font = font(700, 32);
      ctx.fillStyle = P.muted;
      const aw = ctx.measureText(st.a).width;
      ctx.fillText(st.a, x + 24, L.tilesY! + 78);
      ctx.font = font(500, 22);
      ctx.fillText("→", x + 24 + aw + 10, L.tilesY! + 76);
      const arrowW = ctx.measureText("→").width;
      ctx.font = font(700, 32);
      ctx.fillStyle = P.textStrong;
      ctx.fillText(st.b, x + 24 + aw + 20 + arrowW, L.tilesY! + 78);
      ctx.fillStyle = st.tone === "muted" ? P.muted : toneColor(P, st.tone);
      ctx.font = font(700, 22);
      ctx.fillText(st.delta, x + 24, L.tilesY! + 108);
    });
    if (c.changes) {
      const x = tileAt(c.stats.length);
      panelBox(ctx, P, x, L.tilesY, tileW, TC_TILE_HEIGHT, 16);
      ctx.textAlign = "left";
      ctx.fillStyle = P.muted;
      ctx.font = font(600, 15);
      ctx.fillText(labels.scenarioChanges, x + 24, L.tilesY + 34);
      let cx = x + 24;
      for (const part of [
        { n: c.changes.improved, label: labels.better, color: P.success },
        { n: c.changes.regressed, label: labels.worse, color: P.danger },
      ]) {
        ctx.font = font(700, 32);
        ctx.fillStyle = part.n > 0 ? part.color : P.muted;
        ctx.fillText(String(part.n), cx, L.tilesY + 78);
        const w = ctx.measureText(String(part.n)).width;
        ctx.font = font(400, 20);
        ctx.fillStyle = P.muted;
        ctx.fillText(part.label, cx + w + 7, L.tilesY + 78);
        cx += w + 7 + ctx.measureText(part.label).width + 26;
      }
      ctx.font = font(400, 17);
      ctx.fillStyle = P.muted;
      ctx.fillText(labels.unchanged(c.changes.unchanged), x + 24, L.tilesY + 108);
    }
  }

  // Categories: both bars and the change in points
  if (L.catsY != null) {
    const y0 = L.catsY;
    panelBox(ctx, P, PAD, y0, inner, L.catsHeight, 18);
    const left = PAD + 24;
    const right = PAD + inner - 24;
    const barX = left + 390;
    const barW = 300;
    const aRight = right - 270;
    const bRight = right - 170;
    ctx.textBaseline = "middle";
    ctx.font = font(600, 16);
    ctx.fillStyle = P.muted;
    ctx.textAlign = "left";
    ctx.fillText(labels.category, left, y0 + TC_CATS_HEAD / 2 + 2);
    // Legend swatches over the bars
    ctx.fillStyle = `${P.muted}99`;
    ctx.beginPath();
    ctx.roundRect(barX, y0 + TC_CATS_HEAD / 2 - 5, 18, 8, 4);
    ctx.fill();
    ctx.fillStyle = P.muted;
    ctx.fillText(labels.runA, barX + 26, y0 + TC_CATS_HEAD / 2 + 2);
    ctx.fillStyle = P.accent;
    ctx.beginPath();
    ctx.roundRect(barX + 110, y0 + TC_CATS_HEAD / 2 - 5, 18, 8, 4);
    ctx.fill();
    ctx.fillStyle = P.muted;
    ctx.fillText(labels.runB, barX + 136, y0 + TC_CATS_HEAD / 2 + 2);
    ctx.textAlign = "right";
    ctx.fillText("A", aRight, y0 + TC_CATS_HEAD / 2 + 2);
    ctx.fillText("B", bRight, y0 + TC_CATS_HEAD / 2 + 2);
    ctx.fillText(labels.change, right, y0 + TC_CATS_HEAD / 2 + 2);

    c.categories.forEach((cat, i) => {
      const y = y0 + TC_CATS_HEAD + i * TC_CATS_ROW;
      const mid = y + TC_CATS_ROW / 2;
      ctx.strokeStyle = P.rowBorder;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD + 1, y);
      ctx.lineTo(PAD + inner - 1, y);
      ctx.stroke();

      const tone = cat.b == null ? "muted" : toolEvalTone(cat.b);
      ctx.fillStyle = tone === "muted" ? P.badge : `${toolEvalFill(P, tone)}24`;
      ctx.beginPath();
      ctx.roundRect(left, mid - 18, 36, 36, 9);
      ctx.fill();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = tone === "muted" ? P.muted : toneColor(P, tone);
      ctx.font = font(700, 19);
      ctx.fillText(cat.id, left + 18, mid + 1);
      ctx.textAlign = "left";
      ctx.fillStyle = P.textStrong;
      ctx.font = font(600, 22);
      ctx.fillText(fitText(ctx, cat.name, barX - left - 52 - 20), left + 52, mid + 1);

      // Two thin bars: A (muted) over B (the score band's colour)
      for (const [value, dy, color] of [
        [cat.a, -11, `${P.muted}99`],
        [cat.b, 3, toolEvalFill(P, tone)],
      ] as const) {
        ctx.fillStyle = P.badge;
        ctx.beginPath();
        ctx.roundRect(barX, mid + dy, barW, 8, 4);
        ctx.fill();
        if (value != null && value > 0) {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.roundRect(barX, mid + dy, Math.max(8, (barW * value) / 100), 8, 4);
          ctx.fill();
        }
      }

      ctx.textAlign = "right";
      ctx.font = font(500, 20);
      ctx.fillStyle = P.muted;
      ctx.fillText(pctText(cat.a), aRight, mid + 1);
      ctx.font = font(700, 22);
      ctx.fillStyle = P.textStrong;
      ctx.fillText(pctText(cat.b), bRight, mid + 1);
      ctx.font = font(700, 22);
      ctx.fillStyle = cat.tone === "muted" ? P.muted : toneColor(P, cat.tone);
      ctx.fillText(cat.delta, right, mid + 1);
    });
  }
  return L.bottom;
}
