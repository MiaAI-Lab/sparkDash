/**
 * PrefillBench — sequential context-size prefill throughput + TTFT.
 *
 * Sends a unique-prefix padded prompt at each selected size (up to 300k),
 * generates a handful of tokens, and records prompt_tokens / TTFT.
 * One request per size (concurrency 1) so prefix-cache from a prior size
 * cannot inflate the next: each request starts with a fresh salt.
 */

import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWrite } from "../util/atomicWrite.js";
import {
  applyThinkingFlags,
  estimateTokenCount,
  round2,
  runStreamingRequest,
} from "./LlmStreaming.js";
import { decodeBenchManager } from "./DecodeBench.js";
import {
  PREFILL_CONTEXT_SIZES,
  PREFILL_DEFAULT_CONTEXT_SIZES,
  PREFILL_MAX_CONTEXT_SIZE,
  PREFILL_MIN_CONTEXT_SIZE,
  formatContextSize,
  parseContextSize,
} from "../../src/shared/prefillBench.js";
import { formatLlmBaseUrl } from "../../src/shared/llmTarget.js";

export { formatContextSize };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");
const HISTORY_PATH =
  process.env.PREFILL_BENCH_HISTORY_PATH ||
  path.join(ROOT, "config", "prefill-bench-history.json");
const ACTIVE_PATH =
  process.env.PREFILL_BENCH_ACTIVE_PATH ||
  path.join(ROOT, "config", "prefill-bench-active.json");

/** Preset chip sizes (tokens). Custom integers in 256–300k are also allowed. */
export const ALLOWED_CONTEXT_SIZES = PREFILL_CONTEXT_SIZES;
export const DEFAULT_CONTEXT_SIZES = PREFILL_DEFAULT_CONTEXT_SIZES;

const WARMUP_TARGET_TOKENS = 512;
const GEN_MAX_TOKENS = 8;
const HISTORY_LIMIT = 10;

/**
 * Common short English words, each one BPE token with a leading space in the
 * mainstream tokenizers. Cycled in a fixed pseudo-random order so the filler is
 * less degenerate than one repeated token (attention/MoE routing look closer
 * to real text) while the token count stays ~1 per word.
 */
const FILLER_WORDS =
  "the of and to in is you that it he was for on are as with his they at be this have from or one had by word but not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time".split(
    " "
  );

function fillerText(count) {
  const words = new Array(count);
  let state = 0x2545f491;
  for (let i = 0; i < count; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    words[i] = FILLER_WORDS[(state >>> 8) % FILLER_WORDS.length];
  }
  return " " + words.join(" ");
}

/**
 * Unique-prefix prompt aimed at `targetTokens` (estimateTokenCount / 4 chars).
 * Salt at the start so a previous size is not a prefix-cache hit.
 * @param {number} targetTokens
 * @param {string} salt
 */
export function buildPrefillPrompt(targetTokens, salt) {
  const n = Math.max(8, Math.round(Number(targetTokens) || 0));
  const header = `[prefill-bench ${salt}]\nIgnore the filler below. Reply with the single word OK.\n`;
  const footer = "\nReply OK.";
  const reserved = estimateTokenCount(header + footer);
  const fillTokens = Math.max(1, n - reserved);
  return header + fillerText(fillTokens) + footer;
}

/** Tiny prompt used to measure fixed per-request overhead (network, queue, first decode step). */
const CALIBRATION_TOKENS = 16;
const CALIBRATION_SAMPLES = 3;

/** Samples per size: big contexts take minutes each, so they get fewer repeats. */
export function repeatsForSize(tokens) {
  const n = Number(tokens) || 0;
  if (n <= 32768) return 3;
  if (n <= 131072) return 2;
  return 1;
}

