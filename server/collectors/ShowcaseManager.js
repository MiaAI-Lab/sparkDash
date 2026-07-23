/**
 * ShowcaseManager — ephemeral concurrent prompt showcase sessions.
 *
 * One active session per Spark. No disk persistence. Heartbeat via GET poll;
 * auto-cancels if no touch for ~5s while running.
 */

import { randomUUID } from "crypto";
import { decodeBenchManager } from "./DecodeBench.js";
import {
  applyThinkingFlags,
  pollServerGenerationRates,
  round2,
  runStreamingRequest,
} from "./LlmStreaming.js";

const DEFAULT_MAX_TOKENS = 512;
const MIN_MAX_TOKENS = 64;
const MAX_MAX_TOKENS = 2048;
const MIN_PROMPTS = 1;
const MAX_PROMPTS = 32;
const MIN_PROMPT_LEN = 1;
const MAX_PROMPT_LEN = 4000;
const HEARTBEAT_TIMEOUT_MS = 5_000;
const HEARTBEAT_CHECK_MS = 1_000;
const PER_REQUEST_TIMEOUT_MS = 180_000;
const LABEL_CHARS = 40;

/**
 * Cap accumulated content per stream at min(maxTokens * 8, 200_000) chars.
 * @param {number} maxTokens
 */
function contentCap(maxTokens) {
  return Math.min(Math.max(1, maxTokens) * 8, 200_000);
}

function labelFromPrompt(prompt) {
  const s = String(prompt || "").replace(/\s+/g, " ").trim();
  if (s.length <= LABEL_CHARS) return s;
  return `${s.slice(0, LABEL_CHARS - 1)}…`;
}

function isTerminalStreamStatus(status) {
  return status === "completed" || status === "error" || status === "cancelled";
}

export class ShowcaseManager {
  constructor() {
    /** @type {Map<string, object>} sessionId → session */
    this.sessions = new Map();
    /** @type {Map<string, string>} sparkId → active sessionId */
    this.activeBySpark = new Map();
    /** @type {ReturnType<typeof setInterval> | null} */
    this._heartbeatTimer = null;
    this._ensureHeartbeatWatch();
  }

