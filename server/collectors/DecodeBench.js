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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");
const HISTORY_PATH =
  process.env.BENCH_HISTORY_PATH || path.join(ROOT, "config", "bench-history.json");

/**
 * Structured generation prompts (JSON / HTML). Models usually sustain higher
 * decode tok/s on these than open-ended chat essays. Keep prompts short and
 * distinct so concurrent streams don't share an identical prefix.
 */
const BENCH_PROMPTS = [
  "Write only valid JSON (no markdown). Generate a large array \"items\" of objects with fields id, name, category, price, inStock, tags (string array). Keep writing many items until you hit the length limit.",
  "Write only valid JSON (no markdown). Generate a nested object for a fake e-commerce order: orderId, customer, shipping, lineItems[], payments[], timeline[]. Expand lineItems and timeline with many entries.",
  "Write only valid JSON (no markdown). Generate { \"users\": [ ... ] } where each user has id, email, profile{firstName,lastName,bio}, roles[], lastLogin. Add as many users as possible.",
  "Write only valid JSON (no markdown). Generate a metrics dump: { \"hosts\": [ { hostname, cpus[], disks[], gpus[], services[] } ] }. Invent many hosts with nested arrays fully populated.",
  "Write only valid JSON (no markdown). Generate a GraphQL-like schema as JSON: types[], fields[], enums[]. Include many types each with many fields.",
  "Write only valid JSON (no markdown). Generate { \"events\": [ ... ] } log lines with ts, level, service, message, attrs{}. Produce a long continuous event stream.",
  "Write only valid JSON (no markdown). Generate a product catalog: categories[], products[] with sku, title, description, specs{}, variants[]. Make it large.",
  "Write only valid JSON (no markdown). Generate OpenAPI-style paths as JSON: paths{}, components.schemas{}. Invent many endpoints and schemas.",
  "Write only valid HTML5 (no markdown fences). Build a long multi-section documentation page with header, nav, main articles, tables, and footers. Keep adding sections.",
  "Write only valid HTML5 (no markdown fences). Generate a large data table report (<table> with many rows) of invent server metrics: host, cpu, mem, disk, net, status. Dozens of rows.",
  "Write only valid HTML5 (no markdown fences). Create a multi-page-looking dashboard layout with cards, lists, and nested <div>s. Keep expanding content blocks.",
  "Write only valid HTML5 (no markdown fences). Write a long FAQ page with many <h2>/<p>/<ul> Q&A pairs about networking and GPUs. Keep adding pairs.",
  "Write only valid HTML5 (no markdown fences). Generate a blog index with many <article> entries (title, date, tags, excerpt). Continue with lots of articles.",
  "Write only valid HTML5 (no markdown fences). Produce a form-heavy admin UI: multiple <form>s with inputs, selects, textareas, and labels. Expand with more field groups.",
  "Write only valid JSON (no markdown). Generate { \"benchmarks\": [ { name, concurrency, ttftMs, tokPerSec, notes } ] } with many synthetic result rows.",
  "Write only valid JSON (no markdown). Generate a filesystem tree as nested JSON: { name, type, children[] }. Make a deep and wide tree under /data.",
  "Write only valid JSON (no markdown). Generate { \" sparql_like_rows\": [ ... ] } with columns subject, predicate, object, graph — hundreds of triples style rows.",
  "Write only valid HTML5 (no markdown fences). Write a long changelog page with version headings and bullet lists of changes. Keep adding versions.",
  "Write only valid JSON (no markdown). Generate a chat transcript: { \"messages\": [ { role, content, ts } ] } alternating user/assistant, many turns, substantial content.",
  "Write only valid HTML5 (no markdown fences). Generate a recipe site section with many recipes: ingredients lists and step lists. Keep adding recipes.",
  "Write only valid JSON (no markdown). Generate geo data: { \"features\": [ { type:\"Feature\", properties{}, geometry{type,coordinates} } ] } with many features.",
  "Write only valid HTML5 (no markdown fences). Create a long comparison matrix page using nested tables for software features. Fill many rows and columns.",
  "Write only valid JSON (no markdown). Generate CI job results: { \"jobs\": [ { id, name, status, steps[], durationSec, logs[] } ] }. Expand jobs and steps.",
  "Write only valid HTML5 (no markdown fences). Write an API reference page: many endpoint sections with <code> blocks and parameter tables. Keep going.",
  "Write only valid JSON (no markdown). Generate a config blob: services{}, networks{}, volumes{}, env{} with many service definitions and ports.",
  "Write only valid HTML5 (no markdown fences). Produce a news wire page: many <section> items with headline, byline, and paragraphs. Continue writing items.",
  "Write only valid JSON (no markdown). Generate token usage records: { \"requests\": [ { id, model, promptTokens, completionTokens, latencyMs, route } ] } — many requests.",
  "Write only valid HTML5 (no markdown fences). Build a long glossary: <dl> with many <dt>/<dd> terms about ML systems. Keep adding terms.",
  "Write only valid JSON (no markdown). Generate a dependency lock style file: { \"packages\": { \"name\": { version, deps{}, integrity } } } with many packages.",
  "Write only valid HTML5 (no markdown fences). Write a product landing page with repeated feature blocks, pricing tables, and testimonials. Expand heavily.",
  "Write only valid JSON (no markdown). Generate sensor readings: { \"series\": [ { sensorId, points:[{t,v}] } ] } with long point arrays.",
  "Write only valid HTML5 (no markdown fences). Create a multi-chapter tutorial with <h1>–<h3>, code samples in <pre>, and notes. Keep writing chapters.",
];

