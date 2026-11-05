/**
 * QualityBench — fixed, deterministic quality suite against the served model.
 *
 * Categories (see qualitySuite.js): qa, reason, arith, track, gsm8k, mmlu, follow, long.
 * Every request is an OpenAI chat completion at temperature 0 with a fixed seed;
 * items and ids are identical across runs so two runs pair item-by-item
 * (compareQualityRuns in src/shared/qualityBench.js).
 *
 * Mirrors PrefillBench: one active job per Spark, mutual exclusion with the
 * decode / prefill benches (showcase is checked by the route and by
 * ShowcaseManager), history under config/, restart-safe active checkpoint.
 */

import { createHash, randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fetch as undiciFetch } from "undici";
import { atomicWrite } from "../util/atomicWrite.js";
import { LLM_STREAM_AGENT, applyThinkingFlags, round2, runStreamingRequest } from "./LlmStreaming.js";
import { decodeBenchManager } from "./DecodeBench.js";
import { prefillBenchManager, timeoutMsForSize } from "./PrefillBench.js";
import {
  REQUEST_SEED,
  SCORING_VERSION,
  SUITE_VERSION,
  buildLongPrompt,
  generateSuite,
  longSizeLabel,
  longSizesForContext,
  scoreItem,
  summarize,
  visibleAnswer,
} from "./qualitySuite.js";
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
} from "../../src/shared/qualityBench.js";
import { formatLlmBaseUrl } from "../../src/shared/llmTarget.js";
import { noiseSummary, planPasses, probeEngine, thinkingWarnings } from "./qualityEngine.js";
import { qualityFamilyKey, qualityIntervals, qualityProfile } from "../../src/shared/qualityBench.js";
import { runDivergenceItem } from "./qualityDivergence.js";
import {
  compareFidelity,
  deleteFidelitySide,
  fidelityK,
  pruneFidelitySides,
  readFidelitySide,
  runFidelityItem,
  writeFidelitySide,
} from "./qualityFidelity.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");
const HISTORY_PATH =
  process.env.QUALITY_BENCH_HISTORY_PATH ||
  path.join(ROOT, "config", "quality-bench-history.json");
const ACTIVE_PATH =
  process.env.QUALITY_BENCH_ACTIVE_PATH ||
  path.join(ROOT, "config", "quality-bench-active.json");
/** WP4: the pinned reference run per model family. */
const REFERENCES_PATH =
  process.env.QUALITY_BENCH_REFERENCES_PATH ||
  path.join(ROOT, "config", "quality-bench-references.json");

const HISTORY_LIMIT = 30;
const EXCERPT_CHARS = 160;
/**
 * Full visible reply kept on rows that need auditing (failed, truncated, disputed), capped so a
 * 30-run history stays small; thinking categories keep the tail, where the verdict is.
 */
const REPLY_KEEP_CHARS = 4000;
/** Reasoning tail kept on failed thinking rows: where the model went wrong is usually at the end. */
const REASONING_KEEP_CHARS = 2000;
/** Abort the run after this many back-to-back request errors (server down, bad model id, …). */
const MAX_CONSECUTIVE_ERRORS = 8;
const CHECKPOINT_INTERVAL_MS = 2_000;
const MODEL_INFO_TIMEOUT_MS = 15_000;

/**
 * Per-request timeout: 2 min floor + 150 ms per allowed output token
 * (12288-token reasoning ≈ 33 min); long items add PrefillBench's prefill budget.
 * @param {{ category: string, maxTokens: number, size?: number }} item
 */
export function timeoutMsForItem(item) {
  const gen = 120_000 + (Number(item.maxTokens) || 0) * 150;
  return item.category === "long" ? timeoutMsForSize(item.size) + gen : gen;
}

/** @param {unknown} raw */
export function normalizeQualityOptions(raw = {}) {
  const r = raw && typeof raw === "object" ? /** @type {Record<string, any>} */ (raw) : {};
  const categories = Array.isArray(r.categories)
    ? QUALITY_CATEGORIES.filter((c) => r.categories.includes(c))
    : [...QUALITY_DEFAULT_CATEGORIES];
  let longSizes = Array.isArray(r.longSizes)
    ? QUALITY_LONG_SIZES.filter((s) => r.longSizes.map(Number).includes(s))
    : [...QUALITY_DEFAULT_LONG_SIZES];
  if (categories.includes("long") && !longSizes.length) longSizes = [...QUALITY_DEFAULT_LONG_SIZES];
  if (!categories.includes("long")) longSizes = [];
  const li = Number(r.longItems);
  const longItems = Number.isInteger(li) && li >= 1 ? Math.min(li, QUALITY_MAX_LONG_ITEMS) : QUALITY_DEFAULT_LONG_ITEMS;
  const cc = Number(r.concurrency);
  const concurrency =
    Number.isInteger(cc) && cc >= 1 ? Math.min(cc, QUALITY_MAX_CONCURRENCY) : QUALITY_DEFAULT_CONCURRENCY;
  const label = typeof r.label === "string" ? r.label.replace(/\s+/g, " ").trim().slice(0, QUALITY_LABEL_MAX) : "";
  // Noise floor: every category runs again at the same settings, and twice more at concurrency 1
  // when the run is batched, so run-to-run and batch noise are measured beside the score.
  const noiseFloor = r.noiseFloor === true || r.noiseFloor === "true" || r.noiseFloor === 1;
  return { categories, longSizes, longItems, concurrency, label, noiseFloor };
}

/**
 * Model id + context length from `/v1/models` (vLLM max_model_len, ds4/others
 * context_length). Best-effort: returns nulls on any failure.
 */
export async function fetchModelInfo(baseUrl, { apiKey = null, signal = null } = {}) {
  /** @type {Record<string, string>} */
  const headers = { Accept: "application/json" };
  const key = apiKey != null ? String(apiKey).trim() : "";
  if (key) headers.Authorization = `Bearer ${key}`;
  const timeout = AbortSignal.timeout(MODEL_INFO_TIMEOUT_MS);
  try {
    const res = await undiciFetch(`${baseUrl}/v1/models`, {
      headers,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      dispatcher: LLM_STREAM_AGENT,
    });
    if (!res.ok) return { modelId: null, contextLength: null };
    const data = await res.json();
    const first = Array.isArray(data?.data) ? data.data[0] : null;
    const ctx = Number(first?.max_model_len ?? first?.context_length ?? first?.meta?.n_ctx_train);
    return {
      modelId: typeof first?.id === "string" ? first.id : null,
      contextLength: Number.isFinite(ctx) && ctx > 0 ? Math.round(ctx) : null,
    };
  } catch {
    return { modelId: null, contextLength: null };
  }
}

function replyHash(text) {
  return createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);
}

