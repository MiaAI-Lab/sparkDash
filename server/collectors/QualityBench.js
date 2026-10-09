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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");
const HISTORY_PATH =
  process.env.QUALITY_BENCH_HISTORY_PATH ||
  path.join(ROOT, "config", "quality-bench-history.json");
const ACTIVE_PATH =
  process.env.QUALITY_BENCH_ACTIVE_PATH ||
  path.join(ROOT, "config", "quality-bench-active.json");

const HISTORY_LIMIT = 30;
const EXCERPT_CHARS = 160;
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
  return { categories, longSizes, longItems, concurrency, label };
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
    const row = {
      id: item.id,
      category: item.category,
      ok: false,
      excerpt: excerptOf(item, answer, reasoning),
      hash: replyHash(answer),
      finishReason: result.finishReason || null,
      completionTokens: Number(result.usage?.completionTokens ?? result.completionTokens) || 0,
      promptTokens: Number(result.usage?.promptTokens ?? result.prefillTokens) || 0,
      durationMs: round2(performance.now() - t0),
      model: result.model || null,
      error: null,
      detail: null,
    };
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
    if (item.category === "long") {
      row.longCorrect = s.correct;
      row.longTotal = s.total;
      row.longStale = s.stale;
      row.detail = `${s.correct}/${s.total} keys${s.stale ? `, ${s.stale} stale` : ""}`;
    } else if (item.category === "follow") {
      row.detail = `${s.passed}/${s.total} rules`;
    } else if ("parsed" in s) {
      // "no 'Answer:' line" only when the reply truly has none; a present-but-unreadable line
      // (e.g. "Answer: five", "Answer: B or C") says so.
      if (s.parsed != null) row.detail = `parsed ${s.parsed}`;
      else row.detail = s.labeled === false ? "no 'Answer:' line" : "could not read the 'Answer:' line";
    }
    return row;
  } finally {
    clearTimeout(timer);
    if (abortSignal) abortSignal.removeEventListener("abort", onParentAbort);
  }
}

/** Summary-only copy for history listings (drops per-item rows). */
function summaryOf(job) {
  if (!job) return job;
  const { results, ...rest } = job;
  return {
    ...rest,
    results: results
      ? { categories: results.categories, overallPct: results.overallPct, skippedLongSizes: results.skippedLongSizes, itemCount: results.items?.length ?? 0 }
      : results,
  };
}

/**
 * @param {object} job
 * @param {{ full?: boolean }} [opts] full = include per-item rows. A running job omits them by
 *   default (the dialog polls every second; the rows are only needed once it finishes).
 */
function publicJob(job, { full = job.status !== "running" } = {}) {
  const results =
    full || !job.results
      ? job.results
      : {
          categories: job.results.categories,
          overallPct: job.results.overallPct,
          skippedLongSizes: job.results.skippedLongSizes,
          itemCount: job.results.items?.length ?? 0,
        };
  return {
    benchId: job.benchId,
    sparkId: job.sparkId,
    status: job.status,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    config: { ...job.config },
    progress: { ...job.progress },
    results,
    error: job.error,
    durationMs:
      job.completedAt != null ? job.completedAt - job.startedAt : Date.now() - job.startedAt,
    owner: job.owner || null,
  };
}

function emptyResults() {
  return { items: [], categories: {}, overallPct: null, skippedLongSizes: [] };
}

