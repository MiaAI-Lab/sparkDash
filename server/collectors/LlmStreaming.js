/**
 * Shared OpenAI-compatible SSE streaming helpers used by DecodeBench and Showcase.
 *
 * Decode tok/s uses the first visible token → last visible token window
 * (not stream EOF), so trailing usage/[DONE] latency does not drag the rate down.
 */

/** Response headers worth keeping for request correlation / debugging. */
const DEBUG_HEADER_RE =
  /^(x-request-id|x-stainless-|server|date|content-type|openai-|x-envoy-|cf-ray|request-id)$/i;

/** Truncate streamed content previews stored for debugging. */
export const CONTENT_PREVIEW_CHARS = 160;

export function round2(n) {
  return Math.round(n * 100) / 100;
}

export function mean(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export function sleep(ms, signal) {
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
 * Read cumulative generation (output) token counters from the server —
 * same sources as LlmProbe live tok/s.
 * @returns {Promise<number | null>}
 */
export async function readServerGenerationTokens(baseUrl) {
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

/** Pick correlatable response headers for the debug trace. */
export function pickDebugHeaders(headers) {
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
 * Extract visible text pieces from an OpenAI-compatible delta (or choice.text).
 * Counts content + reasoning / reasoning_content so thinking models stay "alive".
 * Separates answer (`content`/`text`) from reasoning for display styling.
 * @returns {{ answer: string, reasoning: string, tokenChunks: number }}
 */
function extractDeltaPieces(choice) {
  let answer = "";
  let reasoning = "";
  let tokenChunks = 0;

  const delta = choice?.delta;
  if (delta && typeof delta === "object") {
    if (typeof delta.content === "string" && delta.content.length > 0) {
      answer = delta.content;
      tokenChunks += 1;
    }
    // Prefer delta.reasoning; fall back to reasoning_content (don't double-count)
    if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
      reasoning = delta.reasoning;
      tokenChunks += 1;
    } else if (
      typeof delta.reasoning_content === "string" &&
      delta.reasoning_content.length > 0
    ) {
      reasoning = delta.reasoning_content;
      tokenChunks += 1;
    }
  }

  // Non-delta fallbacks (some backends)
  if (!answer && !reasoning && typeof choice?.text === "string" && choice.text.length > 0) {
    answer = choice.text;
    tokenChunks = 1;
  }

  return { answer, reasoning, tokenChunks };
}

/**
 * Apply per-model thinking flags so reasoning models don't 400.
 * MiniMax-M3 needs `thinking_mode`; most others use `enable_thinking`.
 *
 * @param {Record<string, unknown>} body
 * @param {string | null | undefined} modelId
 * @param {boolean} [think=true]
 */
export function applyThinkingFlags(body, modelId, think = true) {
  if (!body || typeof body !== "object") return body;
  const id = String(modelId || "").toLowerCase();
  /** @type {Record<string, unknown>} */
  const ctk = {
    ...(body.chat_template_kwargs && typeof body.chat_template_kwargs === "object"
      ? body.chat_template_kwargs
      : {}),
    enable_thinking: think,
  };
  // MiniMax-M3 (and similarly named) use thinking_mode
  if (id.includes("minimax") || /(^|[^a-z])m3([^a-z]|$)/.test(id)) {
    ctk.thinking_mode = think ? "enabled" : "disabled";
  }
  body.chat_template_kwargs = ctk;
  return body;
}

/**
 * Strip thinking-related request fields (for 400 retry).
 * @param {Record<string, unknown>} body
 */
export function stripThinkingFlags(body) {
  if (!body || typeof body !== "object") return body;
  if (body.chat_template_kwargs && typeof body.chat_template_kwargs === "object") {
    const ctk = { ...body.chat_template_kwargs };
    delete ctk.enable_thinking;
    delete ctk.thinking_mode;
    if (Object.keys(ctk).length) body.chat_template_kwargs = ctk;
    else delete body.chat_template_kwargs;
  }
  return body;
}

/**
 * Poll server generation counters the same way live LlmProbe does (Δtokens / Δt).
 * Returns the median of positive samples while generation is active.
 *
 * @param {string} baseUrl
 * @param {AbortSignal} signal
 * @param {number} [intervalMs=400]
 * @param {{ onSample?: (info: { rate: number, median: number | null, max: number | null, samples: number }) => void }} [opts]
 * @returns {Promise<{ median: number | null, mean: number | null, max: number | null, samples: number }>}
 */
export async function pollServerGenerationRates(
  baseUrl,
  signal,
  intervalMs = 400,
  opts = {}
) {
  /** @type {number[]} */
  const rates = [];
  let lastTokens = await readServerGenerationTokens(baseUrl);
  let lastT = performance.now();
  const onSample = typeof opts.onSample === "function" ? opts.onSample : null;

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
      const rate = dTok / dtSec;
      rates.push(rate);
      if (onSample) {
        try {
          onSample({
            rate: round2(rate),
            median: rates.length ? round2(median(rates)) : null,
            max: rates.length ? round2(Math.max(...rates)) : null,
            samples: rates.length,
          });
        } catch {
          /* non-fatal */
        }
      }
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
 * Options:
 * - debug: capture compact HTTP/SSE debug trace
 * - collectContent: accumulate full visible text (showcase)
 * - onDelta: live callback `{ text?, answer?, reasoning?, tokenCount, tFirst, tLast, … }`
 * - retryOnThinking400: if HTTP 400 and body had thinking flags, retry once stripped
 */
export async function runStreamingRequest(
  url,
  body,
  signal,
  {
    debug = false,
    collectContent = false,
    onDelta = null,
    retryOnThinking400 = false,
  } = {}
) {
  const result = await runStreamingRequestOnce(url, body, signal, {
    debug,
    collectContent,
    onDelta,
  });

  if (
    retryOnThinking400 &&
    result.error &&
    /^HTTP 400\b/.test(result.error) &&
    body &&
    typeof body === "object" &&
    body.chat_template_kwargs
  ) {
    const retryBody = stripThinkingFlags({ ...body, chat_template_kwargs: { ...body.chat_template_kwargs } });
    return runStreamingRequestOnce(url, retryBody, signal, {
      debug,
      collectContent,
      onDelta,
    });
  }

  return result;
}

/**
 * @param {string} url
 * @param {Record<string, unknown>} body
 * @param {AbortSignal} signal
 * @param {{ debug?: boolean, collectContent?: boolean, onDelta?: Function | null }} opts
 */
async function runStreamingRequestOnce(
  url,
  body,
  signal,
  { debug = false, collectContent = false, onDelta = null } = {}
) {
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
  let reasoningContent = "";
  let answerContent = "";
  let sseEventCount = 0;
  let firstSseDataPreview = null;
  const keepContent = Boolean(debug || collectContent);
  const deltaCb = typeof onDelta === "function" ? onDelta : null;

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

          const { answer, reasoning, tokenChunks } = extractDeltaPieces(choice);
          if (tokenChunks > 0) {
            const now = performance.now();
            if (tFirst == null) tFirst = now;
            tLast = now;
            chunkTokenCount += tokenChunks;
            const text = `${reasoning}${answer}`;
            if (keepContent) {
              if (reasoning) reasoningContent += reasoning;
              if (answer) answerContent += answer;
              content += text;
            }
            if (deltaCb) {
              try {
                deltaCb({
                  text: text || undefined,
                  answer: answer || undefined,
                  reasoning: reasoning || undefined,
                  tokenCount: chunkTokenCount,
                  tFirst,
                  tLast,
                  model,
                });
              } catch {
                /* non-fatal */
              }
            }
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

  if (collectContent) {
    out.content = content;
    out.answer = answerContent;
    out.reasoning = reasoningContent;
  }

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