/** The reply to keep for an audit: the whole visible answer, or its head / tail when very long. */
function replyKeep(item, answer) {
  const text = visibleAnswer(answer);
  if (text.length <= REPLY_KEEP_CHARS) return text;
  return item.thinking ? `…${text.slice(-REPLY_KEEP_CHARS)}` : `${text.slice(0, REPLY_KEEP_CHARS)}…`;
}

function excerptOf(item, answer, reasoning) {
  const text = visibleAnswer(answer).replace(/\s+/g, " ").trim();
  if (!text) return reasoning ? "(no answer — reasoning only)" : "(empty reply)";
  if (text.length <= EXCERPT_CHARS) return text;
  // Thinking categories put the verdict at the end; others answer up front.
  return item.thinking ? `…${text.slice(-EXCERPT_CHARS)}` : `${text.slice(0, EXCERPT_CHARS)}…`;
}

function requestBody(modelId, item, prompt) {
  const body = {
    model: modelId || undefined,
    messages: [{ role: "user", content: prompt }],
    max_tokens: item.maxTokens,
    temperature: 0,
    top_p: 1,
    seed: REQUEST_SEED,
    stream: true,
    stream_options: { include_usage: true },
  };
  applyThinkingFlags(body, modelId, item.thinking);
  return body;
}

/**
 * One item: request and score.
 * @returns {Promise<object>} item row
 */