export class QualityBenchManager {
  constructor(historyPath = HISTORY_PATH, activePath = ACTIVE_PATH) {
    /** @type {Map<string, object>} */
    this.jobs = new Map();
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
    if (job) return publicJob(job, opts.full ? { full: true } : undefined);
    for (const list of this.historyBySpark.values()) {
      const found = list.find((j) => j.benchId === benchId);
      if (found) return found;
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
      if (match) return match;
      const anyPort = hist.find((j) => j.config?.port === p);
      if (anyPort) return anyPort;
    }
    return hist[0] || null;
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
    } = opts;

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
      error: null,
      _abort: new AbortController(),
      _fatal: null,
      _apiKey: apiKey != null && String(apiKey).trim() ? String(apiKey).trim() : null,
      _resolveTarget: typeof resolveTarget === "function" ? resolveTarget : null,
      _closeTarget: null,
      owner: owner ? { id: owner.id, via: owner.via } : null,
    };

    this.jobs.set(benchId, job);
    this.activeBySpark.set(sparkId, benchId);
    this._checkpointActive();

    this._runJob(job, lanIp).catch(() => {
      /* errors recorded on job */
    });

    return publicJob(job);
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

  /** Refresh the category summary only (cheap; per item). */
  _updateSummary(job) {
    const { categories, overallPct } = summarize(job.results.items);
    job.results.categories = categories;
    job.results.overallPct = overallPct;
  }

  /** Sort rows into suite order and summarize — once, when the job ends. */
  _finalizeResults(job) {
    const order = new Map((job._suiteOrder || []).map((id, i) => [id, i]));
    job.results.items.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const { categories, overallPct } = summarize(job.results.items);
    job.results.categories = categories;
    job.results.overallPct = overallPct;
  }

  async _runJob(job, lanIp) {
    let host = lanIp;
    let port = job.config.port;
    let tls = Boolean(job.config.tls);
    const signal = job._abort.signal;
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

      const { run: longSizes, skipped } = longSizesForContext(job.config.longSizes, job.config.contextLength);
      job.results.skippedLongSizes = skipped;
      const items = generateSuite({
        categories: job.config.categories,
        longSizes,
        longItems: job.config.longItems,
      });
      job._suiteOrder = items.map((it) => it.id);
      job.progress.total = items.length;
      if (!items.length) throw new Error("Nothing to run — every selected long size exceeds the model context");

      let consecutiveErrors = 0;
      for (const category of QUALITY_CATEGORIES) {
        if (signal.aborted) break;
        const catItems = items.filter((it) => it.category === category);
        if (!catItems.length) continue;
        job.progress.currentCategory = category;
        job.progress.categoryDone = 0;
        job.progress.categoryTotal = catItems.length;
        job.progress.message = `${QUALITY_CATEGORY_LABELS[category]}…`;
        this._checkpointActive();

        const width = category === "long" ? 1 : job.config.concurrency;
        let next = 0;
        const worker = async () => {
          while (!signal.aborted) {
            const item = catItems[next++];
            if (!item) return;
            if (category === "long") {
              job.progress.message = `Long-context recall ${longSizeLabel(item.size)}…`;
            }
            const row = await runQualityItem({
              baseUrl,
              modelId: job.config.modelId,
              item,
              abortSignal: signal,
              apiKey: job._apiKey,
            });
            if (signal.aborted) return;
            if (row.model && !job.config.modelId) job.config.modelId = row.model;
            delete row.model;
            job.results.items.push(row);
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
            this._updateSummary(job);
            this._checkpointActive(false);
          }
        };
        await Promise.all(Array.from({ length: Math.min(width, catItems.length) }, worker));
      }

      if (job._fatal) {
        job.status = "failed";
        job.error = job._fatal;
        job.progress.message = "Failed";
      } else if (signal.aborted) {
        job.status = "cancelled";
        job.error = "Cancelled by user";
        job.progress.message = "Cancelled";
      } else if (job.status === "running") {
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
      this._finalizeResults(job);
      // Only release the Spark if it still points at this job.
      if (this.activeBySpark.get(job.sparkId) === job.benchId) this.activeBySpark.delete(job.sparkId);
      this._pushHistory(job);
      this._checkpointActive();
      this._emitFinished(job);
      // History now holds the finished run; drop the live job (and its AbortController etc.).
      this.jobs.delete(job.benchId);
    }
  }

  _pushHistory(job) {
    const list = this.historyBySpark.get(job.sparkId) || [];
    const pub = publicJob(job, { full: true });
    const existing = list.findIndex((j) => j.benchId === pub.benchId);
    if (existing >= 0) list.splice(existing, 1);
    list.unshift(pub);
    this.historyBySpark.set(job.sparkId, list.slice(0, HISTORY_LIMIT));
    this._saveHistory();
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