export function medianOf(nums) {
  const v = nums.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Turn one raw sample into a prefill rate.
 *  - "server": the backend reported its own prompt-processing time (llama.cpp `timings`).
 *  - "ttft": prompt tokens actually computed (cache hits excluded) over TTFT minus the
 *    calibrated fixed overhead. The correction is capped so a noisy calibration cannot
 *    remove more than 80% of the measured TTFT.
 * @param {{ promptTokens: number, ttftMs: number, cachedTokens: number, serverPromptMs: number | null, serverPromptN: number | null }} s
 * @param {number} overheadMs
 */
export function rateFromSample(s, overheadMs = 0) {
  if (s.serverPromptMs > 0 && s.serverPromptN > 0) {
    return {
      tps: round2((s.serverPromptN / s.serverPromptMs) * 1000),
      method: "server",
    };
  }
  const computed = Math.max(0, (s.promptTokens || 0) - (s.cachedTokens || 0));
  if (!(s.ttftMs > 0) || computed <= 0) return { tps: 0, method: "ttft" };
  const effectiveMs = Math.max(s.ttftMs - Math.max(0, overheadMs), s.ttftMs * 0.2);
  return { tps: round2((computed / effectiveMs) * 1000), method: "ttft" };
}

/**
 * Per-size request timeout: 90s floor, ~8 ms/token (~125 tok/s), 45 min cap.
 * 256k at a slow ~200 tok/s is ~22 min — the old 12 min cap aborted those runs.
 * @param {number} tokens
 */
export function timeoutMsForSize(tokens) {
  const n = Math.max(0, Number(tokens) || 0);
  return Math.min(2_700_000, Math.max(90_000, 60_000 + n * 8));
}

export function normalizeContextSizes(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    const n = parseContextSize(v);
    if (n == null || out.includes(n)) continue;
    out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
}

function prefillRequestBody(modelId, prompt) {
  const body = {
    model: modelId || undefined,
    messages: [{ role: "user", content: prompt }],
    max_tokens: GEN_MAX_TOKENS,
    temperature: 0,
    top_p: 1,
    stream: true,
    stream_options: { include_usage: true },
  };
  applyThinkingFlags(body, modelId, false);
  return body;
}

/**
 * @param {{
 *   baseUrl: string,
 *   modelId: string | null,
 *   targetTokens: number,
 *   abortSignal: AbortSignal,
 *   apiKey?: string | null,
 * }} opts
 */
async function runPrefillSize({
  baseUrl,
  modelId,
  targetTokens,
  abortSignal,
  apiKey = null,
}) {
  const url = `${baseUrl}/v1/chat/completions`;
  const salt = randomUUID();
  const prompt = buildPrefillPrompt(targetTokens, salt);
  const promptChars = prompt.length;
  const timeoutMs = timeoutMsForSize(targetTokens);

  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort();
  if (abortSignal) {
    if (abortSignal.aborted) ctrl.abort();
    else abortSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const wallStart = performance.now();

  try {
    const result = await runStreamingRequest(
      url,
      prefillRequestBody(modelId, prompt),
      ctrl.signal,
      { retryOnThinking400: true, thinking: false, apiKey }
    );
    const durationMs = round2(performance.now() - wallStart);
    const timeoutErr = timedOut
      ? `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for first token at ${formatContextSize(targetTokens)}`
      : null;
    const ok =
      !timedOut &&
      !result.error &&
      (result.prefillTokens > 0 || result.ttftMs > 0);
    return {
      targetTokens,
      promptTokens: result.prefillTokens || 0,
      promptChars,
      prefillTps: result.prefillTps || 0,
      cachedTokens: result.cachedPromptTokens || 0,
      serverPromptMs: result.serverPromptMs ?? null,
      serverPromptN: result.serverPromptN ?? null,
      ttftMs: result.ttftMs || 0,
      ttftContentMs: result.ttftContentMs ?? null,
      completionTokens: result.completionTokens || 0,
      durationMs,
      model: result.model || modelId || null,
      error: ok ? null : timeoutErr || result.error || "No first token",
    };
  } finally {
    clearTimeout(timeout);
    if (abortSignal) abortSignal.removeEventListener("abort", onParentAbort);
  }
}

async function warmupPrefill({
  baseUrl,
  modelId,
  abortSignal,
  apiKey,
  tokens = WARMUP_TARGET_TOKENS,
}) {
  try {
    await runPrefillSize({
      baseUrl,
      modelId,
      targetTokens: tokens,
      abortSignal,
      apiKey,
    });
  } catch {
    /* best-effort */
  }
}

/** Median TTFT of a few tiny prompts = fixed overhead that is not prefill work. */
async function calibrateOverhead({ baseUrl, modelId, abortSignal, apiKey }) {
  const ttfts = [];
  for (let i = 0; i < CALIBRATION_SAMPLES; i += 1) {
    if (abortSignal?.aborted) break;
    try {
      const r = await runPrefillSize({
        baseUrl,
        modelId,
        targetTokens: CALIBRATION_TOKENS,
        abortSignal,
        apiKey,
      });
      if (!r.error && r.ttftMs > 0) ttfts.push(r.ttftMs);
    } catch {
      /* best-effort */
    }
  }
  return ttfts.length ? round2(medianOf(ttfts)) : 0;
}

/**
 * Several samples for one size; reports the median-rate sample's fields.
 * @param {(msg: string) => void} [onSample]
 */
async function runPrefillMeasured(opts, overheadMs, onSample) {
  const repeats = repeatsForSize(opts.targetTokens);
  const good = [];
  let lastErr = null;
  let firstFail = null;
  for (let i = 0; i < repeats; i += 1) {
    if (opts.abortSignal?.aborted) break;
    if (repeats > 1 && onSample) onSample(i + 1, repeats);
    const sample = await runPrefillSize(opts);
    if (sample.error) {
      lastErr = sample;
      if (!firstFail) firstFail = sample;
      break; // a failing size will not get better on retry; keep the time budget
    }
    good.push({ sample, ...rateFromSample(sample, overheadMs) });
  }
  if (!good.length) {
    return {
      ...(lastErr || {
        targetTokens: opts.targetTokens,
        promptTokens: 0,
        promptChars: 0,
        prefillTps: 0,
        ttftMs: 0,
        ttftContentMs: null,
        completionTokens: 0,
        durationMs: 0,
        model: null,
        error: "Cancelled",
      }),
      prefillTps: 0,
      method: "ttft",
      cachedTokens: 0,
      samples: 0,
      overheadMs,
    };
  }
  good.sort((a, b) => a.tps - b.tps);
  const pick = good[(good.length - 1) >> 1];
  const { sample } = pick;
  return {
    targetTokens: sample.targetTokens,
    promptTokens: sample.promptTokens,
    promptChars: sample.promptChars,
    prefillTps: round2(medianOf(good.map((g) => g.tps))),
    method: pick.method,
    cachedTokens: sample.cachedTokens,
    samples: good.length,
    overheadMs,
    ttftMs: round2(medianOf(good.map((g) => g.sample.ttftMs))),
    ttftContentMs: sample.ttftContentMs,
    completionTokens: sample.completionTokens,
    durationMs: round2(good.reduce((t, g) => t + g.sample.durationMs, 0)),
    model: sample.model,
    error: null,
  };
}

function publicJob(job) {
  return {
    benchId: job.benchId,
    sparkId: job.sparkId,
    status: job.status,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    config: { ...job.config },
    progress: { ...job.progress },
    results: job.results,
    error: job.error,
    durationMs:
      job.completedAt != null
        ? job.completedAt - job.startedAt
        : Date.now() - job.startedAt,
    owner: job.owner || null,
  };
}

/**
 * Job manager: one active prefill job per Spark, history on disk.
 */
export class PrefillBenchManager {
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
      this._onEvent("prefill", job);
    } catch {
      /* event recording must never break the bench */
    }
  }

  activeCount() {
    return this.activeBySpark.size;
  }

  getJob(benchId) {
    const job = this.jobs.get(benchId);
    if (job) return publicJob(job);
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

  getLast(sparkId, port = null) {
    const hist = this.getHistory(sparkId);
    if (!hist.length) return null;
    if (port != null) {
      const p = Number(port);
      const match = hist.find(
        (j) => j.config?.port === p && Array.isArray(j.results) && j.results.length > 0
      );
      if (match) return match;
      const anyPort = hist.find((j) => j.config?.port === p);
      if (anyPort) return anyPort;
    }
    return hist[0] || null;
  }

  clearHistory(sparkId, port = null) {
    const p = port != null ? Number(port) : null;

    if (p != null && Number.isInteger(p)) {
      const list = this.getHistory(sparkId).filter((j) => j.config?.port !== p);
      if (list.length) this.historyBySpark.set(sparkId, list);
      else this.historyBySpark.delete(sparkId);
      for (const [benchId, job] of this.jobs.entries()) {
        if (job.sparkId === sparkId && job.config?.port === p && job.status !== "running") {
          this.jobs.delete(benchId);
        }
      }
    } else {
      this.historyBySpark.delete(sparkId);
      for (const [benchId, job] of this.jobs.entries()) {
        if (job.sparkId === sparkId && job.status !== "running") {
          this.jobs.delete(benchId);
        }
      }
    }

    this._saveHistory();
    return { ok: true };
  }

  _loadHistory() {
    try {
      if (!fs.existsSync(this.historyPath)) return;
      const raw = fs.readFileSync(this.historyPath, "utf8");
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") return;
      for (const [sparkId, list] of Object.entries(data)) {
        if (!Array.isArray(list)) continue;
        const cleaned = list
          .filter((j) => j && typeof j === "object" && j.benchId && j.sparkId)
          .slice(0, HISTORY_LIMIT)
          .map((j) => ({
            ...j,
            status: j.status === "running" ? "cancelled" : j.status || "completed",
          }));
        if (cleaned.length) this.historyBySpark.set(sparkId, cleaned);
      }
    } catch (err) {
      console.warn("[PrefillBench] failed to load history:", err?.message || err);
    }
  }

  _recoverInterruptedActive() {
    const leftovers = this._readActiveFile();
    if (!leftovers.length) return;

    let changed = false;
    for (const snap of leftovers) {
      if (!snap?.benchId || !snap?.sparkId) continue;
      const hist = this.getHistory(snap.sparkId);
      if (hist.some((j) => j.benchId === snap.benchId)) continue;

      const interrupted = {
        ...snap,
        status: "failed",
        error:
          snap.error ||
          "Interrupted — server restarted while the benchmark was running",
        completedAt: snap.completedAt || Date.now(),
        progress: {
          ...(snap.progress || {}),
          message: "Interrupted",
          currentContext: null,
        },
      };
      if (interrupted.completedAt && interrupted.startedAt) {
        interrupted.durationMs = interrupted.completedAt - interrupted.startedAt;
      }
      this.jobs.set(interrupted.benchId, interrupted);
      this._pushHistory(interrupted);
      changed = true;
      console.warn(
        `[PrefillBench] recovered interrupted job ${interrupted.benchId} on ${interrupted.sparkId}`
      );
    }

    this._writeActiveFile([]);
    if (changed) this._saveHistory();
  }

  _readActiveFile() {
    try {
      if (!fs.existsSync(this.activePath)) return [];
      const raw = fs.readFileSync(this.activePath, "utf8");
      const data = JSON.parse(raw);
      if (Array.isArray(data)) return data;
      if (data && typeof data === "object" && Array.isArray(data.jobs)) {
        return data.jobs;
      }
      return [];
    } catch (err) {
      console.warn("[PrefillBench] failed to load active jobs:", err?.message || err);
      return [];
    }
  }

  _writeActiveFile(jobs) {
    try {
      atomicWrite(this.activePath, JSON.stringify({ jobs }, null, 2), 0o600);
    } catch (err) {
      console.warn("[PrefillBench] failed to save active jobs:", err?.message || err);
    }
  }

  _checkpointActive() {
    /** @type {object[]} */
    const running = [];
    for (const job of this.jobs.values()) {
      if (job.status === "running") running.push(publicJob(job));
    }
    this._writeActiveFile(running);
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
      job.progress.currentContext = null;
      job.completedAt = Date.now();
      this.activeBySpark.delete(job.sparkId);
      this._pushHistory(job);
    }
    this._writeActiveFile([]);
  }

  _saveHistory() {
    try {
      /** @type {Record<string, object[]>} */
      const out = {};
      for (const [sparkId, list] of this.historyBySpark.entries()) {
        out[sparkId] = list;
      }
      atomicWrite(this.historyPath, JSON.stringify(out, null, 2), 0o600);
    } catch (err) {
      console.warn("[PrefillBench] failed to save history:", err?.message || err);
    }
  }

  /**
   * @param {{
   *   sparkId: string,
   *   lanIp: string,
   *   port: number,
   *   modelId: string | null,
   *   contextSizes: number[],
   *   apiKey?: string | null,
   *   resolveTarget?: (ctx: { onStatus?: Function, signal?: AbortSignal }) => Promise<{
   *     host: string, port: number, tls?: boolean, via?: string, close: () => void
   *   }>,
   *   host?: string | null,
   *   tls?: boolean,
   * }} opts
   */
  start(opts) {
    const {
      sparkId,
      lanIp,
      port,
      modelId,
      contextSizes: rawSizes,
      apiKey = null,
      resolveTarget = null,
      host: rawHost = null,
      tls: rawTls = false,
      owner = null,
    } = opts;

    if (this.activeBySpark.has(sparkId)) {
      const err = new Error("A prefill benchmark is already running for this Spark");
      err.status = 409;
      throw err;
    }
    if (decodeBenchManager.getActive(sparkId)) {
      const err = new Error("A decode benchmark is already running for this Spark");
      err.status = 409;
      throw err;
    }

    const contextSizes = normalizeContextSizes(rawSizes);
    if (!contextSizes.length) {
      const err = new Error(
        `Select at least one context size (${PREFILL_MIN_CONTEXT_SIZE}–${PREFILL_MAX_CONTEXT_SIZE.toLocaleString()} tokens)`
      );
      err.status = 400;
      throw err;
    }

    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      const err = new Error("Invalid LLM port");
      err.status = 400;
      throw err;
    }

    const benchId = randomUUID();
    const abort = new AbortController();
    const job = {
      benchId,
      sparkId,
      status: "running",
      startedAt: Date.now(),
      completedAt: null,
      config: {
        port: p,
        modelId: modelId || null,
        contextSizes,
        ...(rawHost
          ? { host: String(rawHost).trim(), tls: Boolean(rawTls) }
          : {}),
      },
      progress: {
        currentContext: null,
        completedLevels: 0,
        totalLevels: contextSizes.length,
        message: "Starting…",
      },
      results: [],
      error: null,
      _abort: abort,
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
    if (!job || job.sparkId !== sparkId) return null;
    if (job.status !== "running") return publicJob(job);
    job._abort.abort();
    job.progress.message = "Cancelling…";
    return publicJob(job);
  }

  async _runJob(job, lanIp) {
    let host = lanIp;
    let port = job.config.port;
    let tls = Boolean(job.config.tls);
    try {
      if (typeof job._resolveTarget === "function") {
        job.progress.message = "Connecting to LLM…";
        this._checkpointActive();
        const target = await job._resolveTarget({
          onStatus: (msg) => {
            if (typeof msg === "string" && msg) job.progress.message = msg;
            this._checkpointActive();
          },
          signal: job._abort.signal,
        });
        host = target?.host || host;
        port = Number.isInteger(target?.port) ? target.port : port;
        if (target?.tls != null) tls = Boolean(target.tls);
        job._closeTarget = typeof target?.close === "function" ? target.close : null;
        if (target?.via === "ssh-tunnel") {
          job.progress.message = "Warming up via SSH tunnel…";
        }
      }
      const baseUrl = formatLlmBaseUrl({ host, port, tls });
      let overheadMs = 0;
      if (!job._abort.signal.aborted) {
        if (!String(job.progress.message || "").startsWith("Warming up")) {
          job.progress.message = "Warming up…";
        }
        this._checkpointActive();
        await warmupPrefill({
          baseUrl,
          modelId: job.config.modelId,
          abortSignal: job._abort.signal,
          apiKey: job._apiKey,
        });
        // Second warmup at a mid size so kernel/graph compilation for larger
        // shapes does not land in the first measured row.
        await warmupPrefill({
          tokens: 4096,
          baseUrl,
          modelId: job.config.modelId,
          abortSignal: job._abort.signal,
          apiKey: job._apiKey,
        });
        job.progress.message = "Calibrating…";
        overheadMs = await calibrateOverhead({
          baseUrl,
          modelId: job.config.modelId,
          abortSignal: job._abort.signal,
          apiKey: job._apiKey,
        });
      }

      for (const size of job.config.contextSizes) {
        if (job._abort.signal.aborted) {
          if (job.status === "running") {
            job.status = "cancelled";
            job.error = "Cancelled by user";
            job.progress.message = "Cancelled";
          }
          break;
        }

        job.progress.currentContext = size;
        job.progress.message = `Prefilling ${formatContextSize(size)}…`;
        this._checkpointActive();

        const row = await runPrefillMeasured(
          {
            baseUrl,
            modelId: job.config.modelId,
            targetTokens: size,
            abortSignal: job._abort.signal,
            apiKey: job._apiKey,
          },
          overheadMs,
          (i, n) => {
            job.progress.message = `Prefilling ${formatContextSize(size)} (run ${i}/${n})…`;
          }
        );

        if (job._abort.signal.aborted) {
          if (job.status === "running") {
            job.status = "cancelled";
            job.error = "Cancelled by user";
            job.progress.message = "Cancelled";
          }
          break;
        }

        if (row.model && !job.config.modelId) {
          job.config.modelId = row.model;
        }

        job.results.push(row);
        job.progress.completedLevels += 1;
        this._checkpointActive();
      }

      if (job.status === "running") {
        job.status = "completed";
        job.progress.currentContext = null;
        job.progress.message = "Done";
      }
    } catch (err) {
      if (job.status === "running") {
        if (job._abort.signal.aborted) {
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
      this.activeBySpark.delete(job.sparkId);
      this._pushHistory(job);
      this._checkpointActive();
      this._emitFinished(job);
    }
  }

  _pushHistory(job) {
    const list = this.historyBySpark.get(job.sparkId) || [];
    const pub = publicJob(job);
    const existing = list.findIndex((j) => j.benchId === pub.benchId);
    if (existing >= 0) list.splice(existing, 1);
    list.unshift(pub);
    this.historyBySpark.set(job.sparkId, list.slice(0, HISTORY_LIMIT));
    this._saveHistory();
  }
}

export const prefillBenchManager = new PrefillBenchManager();

export const PREFILL_BENCH_DEFAULTS = {
  allowedContextSizes: [...ALLOWED_CONTEXT_SIZES],
  defaultContextSizes: [...DEFAULT_CONTEXT_SIZES],
  minContextSize: PREFILL_MIN_CONTEXT_SIZE,
  maxContextSize: PREFILL_MAX_CONTEXT_SIZE,
};