export async function runQualityItem({ baseUrl, modelId, item, abortSignal, apiKey = null }) {
  const prompt = item.category === "long" ? buildLongPrompt(item) : item.prompt;
  const timeoutMs = timeoutMsForItem(item);
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort();
  if (abortSignal) {
    if (abortSignal.aborted) ctrl.abort();
    else abortSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const t0 = performance.now();
  try {
    const result = await runStreamingRequest(
      `${baseUrl}/v1/chat/completions`,
      requestBody(modelId, item, prompt),
      ctrl.signal,
      { collectContent: true, debug: true, retryOnThinking400: true, thinking: item.thinking, apiKey }
    );
    const answer = String(result.answer || "");
    const reasoning = String(result.reasoning || "");
    const reasoningTokens = result.usage?.reasoningTokens;
    const row = {
      id: item.id,
      category: item.category,
      ok: false,
      excerpt: excerptOf(item, answer, reasoning),
      hash: replyHash(answer),
      finishReason: result.finishReason || null,
      completionTokens: Number(result.usage?.completionTokens ?? result.completionTokens) || 0,
      promptTokens: Number(result.usage?.promptTokens ?? result.prefillTokens) || 0,
      // Reasoning as the server counted it (null when it reports none), and the reasoning text's
      // length, so a thinking-off category that still reasons is visible per row.
      reasoningTokens: Number.isFinite(reasoningTokens) ? reasoningTokens : null,
      reasoningChars: reasoning.length,
      durationMs: round2(performance.now() - t0),
      model: result.model || null,
      error: null,
      detail: null,
    };
    if (item.category === "long") row.size = item.size;
    row.thinking = Boolean(item.thinking);
    if (timedOut) {
      row.error = `Timed out after ${Math.round(timeoutMs / 1000)}s`;
      return row;
    }
    if (result.error) {
      row.error = String(result.error);
      return row;
    }
    const s = scoreItem(item, answer);
    row.ok = Boolean(s.ok);
    if (item.disputed) row.disputed = true;
    // Only rows a reader may need to audit carry the full reply: a pass is its own evidence.
    if (!row.ok || row.disputed) row.reply = replyKeep(item, answer);
    if (!row.ok && reasoning) {
      row.reasoning = reasoning.length <= REASONING_KEEP_CHARS ? reasoning : `…${reasoning.slice(-REASONING_KEEP_CHARS)}`;
    }
    if (item.category === "long") {
      row.longCorrect = s.correct;
      row.longTotal = s.total;
      row.longStale = s.stale;
      row.gradeCorrect = s.correct;
      row.gradeTotal = s.total;
      row.detail = `${s.correct}/${s.total} keys${s.stale ? `, ${s.stale} stale` : ""}`;
    } else if (Number(s.gradeTotal) > 0) {
      // Suite v2 graded scorers (arithmetic steps, tracked people): the grade beside the parsed answer.
      row.gradeCorrect = s.gradeCorrect;
      row.gradeTotal = s.gradeTotal;
      row.detail = [s.parsed != null ? `parsed ${s.parsed}` : s.labeled === false ? "no 'Answer:' line" : "could not read the 'Answer:' line", s.detail].filter(Boolean).join(" · ");
    } else if (item.category === "follow") {
      row.detail = `${s.passed}/${s.total} rules${s.failed?.length ? ` · failed: ${s.failed.join(", ")}` : ""}`;
    } else if ("parsed" in s) {
      // "no 'Answer:' line" only when the reply truly has none; a present-but-unreadable line
      // (e.g. "Answer: five", "Answer: B or C") says so.
      if (s.parsed != null) row.detail = `parsed ${s.parsed}`;
      else row.detail = s.labeled === false ? "no 'Answer:' line" : "could not read the 'Answer:' line";
    }
    if (item.disputed) row.detail = `${row.detail ? `${row.detail} · ` : ""}disputed reference, not scored: ${item.disputed}`;
    return row;
  } finally {
    clearTimeout(timer);
    if (abortSignal) abortSignal.removeEventListener("abort", onParentAbort);
  }
}

/** Summary-only copy for history listings (drops per-item rows). */
function summaryOf(job) {
  if (!job) return job;
  const { results, ...rest } = withResumable(job);
  return {
    ...rest,
    results: results ? resultsSummary(results) : results,
  };
}

/**
 * A finished run that still has items to score can be relaunched from its saved rows: one killed
 * by a server restart, stopped by an error streak, or cancelled. It must have been scored by this
 * server's suite and scoring rules, or the old and new rows would not be comparable.
 */
export function isResumable(record) {
  if (!record || record.status === "running" || record.status === "completed") return false;
  const c = record.config || {};
  if (c.suiteVersion !== SUITE_VERSION || c.scoringVersion !== SCORING_VERSION) return false;
  const total = Number(record.progress?.total) || 0;
  const done = Number(record.progress?.done) || 0;
  return total > 0 && done < total && done > 0 && Array.isArray(record.results?.items);
}

/** A stored record with `resumable` set for the dialog. */
function withResumable(record) {
  return record && record.status !== "running" ? { ...record, resumable: isResumable(record) } : record;
}

/** The results without per-item rows (and without the noise-floor passes' rows). */
function resultsSummary(results) {
  return {
    categories: results.categories,
    overallPct: results.overallPct,
    skippedLongSizes: results.skippedLongSizes,
    itemCount: results.items?.length ?? 0,
    ...(results.noise ? { noise: results.noise } : {}),
    ...(results.longTokens ? { longTokens: results.longTokens } : {}),
    ...(results.overallCi ? { overallCi: results.overallCi } : {}),
    ...(results.warnings?.length ? { warnings: results.warnings } : {}),
    ...(results.fidelity ? { fidelity: results.fidelity } : {}),
    ...(results.fidelityUnsupported ? { fidelityUnsupported: results.fidelityUnsupported } : {}),
  };
}

/**
 * @param {object} job
 * @param {{ full?: boolean }} [opts] full = include per-item rows. A running job omits them by
 *   default (the dialog polls every second; the rows are only needed once it finishes).
 */
function publicJob(job, { full = job.status !== "running" } = {}) {
  const results = full || !job.results ? job.results : resultsSummary(job.results);
  return {
    benchId: job.benchId,
    sparkId: job.sparkId,
    status: job.status,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    config: { ...job.config },
    progress: { ...job.progress },
    results,
    // WP0: the engine's build record and measured capabilities (null until probed).
    engine: job.engine ?? null,
    // WP4: the unit the run was made on and the cost side read from the probe at start.
    unit: job.unit ?? null,
    cost: job.cost ?? null,
    error: job.error,
    // Paused: the gate is closed between items; in-flight replies finish first. The clock below
    // excludes the time spent paused, so a run paused overnight still reports its working time.
    // Relaunched from saved rows: how many times, when last, and how many rows it took over.
    ...(job.resumes ? { resumes: job.resumes, resumedAt: job.resumedAt ?? null, resumedFrom: job.resumedFrom ?? null } : {}),
    paused: Boolean(job.paused),
    pausedAt: job.pausedAt ?? null,
    pausedMs: pausedMsOf(job),
    durationMs: (job.completedAt != null ? job.completedAt - job.startedAt : Date.now() - job.startedAt) - pausedMsOf(job),
    owner: job.owner || null,
  };
}

/** Time the job has spent paused so far, the current pause included. */
function pausedMsOf(job) {
  const settled = job.pausedMs || 0;
  return job.paused && job.pausedAt != null ? settled + Date.now() - job.pausedAt : settled;
}

function emptyResults() {
  return { items: [], categories: {}, overallPct: null, skippedLongSizes: [] };
}

export class QualityBenchManager {
  constructor(historyPath = HISTORY_PATH, activePath = ACTIVE_PATH, fidelityDir = undefined, referencesPath = REFERENCES_PATH) {
    /** @type {Map<string, object>} */
    this.jobs = new Map();
    /** Where fidelity side files live; undefined = the module default (config/quality-fidelity). */
    this.fidelityDir = fidelityDir;
    this.referencesPath = referencesPath;
    /** @type {Record<string, { sparkId: string, benchId: string, modelId: string | null, pinnedAt: number }>} family key → reference run */
    this.references = {};
    this._loadReferences();
    /** @type {Map<string, string>} */
    this.activeBySpark = new Map();
    /** @type {Map<string, object[]>} */
    this.historyBySpark = new Map();
    this.historyPath = historyPath;
    this.activePath = activePath;
    /** @type {((kind: string, job: object) => void) | null} */
    this._onEvent = null;
    this._lastCheckpoint = 0;
    this._pendingActive = null;
    this._checkpointTimer = null;
    this._activeWriting = false;
    this._activeSyncEpoch = 0;
    this._loadHistory();
    this._recoverInterruptedActive();
  }

  /** Optional sink invoked once when a job reaches completed/failed/cancelled. */
  setEventSink(fn) {
    this._onEvent = typeof fn === "function" ? fn : null;
  }

  _emitFinished(job) {
    if (!this._onEvent) return;
    try {
      this._onEvent("quality", job);
    } catch {
      /* event recording must never break the bench */
    }
  }

  activeCount() {
    return this.activeBySpark.size;
  }

  /** @param {{ full?: boolean }} [opts] full: include per-item rows even while running */
  getJob(benchId, opts = {}) {
    const job = this.jobs.get(benchId);
    if (job) return withResumable(publicJob(job, opts.full ? { full: true } : undefined));
    for (const list of this.historyBySpark.values()) {
      const found = list.find((j) => j.benchId === benchId);
      if (found) return withResumable(found);
    }
    return null;
  }

  getActive(sparkId) {
    const id = this.activeBySpark.get(sparkId);
    if (!id) return null;
    const job = this.jobs.get(id);
    return job ? publicJob(job) : null;
  }

  getHistory(sparkId) {
    return this.historyBySpark.get(sparkId) || [];
  }

  /** History without per-item rows (the dialog fetches a full run by id to compare). */
  getHistorySummaries(sparkId, port = null) {
    const p = port != null ? Number(port) : null;
    return this.getHistory(sparkId)
      .filter((j) => p == null || !Number.isInteger(p) || j.config?.port === p)
      .map(summaryOf);
  }

  getLast(sparkId, port = null) {
    const hist = this.getHistory(sparkId);
    if (!hist.length) return null;
    if (port != null) {
      const p = Number(port);
      const match = hist.find((j) => j.config?.port === p && j.results?.items?.length > 0);
      if (match) return withResumable(match);
      const anyPort = hist.find((j) => j.config?.port === p);
      if (anyPort) return withResumable(anyPort);
    }
    return withResumable(hist[0] || null);
  }

  clearHistory(sparkId, port = null) {
    const p = port != null ? Number(port) : null;
    const portScoped = p != null && Number.isInteger(p);
    const list = portScoped ? this.getHistory(sparkId).filter((j) => j.config?.port !== p) : [];
    if (list.length) this.historyBySpark.set(sparkId, list);
    else this.historyBySpark.delete(sparkId);
    for (const [benchId, job] of this.jobs.entries()) {
      if (job.sparkId === sparkId && job.status !== "running" && (!portScoped || job.config?.port === p)) {
        this.jobs.delete(benchId);
      }
    }
    this._saveHistory();
    this._pruneFidelity();
    return { ok: true };
  }

  // ── WP4: fleet listing and reference pinning ────────────────────────────────────────────

  /** Every unit's saved runs, summaries only, newest first across the fleet. */
  getFleetSummaries() {
    const out = [];
    for (const [sparkId, list] of this.historyBySpark.entries()) {
      for (const j of list) out.push({ ...summaryOf(j), sparkId });
    }
    out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return out;
  }

  _loadReferences() {
    try {
      if (!fs.existsSync(this.referencesPath)) return;
      const data = JSON.parse(fs.readFileSync(this.referencesPath, "utf8"));
      if (data && typeof data === "object" && !Array.isArray(data)) this.references = data;
    } catch (err) {
      console.warn("[QualityBench] failed to load references:", err?.message || err);
    }
  }

  _saveReferences() {
    try {
      atomicWrite(this.referencesPath, JSON.stringify(this.references, null, 2), 0o600);
    } catch (err) {
      console.warn("[QualityBench] failed to save references:", err?.message || err);
    }
  }

  getReferences() {
    return { ...this.references };
  }

  /** The pinned reference for a model id's family, or null. */
  referenceFor(modelId) {
    const key = qualityFamilyKey(modelId);
    return key && this.references[key] ? { key, ...this.references[key] } : null;
  }

  /**
   * Pin a saved run as the reference for its model family (comparisons default to it).
   * @returns {{ ok: true, key: string } | { ok: false, reason: "missing" | "running" | "no-model" }}
   */
  setReference(sparkId, benchId) {
    const job = this.getJob(benchId);
    if (!job || job.sparkId !== sparkId) return { ok: false, reason: "missing" };
    if (job.status === "running") return { ok: false, reason: "running" };
    const key = qualityFamilyKey(job.config?.modelId);
    if (!key) return { ok: false, reason: "no-model" };
    this.references[key] = { sparkId, benchId, modelId: job.config.modelId, pinnedAt: Date.now() };
    this._saveReferences();
    return { ok: true, key };
  }

  clearReference(key) {
    if (!this.references[key]) return { ok: false, reason: "missing" };
    delete this.references[key];
    this._saveReferences();
    return { ok: true };
  }

  /** Every run id still in some history list; fidelity side files outside it are dropped. */
  _pruneFidelity() {
    const keep = [];
    for (const list of this.historyBySpark.values()) for (const j of list) keep.push(j.benchId);
    for (const job of this.jobs.values()) keep.push(job.benchId);
    pruneFidelitySides(keep, this.fidelityDir);
  }

  /** The per-position fidelity data of a saved run (null when the run has none). */
  getFidelitySide(benchId) {
    return readFidelitySide(benchId, this.fidelityDir);
  }

  /**
   * Fidelity comparison of a test run (A) against a reference run (B). The reference may sit on
   * another unit (WP4 cross-unit compare); each run must exist on the unit named for it.
   */
  compareFidelityRuns(sparkId, benchIdA, benchIdB, sparkIdB = sparkId) {
    const a = this.getJob(benchIdA);
    const b = this.getJob(benchIdB);
    if (!a || a.sparkId !== sparkId || !b || b.sparkId !== sparkIdB) return null;
    const out = compareFidelity(this.getFidelitySide(benchIdA), this.getFidelitySide(benchIdB));
    return { a: benchIdA, b: benchIdB, ...out };
  }

  /**
   * Remove one saved run from history, leaving the other runs of the unit (and of the
   * other ports) in place. A run still in flight is refused: cancel it first with
   * `DELETE …/quality-bench/:benchId`, then delete it here.
   * @returns {{ ok: true } | { ok: false, reason: "running" | "missing" }}
   */
  deleteRun(sparkId, benchId) {
    const job = this.jobs.get(benchId);
    if (job && job.sparkId === sparkId && job.status === "running") return { ok: false, reason: "running" };
    const list = this.getHistory(sparkId);
    const index = list.findIndex((j) => j.benchId === benchId);
    if (index < 0) return { ok: false, reason: "missing" };
    list.splice(index, 1);
    if (list.length) this.historyBySpark.set(sparkId, list);
    else this.historyBySpark.delete(sparkId);
    // A finished run can still sit in `jobs` until the next prune; drop it too, so
    // `GET …/:benchId` stops answering for a run the user deleted.
    if (job && job.sparkId === sparkId) this.jobs.delete(benchId);
    this._saveHistory();
    deleteFidelitySide(benchId, this.fidelityDir);
    return { ok: true };
  }

  _loadHistory() {
    try {
      if (!fs.existsSync(this.historyPath)) return;
      const data = JSON.parse(fs.readFileSync(this.historyPath, "utf8"));
      if (!data || typeof data !== "object") return;
      for (const [sparkId, list] of Object.entries(data)) {
        if (!Array.isArray(list)) continue;
        const cleaned = list
          .filter((j) => j && typeof j === "object" && j.benchId && j.sparkId)
          .slice(0, HISTORY_LIMIT)
          .map((j) => ({ ...j, status: j.status === "running" ? "cancelled" : j.status || "completed" }));
        if (cleaned.length) this.historyBySpark.set(sparkId, cleaned);
      }
    } catch (err) {
      console.warn("[QualityBench] failed to load history:", err?.message || err);
    }
  }

  _recoverInterruptedActive() {
    const leftovers = this._readActiveFile();
    if (!leftovers.length) return;
    let changed = false;
    for (const snap of leftovers) {
      if (!snap?.benchId || !snap?.sparkId) continue;
      if (this.getHistory(snap.sparkId).some((j) => j.benchId === snap.benchId)) continue;
      const interrupted = {
        ...snap,
        status: "failed",
        error: snap.error || "Interrupted — server restarted while the benchmark was running",
        completedAt: snap.completedAt || Date.now(),
        progress: { ...(snap.progress || {}), message: "Interrupted", currentCategory: null },
      };
      if (interrupted.completedAt && interrupted.startedAt) {
        interrupted.durationMs = interrupted.completedAt - interrupted.startedAt;
      }
      this._pushHistory(interrupted);
      changed = true;
      console.warn(`[QualityBench] recovered interrupted job ${interrupted.benchId} on ${interrupted.sparkId}`);
    }
    this._writeActiveFile([]);
    if (changed) this._saveHistory();
  }

  _readActiveFile() {
    try {
      if (!fs.existsSync(this.activePath)) return [];
      const data = JSON.parse(fs.readFileSync(this.activePath, "utf8"));
      if (Array.isArray(data)) return data;
      if (data && typeof data === "object" && Array.isArray(data.jobs)) return data.jobs;
      return [];
    } catch (err) {
      console.warn("[QualityBench] failed to load active jobs:", err?.message || err);
      return [];
    }
  }

  _writeActiveFile(jobs) {
    // Supersedes any queued/in-flight async snapshot.
    this._activeSyncEpoch += 1;
    this._pendingActive = null;
    try {
      atomicWrite(this.activePath, JSON.stringify({ jobs }), 0o600);
    } catch (err) {
      console.warn("[QualityBench] failed to save active jobs:", err?.message || err);
    }
  }

  _runningSnapshots() {
    const running = [];
    for (const job of this.jobs.values()) {
      if (job.status === "running") running.push(publicJob(job, { full: true }));
    }
    return running;
  }

  /**
   * Persist the running jobs. `force` (status changes, category boundaries, finish) writes
   * synchronously; the per-item checkpoints are throttled and written off the event loop.
   * @param {boolean} [force] skip the throttle
   */
  _checkpointActive(force = true) {
    const now = Date.now();
    if (!force && now - this._lastCheckpoint < CHECKPOINT_INTERVAL_MS) {
      // Trailing edge: the latest rows still get written once the interval has passed.
      if (!this._checkpointTimer) {
        this._checkpointTimer = setTimeout(() => {
          this._checkpointTimer = null;
          this._checkpointActive(false);
        }, CHECKPOINT_INTERVAL_MS - (now - this._lastCheckpoint) + 5);
        this._checkpointTimer.unref?.();
      }
      return;
    }
    this._lastCheckpoint = now;
    if (force) {
      this._writeActiveFile(this._runningSnapshots());
      return;
    }
    const running = this._runningSnapshots();
    if (running.length) this._writeActiveFileAsync(running);
  }

  _writeActiveFileAsync(jobs) {
    // One write in flight; a newer snapshot replaces any queued one.
    this._pendingActive = jobs;
    if (this._activeWriting) return;
    this._activeWriting = true;
    const tmp = `${this.activePath}.${process.pid}.async.tmp`;
    const pump = async () => {
      try {
        while (this._pendingActive) {
          const snap = this._pendingActive;
          this._pendingActive = null;
          // A synchronous write (finish/interrupt) may have cleared the file since: skip stale data.
          if (this._activeSyncEpoch !== epoch) break;
          await fs.promises.mkdir(path.dirname(this.activePath), { recursive: true });
          await fs.promises.writeFile(tmp, JSON.stringify({ jobs: snap }), { mode: 0o600 });
          if (this._activeSyncEpoch !== epoch) {
            await fs.promises.unlink(tmp).catch(() => {});
            break;
          }
          await fs.promises.rename(tmp, this.activePath);
        }
      } catch (err) {
        console.warn("[QualityBench] failed to save active jobs:", err?.message || err);
        await fs.promises.unlink(tmp).catch(() => {});
      } finally {
        this._activeWriting = false;
      }
    };
    const epoch = this._activeSyncEpoch;
    void pump();
  }

  interruptAll(reason = "Interrupted — server shutting down") {
    for (const job of this.jobs.values()) {
      if (job.status !== "running") continue;
      try {
        job._abort?.abort();
      } catch {
        /* ignore */
      }
      try {
        job._closeTarget?.();
      } catch {
        /* ignore */
      }
      job._closeTarget = null;
      job.status = "failed";
      job.error = reason;
      job.progress.message = "Interrupted";
      job.progress.currentCategory = null;
      job.completedAt = Date.now();
      this._settlePause(job);
      this._finalizeResults(job);
      if (this.activeBySpark.get(job.sparkId) === job.benchId) this.activeBySpark.delete(job.sparkId);
      this._pushHistory(job);
    }
    this._writeActiveFile([]);
  }

  _saveHistory() {
    try {
      const out = {};
      for (const [sparkId, list] of this.historyBySpark.entries()) out[sparkId] = list;
      atomicWrite(this.historyPath, JSON.stringify(out), 0o600);
    } catch (err) {
      console.warn("[QualityBench] failed to save history:", err?.message || err);
    }
  }

  /**
   * @param {{
   *   sparkId: string, lanIp: string, port: number, modelId: string | null,
   *   contextLength?: number | null, categories?: string[], longSizes?: number[],
   *   longItems?: number, concurrency?: number, label?: string,
   *   apiKey?: string | null, resolveTarget?: Function | null,
   *   host?: string | null, tls?: boolean, owner?: { id: string, via: string } | null,
   * }} opts
   */
  start(opts) {
    const {
      sparkId,
      lanIp,
      port,
      modelId,
      contextLength = null,
      apiKey = null,
      resolveTarget = null,
      host: rawHost = null,
      tls: rawTls = false,
      owner = null,
      backend = null,
      unit = null,
      cost = null,
    } = opts;

    this._assertUnitFree(sparkId);

    const settings = normalizeQualityOptions(opts);
    if (!settings.categories.length) {
      const err = new Error(`Select at least one category (${QUALITY_CATEGORIES.join(", ")})`);
      err.status = 400;
      throw err;
    }
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      const err = new Error("Invalid LLM port");
      err.status = 400;
      throw err;
    }
    const ctx = Number(contextLength);

    const benchId = randomUUID();
    const job = {
      benchId,
      sparkId,
      status: "running",
      startedAt: Date.now(),
      completedAt: null,
      config: {
        port: p,
        modelId: modelId || null,
        contextLength: Number.isFinite(ctx) && ctx > 0 ? Math.round(ctx) : null,
        suiteVersion: SUITE_VERSION,
        scoringVersion: SCORING_VERSION,
        // WP1: only a named profile carries a headline overall; a custom category set is a partial run.
        profile: qualityProfile(settings.categories),
        ...settings,
        ...(rawHost ? { host: String(rawHost).trim(), tls: Boolean(rawTls) } : {}),
      },
      progress: {
        currentCategory: null,
        categoryDone: 0,
        categoryTotal: 0,
        done: 0,
        total: 0,
        message: "Starting…",
      },
      results: emptyResults(),
      engine: null,
      unit: unit && typeof unit === "object" && unit.id ? { id: String(unit.id), name: String(unit.name || unit.id) } : { id: sparkId, name: sparkId },
      cost: cost && typeof cost === "object" ? { ...cost } : null,
      error: null,
      paused: false,
      pausedAt: null,
      pausedMs: 0,
      _abort: new AbortController(),
      _fatal: null,
      _resume: null,
      _inFlight: 0,
      _backend: typeof backend === "string" && backend.trim() ? backend.trim() : null,
      _apiKey: apiKey != null && String(apiKey).trim() ? String(apiKey).trim() : null,
      _resolveTarget: typeof resolveTarget === "function" ? resolveTarget : null,
      _closeTarget: null,
      owner: owner ? { id: owner.id, via: owner.via } : null,
    };

    return this._launch(job, lanIp);
  }

  _assertUnitFree(sparkId) {
    if (this.activeBySpark.has(sparkId)) {
      const err = new Error("A quality benchmark is already running for this Spark");
      err.status = 409;
      throw err;
    }
    if (decodeBenchManager.getActive(sparkId)) {
      const err = new Error("A decode benchmark is already running for this Spark");
      err.status = 409;
      throw err;
    }
    if (prefillBenchManager.getActive(sparkId)) {
      const err = new Error("A prefill benchmark is already running for this Spark");
      err.status = 409;
      throw err;
    }
  }

  _launch(job, lanIp) {
    this.jobs.set(job.benchId, job);
    this.activeBySpark.set(job.sparkId, job.benchId);
    this._checkpointActive();

    this._runJob(job, lanIp).catch(() => {
      /* errors recorded on job */
    });

    return publicJob(job);
  }

  /**
   * Relaunch a finished run from its saved rows, under the same id. The rows already scored stay
   * and their items are skipped; the rest run as a new job with the record's settings. Fidelity
   * rows are rerun (their per-position data is only written when a run finishes). The time the
   * run was down counts as paused, so its clock stays the working time. The record leaves the
   * history while the run is live and takes its place again when it ends.
   * @param {string} sparkId
   * @param {string} benchId
   * @param {{ lanIp: string, apiKey?: string | null, resolveTarget?: Function | null, backend?: string | null,
   *   unit?: { id: string, name: string } | null, cost?: object | null, owner?: object | null }} opts
   */
  resumeRun(sparkId, benchId, opts) {
    const list = this.getHistory(sparkId);
    const record = list.find((j) => j.benchId === benchId);
    if (!record) {
      const err = new Error("Benchmark not found");
      err.status = 404;
      throw err;
    }
    if (!isResumable(record)) {
      const err = new Error(
        record.status === "completed"
          ? "This run finished; nothing to resume"
          : record.config?.suiteVersion !== SUITE_VERSION || record.config?.scoringVersion !== SCORING_VERSION
            ? "This run was scored by an older suite; its rows cannot be continued with the current rules"
            : "This run has no scored rows to continue from"
      );
      err.status = 409;
      throw err;
    }
    this._assertUnitFree(sparkId);

    const now = Date.now();
    const keep = (rows) => (Array.isArray(rows) ? rows.filter((r) => r && r.category !== "fidelity") : []);
    const passes = Array.isArray(record.results.passes)
      ? record.results.passes.map((p) => ({ index: p.index, kind: p.kind, concurrency: p.concurrency, items: keep(p.items) }))
      : undefined;
    const items = keep(record.results.items);
    const done = items.length + (passes ? passes.reduce((n, p) => n + p.items.length, 0) : 0);
    const downtime = record.completedAt != null ? Math.max(0, now - record.completedAt) : 0;
    const job = {
      benchId,
      sparkId,
      status: "running",
      startedAt: record.startedAt,
      completedAt: null,
      config: { ...record.config },
      progress: {
        currentCategory: null,
        categoryDone: 0,
        categoryTotal: 0,
        done,
        total: record.progress.total,
        message: `Resuming from ${done.toLocaleString("en-US")} scored items…`,
      },
      results: { ...emptyResults(), items, skippedLongSizes: record.results.skippedLongSizes || [], ...(passes ? { passes } : {}) },
      engine: record.engine ?? null,
      unit: opts.unit && opts.unit.id ? { id: String(opts.unit.id), name: String(opts.unit.name || opts.unit.id) } : record.unit ?? null,
      cost: opts.cost && typeof opts.cost === "object" ? { ...opts.cost } : record.cost ?? null,
      error: null,
      paused: false,
      pausedAt: null,
      pausedMs: (record.pausedMs || 0) + downtime,
      resumes: (record.resumes || 0) + 1,
      resumedAt: now,
      resumedFrom: done,
      _abort: new AbortController(),
      _fatal: null,
      _resume: null,
      _inFlight: 0,
      _backend: typeof opts.backend === "string" && opts.backend.trim() ? opts.backend.trim() : record.engine?.record?.backend ?? null,
      _apiKey: opts.apiKey != null && String(opts.apiKey).trim() ? String(opts.apiKey).trim() : null,
      _resolveTarget: typeof opts.resolveTarget === "function" ? opts.resolveTarget : null,
      _closeTarget: null,
      owner: opts.owner ? { id: opts.owner.id, via: opts.owner.via } : record.owner || null,
    };
    this._updateSummary(job);
    // The record comes back under the same id when the run ends (or is interrupted again).
    const rest = list.filter((j) => j.benchId !== benchId);
    if (rest.length) this.historyBySpark.set(sparkId, rest);
    else this.historyBySpark.delete(sparkId);
    this._saveHistory();
    return this._launch(job, opts.lanIp);
  }

  cancel(sparkId, benchId) {
    const job = this.jobs.get(benchId);
    if (!job) {
      // Finished jobs are pruned from `jobs`; answer from history.
      const done = this.getHistory(sparkId).find((j) => j.benchId === benchId);
      return done || null;
    }
    if (job.sparkId !== sparkId) return null;
    if (job.status !== "running") return publicJob(job);
    job._abort.abort();
    job.progress.message = "Cancelling…";
    return publicJob(job);
  }

  /**
   * Close the gate the workers pass between items: replies already in flight finish and are
   * kept, nothing new is sent until `resume`. A paused run stays "running" (its unit slot, the
   * history and the delete rules are unchanged); `paused` on the job says so. Idempotent.
   * @returns {object | null} the public job, null when unknown
   */
  pause(sparkId, benchId) {
    const job = this.jobs.get(benchId);
    if (!job || job.sparkId !== sparkId) return null;
    if (job.status !== "running" || job.paused) return publicJob(job);
    job.paused = true;
    job.pausedAt = Date.now();
    job._pausedMessage = job.progress.message;
    job.progress.message = job._inFlight > 0 ? `Pausing — ${job._inFlight} in flight finishing…` : "Paused";
    this._checkpointActive();
    return publicJob(job);
  }

  /** Reopen the gate; the run carries on from the next item. Idempotent. */
  resume(sparkId, benchId) {
    const job = this.jobs.get(benchId);
    if (!job || job.sparkId !== sparkId) return null;
    if (job.status !== "running" || !job.paused) return publicJob(job);
    job.pausedMs = (job.pausedMs || 0) + (Date.now() - job.pausedAt);
    job.paused = false;
    job.pausedAt = null;
    job.progress.message = job._pausedMessage || job.progress.message;
    job._pausedMessage = null;
    this._releaseGate(job);
    this._checkpointActive();
    return publicJob(job);
  }

  /** A run that ends while paused folds the open pause into `pausedMs` and clears the flag. */
  _settlePause(job) {
    if (!job.paused) return;
    if (job.pausedAt != null) job.pausedMs = (job.pausedMs || 0) + (Date.now() - job.pausedAt);
    job.paused = false;
    job.pausedAt = null;
  }

  _releaseGate(job) {
    const wake = job._resume;
    job._resume = null;
    job._gate = null;
    wake?.();
  }

  /** Workers call this between items: parks until resumed or aborted. */
  async _waitWhilePaused(job) {
    const signal = job._abort.signal;
    while (job.paused && !signal.aborted) {
      if (!job._gate) job._gate = new Promise((resolve) => (job._resume = resolve));
      if (job._inFlight === 0 && job.progress.message !== "Paused") {
        job.progress.message = "Paused";
        this._checkpointActive();
      }
      await job._gate;
    }
  }

  /** Refresh the category summary only (cheap; per item). */
  _updateSummary(job) {
    const { categories, overallPct } = summarize(job.results.items);
    job.results.categories = categories;
    job.results.overallPct = job.config.profile === "custom" ? null : overallPct;
    // Early warning while the run is still going, so a model that ignores "thinking off" is
    // noticed after ten rows rather than after a wasted hour.
    job.results.warnings = thinkingWarnings(job.results.items);
  }

  /** Sort rows into suite order and summarize — once, when the job ends. */
  _finalizeResults(job) {
    const order = new Map((job._suiteOrder || []).map((id, i) => [id, i]));
    const bySuite = (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
    job.results.items.sort(bySuite);
    const { categories, overallPct } = summarize(job.results.items);
    job.results.categories = categories;
    job.results.overallPct = job.config.profile === "custom" ? null : overallPct;
    job.results.warnings = thinkingWarnings(job.results.items, { final: true });
    // WP1 intervals: the overall's stratified bootstrap and the prompt-clustered long-recall interval.
    const intervals = qualityIntervals(job.results.items);
    job.results.overallCi = job.results.overallPct != null ? intervals.overallCi : null;
    if (intervals.keysCi && categories.long) categories.long.keysCi = intervals.keysCi;
    for (const [category, ci] of Object.entries(intervals.gradeCi)) if (categories[category]) categories[category].gradeCi = ci;
    if (Array.isArray(job.results.passes) && job.results.passes.length) {
      for (const p of job.results.passes) p.items.sort(bySuite);
      job.results.noise = noiseSummary(job.results.items, job.results.passes, job.config.concurrency);
    }
    // Measured prompt tokens per long size (the sizes themselves are word-count estimates).
    const longRows = job.results.items.filter((r) => r.category === "long" && r.size && r.promptTokens > 0);
    if (longRows.length) {
      /** @type {Record<string, number>} */
      const longTokens = {};
      for (const size of new Set(longRows.map((r) => r.size))) {
        const rows = longRows.filter((r) => r.size === size);
        longTokens[size] = Math.round(rows.reduce((n, r) => n + r.promptTokens, 0) / rows.length);
      }
      job.results.longTokens = longTokens;
    }
  }

  async _runJob(job, lanIp) {
    let host = lanIp;
    let port = job.config.port;
    let tls = Boolean(job.config.tls);
    const signal = job._abort.signal;
    // A cancel, a fatal stop or a shutdown must wake parked workers so the run can finish.
    signal.addEventListener("abort", () => this._releaseGate(job), { once: true });
    try {
      if (typeof job._resolveTarget === "function") {
        job.progress.message = "Connecting to LLM…";
        this._checkpointActive();
        const target = await job._resolveTarget({
          onStatus: (msg) => {
            if (typeof msg === "string" && msg) job.progress.message = msg;
            this._checkpointActive();
          },
          signal,
        });
        host = target?.host || host;
        port = Number.isInteger(target?.port) ? target.port : port;
        if (target?.tls != null) tls = Boolean(target.tls);
        job._closeTarget = typeof target?.close === "function" ? target.close : null;
      }
      const baseUrl = formatLlmBaseUrl({ host, port, tls });

      if (!signal.aborted && (!job.config.modelId || job.config.contextLength == null)) {
        job.progress.message = "Reading /v1/models…";
        const info = await fetchModelInfo(baseUrl, { apiKey: job._apiKey, signal });
        if (!job.config.modelId && info.modelId) job.config.modelId = info.modelId;
        if (job.config.contextLength == null && info.contextLength) job.config.contextLength = info.contextLength;
      }

      // WP0: what the engine is and what it can do, on the run itself. A probe that fails leaves
      // a reason, never a failed run.
      if (!signal.aborted) {
        job.progress.message = "Probing engine…";
        this._checkpointActive();
        try {
          job.engine = await probeEngine(baseUrl, {
            modelId: job.config.modelId,
            apiKey: job._apiKey,
            signal,
            backend: job._backend,
          });
        } catch (err) {
          job.engine = { record: null, capabilities: null, error: err?.message || String(err), probedAt: Date.now() };
        }
        if (!job.config.modelId && job.engine?.record?.modelId) job.config.modelId = job.engine.record.modelId;
        if (job.config.contextLength == null && job.engine?.record?.contextLength) {
          job.config.contextLength = job.engine.record.contextLength;
        }
      }

      const { run: longSizes, skipped } = longSizesForContext(job.config.longSizes, job.config.contextLength);
      job.results.skippedLongSizes = skipped;
      let items = generateSuite({
        categories: job.config.categories,
        longSizes,
        longItems: job.config.longItems,
      });
      // WP2 fidelity: only where the probe measured prompt logprobs; "unsupported" is reported on
      // the run, never run into eight errors.
      const fidelityItems = items.filter((it) => it.category === "fidelity");
      if (fidelityItems.length) {
        const cap = job.engine?.capabilities;
        if (cap && cap.promptLogprobs === false) {
          job.results.fidelityUnsupported = cap.reason || "the engine returns no prompt log-probabilities";
          items = items.filter((it) => it.category !== "fidelity");
        } else {
          const k = fidelityK(cap);
          job.results.fidelity = {
            corpusVersion: fidelityItems[0].corpusVersion,
            corpusSha256: fidelityItems[0].corpusSha256,
            k,
            docs: fidelityItems.length,
          };
          job._fidelityK = k;
          job._fidelitySide = { docs: {} };
        }
      }
      job._suiteOrder = items.map((it) => it.id);
      const passes = planPasses(job.config.concurrency, job.config.noiseFloor);
      if (passes.length > 1) {
        // A resumed run brings the rows its extra passes already scored.
        const prior = Array.isArray(job.results.passes) ? job.results.passes : [];
        job.results.passes = passes
          .slice(1)
          .map((p) => ({ index: p.index, kind: p.kind, concurrency: p.concurrency, items: prior.find((q) => q.index === p.index)?.items ?? [] }));
      }
      job.progress.total = items.length * passes.length;
      if (job.resumes) {
        // Rows of items the current suite no longer generates (a dropped category) are let go.
        const known = new Set(items.map((it) => it.id));
        job.results.items = job.results.items.filter((r) => known.has(r.id));
        for (const p of job.results.passes || []) p.items = p.items.filter((r) => known.has(r.id));
        job.progress.done = job.results.items.length + (job.results.passes || []).reduce((n, p) => n + p.items.length, 0);
        this._updateSummary(job);
      }
      if (!items.length) {
        throw new Error(
          job.results.fidelityUnsupported
            ? `Nothing to run — fidelity is unsupported on this engine: ${job.results.fidelityUnsupported}`
            : "Nothing to run — every selected long size exceeds the model context"
        );
      }

      let consecutiveErrors = 0;
      for (const pass of passes) {
        if (signal.aborted) break;
        const sink = pass.index === 0 ? job.results.items : job.results.passes[pass.index - 1].items;
        const passTag = passes.length > 1 ? ` (pass ${pass.index + 1}/${passes.length}, concurrency ${pass.concurrency})` : "";
        // A resumed run: the rows this pass already holds are kept and their items skipped.
        const doneIds = new Set(sink.map((r) => r.id));
        for (const category of QUALITY_CATEGORIES) {
          if (signal.aborted) break;
          const catAll = items.filter((it) => it.category === category);
          if (!catAll.length) continue;
          const catItems = doneIds.size ? catAll.filter((it) => !doneIds.has(it.id)) : catAll;
          if (!catItems.length) continue;
          await this._waitWhilePaused(job);
          if (signal.aborted) break;
          job.progress.currentCategory = category;
          job.progress.categoryDone = catAll.length - catItems.length;
          job.progress.categoryTotal = catAll.length;
          job.progress.message = `${QUALITY_CATEGORY_LABELS[category]}${passTag}…`;
          this._checkpointActive();

          const width = category === "long" || category === "fidelity" ? 1 : pass.concurrency;
          let next = 0;
          const worker = async () => {
            while (!signal.aborted) {
              await this._waitWhilePaused(job);
              if (signal.aborted) return;
              const item = catItems[next++];
              if (!item) return;
              job._inFlight += 1;
              if (category === "long") {
                job.progress.message = `Long-context recall ${longSizeLabel(item.size)}${passTag}…`;
              }
              let row;
              if (category === "fidelity") {
                job.progress.message = `Fidelity ${item.docId} (~${Math.round(item.chars / 3).toLocaleString("en-US")} tokens)${passTag}…`;
                const out = await runFidelityItem({
                  baseUrl,
                  modelId: job.config.modelId,
                  item,
                  k: job._fidelityK,
                  abortSignal: signal,
                  apiKey: job._apiKey,
                });
                row = out.row;
                if (out.side && pass.index === 0 && job._fidelitySide) job._fidelitySide.docs[item.id] = out.side;
              } else if (category === "divergence") {
                row = await runDivergenceItem({
                  baseUrl,
                  modelId: job.config.modelId,
                  item,
                  abortSignal: signal,
                  apiKey: job._apiKey,
                });
              } else {
                row = await runQualityItem({
                  baseUrl,
                  modelId: job.config.modelId,
                  item,
                  abortSignal: signal,
                  apiKey: job._apiKey,
                });
              }
              job._inFlight -= 1;
              if (signal.aborted) return;
              if (job.paused && job._inFlight > 0) job.progress.message = `Pausing — ${job._inFlight} in flight finishing…`;
              if (row.model && !job.config.modelId) job.config.modelId = row.model;
              delete row.model;
              sink.push(row);
              job.progress.categoryDone += 1;
              job.progress.done += 1;
              if (row.error) {
                consecutiveErrors += 1;
                if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS && !job._fatal) {
                  job._fatal = `Stopped after ${MAX_CONSECUTIVE_ERRORS} failed requests in a row: ${row.error}`;
                  job._abort.abort();
                }
              } else {
                consecutiveErrors = 0;
              }
              if (pass.index === 0) this._updateSummary(job);
              this._checkpointActive(false);
            }
          };
          await Promise.all(Array.from({ length: Math.min(width, catItems.length) }, worker));
        }
      }

      // A run interruptAll already closed (server shutdown or reload) keeps its "failed" status and
      // reason; the abort it saw was not a user's cancel.
      if (job.status !== "running") {
        /* already finalised */
      } else if (job._fatal) {
        job.status = "failed";
        job.error = job._fatal;
        job.progress.message = "Failed";
      } else if (signal.aborted) {
        job.status = "cancelled";
        job.error = "Cancelled by user";
        job.progress.message = "Cancelled";
      } else {
        job.status = "completed";
        job.progress.message = "Done";
      }
      job.progress.currentCategory = null;
    } catch (err) {
      if (job.status === "running") {
        if (job._fatal) {
          job.status = "failed";
          job.error = job._fatal;
          job.progress.message = "Failed";
        } else if (signal.aborted) {
          job.status = "cancelled";
          job.error = "Cancelled by user";
          job.progress.message = "Cancelled";
        } else {
          job.status = "failed";
          job.error = err?.message || String(err);
          job.progress.message = "Failed";
        }
      }
    } finally {
      try {
        job._closeTarget?.();
      } catch {
        /* ignore */
      }
      job._closeTarget = null;
      if (job.completedAt == null) job.completedAt = Date.now();
      this._settlePause(job);
      this._finalizeResults(job);
      // The per-position fidelity data goes to its side file; the history keeps only the summary.
      if (job._fidelitySide && Object.keys(job._fidelitySide.docs).length) {
        try {
          writeFidelitySide(
            job.benchId,
            {
              benchId: job.benchId,
              sparkId: job.sparkId,
              modelId: job.config.modelId,
              corpusVersion: job.results.fidelity?.corpusVersion ?? null,
              corpusSha256: job.results.fidelity?.corpusSha256 ?? null,
              k: job._fidelityK,
              docs: job._fidelitySide.docs,
            },
            this.fidelityDir
          );
          if (job.results.fidelity) job.results.fidelity.sideFile = true;
        } catch (err) {
          console.warn("[QualityBench] failed to save fidelity side data:", err?.message || err);
        }
      }
      // A run interrupted in-process and already relaunched under its id must not release the
      // relaunch's slot or put its stale record back into the history.
      const superseded = this.jobs.get(job.benchId) !== job;
      // Only release the Spark if it still points at this job.
      if (!superseded && this.activeBySpark.get(job.sparkId) === job.benchId) this.activeBySpark.delete(job.sparkId);
      if (!superseded) this._pushHistory(job);
      this._checkpointActive();
      this._emitFinished(job);
      // History now holds the finished run; drop the live job (and its AbortController etc.).
      if (!superseded) this.jobs.delete(job.benchId);
    }
  }

  _pushHistory(job) {
    const list = this.historyBySpark.get(job.sparkId) || [];
    const pub = publicJob(job, { full: true });
    const existing = list.findIndex((j) => j.benchId === pub.benchId);
    if (existing >= 0) list.splice(existing, 1);
    list.unshift(pub);
    const trimmed = list.slice(0, HISTORY_LIMIT);
    this.historyBySpark.set(job.sparkId, trimmed);
    this._saveHistory();
    if (list.length > trimmed.length) this._pruneFidelity();
  }
}

export const qualityBenchManager = new QualityBenchManager();

export const QUALITY_BENCH_DEFAULTS = {
  categories: [...QUALITY_CATEGORIES],
  defaultCategories: [...QUALITY_DEFAULT_CATEGORIES],
  longSizes: [...QUALITY_LONG_SIZES],
  defaultLongSizes: [...QUALITY_DEFAULT_LONG_SIZES],
  defaultLongItems: QUALITY_DEFAULT_LONG_ITEMS,
  maxLongItems: QUALITY_MAX_LONG_ITEMS,
  defaultConcurrency: QUALITY_DEFAULT_CONCURRENCY,
  maxConcurrency: QUALITY_MAX_CONCURRENCY,
};