  _ensureHeartbeatWatch() {
    if (this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(() => {
      this._checkHeartbeats();
    }, HEARTBEAT_CHECK_MS);
    if (typeof this._heartbeatTimer.unref === "function") {
      this._heartbeatTimer.unref();
    }
  }

  _checkHeartbeats() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.status !== "running") continue;
      const last = session._lastTouchAt || session.startedAt;
      if (now - last >= HEARTBEAT_TIMEOUT_MS) {
        this.cancel(session.sparkId, session.sessionId, "Heartbeat timeout");
      }
    }
  }

  getActive(sparkId) {
    const id = this.activeBySpark.get(sparkId);
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session || session.status !== "running") return null;
    return { sessionId: session.sessionId, status: session.status };
  }

  touch(sparkId, sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.sparkId !== sparkId) return false;
    session._lastTouchAt = Date.now();
    return true;
  }

  /**
   * @param {{
   *   sparkId: string,
   *   lanIp: string,
   *   port: number,
   *   modelId?: string | null,
   *   maxTokens?: number,
   *   thinking?: boolean,
   *   prompts: string[],
   * }} opts
   */
  start(opts) {
    const {
      sparkId,
      lanIp,
      port,
      modelId = null,
      maxTokens: rawMax,
      thinking: rawThinking,
      prompts: rawPrompts,
    } = opts;

    if (this.activeBySpark.has(sparkId)) {
      const err = new Error("A showcase is already running for this Spark");
      err.status = 409;
      throw err;
    }
    if (decodeBenchManager.getActive(sparkId)) {
      const err = new Error("A decode benchmark is already running for this Spark");
      err.status = 409;
      throw err;
    }

    const prompts = normalizePrompts(rawPrompts);
    if (!prompts) {
      const err = new Error(
        `prompts must be an array of ${MIN_PROMPTS}–${MAX_PROMPTS} strings (each ${MIN_PROMPT_LEN}–${MAX_PROMPT_LEN} chars)`
      );
      err.status = 400;
      throw err;
    }

    let maxTokens = Number(rawMax);
    if (!Number.isFinite(maxTokens)) maxTokens = DEFAULT_MAX_TOKENS;
    maxTokens = Math.round(maxTokens);
    if (maxTokens < MIN_MAX_TOKENS || maxTokens > MAX_MAX_TOKENS) {
      const err = new Error(
        `maxTokens must be between ${MIN_MAX_TOKENS} and ${MAX_MAX_TOKENS}`
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

    const thinking = rawThinking !== false;

    const sessionId = randomUUID();
    const abort = new AbortController();
    const cap = contentCap(maxTokens);
    const now = Date.now();

    /** @type {object[]} */
    const streams = prompts.map((prompt, i) => ({
      streamId: String(i),
      label: labelFromPrompt(prompt),
      prompt,
      status: "pending",
      /** Answer text (delta.content) */
      content: "",
      /** Reasoning / thinking text */
      reasoning: "",
      contentLength: 0,
      reasoningLength: 0,
      contentCapped: false,
      tokenCount: 0,
      ttftMs: null,
      decodeTps: 0,
      liveTokPerSec: 0,
      model: null,
      error: null,
      _t0: null,
      _tFirst: null,
      _tLast: null,
      _abort: null,
    }));

    const session = {
      sessionId,
      sparkId,
      status: "running",
      rev: 0,
      port: p,
      modelId: modelId || null,
      maxTokens,
      thinking,
      startedAt: now,
      completedAt: null,
      streams,
      error: null,
      /** Live /metrics generation tok/s strip */
      serverGenerationTps: null,
      serverGenerationTpsMax: null,
      serverGenerationSamples: 0,
      _abort: abort,
      _lastTouchAt: now,
      _contentCap: cap,
      _lanIp: lanIp,
      _sentContentLengths: /** @type {number[]} */ (prompts.map(() => 0)),
      _sentReasoningLengths: /** @type {number[]} */ (prompts.map(() => 0)),
    };

    this.sessions.set(sessionId, session);
    this.activeBySpark.set(sparkId, sessionId);

    this._runSession(session).catch(() => {
      /* errors recorded on session */
    });

    return { sessionId, status: "running" };
  }

  /**
   * Live snapshot for poll. Delta-friendly via `since` rev.
   * @param {string} sparkId
   * @param {string} sessionId
   * @param {number | null} [since]
   */
  getSession(sparkId, sessionId, since = null) {
    const session = this.sessions.get(sessionId);
    if (!session || session.sparkId !== sparkId) return null;

    this.touch(sparkId, sessionId);

    const sinceRev =
      since != null && Number.isFinite(Number(since))
        ? Math.max(0, Math.floor(Number(since)))
        : null;
    const fullSnapshot = sinceRev == null;

    const streams = session.streams.map((s, i) => {
      const content = s.content || "";
      const reasoning = s.reasoning || "";
      const sentContent = fullSnapshot ? 0 : (session._sentContentLengths[i] ?? 0);
      const sentReasoning = fullSnapshot ? 0 : (session._sentReasoningLengths[i] ?? 0);
      const resetContent =
        !fullSnapshot && (sentContent > content.length || sentReasoning > reasoning.length);

      session._sentContentLengths[i] = content.length;
      session._sentReasoningLengths[i] = reasoning.length;

      /** @type {Record<string, unknown>} */
      const out = {
        streamId: s.streamId,
        label: s.label,
        prompt: s.prompt,
        status: s.status,
        contentLength: s.contentLength,
        reasoningLength: s.reasoningLength,
        resetContent: Boolean(resetContent),
        tokenCount: s.tokenCount,
        ttftMs: s.ttftMs,
        decodeTps: s.decodeTps,
        liveTokPerSec: s.liveTokPerSec,
        model: s.model,
        error: s.error,
      };

      if (fullSnapshot || resetContent) {
        out.content = content;
        out.reasoning = reasoning;
        out.contentAppend = "";
        out.reasoningAppend = "";
      } else {
        out.contentAppend = content.slice(sentContent);
        out.reasoningAppend = reasoning.slice(sentReasoning);
      }

      return out;
    });

    return {
      sessionId: session.sessionId,
      sparkId: session.sparkId,
      status: session.status,
      rev: session.rev,
      port: session.port,
      modelId: session.modelId,
      startedAt: session.startedAt,
      serverGenerationTps: session.serverGenerationTps,
      serverGenerationTpsMax: session.serverGenerationTpsMax,
      serverGenerationSamples: session.serverGenerationSamples,
      streams,
      error: session.error,
    };
  }

  /**
   * @param {string} sparkId
   * @param {string} sessionId
   * @param {string} [reason]
   */
  cancel(sparkId, sessionId, reason = "Cancelled by user") {
    const session = this.sessions.get(sessionId);
    if (!session || session.sparkId !== sparkId) return null;
    if (session.status !== "running") {
      return this.getSession(sparkId, sessionId);
    }

    session._abort.abort();
    for (const s of session.streams) {
      if (!isTerminalStreamStatus(s.status)) {
        s.status = "cancelled";
        if (!s.error) s.error = reason;
        try {
          s._abort?.abort();
        } catch {
          /* ignore */
        }
      }
    }
    session.status = "cancelled";
    session.error = reason;
    session.completedAt = Date.now();
    this._bumpRev(session);
    this.activeBySpark.delete(sparkId);
    return this.getSession(sparkId, sessionId);
  }

  _bumpRev(session) {
    session.rev += 1;
  }

  _updateLiveMetrics(stream, info) {
    const now = performance.now();
    if (info?.tFirst != null) stream._tFirst = info.tFirst;
    if (info?.tLast != null) stream._tLast = info.tLast;
    if (info?.tokenCount != null) stream.tokenCount = info.tokenCount;
    if (info?.model) stream.model = info.model;

    if (stream._t0 != null && stream._tFirst != null && stream.ttftMs == null) {
      stream.ttftMs = round2(stream._tFirst - stream._t0);
    }

    if (stream._tFirst != null && stream.tokenCount > 0) {
      const elapsedMs = Math.max(0, now - stream._tFirst);
      if (elapsedMs > 0) {
        const decodeTokens = Math.max(0, stream.tokenCount - 1);
        stream.liveTokPerSec = round2((decodeTokens / elapsedMs) * 1000);
      }
    }
  }

  /**
   * Append to answer and/or reasoning under a shared char cap.
   * @param {object} session
   * @param {object} stream
   * @param {{ answer?: string, reasoning?: string }} parts
   */
  _appendParts(session, stream, parts) {
    if (stream.contentCapped) return;
    const cap = session._contentCap;
    const used = stream.content.length + stream.reasoning.length;
    let room = cap - used;
    if (room <= 0) {
      stream.contentCapped = true;
      return;
    }

    const appendOne = (field, text) => {
      if (!text || room <= 0) return;
      if (text.length <= room) {
        stream[field] += text;
        room -= text.length;
      } else {
        stream[field] += text.slice(0, room);
        room = 0;
        stream.contentCapped = true;
      }
    };

    // Prefer keeping reasoning "alive" then answer
    appendOne("reasoning", parts.reasoning);
    appendOne("content", parts.answer);

    stream.contentLength = stream.content.length;
    stream.reasoningLength = stream.reasoning.length;
  }

  async _runSession(session) {
    const baseUrl = `http://${session._lanIp}:${session.port}`;
    const url = `${baseUrl}/v1/chat/completions`;

    const ratePollAbort = new AbortController();
    const onParentForPoll = () => ratePollAbort.abort();
    if (session._abort.signal.aborted) onParentForPoll();
    else session._abort.signal.addEventListener("abort", onParentForPoll, { once: true });

    const ratePollPromise = pollServerGenerationRates(
      baseUrl,
      ratePollAbort.signal,
      400,
      {
        onSample: (info) => {
          if (session.status !== "running") return;
          session.serverGenerationTps = info.median;
          session.serverGenerationTpsMax = info.max;
          session.serverGenerationSamples = info.samples;
          this._bumpRev(session);
        },
      }
    );

    const promises = session.streams.map((stream) => {
      const ctrl = new AbortController();
      stream._abort = ctrl;

      const onParentAbort = () => ctrl.abort();
      if (session._abort.signal.aborted) ctrl.abort();
      else session._abort.signal.addEventListener("abort", onParentAbort, { once: true });

      const body = {
        model: session.modelId || undefined,
        messages: [{ role: "user", content: stream.prompt }],
        max_tokens: session.maxTokens,
        temperature: 0.7,
        stream: true,
        stream_options: { include_usage: true },
      };
      applyThinkingFlags(body, session.modelId, session.thinking !== false);

      stream.status = "streaming";
      stream._t0 = performance.now();
      this._bumpRev(session);

      const timeout = setTimeout(() => ctrl.abort(), PER_REQUEST_TIMEOUT_MS);

      return runStreamingRequest(url, body, ctrl.signal, {
        collectContent: true,
        retryOnThinking400: true,
        onDelta: (info) => {
          if (session.status !== "running") return;
          this._appendParts(session, stream, {
            answer: info?.answer,
            reasoning: info?.reasoning,
          });
          this._updateLiveMetrics(stream, info);
          this._bumpRev(session);
        },
      })
        .then((result) => {
          if (session._abort.signal.aborted && stream.status === "streaming") {
            stream.status = "cancelled";
            stream.error = stream.error || "Cancelled";
          } else if (result.error) {
            stream.status = "error";
            stream.error = result.error;
          } else {
            stream.status = "completed";
            stream.error = null;
          }

          stream.tokenCount = result.completionTokens ?? stream.tokenCount;
          stream.ttftMs =
            result.ttftMs != null && result.ttftMs > 0
              ? result.ttftMs
              : stream.ttftMs;
          stream.decodeTps = result.decodeTps ?? 0;
          stream.liveTokPerSec = stream.decodeTps;
          if (result.model) stream.model = result.model;

          // Prefer live buffers; fill gaps from final collectContent
          if (result.answer && result.answer.length > stream.content.length) {
            stream.content = result.answer;
          }
          if (result.reasoning && result.reasoning.length > stream.reasoning.length) {
            stream.reasoning = result.reasoning;
          }
          // Enforce cap after fill
          const total = stream.content.length + stream.reasoning.length;
          if (total > session._contentCap) {
            const over = total - session._contentCap;
            if (stream.content.length >= over) {
              stream.content = stream.content.slice(0, stream.content.length - over);
            } else {
              const rest = over - stream.content.length;
              stream.content = "";
              stream.reasoning = stream.reasoning.slice(0, Math.max(0, stream.reasoning.length - rest));
            }
            stream.contentCapped = true;
          }
          stream.contentLength = stream.content.length;
          stream.reasoningLength = stream.reasoning.length;

          this._bumpRev(session);
        })
        .finally(() => {
          clearTimeout(timeout);
          session._abort.signal.removeEventListener("abort", onParentAbort);
        });
    });

    try {
      await Promise.all(promises);
    } catch {
      /* per-stream errors recorded */
    } finally {
      ratePollAbort.abort();
      session._abort.signal.removeEventListener("abort", onParentForPoll);
      const rateStats = await ratePollPromise;
      if (rateStats.median != null) session.serverGenerationTps = rateStats.median;
      if (rateStats.max != null) session.serverGenerationTpsMax = rateStats.max;
      session.serverGenerationSamples = rateStats.samples;

      if (session.status === "running") {
        this._finalizeSession(session);
      }
      this.activeBySpark.delete(session.sparkId);
      session.completedAt = session.completedAt ?? Date.now();
    }
  }

  _finalizeSession(session) {
    const streams = session.streams;
    const anyOk = streams.some(
      (s) => s.status === "completed" && s.tokenCount > 0
    );
    const allFailed = streams.every(
      (s) => s.status === "error" || (s.status === "completed" && s.tokenCount <= 0)
    );
    const anyCancelled = streams.some((s) => s.status === "cancelled");

    if (session._abort.signal.aborted || anyCancelled) {
      if (session.status === "running") {
        session.status = anyOk ? "completed" : "cancelled";
        if (session.status === "cancelled" && !session.error) {
          session.error = "Cancelled";
        }
      }
    } else if (allFailed && !anyOk) {
      session.status = "error";
      session.error =
        streams.find((s) => s.error)?.error || "All streams failed";
    } else {
      session.status = "completed";
    }
    this._bumpRev(session);
  }
}

/**
 * @param {unknown} raw
 * @returns {string[] | null}
 */
function normalizePrompts(raw) {
  if (!Array.isArray(raw)) return null;
  if (raw.length < MIN_PROMPTS || raw.length > MAX_PROMPTS) return null;
  /** @type {string[]} */
  const out = [];
  for (const p of raw) {
    if (typeof p !== "string") return null;
    const t = p.trim();
    if (t.length < MIN_PROMPT_LEN || t.length > MAX_PROMPT_LEN) return null;
    out.push(t);
  }
  return out;
}

export const showcaseManager = new ShowcaseManager();

export const SHOWCASE_DEFAULTS = {
  defaultMaxTokens: DEFAULT_MAX_TOKENS,
  minMaxTokens: MIN_MAX_TOKENS,
  maxMaxTokens: MAX_MAX_TOKENS,
  minPrompts: MIN_PROMPTS,
  maxPrompts: MAX_PROMPTS,
  heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
};
