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
  formatContextSize,
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

/** Canonical sizes (tokens). 300k is the top of the sweep. */
export const ALLOWED_CONTEXT_SIZES = PREFILL_CONTEXT_SIZES;
export const DEFAULT_CONTEXT_SIZES = PREFILL_DEFAULT_CONTEXT_SIZES;
const ALLOWED_SET = new Set(ALLOWED_CONTEXT_SIZES);

const WARMUP_TARGET_TOKENS = 512;
const GEN_MAX_TOKENS = 8;
const HISTORY_LIMIT = 10;

/** `" the"` is typically one BPE token (~4 chars). */
const FILLER_UNIT = " the";

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
  return header + FILLER_UNIT.repeat(fillTokens) + footer;
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
    const n = typeof v === "string" ? parseInt(v, 10) : Number(v);
    if (!Number.isInteger(n) || !ALLOWED_SET.has(n)) continue;
    if (!out.includes(n)) out.push(n);
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

async function warmupPrefill({ baseUrl, modelId, abortSignal, apiKey }) {
  try {
    await runPrefillSize({
      baseUrl,
      modelId,
      targetTokens: WARMUP_TARGET_TOKENS,
      abortSignal,
      apiKey,
    });
  } catch {
    /* best-effort */
  }
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
    this._loadHistory();
    this._recoverInterruptedActive();
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
        "Select at least one context size (1k–300k)"
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

        const row = await runPrefillSize({
          baseUrl,
          modelId: job.config.modelId,
          targetTokens: size,
          abortSignal: job._abort.signal,
          apiKey: job._apiKey,
        });

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
};
