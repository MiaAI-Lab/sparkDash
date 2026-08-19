/**
 * DecodeBench — concurrent streaming decode throughput benchmark.
 *
 * Measures real post-first-token decode tok/s against an OpenAI-compatible
 * chat completions endpoint. Concurrency levels run one after another.
 */

import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWrite } from "../util/atomicWrite.js";
import {
  applyThinkingFlags,
  mean,
  median,
  round2,
  runStreamingRequest,
  sleep,
  stripFillForceFields,
} from "./LlmStreaming.js";
import {
  pickShowcasePrompts,
  withFillToMaxInstruction,
} from "../../src/shared/llmPrompts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");
const HISTORY_PATH =
  process.env.BENCH_HISTORY_PATH || path.join(ROOT, "config", "bench-history.json");
/** In-flight jobs checkpointed here so a --watch / SIGTERM restart does not 404 polls. */
const ACTIVE_PATH =
  process.env.BENCH_ACTIVE_PATH || path.join(ROOT, "config", "bench-active.json");

/** Same catalog + fill-to-max as Showcase structural; temperature 0; thinking off. */

const ALLOWED_CONCURRENCIES = new Set([1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32]);
const DEFAULT_MAX_TOKENS = 512;
const MIN_MAX_TOKENS = 64;
const MAX_MAX_TOKENS = 2048;
const PER_REQUEST_TIMEOUT_MS = 360_000;
const WAVE_TIMEOUT_MS = 360_000;
const HISTORY_LIMIT = 10;
/** Hardware sample cadence while a concurrency wave runs (debug timeline). */
const HARDWARE_SAMPLE_MS = 1_000;
/** Cap samples per wave so history stays bounded (~2 min). */
const HARDWARE_SAMPLE_MAX = 120;

/**
 * Poll cached / fresh hardware while a wave runs (GPU util, temp, power, VRAM).
 * @param {(() => Promise<object | null> | object | null) | null | undefined} sampleHardware
 * @param {AbortSignal} signal
 */
async function pollHardwareSamples(sampleHardware, signal, intervalMs = HARDWARE_SAMPLE_MS) {
  /** @type {object[]} */
  const samples = [];
  if (typeof sampleHardware !== "function") {
    return samples;
  }

  const push = async () => {
    if (samples.length >= HARDWARE_SAMPLE_MAX) return;
    try {
      const raw = await sampleHardware();
      if (!raw || typeof raw !== "object") return;
      samples.push({
        t: Date.now(),
        ...raw,
      });
    } catch {
      /* non-fatal */
    }
  };

  await push();
  while (!signal.aborted && samples.length < HARDWARE_SAMPLE_MAX) {
    try {
      await sleep(intervalMs, signal);
    } catch {
      break;
    }
    await push();
  }
  return samples;
}

/** Same cycling as Showcase structural, plus the shared fill-to-max suffix. */
function pickBenchPrompts(count) {
  return pickShowcasePrompts("structural", count).map(withFillToMaxInstruction);
}

/**
 * Run one concurrency wave: N simultaneous streams.
 * Prompts cycle the structural catalog (repeats after the catalog length).
 */
function emptyWaveResult(concurrency, waveMs, results, modelId, error, prompts = [], debug = false) {
  return {
    concurrency,
    streamsOk: 0,
    streamsFailed: concurrency,
    meanDecodeTps: 0,
    medianDecodeTps: 0,
    minDecodeTps: 0,
    maxDecodeTps: 0,
    meanTtftMs: 0,
    medianTtftMs: 0,
    /** Client-side: total decode tokens / concurrent decode window */
    aggregateDecodeTps: 0,
    meanPrefillTps: 0,
    medianPrefillTps: 0,
    aggregatePrefillTps: 0,
    totalPrefillTokens: 0,
    /**
     * Server-side generation tok/s (same basis as live Generation tok/s panel).
     * Null when the backend does not expose counters.
     */

    totalDecodeTokens: 0,
    totalCompletionTokens: 0,
    durationMs: round2(waveMs),
    error,
    streams: (results || []).map((r, i) => {
      const pub = streamPublicResult(r, i, prompts[i] ?? null, {
        url: null,
        modelId,
        maxTokens: null,
      }, debug);
      if (!pub.error && error) pub.error = error;
      return pub;
    }),
    ...(debug ? { hardwareSamples: [] } : {}),
    model: modelId || null,
  };
}