const ALLOWED_CONCURRENCIES = new Set([1, 2, 3, 4, 6, 8, 16, 32]);
const DEFAULT_MAX_TOKENS = 500;
const MIN_MAX_TOKENS = 64;
const MAX_MAX_TOKENS = 2048;
const PER_REQUEST_TIMEOUT_MS = 180_000;
const WAVE_TIMEOUT_MS = 300_000;
const HISTORY_LIMIT = 10;
/** Hardware sample cadence while a concurrency wave runs (debug timeline). */
const HARDWARE_SAMPLE_MS = 1_000;
/** Cap samples per wave so history stays bounded (~2 min). */
const HARDWARE_SAMPLE_MAX = 120;
/** Truncate streamed content previews stored for debugging. */
const CONTENT_PREVIEW_CHARS = 160;

/** Response headers worth keeping for request correlation / debugging. */
const DEBUG_HEADER_RE =
  /^(x-request-id|x-stainless-|server|date|content-type|openai-|x-envoy-|cf-ray|request-id)$/i;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function mean(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * Read cumulative generation (output) token counters from the server —
 * same sources as LlmProbe live tok/s.
 * @returns {Promise<number | null>}
 */
async function readServerGenerationTokens(baseUrl) {
  // vLLM Prometheus
  try {
    const res = await fetch(`${baseUrl}/metrics`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const txt = await res.text();
      const re =
        /^vllm:generation_tokens_total(?:\{[^}]*\})?\s+([\d.eE+-]+)\s*$/gm;
      let sum = 0;
      let found = false;
      let m;
      while ((m = re.exec(txt)) !== null) {
        const v = parseFloat(m[1]);
        if (Number.isFinite(v)) {
          sum += v;
          found = true;
        }
      }
      if (found) return sum;
    }
  } catch {
    /* try next */
  }

  // SGLang
  try {
    const res = await fetch(`${baseUrl}/get_server_info`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.total_output_tokens != null) {
        const v = Number(data.total_output_tokens);
        if (Number.isFinite(v)) return v;
      }
    }
  } catch {
    /* ignore */
  }

  return null;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Poll server generation counters the same way live LlmProbe does (Δtokens / Δt).
 * Returns the median of positive samples while generation is active — this matches
 * the peak/steady number you see on the dashboard during a long reply.
 *
 * @returns {Promise<{ median: number | null, mean: number | null, max: number | null, samples: number }>}
 */
