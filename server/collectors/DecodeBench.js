/**
 * DecodeBench — concurrent streaming decode throughput benchmark.
 *
 * Measures real post-first-token decode tok/s against an OpenAI-compatible
 * chat completions endpoint. Concurrency levels run one after another.
 *
 * Output types (structured / prose / code / json) are prompt labels only —
 * never response_format, grammars, or guided JSON.
 *
 * Structured protocol (matches glm-5.3-flash-sm120 tests/bench_decode.py):
 * count 1→200, temperature 0.7 and thinking on by default (both selectable
 * per run), top_p 1, warmup 32 tokens,
 * decode tok/s = (completion_tokens − 1) / (last − first token).
 * The same sampling protocol applies to every type.
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
  pickDecodeBenchPrompts,
  decodeBenchPromptForType,
  normalizeDecodeBenchType,
  DECODE_BENCH_DEFAULT_TYPE,
  DECODE_BENCH_TYPES,
  DECODE_CODE_WARMUP_PROMPT,
} from "../../src/shared/llmPrompts.js";
import { formatLlmBaseUrl } from "../../src/shared/llmTarget.js";
import {
  PREFILL_MAX_CONTEXT_SIZE,
  PREFILL_MIN_CONTEXT_SIZE,
  formatContextSize,
  parseContextSize,
} from "../../src/shared/prefillBench.js";
import { assessContextCache, buildContextPrompt, timeoutMsForSize } from "./contextFill.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");
const HISTORY_PATH =
  process.env.BENCH_HISTORY_PATH || path.join(ROOT, "config", "bench-history.json");
/** In-flight jobs checkpointed here so a --watch / SIGTERM restart does not 404 polls. */
const ACTIVE_PATH =
  process.env.BENCH_ACTIVE_PATH || path.join(ROOT, "config", "bench-active.json");

/** Lab protocol: temperature 0.7, thinking on (both selectable per run); top_p 1. Structured default. */
const DEFAULT_TEMPERATURE = 0.7;
const MIN_TEMPERATURE = 0;
const MAX_TEMPERATURE = 2;
const DEFAULT_THINKING = true;

const ALLOWED_CONCURRENCIES = new Set([1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32]);
const DEFAULT_MAX_TOKENS = 400;
const MIN_MAX_TOKENS = 64;
const MAX_MAX_TOKENS = 2048;
const WARMUP_MAX_TOKENS = 32;
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

/** Lab prompt for the selected type on every stream (C1 is the exact prompt). */
function pickBenchPrompts(count, type) {
  return pickDecodeBenchPrompts(count, type);
}

function decodeRequestBody(
  modelId,
  prompt,
  maxTokens,
  { temperature = DEFAULT_TEMPERATURE, thinking = DEFAULT_THINKING, topK = null } = {}
) {
  const body = {
    model: modelId || undefined,
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
    temperature,
    top_p: 1,
    stream: true,
    stream_options: { include_usage: true },
  };
  // TensorFold's native sampler requires top_k for non-greedy sampling.
  // Only the detected backend opts in; strict OpenAI-compatible servers may reject it.
  if (topK != null) body.top_k = topK;
  applyThinkingFlags(body, modelId, thinking);
  return body;
}

/**
 * Short count stream so DFlash2 / Triton JIT is not billed on the first wave.
 * Best-effort: a warmup failure does not fail the job.
 */