function streamPublicResult(r, index, prompt, reqMeta, debug = false) {
  /** @type {Record<string, unknown>} */
  const out = {
    index,
    ttftContentMs: r?.ttftContentMs ?? null,
    reasoningChunks: r?.reasoningChunks ?? 0,
    ttftMs: r?.ttftMs ?? 0,
    decodeTps: r?.decodeTps ?? 0,
    decodeTokens: r?.decodeTokens ?? 0,
    completionTokens: r?.completionTokens ?? 0,
    prefillTps: r?.prefillTps ?? 0,
    prefillTokens: r?.prefillTokens ?? 0,
    totalMs: r?.totalMs ?? 0,
    error: r?.error ?? null,
  };

  if (!debug) return out;

  out.prompt = prompt ?? null;
  out.http = {
    url: reqMeta?.url ?? null,
    status: r?.httpStatus ?? null,
    headers: r?.responseHeaders || {},
    completionId: r?.completionId ?? null,
    finishReason: r?.finishReason ?? null,
    sseEventCount: r?.sseEventCount ?? 0,
    firstSseDataPreview: r?.firstSseDataPreview ?? null,
    request: {
      model: reqMeta?.modelId ?? null,
      maxTokens: reqMeta?.maxTokens ?? null,
      temperature: 0,
      stream: true,
      promptChars: prompt != null ? String(prompt).length : 0,
    },
  };
  out.usage = r?.usage ?? null;
  out.contentPreview = r?.contentPreview ?? null;
  out.decodeMs = r?.decodeMs ?? null;
  return out;
}