async function pollServerGenerationRates(baseUrl, signal, intervalMs = 400) {
  /** @type {number[]} */
  const rates = [];
  let lastTokens = await readServerGenerationTokens(baseUrl);
  let lastT = performance.now();

  while (!signal.aborted) {
    try {
      await sleep(intervalMs, signal);
    } catch {
      break;
    }
    const now = performance.now();
    const tokens = await readServerGenerationTokens(baseUrl);
    if (tokens == null || lastTokens == null) {
      if (tokens != null) {
        lastTokens = tokens;
        lastT = now;
      }
      continue;
    }
    const dtSec = (now - lastT) / 1000;
    const dTok = tokens - lastTokens;
    lastTokens = tokens;
    lastT = now;
    // Ignore idle / counter reset samples (same guards as LlmProbe dt window)
    if (dtSec > 0 && dtSec < 10 && dTok > 0) {
      rates.push(dTok / dtSec);
    }
  }

  if (!rates.length) {
    return { median: null, mean: null, max: null, samples: 0 };
  }
  return {
    median: round2(median(rates)),
    mean: round2(mean(rates)),
    max: round2(Math.max(...rates)),
    samples: rates.length,
  };
}

/**
 * Parse one OpenAI-compatible SSE stream for a single completion request.
 *
 * Decode tok/s uses the **first-token → last-token** window (not stream EOF),
 * so trailing usage/[DONE] latency does not drag the rate down.
 *
 * When `debug` is true, also captures a compact HTTP/SSE debug trace
 * (no full completion text).
 */
async function runStreamingRequest(url, body, signal, { debug = false } = {}) {
  const t0 = performance.now();
  /** @type {number | null} */
  let tFirst = null;
  /** @type {number | null} */
  let tLast = null;
  let chunkTokenCount = 0;
  let usageCompletionTokens = null;
  /** @type {Record<string, number> | null} */
  let usage = null;
  let model = null;
  let error = null;
  /** @type {number | null} */
  let httpStatus = null;
  /** @type {Record<string, string>} */
  let responseHeaders = {};
  /** @type {string | null} */
  let completionId = null;
  /** @type {string | null} */
  let finishReason = null;
  let content = "";
  let sseEventCount = 0;
  let firstSseDataPreview = null;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal,
    });

    httpStatus = response.status;
    if (debug) responseHeaders = pickDebugHeaders(response.headers);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    if (!response.body) {
      throw new Error("Empty response body (streaming unsupported?)");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by blank lines
      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        for (const line of rawEvent.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") continue;

          if (debug) {
            sseEventCount += 1;
            if (firstSseDataPreview == null) {
              firstSseDataPreview = data.slice(0, 240);
            }
          }

          let json;
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }

          if (debug && json.id && !completionId) completionId = String(json.id);
          if (json.model) model = json.model;
          if (json.usage && typeof json.usage === "object") {
            if (debug) {
              usage = {
                promptTokens: Number(json.usage.prompt_tokens) || 0,
                completionTokens: Number(json.usage.completion_tokens) || 0,
                totalTokens: Number(json.usage.total_tokens) || 0,
              };
            }
            if (json.usage.completion_tokens != null) {
              usageCompletionTokens = Number(json.usage.completion_tokens);
            }
          }

          const choice = json.choices?.[0];
          if (debug && choice?.finish_reason) finishReason = String(choice.finish_reason);
          const delta = choice?.delta?.content ?? choice?.text ?? "";
          if (typeof delta === "string" && delta.length > 0) {
            const now = performance.now();
            if (tFirst == null) tFirst = now;
            tLast = now;
            // OpenAI-compatible servers typically emit ~1 token per content chunk.
            chunkTokenCount += 1;
            if (debug) content += delta;
          }
        }
      }
    }
  } catch (err) {
    if (err?.name === "AbortError") {
      error = "Request aborted or timed out";
    } else {
      error = err?.message || String(err);
    }
  }

  const tEnd = performance.now();
  const totalMs = tEnd - t0;
  const ttftMs = tFirst != null ? tFirst - t0 : 0;

  // Prefer usage.completion_tokens when the server reports it (accurate).
  const completionTokens =
    usageCompletionTokens != null && usageCompletionTokens > 0
      ? usageCompletionTokens
      : chunkTokenCount;

  // Post-first-token tokens. With usage: all but the first generated token.
  const decodeTokens = Math.max(0, completionTokens - (completionTokens > 0 ? 1 : 0));

  // Decode window: first content token → last content token (excludes prefill + teardown).
  const decodeMs =
    tFirst != null && tLast != null && tLast > tFirst ? tLast - tFirst : 0;
  const decodeTps =
    decodeMs > 0 && decodeTokens > 0 ? (decodeTokens / decodeMs) * 1000 : 0;

  /** @type {Record<string, unknown>} */
  const out = {
    ttftMs: round2(ttftMs),
    decodeMs: round2(decodeMs),
    completionTokens,
    decodeTokens,
    decodeTps: round2(decodeTps),
    totalMs: round2(totalMs),
    /** Absolute performance.now() marks for wave-level aggregation */
    tFirst,
    tLast,
    model,
    error,
  };

  if (debug) {
    out.httpStatus = httpStatus;
    out.responseHeaders = responseHeaders;
    out.completionId = completionId;
    out.finishReason = finishReason;
    out.usage = usage;
    out.sseEventCount = sseEventCount;
    out.firstSseDataPreview = firstSseDataPreview;
    out.contentPreview = {
      first: content.slice(0, CONTENT_PREVIEW_CHARS),
      last:
        content.length > CONTENT_PREVIEW_CHARS
          ? content.slice(-CONTENT_PREVIEW_CHARS)
          : content,
      chars: content.length,
    };
  }

  return out;
}