async function warmupDecode({
  baseUrl,
  modelId,
  abortSignal,
  apiKey,
  debug = false,
  promptType = DECODE_BENCH_DEFAULT_TYPE,
  temperature = DEFAULT_TEMPERATURE,
  thinking = DEFAULT_THINKING,
  topK = null,
}) {
  const url = `${baseUrl}/v1/chat/completions`;
  const kind = normalizeDecodeBenchType(promptType);
  const warmupPrompt =
    kind === "code" ? DECODE_CODE_WARMUP_PROMPT : decodeBenchPromptForType(kind);
  const body = decodeRequestBody(modelId, warmupPrompt, WARMUP_MAX_TOKENS, { temperature, thinking, topK });
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort();
  if (abortSignal) {
    if (abortSignal.aborted) ctrl.abort();
    else abortSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  const timeout = setTimeout(() => ctrl.abort(), PER_REQUEST_TIMEOUT_MS);
  try {
    await runStreamingRequest(url, body, ctrl.signal, {
      debug,
      retryOnThinking400: true,
      thinking,
      apiKey,
    });
  } catch {
    /* ignore */
  } finally {
    clearTimeout(timeout);
    if (abortSignal) abortSignal.removeEventListener("abort", onParentAbort);
  }
}

/**
 * Prefill each stream's context into the server's KV, one stream at a time (so a big context
 * is never evicted by its neighbours' prefills and a failure names the stream). Each request is
 * the exact prompt of the measured pass with a one-token reply, so the measured pass can reuse
 * the prefix cache.
 * @returns {Promise<{ results: object[], error: string | null }>}
 */
async function prefillContexts({
  baseUrl,
  modelId,
  prompts,
  contextTokens,
  abortSignal,
  apiKey,
  temperature,
  thinking,
  topK = null,
  onProgress = null,
}) {
  const url = `${baseUrl}/v1/chat/completions`;
  const timeoutMs = timeoutMsForSize(contextTokens);
  const results = [];
  for (let i = 0; i < prompts.length; i += 1) {
    if (abortSignal?.aborted) return { results, error: "Cancelled" };
    onProgress?.(i, prompts.length);
    const ctrl = new AbortController();
    const onParentAbort = () => ctrl.abort();
    abortSignal?.addEventListener("abort", onParentAbort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    try {
      const body = decodeRequestBody(modelId, prompts[i], 1, { temperature, thinking, topK });
      const r = await runStreamingRequest(url, body, ctrl.signal, {
        retryOnThinking400: true,
        thinking,
        apiKey,
      });
      results.push(r);
      const hasTiming = r.ttftMs > 0 || r.serverPromptMs > 0;
      if (timedOut || r.error || !hasTiming) {
        const why = timedOut
          ? `timed out after ${Math.round(timeoutMs / 1000)}s`
          : r.error || "no first token";
        return {
          results,
          error: `Context prefill failed for stream ${i + 1} of ${prompts.length} at ${formatContextSize(contextTokens)}: ${why}`,
        };
      }
    } catch (err) {
      return {
        results,
        error: `Context prefill failed for stream ${i + 1} of ${prompts.length}: ${err?.message || err}`,
      };
    } finally {
      clearTimeout(timeout);
      abortSignal?.removeEventListener("abort", onParentAbort);
    }
  }
  onProgress?.(prompts.length, prompts.length);
  return { results, error: null };
}

/**
 * Run one concurrency wave: N simultaneous streams.
 * Prompts use the selected decode type (structured default).
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
    cachedTokens: r?.cachedPromptTokens ?? 0,
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


/**
 * Live generation rate of a wave, measured from the streams themselves: tokens received
 * across all streams over the last ~2 s, sampled every second. The engine's own live
 * reading is 0 on backends whose counters only move when a request finishes (TensorFold
 * and EXL3 `/health` totals), and does not exist for a Remote target. Calls `onLive(tps)`
 * once a second while tokens flow, and `onLive(null)` when the wave ends.
 */
/**
 * The engine serving `port`, from a unit's LLM snapshot list.
 *
 * Matched on each entry's own `port` rather than by position in the configured-port array: the
 * configured list is raw while the snapshot follows SparkMonitor._llmPorts(), which drops
 * invalid entries, and the snapshot is the previous poll's, so right after a port is added or
 * removed the two lists are offset. A positional read would then hand back another port's
 * engine, and the backend decides the request shape — sending a sampler field a strict
 * OpenAI-compatible server rejects, or omitting the one TensorFold requires. An unmatched port
 * stays null: an engine that was not identified must not be guessed at.
 */
export function backendForPort(llmList, port) {
  if (!Array.isArray(llmList)) return null;
  return llmList.find((entry) => Number(entry?.port) === Number(port))?.backend || null;
}

export function createLiveRate(streams, onLive, { now = () => performance.now(), intervalMs = 1000, windowMs = 2000 } = {}) {
  const counts = new Array(streams).fill(0);
  const samples = []; // [time, total]
  let timer = null;
  const total = () => counts.reduce((a, b) => a + b, 0);
  const tick = () => {
    const t = now();
    samples.push([t, total()]);
    // Start the window where tokens start: the prefill before the first token is not decode time.
    while (samples.length > 2 && samples[1][1] === 0) samples.shift();
    while (samples.length > 2 && t - samples[0][0] > windowMs) samples.shift();
    const [t0, n0] = samples[0];
    const [t1, n1] = samples[samples.length - 1];
    // Nothing streamed yet (still prefilling): no reading, rather than a misleading 0.
    if (t1 <= t0 || n1 === 0) return;
    try {
      onLive?.(Math.round(((n1 - n0) / ((t1 - t0) / 1000)) * 10) / 10);
    } catch {
      /* the display must never break a run */
    }
  };
  if (typeof onLive === "function") {
    samples.push([now(), 0]);
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
  }
  return {
    note(index, tokenCount) {
      const n = Number(tokenCount);
      if (Number.isFinite(n) && n >= 0) counts[index] = n;
    },
    tick,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      try {
        onLive?.(null);
      } catch {
        /* ignore */
      }
    },
  };
}

export async function runConcurrencyWave({
  baseUrl,
  modelId,
  concurrency,
  maxTokens,
  abortSignal,
  sampleHardware = null,
  debug = false,
  apiKey = null,
  promptType = DECODE_BENCH_DEFAULT_TYPE,
  temperature = DEFAULT_TEMPERATURE,
  thinking = DEFAULT_THINKING,
  topK = null,
  onLive = null,
  contextTokens = 0,
  contextSalt = randomUUID(),
  onPrefill = null,
}) {
  const url = `${baseUrl}/v1/chat/completions`;
  // `prompts` are the task prompts (what debug traces show); `sendPrompts` are what goes on the wire.
  const prompts = pickBenchPrompts(concurrency, promptType);
  const deep = contextTokens > 0;
  const sendPrompts = deep
    ? prompts.map((task, i) => buildContextPrompt(contextTokens, `${contextSalt}-${i}`, task))
    : prompts;
  const reqMeta = { url, modelId, maxTokens };

  let fillResults = [];
  let contextPrefillMs = 0;
  if (deep) {
    const fillStart = performance.now();
    const fill = await prefillContexts({
      baseUrl,
      modelId,
      prompts: sendPrompts,
      contextTokens,
      abortSignal,
      apiKey,
      temperature,
      thinking,
      topK,
      onProgress: onPrefill,
    });
    contextPrefillMs = round2(performance.now() - fillStart);
    fillResults = fill.results;
    if (fill.error) {
      const empty = emptyWaveResult(concurrency, 0, [], modelId, fill.error, prompts, debug);
      empty.contextTokens = contextTokens;
      empty.contextPrefillMs = contextPrefillMs;
      return empty;
    }
  }

  const live = createLiveRate(concurrency, onLive);

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
      ...decodeRequestBody(modelId, sendPrompts[streamIndex], maxTokens, { temperature, thinking, topK }),
      min_tokens: maxTokens,
      ignore_eos: true,
      stop: [],
    };

    const streamOpts = {
      debug,
      retryOnThinking400: true,
      thinking,
      apiKey,
      onDelta: (d) => live.note(streamIndex, d?.tokenCount),
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
    live.stop();
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
      `Wave timed out after ${WAVE_TIMEOUT_MS}ms${deep ? " (is prefix caching enabled? The prefilled context may have been recomputed)" : ""}`,
      prompts,
      debug
    );
    if (debug) empty.hardwareSamples = hardwareSamples;
    if (deep) {
      empty.contextTokens = contextTokens;
      empty.contextPrefillMs = contextPrefillMs;
    }
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
  if (deep) {
    // A deep-context number only counts when the measured pass decoded from the prefilled KV.
    const verdicts = results.map((r, i) =>
      r.error
        ? "unknown"
        : assessContextCache({
            promptTokens: r.prefillTokens,
            cachedTokens: r.cachedPromptTokens,
            ttftMs: r.ttftMs,
            fillTtftMs: fillResults[i]?.ttftMs,
          })
    );
    const count = (v) => verdicts.filter((x) => x === v).length;
    wave.contextTokens = contextTokens;
    wave.contextPrefillMs = contextPrefillMs;
    wave.contextCache = {
      cached: count("cached"),
      partial: count("partial"),
      uncached: count("uncached"),
      unknown: count("unknown"),
    };
    wave.streams.forEach((st, i) => {
      st.contextCache = verdicts[i];
    });
    const bad = count("partial") + count("uncached");
    if (bad > 0) {
      wave.warning = `${bad} of ${concurrency} streams re-prefilled part of the ${formatContextSize(contextTokens)} context (prefix cache miss), so their tok/s is not a clean deep-context decode. Enable prefix caching or raise its capacity.`;
    }
  }
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
      this._onEvent("decode", job);
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
      try {
        job._closeTarget?.();
      } catch {
        /* ignore */
      }
      job._closeTarget = null;
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
   *   backend?: string | null,
   *   concurrencies: number[],
   *   maxTokens?: number,
   *   promptType?: string,
   *   temperature?: number,
   *   thinking?: boolean,
   *   debug?: boolean,
   *   sampleHardware?: (() => Promise<object | null> | object | null) | null,
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
      backend = null,
      concurrencies: rawConc,
      maxTokens: rawMax,
      promptType: rawType,
      temperature: rawTemp,
      thinking: rawThinking,
      contextTokens: rawContext,
      debug = false,
      sampleHardware = null,
      apiKey = null,
      resolveTarget = null,
      host: rawHost = null,
      tls: rawTls = false,
      owner = null,
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

    let temperature = rawTemp == null || rawTemp === "" ? DEFAULT_TEMPERATURE : Number(rawTemp);
    if (!Number.isFinite(temperature) || temperature < MIN_TEMPERATURE || temperature > MAX_TEMPERATURE) {
      const err = new Error(`temperature must be between ${MIN_TEMPERATURE} and ${MAX_TEMPERATURE}`);
      err.status = 400;
      throw err;
    }
    temperature = Math.round(temperature * 100) / 100;
    let contextTokens = 0;
    if (rawContext != null && rawContext !== "" && Number(rawContext) !== 0) {
      contextTokens = parseContextSize(rawContext);
      if (contextTokens == null) {
        const err = new Error(`contextTokens must be an integer between ${PREFILL_MIN_CONTEXT_SIZE} and ${PREFILL_MAX_CONTEXT_SIZE}, or 0 to start empty`);
        err.status = 400;
        throw err;
      }
    }
    const promptType = normalizeDecodeBenchType(rawType);
    const thinking =
      rawThinking == null ? DEFAULT_THINKING : rawThinking === true || rawThinking === "true";
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
        promptType,
        temperature,
        thinking,
        ...(backend === "tensorfold" ? { topK: 20 } : {}),
        ...(contextTokens > 0 ? { contextTokens } : {}),
        ...(debugOn ? { debug: true } : {}),
        ...(rawHost
          ? { host: String(rawHost).trim(), tls: Boolean(rawTls) }
          : {}),
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
      _resolveTarget: typeof resolveTarget === "function" ? resolveTarget : null,
      _closeTarget: null,
      owner: owner ? { id: owner.id, via: owner.via } : null,
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
    const debug = Boolean(job._debug);
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
        await warmupDecode({
          baseUrl,
          modelId: job.config.modelId,
          abortSignal: job._abort.signal,
          apiKey: job._apiKey,
          debug,
          promptType: job.config.promptType,
          temperature: job.config.temperature,
          thinking: job.config.thinking,
          topK: job.config.topK,
        });
      }
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
          promptType: job.config.promptType,
          temperature: job.config.temperature,
          thinking: job.config.thinking,
          topK: job.config.topK,
          contextTokens: job.config.contextTokens || 0,
          contextSalt: job.benchId,
          onPrefill: (done, total) => {
            job.progress.prefill = { done, total };
            job.progress.message =
              done < total
                ? `Prefilling ${formatContextSize(job.config.contextTokens)} context ${done + 1}/${total} for ×${c}…`
                : `Running concurrency ${c}…`;
            this._checkpointActive();
          },
          onLive: (tps) => {
            job.progress.liveTps = tps;
          },
        });
        job.progress.prefill = null;

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

export { ALLOWED_CONCURRENCIES, DEFAULT_MAX_TOKENS, normalizeConcurrencies };

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
    owner: job.owner || null,
  };
}

export const decodeBenchManager = new DecodeBenchManager();

export const DECODE_BENCH_DEFAULTS = {
  allowedConcurrencies: [...ALLOWED_CONCURRENCIES].sort((a, b) => a - b),
  defaultMaxTokens: DEFAULT_MAX_TOKENS,
  minMaxTokens: MIN_MAX_TOKENS,
  maxMaxTokens: MAX_MAX_TOKENS,
  promptTypes: [...DECODE_BENCH_TYPES],
  defaultPromptType: DECODE_BENCH_DEFAULT_TYPE,
  defaultTemperature: DEFAULT_TEMPERATURE,
  minTemperature: MIN_TEMPERATURE,
  maxTemperature: MAX_TEMPERATURE,
  defaultThinking: DEFAULT_THINKING,
  minContextTokens: PREFILL_MIN_CONTEXT_SIZE,
  maxContextTokens: PREFILL_MAX_CONTEXT_SIZE,
};