async function runConcurrencyWave({
  baseUrl,
  modelId,
  concurrency,
  maxTokens,
  abortSignal,
  sampleHardware = null,
  debug = false,
  apiKey = null,
}) {
  const url = `${baseUrl}/v1/chat/completions`;
  const prompts = pickBenchPrompts(concurrency);
  const reqMeta = { url, modelId, maxTokens };

  const wallStart = performance.now();

  // Poll /metrics like the live panel while streams run (steady-state gen tok/s)
  const hwPollAbort = new AbortController();
  const onParentForPoll = () => {
    hwPollAbort.abort();
  };
  if (abortSignal) {
    if (abortSignal.aborted) onParentForPoll();
    else abortSignal.addEventListener("abort", onParentForPoll, { once: true });
  }
  const hwPollPromise = debug
    ? pollHardwareSamples(sampleHardware, hwPollAbort.signal, HARDWARE_SAMPLE_MS)
    : Promise.resolve([]);

  const controllers = [];

  const promises = Array.from({ length: concurrency }, (_, streamIndex) => {
    const ctrl = new AbortController();
    controllers.push(ctrl);

    const onParentAbort = () => ctrl.abort();
    if (abortSignal) {
      if (abortSignal.aborted) ctrl.abort();
      else abortSignal.addEventListener("abort", onParentAbort, { once: true });
    }

    const body = {
      model: modelId || undefined,
      messages: [{ role: "user", content: prompts[streamIndex] }],
      max_tokens: maxTokens,
      min_tokens: maxTokens,
      ignore_eos: true,
      stop: [],
      temperature: 0,
      stream: true,
      stream_options: { include_usage: true },
    };
    applyThinkingFlags(body, modelId, false);

    const streamOpts = {
      debug,
      retryOnThinking400: true,
      apiKey,
    };

    return (async () => {
      const timeout = setTimeout(() => ctrl.abort(), PER_REQUEST_TIMEOUT_MS);
      try {
        let result = await runStreamingRequest(url, body, ctrl.signal, streamOpts);
        if (
          result.error &&
          /^HTTP 400\b/.test(result.error) &&
          (body.min_tokens != null || body.ignore_eos != null)
        ) {
          result = await runStreamingRequest(
            url,
            stripFillForceFields(body),
            ctrl.signal,
            streamOpts
          );
        }
        return result;
      } finally {
        clearTimeout(timeout);
        if (abortSignal) abortSignal.removeEventListener("abort", onParentAbort);
      }
    })();
  });

  // Hard cap on the whole wave
  let waveTimedOut = false;
  const waveTimer = setTimeout(() => {
    waveTimedOut = true;
    for (const c of controllers) c.abort();
  }, WAVE_TIMEOUT_MS);

  let results;
  try {
    results = await Promise.all(promises);
  } finally {
    clearTimeout(waveTimer);
    // Stop metrics / hardware polling as soon as streams finish
    hwPollAbort.abort();
    if (abortSignal) abortSignal.removeEventListener("abort", onParentForPoll);
  }

  const wallEnd = performance.now();
  const waveMs = wallEnd - wallStart;
  const hardwareSamples = await hwPollPromise;

  if (waveTimedOut && results.every((r) => r.error)) {
    const empty = emptyWaveResult(
      concurrency,
      waveMs,
      results,
      modelId,
      `Wave timed out after ${WAVE_TIMEOUT_MS}ms`,
      prompts,
      debug
    );
    if (debug) empty.hardwareSamples = hardwareSamples;
    return empty;
  }

  const ok = results.filter((r) => !r.error && r.decodeTokens > 0);
  const failed = results.filter((r) => r.error || r.decodeTokens <= 0);
  const decodeTpsList = ok.map((r) => r.decodeTps);
  const ttftList = ok.map((r) => r.ttftMs);
  const prefillTpsList = ok.map((r) => r.prefillTps).filter((n) => n > 0);
  const totalDecodeTokens = ok.reduce((s, r) => s + r.decodeTokens, 0);
  const totalCompletionTokens = ok.reduce((s, r) => s + r.completionTokens, 0);
  const totalPrefillTokens = ok.reduce((s, r) => s + (r.prefillTokens || 0), 0);

  // Client aggregate over concurrent first→last content window (network-affected)
  let aggregateDecodeTps = 0;
  const firsts = ok.map((r) => r.tFirst).filter((t) => t != null);
  const lasts = ok.map((r) => r.tLast).filter((t) => t != null);
  if (ok.length > 0 && firsts.length && lasts.length) {
    const decodeWindowMs = Math.max(...lasts) - Math.min(...firsts);
    if (decodeWindowMs > 0) {
      aggregateDecodeTps = (totalDecodeTokens / decodeWindowMs) * 1000;
    }
  }

  // Concurrent prefill window: earliest request start → latest first token
  let aggregatePrefillTps = 0;
  const t0s = ok
    .map((r) => (r.t0 != null ? r.t0 : r.tFirst != null ? r.tFirst - (r.ttftMs || 0) : null))
    .filter((t) => t != null);
  if (ok.length > 0 && t0s.length && firsts.length && totalPrefillTokens > 0) {
    const prefillWindowMs = Math.max(...firsts) - Math.min(...t0s);
    if (prefillWindowMs > 0) {
      aggregatePrefillTps = (totalPrefillTokens / prefillWindowMs) * 1000;
    }
  }

  const model = results.find((r) => r.model)?.model || modelId || null;

  /** @type {Record<string, unknown>} */
  const wave = {
    concurrency,
    streamsOk: ok.length,
    streamsFailed: failed.length,
    meanDecodeTps: round2(mean(decodeTpsList)),
    medianDecodeTps: round2(median(decodeTpsList)),
    minDecodeTps: decodeTpsList.length ? round2(Math.min(...decodeTpsList)) : 0,
    maxDecodeTps: decodeTpsList.length ? round2(Math.max(...decodeTpsList)) : 0,
    meanTtftMs: round2(mean(ttftList)),
    medianTtftMs: round2(median(ttftList)),
    aggregateDecodeTps: round2(aggregateDecodeTps),
    meanPrefillTps: round2(mean(prefillTpsList)),
    medianPrefillTps: round2(median(prefillTpsList)),
    aggregatePrefillTps: round2(aggregatePrefillTps),
    totalPrefillTokens,

    totalDecodeTokens,
    totalCompletionTokens,
    durationMs: round2(waveMs),
    error: failed.length === concurrency
      ? failed[0]?.error || "All streams failed"
      : failed.length
        ? `${failed.length} of ${concurrency} streams failed`
        : null,
    streams: results.map((r, i) =>
      streamPublicResult(r, i, prompts[i], reqMeta, debug)
    ),
    model,
  };
  if (debug) wave.hardwareSamples = hardwareSamples;
  return wave;
}

/**
 * Job manager: one active job per spark, short history persisted to disk
 * so last results survive page refresh and process restart.
 *
 * Running jobs are also checkpointed to bench-active.json. On boot (or
 * graceful shutdown), any leftover "running" entries are finalized as
 * interrupted so GET /bench/:id keeps working instead of returning 404.
 */