/** Pick correlatable response headers for the debug trace. */
function pickDebugHeaders(headers) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!headers || typeof headers.forEach !== "function") return out;
  headers.forEach((value, key) => {
    if (DEBUG_HEADER_RE.test(key) || String(key).toLowerCase().startsWith("x-")) {
      out[String(key).toLowerCase()] = String(value);
    }
  });
  return out;
}

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

/**
 * Pick `count` distinct prompts (shuffled). Falls back to unique suffixes if
 * we ever need more than the pool size.
 */
function pickDistinctPrompts(count) {
  const pool = [...BENCH_PROMPTS];
  // Fisher–Yates shuffle so concurrent sets vary across waves/runs
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    if (i < pool.length) {
      out.push(pool[i]);
    } else {
      // Should not hit for allowed concurrencies ≤ pool size
      out.push(`${pool[i % pool.length]}\n\n[stream variant ${i + 1}]`);
    }
  }
  return out;
}

/**
 * Run one concurrency wave: N simultaneous streams, each with a different prompt.
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
    /**
     * Server-side generation tok/s (same basis as live Generation tok/s panel).
     * Null when the backend does not expose counters.
     */
    serverGenerationTps: null,
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
    ttftMs: r?.ttftMs ?? 0,
    decodeTps: r?.decodeTps ?? 0,
    decodeTokens: r?.decodeTokens ?? 0,
    completionTokens: r?.completionTokens ?? 0,
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
}) {
  const url = `${baseUrl}/v1/chat/completions`;
  const prompts = pickDistinctPrompts(concurrency);
  const reqMeta = { url, modelId, maxTokens };

  const wallStart = performance.now();

  // Poll /metrics like the live panel while streams run (steady-state gen tok/s)
  const ratePollAbort = new AbortController();
  const hwPollAbort = new AbortController();
  const onParentForPoll = () => {
    ratePollAbort.abort();
    hwPollAbort.abort();
  };
  if (abortSignal) {
    if (abortSignal.aborted) onParentForPoll();
    else abortSignal.addEventListener("abort", onParentForPoll, { once: true });
  }
  const ratePollPromise = pollServerGenerationRates(baseUrl, ratePollAbort.signal, 400);
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
      temperature: 0,
      stream: true,
      stream_options: { include_usage: true },
      // Prefer full-length generations when the backend supports it
      ignore_eos: true,
      stop: [],
    };

    const timeout = setTimeout(() => ctrl.abort(), PER_REQUEST_TIMEOUT_MS);
    return runStreamingRequest(url, body, ctrl.signal, { debug }).finally(() => {
      clearTimeout(timeout);
      if (abortSignal) abortSignal.removeEventListener("abort", onParentAbort);
    });
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
    ratePollAbort.abort();
    hwPollAbort.abort();
    if (abortSignal) abortSignal.removeEventListener("abort", onParentForPoll);
  }

  const wallEnd = performance.now();
  const waveMs = wallEnd - wallStart;
  const rateStats = await ratePollPromise;
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
  const totalDecodeTokens = ok.reduce((s, r) => s + r.decodeTokens, 0);
  const totalCompletionTokens = ok.reduce((s, r) => s + r.completionTokens, 0);

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

  // Primary server number: median of live-style poll samples (matches dashboard)
  let serverGenerationTps = rateStats.median;
  // Fallback: total completion tokens / client decode window if no metrics endpoint
  if (serverGenerationTps == null && aggregateDecodeTps > 0) {
    serverGenerationTps = round2(aggregateDecodeTps);
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
    serverGenerationTps,
    serverGenerationTpsMax: rateStats.max,
    serverGenerationSamples: rateStats.samples,
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
 */
export class DecodeBenchManager {
  constructor(historyPath = HISTORY_PATH) {
    /** @type {Map<string, object>} */
    this.jobs = new Map();
    /** @type {Map<string, string>} sparkId → active benchId */
    this.activeBySpark = new Map();
    /** @type {Map<string, object[]>} */
    this.historyBySpark = new Map();
    this.historyPath = historyPath;
    this._loadHistory();
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
    } = opts;

    if (this.activeBySpark.has(sparkId)) {
      const err = new Error("A benchmark is already running for this Spark");
      err.status = 409;
      throw err;
    }

    const concurrencies = normalizeConcurrencies(rawConc);
    if (!concurrencies.length) {
      const err = new Error("Select at least one concurrency level (1, 2, 3, 4, 6, 8, 16, or 32)");
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
      _sampleHardware:
        debugOn && typeof sampleHardware === "function" ? sampleHardware : null,
    };

    this.jobs.set(benchId, job);
    this.activeBySpark.set(sparkId, benchId);

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
          job.status = "cancelled";
          job.error = "Cancelled by user";
          job.progress.message = "Cancelled";
          break;
        }

        job.progress.currentConcurrency = c;
        job.progress.message = `Running concurrency ${c}…`;

        const wave = await runConcurrencyWave({
          baseUrl,
          modelId: job.config.modelId,
          concurrency: c,
          maxTokens: job.config.maxTokens,
          abortSignal: job._abort.signal,
          sampleHardware: job._sampleHardware,
          debug,
        });

        if (job._abort.signal.aborted) {
          // Keep partial wave only if it fully succeeded before cancel
          if (wave.streamsOk > 0 && !wave.error) {
            job.results.push(wave);
            job.progress.completedLevels += 1;
          }
          job.status = "cancelled";
          job.error = "Cancelled by user";
          job.progress.message = "Cancelled";
          break;
        }

        if (wave.model && !job.config.modelId) {
          job.config.modelId = wave.model;
        }

        job.results.push(wave);
        job.progress.completedLevels += 1;
      }

      if (job.status === "running") {
        job.status = "completed";
        job.progress.currentConcurrency = null;
        job.progress.message = "Done";
      }
    } catch (err) {
      if (job._abort.signal.aborted) {
        job.status = "cancelled";
        job.error = "Cancelled by user";
        job.progress.message = "Cancelled";
      } else {
        job.status = "failed";
        job.error = err?.message || String(err);
        job.progress.message = "Failed";
      }
    } finally {
      job.completedAt = Date.now();
      this.activeBySpark.delete(job.sparkId);
      this._pushHistory(job);
    }
  }

  _pushHistory(job) {
    const list = this.historyBySpark.get(job.sparkId) || [];
    list.unshift(publicJob(job));
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