export class DecodeBenchManager {
  constructor(historyPath = HISTORY_PATH, activePath = ACTIVE_PATH) {
    /** @type {Map<string, object>} */
    this.jobs = new Map();
    /** @type {Map<string, string>} sparkId → active benchId */
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
    // Fall back to history (survives after completion / process restart)
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

  /**
   * Most recent finished job for a Spark, optionally filtered by LLM port.
   * @param {string} sparkId
   * @param {number | null} [port]
   */
  getLast(sparkId, port = null) {
    const hist = this.getHistory(sparkId);
    if (!hist.length) return null;
    if (port != null) {
      const p = Number(port);
      const match = hist.find(
        (j) => j.config?.port === p && Array.isArray(j.results) && j.results.length > 0
      );
      if (match) return match;
      // Any finished job on this port (even empty results)
      const anyPort = hist.find((j) => j.config?.port === p);
      if (anyPort) return anyPort;
    }
    return hist[0] || null;
  }

  /**
   * Drop finished history (and idle job records) for a Spark.
   * Optional port limits the wipe to that LLM port only.
   * Does not cancel a currently running job.
   * @param {string} sparkId
   * @param {number | null} [port]
   */
  clearHistory(sparkId, port = null) {
    const p = port != null ? Number(port) : null;

    if (p != null && Number.isInteger(p)) {
      const list = this.getHistory(sparkId).filter((j) => j.config?.port !== p);
      if (list.length) this.historyBySpark.set(sparkId, list);
      else this.historyBySpark.delete(sparkId);
      for (const [benchId, job] of this.jobs.entries()) {
        if (
          job.sparkId === sparkId &&
          job.config?.port === p &&
          job.status !== "running"
        ) {
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
            // Never restore as running after restart
            status:
              j.status === "running" ? "cancelled" : j.status || "completed",
          }));
        if (cleaned.length) this.historyBySpark.set(sparkId, cleaned);
      }
    } catch (err) {
      console.warn("[DecodeBench] failed to load history:", err?.message || err);
    }
  }

  /**
   * Promote leftover active checkpoints (process died mid-run) into history
   * so clients polling GET /:benchId still get a final job instead of 404.
   */
  _recoverInterruptedActive() {
    const leftovers = this._readActiveFile();
    if (!leftovers.length) return;

    let changed = false;
    for (const snap of leftovers) {
      if (!snap?.benchId || !snap?.sparkId) continue;
      // Already in history from a prior clean finalize — skip
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
          currentConcurrency: null,
        },
      };
      if (interrupted.completedAt && interrupted.startedAt) {
        interrupted.durationMs = interrupted.completedAt - interrupted.startedAt;
      }
      this.jobs.set(interrupted.benchId, interrupted);
      this._pushHistory(interrupted);
      changed = true;
      console.warn(
        `[DecodeBench] recovered interrupted job ${interrupted.benchId} on ${interrupted.sparkId}`
      );
    }

    // Clear active file either way — nothing is actually running after boot
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
      console.warn("[DecodeBench] failed to load active jobs:", err?.message || err);
      return [];
    }
  }

  _writeActiveFile(jobs) {
    try {
      atomicWrite(
        this.activePath,
        JSON.stringify({ jobs }, null, 2),
        0o600
      );
    } catch (err) {
      console.warn("[DecodeBench] failed to save active jobs:", err?.message || err);
    }
  }

  /** Persist public snapshots of all currently running jobs. */
  _checkpointActive() {
    /** @type {object[]} */
    const running = [];
    for (const job of this.jobs.values()) {
      if (job.status === "running") running.push(publicJob(job));
    }
    this._writeActiveFile(running);
  }

  /**
   * Finalize every running job (used on SIGTERM / --watch reload).
   * Aborts in-flight streams and writes history so polls do not 404.
   * @param {string} [reason]
   */
  interruptAll(reason = "Interrupted — server shutting down") {
    for (const job of this.jobs.values()) {
      if (job.status !== "running") continue;
      try {
        job._abort?.abort();
      } catch {
        /* ignore */
      }
      job.status = "failed";
      job.error = reason;
      job.progress.message = "Interrupted";
      job.progress.currentConcurrency = null;
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
      console.warn("[DecodeBench] failed to save history:", err?.message || err);
    }
  }

  /**
   * @param {{
   *   sparkId: string,
   *   lanIp: string,
   *   port: number,
   *   modelId: string | null,
   *   concurrencies: number[],
   *   maxTokens?: number,
   *   debug?: boolean,
   *   sampleHardware?: (() => Promise<object | null> | object | null) | null,
   *   apiKey?: string | null,
   * }} opts
   */
  start(opts) {
    const {
      sparkId,
      lanIp,
      port,
      modelId,
      concurrencies: rawConc,
      maxTokens: rawMax,
      debug = false,
      sampleHardware = null,
      apiKey = null,
    } = opts;

    if (this.activeBySpark.has(sparkId)) {
      const err = new Error("A benchmark is already running for this Spark");
      err.status = 409;
      throw err;
    }

    const concurrencies = normalizeConcurrencies(rawConc);
    if (!concurrencies.length) {
      const err = new Error("Select at least one concurrency level (1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24, or 32)");
      err.status = 400;
      throw err;
    }

    let maxTokens = Number(rawMax);
    if (!Number.isFinite(maxTokens)) maxTokens = DEFAULT_MAX_TOKENS;
    maxTokens = Math.round(maxTokens);
    if (maxTokens < MIN_MAX_TOKENS || maxTokens > MAX_MAX_TOKENS) {
      const err = new Error(`maxTokens must be between ${MIN_MAX_TOKENS} and ${MAX_MAX_TOKENS}`);
      err.status = 400;
      throw err;
    }

    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      const err = new Error("Invalid LLM port");
      err.status = 400;
      throw err;
    }

    const debugOn = Boolean(debug);
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
        concurrencies,
        maxTokens,
        ...(debugOn ? { debug: true } : {}),
      },
      progress: {
        currentConcurrency: null,
        completedLevels: 0,
        totalLevels: concurrencies.length,
        message: "Starting…",
      },
      results: [],
      error: null,
      _abort: abort,
      _debug: debugOn,
      _apiKey: apiKey != null && String(apiKey).trim() ? String(apiKey).trim() : null,
      _sampleHardware:
        debugOn && typeof sampleHardware === "function" ? sampleHardware : null,
    };

    this.jobs.set(benchId, job);
    this.activeBySpark.set(sparkId, benchId);
    this._checkpointActive();

    // Fire and forget — client polls GET
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
    // Status finalized in _runJob finally so history is written once
    job.progress.message = "Cancelling…";
    return publicJob(job);
  }

  async _runJob(job, lanIp) {
    const baseUrl = `http://${lanIp}:${job.config.port}`;
    const debug = Boolean(job._debug);
    try {
      for (const c of job.config.concurrencies) {
        if (job._abort.signal.aborted) {
          if (job.status === "running") {
            job.status = "cancelled";
            job.error = "Cancelled by user";
            job.progress.message = "Cancelled";
          }
          break;
        }

        job.progress.currentConcurrency = c;
        job.progress.message = `Running concurrency ${c}…`;
        this._checkpointActive();

        const wave = await runConcurrencyWave({
          baseUrl,
          modelId: job.config.modelId,
          concurrency: c,
          maxTokens: job.config.maxTokens,
          abortSignal: job._abort.signal,
          sampleHardware: job._sampleHardware,
          debug,
          apiKey: job._apiKey,
        });

        if (job._abort.signal.aborted) {
          // Keep partial wave only if it fully succeeded before cancel
          if (wave.streamsOk > 0 && !wave.error) {
            job.results.push(wave);
            job.progress.completedLevels += 1;
          }
          if (job.status === "running") {
            job.status = "cancelled";
            job.error = "Cancelled by user";
            job.progress.message = "Cancelled";
          }
          break;
        }

        if (wave.model && !job.config.modelId) {
          job.config.modelId = wave.model;
        }

        job.results.push(wave);
        job.progress.completedLevels += 1;
        this._checkpointActive();
      }

      if (job.status === "running") {
        job.status = "completed";
        job.progress.currentConcurrency = null;
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

function normalizeConcurrencies(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    const n = typeof v === "string" ? parseInt(v, 10) : Number(v);
    if (!Number.isInteger(n) || !ALLOWED_CONCURRENCIES.has(n)) continue;
    if (!out.includes(n)) out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
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

export const decodeBenchManager = new DecodeBenchManager();

export const DECODE_BENCH_DEFAULTS = {
  allowedConcurrencies: [...ALLOWED_CONCURRENCIES].sort((a, b) => a - b),
  defaultMaxTokens: DEFAULT_MAX_TOKENS,
  minMaxTokens: MIN_MAX_TOKENS,
  maxMaxTokens: MAX_MAX_TOKENS,
};
