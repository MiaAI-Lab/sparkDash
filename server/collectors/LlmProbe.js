/**
 * LlmProbe — probes an LLM server on port 8888, auto-detects backend,
 * computes live tokens/sec (generation + prefill).
 *
 * Ported from legacy `probeLlamaServerType` and `_getLlamaMetricsFor`.
 */
import { LLM_PROBE_TIMEOUT_MS } from "../config.js";
import { classifyHostScope } from "../validate.js";

const FAIL_RESET_THRESHOLD = 3;
const REDETECT_INTERVAL_MS = 60_000;

/**
 * Prefer a short model id when the server returns a Hugging Face hub cache path.
 * e.g. /root/.cache/huggingface/models--org--Name/snapshots/<hash>
 *   → org/Name
 * @param {unknown} id
 * @returns {string | null}
 */
export function normalizeModelId(id) {
  if (id == null) return null;
  const s = String(id).trim();
  if (!s) return null;

  const hub = s.match(/(?:^|\/)models--([^/]+?)(?:\/snapshots\/[^/]+)?\/?$/);
  if (hub) return hub[1].replace(/--/g, "/");

  const mid = s.match(/models--([^/]+)\/snapshots\//);
  if (mid) return mid[1].replace(/--/g, "/");

  return s;
}

/**
 * Extract cumulative prompt/generation token totals from SGLang server_info JSON.
 * Newer builds often omit these (use Prometheus instead); older builds expose
 * top-level totals or per-scheduler `internal_states`.
 * @param {Record<string, unknown>} data
 * @returns {{ input: number, output: number } | null}
 */
export function readSglangTokenTotals(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;

  const topIn = data.total_input_tokens ?? data.prompt_tokens;
  const topOut = data.total_output_tokens ?? data.generation_tokens;
  if (topIn != null && topOut != null) {
    const input = Number(topIn);
    const output = Number(topOut);
    if (Number.isFinite(input) && Number.isFinite(output)) return { input, output };
  }

  const states = data.internal_states ?? data.internal_state;
  if (Array.isArray(states)) {
    let input = 0;
    let output = 0;
    let found = false;
    for (const s of states) {
      if (!s || typeof s !== "object") continue;
      const out = s.total_output_tokens ?? s.generation_tokens;
      if (out == null) continue;
      const o = Number(out);
      const i = Number(s.total_input_tokens ?? s.prompt_tokens ?? 0);
      if (!Number.isFinite(o)) continue;
      output += o;
      input += Number.isFinite(i) ? i : 0;
      found = true;
    }
    if (found) return { input, output };
  }

  return null;
}

/**
 * SGLang's last measured decode rate from get_server_info.
 * NOTE: this value is sticky after idle — only use it when /v1/loads (or
 * metrics) reports active requests.
 * @param {Record<string, unknown>} data
 * @returns {number | null}
 */
export function readSglangLiveThroughput(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;

  const states = data.internal_states ?? data.internal_state;
  if (Array.isArray(states) && states.length > 0) {
    let sum = 0;
    let found = false;
    for (const s of states) {
      if (!s || typeof s !== "object") continue;
      const v = Number(s.last_gen_throughput);
      if (!Number.isFinite(v)) continue;
      sum += v;
      found = true;
    }
    if (found) return Math.max(0, Math.round(sum * 100) / 100);
  }

  const top = Number(data.last_gen_throughput);
  if (Number.isFinite(top)) return Math.max(0, Math.round(top * 100) / 100);
  return null;
}

/**
 * Parse SGLang `/v1/loads` JSON — live activity + gen_throughput (0 when idle).
 * @param {unknown} data
 * @returns {{ running: number, waiting: number, genThroughput: number, usedTokens: number, busy: boolean } | null}
 */
export function readSglangLoads(data) {
  if (!data || typeof data !== "object") return null;
  const loads = Array.isArray(/** @type {any} */ (data).loads)
    ? /** @type {any} */ (data).loads
    : Array.isArray(data)
      ? data
      : null;
  if (!loads || loads.length === 0) return null;

  let running = 0;
  let waiting = 0;
  let genTps = 0;
  let used = 0;
  let found = false;
  for (const row of loads) {
    if (!row || typeof row !== "object") continue;
    found = true;
    const r = Number(row.num_running_reqs);
    const w = Number(row.num_waiting_reqs);
    if (Number.isFinite(r)) running += r;
    if (Number.isFinite(w)) waiting += w;
    const g = Number(row.gen_throughput);
    if (Number.isFinite(g)) genTps += g;
    const u = Number(row.num_used_tokens ?? row.num_active_tokens);
    if (Number.isFinite(u)) used += u;
  }
  if (!found) return null;
  return {
    running,
    waiting,
    genThroughput: Math.max(0, Math.round(genTps * 100) / 100),
    usedTokens: used,
    busy: running > 0 || waiting > 0,
  };
}

export class LlmProbe {
  constructor(spark, port = 8888) {
    this.spark = spark;
    this.port = port;
    this.baseUrl = `http://${spark.lanIp}:${port}`;

    // State
    this.backendType = null; // 'vllm' | 'llama.cpp' | 'sglang' | null
    this.serverIsOpenAI = null; // true = OpenAI-compatible
    /** Whether /v1/models (or /slots) answered without credentials. null = unknown. */
    this.authOpen = null;
    this.stepId = 0;
    this.modelId = null;
    this.modelPath = null;
    this.contextLength = null;
    this.gpuMemoryUtilization = null;
    this.slotsActive = 0;
    this.slotsTotal = 0;
    this.generationTps = 0;
    this.prefillTps = 0;
    this.error = null;

    // Per-slot rate tracking (for llama.cpp native path)
    this.slotState = new Map();
    this.lastTokenCounts = { input: 0, output: 0 };
    this.lastProbeTime = 0;
    /** Last /v1/loads used-token sum (for SGLang delta when gauges are idle/sticky). */
    this._lastSglangUsedTokens = null;

    // Cumulative total output tokens (generation) as reported by the LLM server
    this.totalOutputTokens = 0;

    // vLLM inference metrics from /metrics (null when not vLLM / missing series)
    // Metric names follow stock vLLM Prometheus exposition (versions may differ).
    this.kvCacheUsage = null; // 0–1 fraction
    this.requestsRunning = null;
    this.requestsWaiting = null;
    this.ttftP95Seconds = null;
    this.preemptionsTotal = null; // cumulative counter
    /** Prefix cache hit rate 0–1 (hits/queries). */
    this.prefixCacheHitRate = null;
    /** End-to-end request latency p95 (seconds). */
    this.e2eP95Seconds = null;
    /** Inter-token latency p95 (seconds). */
    this.itlP95Seconds = null;
    /** Speculative/MTP acceptance rate 0–1 (accepted/drafted). */
    this.mtpAcceptanceRate = null;

    this._consecutiveFailures = 0;
    this._lastDetectAt = 0;
  }

  /** Update probe port (and host from spark). Resets detection when the target changes. */
  setPort(port) {
    const next = Number(port);
    const prevUrl = this.baseUrl;
    if (Number.isInteger(next) && next >= 1 && next <= 65535) {
      this.port = next;
    }
    this.baseUrl = `http://${this.spark.lanIp}:${this.port}`;
    if (this.baseUrl !== prevUrl) {
      this._resetDetection();
      this._lastDetectAt = 0;
      this._consecutiveFailures = 0;
    }
  }

  /** Probe the LLM server and return a snapshot. */
  async probe() {
    try {
      const shouldDetect =
        this.serverIsOpenAI === null ||
        Date.now() - this._lastDetectAt > REDETECT_INTERVAL_MS;

      if (shouldDetect) {
        await this._detectServerType();
        this._lastDetectAt = Date.now();
      }

      if (this.serverIsOpenAI === false) {
        const snap = await this._probeLlamaCpp();
        this._noteSuccess();
        return snap;
      } else if (this.serverIsOpenAI === true) {
        const snap = await this._probeOpenAICompatible();
        this._noteSuccess();
        return snap;
      } else {
        this._noteFailure("LLM server not reachable");
        return this._defaultLlm();
      }
    } catch (err) {
      this._noteFailure(err.message);
      return this._defaultLlm();
    }
  }

  _noteSuccess() {
    this._consecutiveFailures = 0;
    this.error = null;
  }

  _noteFailure(message) {
    this.error = message;
    this._consecutiveFailures += 1;
    if (this._consecutiveFailures >= FAIL_RESET_THRESHOLD) {
      this._resetDetection();
    }
  }

  _resetDetection() {
    this.serverIsOpenAI = null;
    this.backendType = null;
    this.authOpen = null;
    this.modelId = null;
    this.modelPath = null;
    this.generationTps = 0;
    this.prefillTps = 0;
    this.contextLength = null;
    this.gpuMemoryUtilization = null;
    this.slotsActive = 0;
    this.slotsTotal = 0;
    this.totalOutputTokens = 0;
    this.kvCacheUsage = null;
    this.requestsRunning = null;
    this.requestsWaiting = null;
    this.ttftP95Seconds = null;
    this.preemptionsTotal = null;
    this.prefixCacheHitRate = null;
    this.e2eP95Seconds = null;
    this.itlP95Seconds = null;
    this.mtpAcceptanceRate = null;
    this.slotState.clear();
    this.lastTokenCounts = { input: 0, output: 0 };
    this._lastSglangUsedTokens = null;
  }

  /** Note auth from an HTTP status on an unauthenticated probe request. */
  _noteAuthStatus(status) {
    if (status >= 200 && status < 300) {
      this.authOpen = true;
      return "ok";
    }
    if (status === 401 || status === 403) {
      this.authOpen = false;
      return "auth";
    }
    return "other";
  }

  // ─── Server type detection ───────────────────────────────
  async _detectServerType() {
    // Skip the llama.cpp /slots probe once we've positively identified an
    // OpenAI-compatible backend. vLLM and sglang have no /slots endpoint, so
    // re-probing it on every re-detect cycle just spams 404s in the backend's
    // access log (#15). Still probe /slots on first contact, when the type is
    // unknown, or when the backend was previously llama.cpp.
    if (this.backendType !== "vllm" && this.backendType !== "sglang") {
      const slotUrl = `${this.baseUrl}/slots`;
      try {
        const slotRes = await this._fetch(slotUrl);
        const auth = this._noteAuthStatus(slotRes.status);
        if (auth === "ok") {
          const slots = await slotRes.json();
          if (Array.isArray(slots)) {
            this.serverIsOpenAI = false;
            this.backendType = "llama.cpp";
            return;
          }
        } else if (auth === "auth") {
          // Authenticated llama.cpp — treat as protected OpenAI-style for posture
          this.serverIsOpenAI = false;
          this.backendType = "llama.cpp";
          return;
        }
      } catch {}
    }

    // Try OpenAI-compatible (vLLM or SGLang)
    try {
      const modelRes = await this._fetch(`${this.baseUrl}/v1/models`);
      const auth = this._noteAuthStatus(modelRes.status);
      if (auth === "ok" || auth === "auth") {
        this.serverIsOpenAI = true;
        let isSglang = false;
        if (auth === "ok") {
          try {
            const modelsData = await modelRes.json();
            const owned = modelsData?.data?.[0]?.owned_by;
            if (typeof owned === "string" && /sglang/i.test(owned)) {
              isSglang = true;
            }
          } catch {
            /* body optional for detection */
          }
        }
        if (!isSglang) {
          isSglang = await this._probeIsSglang();
        }
        this.backendType = isSglang ? "sglang" : "vllm";
        return;
      }
    } catch {}

    this.serverIsOpenAI = null;
    this.backendType = null;
  }

  /** True when SGLang native server-info endpoints respond. */
  async _probeIsSglang() {
    for (const path of ["/get_server_info", "/server_info"]) {
      try {
        const res = await this._fetch(`${this.baseUrl}${path}`);
        if (!res.ok) continue;
        const data = await res.json().catch(() => null);
        if (data && typeof data === "object" && !Array.isArray(data)) return true;
      } catch {
        /* try next */
      }
    }
    return false;
  }

  // ─── OpenAI-compatible path (vLLM/sglang) ────────────────
  async _probeOpenAICompatible() {
    const now = Date.now();
    const dtSec = (now - this.lastProbeTime) / 1000;
    this.lastProbeTime = now;

    // Model info from /v1/models — 401/403 means protected; other failure = down
    let modelsOk = false;
    try {
      const modelsRes = await this._fetch(`${this.baseUrl}/v1/models`);
      const auth = this._noteAuthStatus(modelsRes.status);
      if (auth === "auth") {
        return this._getSnapshot();
      }
      if (auth === "ok") {
        modelsOk = true;
        const modelsData = await modelsRes.json();
        const model = modelsData?.data?.[0];
        this.modelId = normalizeModelId(model?.id || null);
        this.contextLength = model?.max_model_len || null;
        // Cheap SGLang hint if detection still says vLLM (self-heal before redetect)
        const owned = model?.owned_by;
        if (
          this.backendType === "vllm" &&
          typeof owned === "string" &&
          /sglang/i.test(owned)
        ) {
          this.backendType = "sglang";
        }
      }
    } catch {}

    if (!modelsOk) {
      throw new Error("OpenAI-compatible /v1/models unreachable");
    }

    // SGLang: native info + Prometheus metrics. Skip on known vLLM to avoid 404 spam.
    let isSglang = this.backendType === "sglang";
    /** @type {{ ok: boolean, contextLength?: number|null, modelPath?: string|null, tokens?: {input:number, output:number}|null } | null} */
    let fromInfo = null;
    if (this.backendType !== "vllm") {
      fromInfo = await this._probeSglangServerInfo();
      if (fromInfo.ok) {
        isSglang = true;
        if (fromInfo.contextLength != null) this.contextLength = fromInfo.contextLength;
        if (fromInfo.modelPath) {
          this.modelPath = fromInfo.modelPath;
          this.modelId = normalizeModelId(fromInfo.modelPath);
        }
      }
    }

    if (isSglang) {
      await this._enrichSglangModelInfo();
      await this._applySglangTokenRates(dtSec, {
        tokens: fromInfo?.tokens ?? null,
        liveThroughput: fromInfo?.liveThroughput ?? null,
        serverInfoProbed: fromInfo != null,
      });
    }

    // Single /metrics fetch: tok/s + slots/sleep (vLLM exposes max_model_len via /v1/models)
    if (!isSglang) {
      try {
        const metricsRes = await this._fetch(`${this.baseUrl}/metrics`);
        if (metricsRes.ok) {
          const txt = await metricsRes.text();

          const promptTokens = this._getVllmMetric(txt, "prompt_tokens_total");
          const genTokens = this._getVllmMetric(txt, "generation_tokens_total");
          if (promptTokens != null && genTokens != null) {
            const deltaIn = promptTokens - this.lastTokenCounts.input;
            const deltaOut = genTokens - this.lastTokenCounts.output;
            this.lastTokenCounts.input = promptTokens;
            this.lastTokenCounts.output = genTokens;
            this.totalOutputTokens = genTokens;
            if (dtSec > 0 && dtSec < 10) {
              this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
              this.prefillTps = Math.max(0, Math.round((deltaIn / dtSec) * 100) / 100);
            }
          }

          const running = this._getVllmMetric(txt, "num_requests_running");
          // Keep requestsRunning in sync with other vLLM tiles (null when missing)
          this.requestsRunning = running;
          if (running != null) this.slotsActive = Math.round(running);

          // Engine sleep state (0 = active, 1 = sleeping)
          if (this.gpuMemoryUtilization == null) {
            const sleepState = this._getVllmMetric(txt, "engine_sleep_state");
            if (sleepState != null) this.gpuMemoryUtilization = sleepState;
          }

          // vLLM inference performance (same /metrics body — no extra HTTP)
          this.requestsWaiting = this._getVllmMetric(txt, "num_requests_waiting");
          this.kvCacheUsage = this._getVllmMetric(txt, "kv_cache_usage_perc");
          this.preemptionsTotal = this._getVllmMetric(txt, "num_preemptions_total");

          const ttftHist = this._parseVllmHistogram(txt, "vllm:time_to_first_token_seconds");
          const ttftP95 = this._histogramQuantile(ttftHist.buckets, ttftHist.total, 0.95);
          // Round to 3 decimals so WS snapshots stay stable (avoids float jitter)
          this.ttftP95Seconds = ttftP95 == null ? null : Math.round(ttftP95 * 1000) / 1000;

          const e2eHist = this._parseVllmHistogram(txt, "vllm:e2e_request_latency_seconds");
          const e2eP95 = this._histogramQuantile(e2eHist.buckets, e2eHist.total, 0.95);
          this.e2eP95Seconds = e2eP95 == null ? null : Math.round(e2eP95 * 1000) / 1000;

          const itlHist = this._parseVllmHistogram(txt, "vllm:inter_token_latency_seconds");
          const itlP95 = this._histogramQuantile(itlHist.buckets, itlHist.total, 0.95);
          this.itlP95Seconds = itlP95 == null ? null : Math.round(itlP95 * 1000) / 1000;

          // Lifetime rates from absolute counters (stable tiles; null when unused)
          const prefixHits = this._getVllmMetric(txt, "prefix_cache_hits_total");
          const prefixQueries = this._getVllmMetric(txt, "prefix_cache_queries_total");
          this.prefixCacheHitRate =
            prefixHits != null && prefixQueries != null && prefixQueries > 0
              ? Math.round((prefixHits / prefixQueries) * 10000) / 10000
              : null;

          const mtpAccepted = this._getVllmMetric(txt, "spec_decode_num_accepted_tokens_total");
          const mtpDrafted = this._getVllmMetric(txt, "spec_decode_num_draft_tokens_total");
          this.mtpAcceptanceRate =
            mtpAccepted != null && mtpDrafted != null && mtpDrafted > 0
              ? Math.round((mtpAccepted / mtpDrafted) * 10000) / 10000
              : null;
        }
      } catch {}
    }

    this.backendType = isSglang ? "sglang" : "vllm";

    return this._getSnapshot();
  }

  /** Prefer SGLang /get_model_info (or /model_info) over raw HF cache paths. */
  async _enrichSglangModelInfo() {
    for (const path of ["/get_model_info", "/model_info"]) {
      try {
        const res = await this._fetch(`${this.baseUrl}${path}`);
        if (!res.ok) continue;
        const data = await res.json();
        const raw = data?.model_path || data?.tokenizer_path;
        if (!raw) continue;
        this.modelPath = String(raw);
        this.modelId = normalizeModelId(raw);
        return;
      } catch {
        /* try next */
      }
    }
  }

  /**
   * Read SGLang /get_server_info (or /server_info) for context + optional legacy counters.
   * @returns {Promise<{ ok: boolean, contextLength?: number|null, modelPath?: string|null, tokens?: {input:number, output:number}|null, liveThroughput?: number|null }>}
   */
  async _probeSglangServerInfo() {
    for (const path of ["/get_server_info", "/server_info"]) {
      try {
        const res = await this._fetch(`${this.baseUrl}${path}`);
        if (!res.ok) continue;
        const sgData = await res.json().catch(() => null);
        if (!sgData || typeof sgData !== "object" || Array.isArray(sgData)) continue;
        const contextLength =
          sgData.max_total_tokens ??
          sgData.max_total_num_tokens ??
          sgData.context_length ??
          null;
        const modelPath = sgData.model_path ? String(sgData.model_path) : null;
        const tokens = readSglangTokenTotals(sgData);
        const liveThroughput = readSglangLiveThroughput(sgData);
        return {
          ok: true,
          contextLength: Number.isFinite(Number(contextLength)) ? Number(contextLength) : null,
          modelPath,
          tokens,
          liveThroughput,
        };
      } catch {
        /* try next */
      }
    }
    return { ok: false };
  }

  /**
   * Live tok/s for SGLang:
   * 1) Prometheus counters (/metrics, needs --enable-metrics)
   * 2) /v1/loads activity — force 0 when idle (last_gen_throughput is sticky)
   * 3) Legacy total_*_tokens on server_info
   * 4) While busy: loads.gen_throughput, else last_gen_throughput, else used-token delta
   * @param {number} dtSec
   * @param {{ tokens?: { input: number, output: number } | null, liveThroughput?: number | null, serverInfoProbed?: boolean }} [opts]
   */
  async _applySglangTokenRates(dtSec, opts = {}) {
    const serverInfoTokens = opts?.tokens ?? null;
    let stickyThroughput = opts?.liveThroughput ?? null;
    let input = null;
    let output = null;
    /** @type {number | null} */
    let metricsGauge = null;
    /** @type {ReturnType<typeof readSglangLoads>} */
    let loads = null;
    let activityKnown = false;

    try {
      const metricsRes = await this._fetch(`${this.baseUrl}/metrics`);
      if (metricsRes.ok) {
        const txt = await metricsRes.text();
        const promptTokens = this._getPromMetric(txt, "prompt_tokens_total", ["sglang", "vllm"]);
        const genTokens = this._getPromMetric(txt, "generation_tokens_total", ["sglang", "vllm"]);
        if (promptTokens != null && genTokens != null) {
          input = promptTokens;
          output = genTokens;
        } else if (genTokens != null) {
          input = this.lastTokenCounts.input;
          output = genTokens;
        }

        metricsGauge = this._getPromMetric(txt, "gen_throughput", ["sglang", "vllm"]);

        const running =
          this._getPromMetric(txt, "num_requests_running", ["sglang", "vllm"]) ??
          this._getPromMetric(txt, "num_running_reqs", ["sglang", "vllm"]);
        if (running != null) {
          this.requestsRunning = running;
          this.slotsActive = Math.round(running);
          activityKnown = true;
        }
        const waiting =
          this._getPromMetric(txt, "num_requests_waiting", ["sglang", "vllm"]) ??
          this._getPromMetric(txt, "num_queue_reqs", ["sglang", "vllm"]);
        if (waiting != null) {
          this.requestsWaiting = waiting;
          activityKnown = true;
        }
      }
    } catch {
      /* fall through */
    }

    // /v1/loads: authoritative idle/busy (gen_throughput / last_gen are often sticky)
    try {
      const loadsRes = await this._fetch(`${this.baseUrl}/v1/loads`);
      if (loadsRes.ok) {
        const body = await loadsRes.json().catch(() => null);
        loads = readSglangLoads(body);
        if (loads) {
          this.requestsRunning = loads.running;
          this.requestsWaiting = loads.waiting;
          this.slotsActive = Math.round(loads.running);
          activityKnown = true;
        }
      }
    } catch {
      /* optional */
    }

    if ((input == null || output == null) && serverInfoTokens) {
      input = serverInfoTokens.input;
      output = serverInfoTokens.output;
    }

    const needTokens = input == null || output == null;
    const needSticky = stickyThroughput == null;
    if ((needTokens || needSticky) && !opts?.serverInfoProbed) {
      const info = await this._probeSglangServerInfo();
      if (needTokens && info.tokens) {
        input = info.tokens.input;
        output = info.tokens.output;
      }
      if (needSticky && info.liveThroughput != null) {
        stickyThroughput = info.liveThroughput;
      }
    }

    const busy =
      activityKnown &&
      ((this.requestsRunning ?? 0) > 0 || (this.requestsWaiting ?? 0) > 0);
    const idle = activityKnown && !busy;

    if (input != null && output != null) {
      const deltaIn = input - this.lastTokenCounts.input;
      const deltaOut = output - this.lastTokenCounts.output;
      this.lastTokenCounts.input = input;
      this.lastTokenCounts.output = output;
      this.totalOutputTokens = output;
      if (idle) {
        this.generationTps = 0;
        this.prefillTps = 0;
      } else if (dtSec > 0 && dtSec < 10) {
        this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
        this.prefillTps = Math.max(0, Math.round((deltaIn / dtSec) * 100) / 100);
      }
      if (loads) this._lastSglangUsedTokens = loads.usedTokens;
      return;
    }

    if (idle) {
      this.generationTps = 0;
      this.prefillTps = 0;
      if (loads) this._lastSglangUsedTokens = loads.usedTokens;
      return;
    }

    // Busy (or activity unknown): instantaneous / sticky gauges, then used-token delta
    const gauge =
      (loads && loads.genThroughput > 0 ? loads.genThroughput : null) ??
      (metricsGauge != null && metricsGauge > 0 ? metricsGauge : null) ??
      (busy && stickyThroughput != null ? stickyThroughput : null);

    if (gauge != null) {
      this.generationTps = Math.max(0, Math.round(Number(gauge) * 100) / 100);
      if (loads) this._lastSglangUsedTokens = loads.usedTokens;
      return;
    }

    if (loads && busy && dtSec > 0 && dtSec < 10 && this._lastSglangUsedTokens != null) {
      const delta = loads.usedTokens - this._lastSglangUsedTokens;
      this.generationTps = Math.max(0, Math.round((delta / dtSec) * 100) / 100);
      this._lastSglangUsedTokens = loads.usedTokens;
      return;
    }

    if (loads) this._lastSglangUsedTokens = loads.usedTokens;

    // Activity unknown and no counters: do not paint sticky last_gen as "live"
    if (!activityKnown && stickyThroughput != null) {
      // Keep prior behavior only when we cannot tell idle vs busy
      this.generationTps = Math.max(0, Math.round(Number(stickyThroughput) * 100) / 100);
    } else if (!busy) {
      this.generationTps = 0;
      this.prefillTps = 0;
    }
  }

  // ─── llama.cpp native path ────────────────────────────────
  async _probeLlamaCpp() {
    const now = Date.now();
    const dtSec = (now - this.lastProbeTime) / 1000;
    this.lastProbeTime = now;

    // Slots
    let slotsOk = false;
    try {
      const slotsRes = await this._fetch(`${this.baseUrl}/slots`);
      const auth = this._noteAuthStatus(slotsRes.status);
      if (auth === "auth") {
        return this._getSnapshot();
      }
      if (auth === "ok") {
        const slots = await slotsRes.json();
        if (Array.isArray(slots)) {
          slotsOk = true;
          this.slotsTotal = slots.length;
          // Some llama.cpp builds use is_processing instead of state
          this.slotsActive = slots.filter((s) => s.is_processing || (s.state && s.state !== "idle")).length;

          let totalGen = 0;
          let totalPrefill = 0;
          let totalDecoded = 0;

          for (const slot of slots) {
            const slotId = slot.id ?? "default";
            const decoded = this._getSlotDecoded(slot);
            const prompted = this._getSlotPrefilled(slot);
            totalDecoded += decoded;
            const lastState = this.slotState.get(slotId) || { decoded: 0, prompted: 0 };
            const dDecoded = decoded - lastState.decoded;
            const dPrompted = prompted - lastState.prompted;
            this.slotState.set(slotId, { decoded, prompted });
            if (dtSec > 0 && dtSec < 10) {
              totalGen += dDecoded / dtSec;
              totalPrefill += dPrompted / dtSec;
            }
          }

          this.totalOutputTokens = totalDecoded;
          this.generationTps = Math.max(0, Math.round(totalGen * 100) / 100);
          this.prefillTps = Math.max(0, Math.round(totalPrefill * 100) / 100);
        }
      }
    } catch {}

    if (!slotsOk) {
      throw new Error("llama.cpp /slots unreachable");
    }

    // Props (model info)
    try {
      const propsRes = await this._fetch(`${this.baseUrl}/props`);
      if (propsRes.ok) {
        const props = await propsRes.json();
        this.modelId = props.model_alias || props.model_path || this.modelId;
        this.modelPath = props.model_path || null;
        this.contextLength = props.total_context_length || props.context_length || this.contextLength;
      }
    } catch {}

    this.backendType = "llama.cpp";
    return this._getSnapshot();
  }

  // ─── Metrics helpers ─────────────────────────────────────
  /**
   * Sum a Prometheus counter/gauge across series for the first matching prefix.
   * @param {string} body
   * @param {string} name metric name without prefix (e.g. generation_tokens_total)
   * @param {string[]} [prefixes] e.g. ["vllm"] or ["sglang","vllm"]
   * @returns {number | null}
   */
  _getPromMetric(body, name, prefixes = ["vllm", "sglang"]) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const prefix of prefixes) {
      const pEsc = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Colon form (vllm:… / sglang:…) and underscore form (sglang_…, v0.5.4+)
      const forms = [`${pEsc}:${esc}`, `${pEsc}_${esc}`];
      for (const full of forms) {
        const re = new RegExp(`^${full}(?:\\{[^}]*\\})?\\s+([\\d.eE+-]+)\\s*$`, "gm");
        let sum = 0;
        let found = false;
        let m;
        while ((m = re.exec(body)) !== null) {
          const v = parseFloat(m[1]);
          if (Number.isFinite(v)) {
            sum += v;
            found = true;
          }
        }
        if (found) return sum;
      }
    }
    return null;
  }

  _getVllmMetric(body, name) {
    return this._getPromMetric(body, name, ["vllm"]);
  }

  /**
   * Parse a vLLM Prometheus histogram from /metrics text.
   * Returns { buckets: [{upper, count}], total } with cumulative counts per `le`,
   * summed across label sets. `total` is the summed `_count` series (or null).
   */
  _parseVllmHistogram(body, metricPrefix) {
    const esc = metricPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Bucket lines: <metricPrefix>_bucket{...le="X"...} VALUE
    const bucketRe = new RegExp(
      `^${esc}_bucket\\{[^}]*\\ble="([^"]+)"[^}]*\\}\\s+([\\d.eE+-]+)\\s*$`,
      "gm"
    );
    const byUpper = new Map();
    let infCount = 0;
    let m;
    while ((m = bucketRe.exec(body)) !== null) {
      const le = m[1];
      const count = parseFloat(m[2]);
      if (!Number.isFinite(count)) continue;
      const upper = le === "+Inf" ? Infinity : parseFloat(le);
      if (upper !== Infinity && !Number.isFinite(upper)) continue;
      if (upper === Infinity) infCount += count;
      byUpper.set(upper, (byUpper.get(upper) || 0) + count);
    }
    const total = this._getVllmMetric(body, `${metricPrefix.replace(/^vllm:/, "")}_count`);
    // Prometheus invariant: +Inf bucket count == _count. Mismatch → refuse quantile.
    if (total != null && infCount > 0 && Math.abs(infCount - total) > 1e-6) {
      return { buckets: [], total: null };
    }
    const buckets = Array.from(byUpper, ([upper, count]) => ({ upper, count }));
    buckets.sort((a, b) => a.upper - b.upper);
    return { buckets, total };
  }

  /**
   * Prometheus-style linear interpolation for a histogram quantile.
   * Returns null when empty / invalid or target is in the +Inf tail.
   */
  _histogramQuantile(buckets, total, quantile) {
    if (!buckets || !buckets.length || total == null || total <= 0) return null;
    const target = total * quantile;
    let prevUpper = 0.0;
    let prevCount = 0.0;
    for (const { upper, count } of buckets) {
      if (count >= target) {
        if (!Number.isFinite(upper)) return null;
        if (count === prevCount) return upper;
        return prevUpper + (upper - prevUpper) * ((target - prevCount) / (count - prevCount));
      }
      prevUpper = upper;
      prevCount = count;
    }
    return null;
  }

  _getSlotDecoded(slot) {
    // Some llama.cpp builds nest n_decoded inside next_token[0]
    if (slot.n_decoded != null) {
      if (Array.isArray(slot.n_decoded)) return slot.n_decoded[0] || 0;
      return slot.n_decoded || 0;
    }
    // Fallback: next_token[0].n_decoded (newer llama.cpp)
    if (Array.isArray(slot.next_token) && slot.next_token[0]?.n_decoded != null) {
      return slot.next_token[0].n_decoded;
    }
    return 0;
  }

  _getSlotPrefilled(slot) {
    return slot.n_prompt_tokens_processed || slot.n_prompt_tokens || 0;
  }

  /**
   * Observational exposure hint from probe target + unauthenticated reachability.
   * Does not claim process bind address (0.0.0.0 vs interface).
   */
  _buildPosture() {
    if (this.authOpen == null) return null;

    const host = this.spark?.lanIp || "";
    const scope = classifyHostScope(host);
    const keyed = Boolean(this._apiKey());
    /** @type {"open" | "protected" | "keyed"} */
    let auth;
    if (keyed) {
      // Key configured: success → keyed; 401/403 → protected (rejected)
      auth = this.authOpen === false ? "protected" : "keyed";
    } else {
      auth = this.authOpen ? "open" : "protected";
    }

    let level = "ok";
    if (auth === "open") {
      if (scope === "public") level = "danger";
      else if (scope === "local") level = "ok";
      else level = "warn"; // lan or unknown hostname
    } else if (keyed && auth === "protected") {
      level = "danger";
    }

    const scopeWords = {
      local: "loopback",
      lan: "LAN",
      public: "public",
      unknown: "unknown-host",
    };
    const shortScope = {
      local: "Local",
      lan: "LAN",
      public: "Public",
      unknown: "Host",
    };
    const label =
      auth === "protected"
        ? keyed
          ? "Bad API key"
          : "Auth required"
        : auth === "keyed"
          ? `API key · ${shortScope[scope]}`
          : `Open · ${shortScope[scope]}`;
    const detail =
      auth === "protected"
        ? keyed
          ? `Configured API key was rejected (401/403) · ${scopeWords[scope]} target (${host || "—"}).`
          : `API key required · ${scopeWords[scope]} target (${host || "—"}). Based on the configured probe host, not the process bind address.`
        : auth === "keyed"
          ? `Using configured API key · ${scopeWords[scope]} target (${host || "—"}). Based on the configured probe host, not the process bind address.`
          : `Unauthenticated · ${scopeWords[scope]} target (${host || "—"}). Based on the configured probe host, not the process bind address.`;

    return { level, auth, scope, label, detail };
  }

  _getSnapshot() {
    const metricsLive = this.serverIsOpenAI !== null && this.authOpen !== false;
    return {
      available: metricsLive,
      backend: this.backendType,
      modelId: this.modelId || null,
      modelPath: this.modelPath || null,
      contextLength: this.contextLength,
      gpuMemoryUtilization: this.gpuMemoryUtilization,
      slotsActive: this.slotsActive,
      slotsTotal: this.slotsTotal,
      generationTps: this.generationTps,
      prefillTps: this.prefillTps,
      totalOutputTokens: this.totalOutputTokens,
      kvCacheUsage: this.kvCacheUsage,
      requestsRunning: this.requestsRunning,
      requestsWaiting: this.requestsWaiting,
      ttftP95Seconds: this.ttftP95Seconds,
      preemptionsTotal: this.preemptionsTotal,
      prefixCacheHitRate: this.prefixCacheHitRate,
      e2eP95Seconds: this.e2eP95Seconds,
      itlP95Seconds: this.itlP95Seconds,
      mtpAcceptanceRate: this.mtpAcceptanceRate,
      posture: this._buildPosture(),
      error: this.error,
    };
  }

  _defaultLlm() {
    return {
      available: false,
      backend: this.backendType,
      modelId: null,
      modelPath: null,
      contextLength: null,
      gpuMemoryUtilization: null,
      slotsActive: 0,
      slotsTotal: 0,
      generationTps: 0,
      prefillTps: 0,
      totalOutputTokens: 0,
      kvCacheUsage: null,
      requestsRunning: null,
      requestsWaiting: null,
      ttftP95Seconds: null,
      preemptionsTotal: null,
      prefixCacheHitRate: null,
      e2eP95Seconds: null,
      itlP95Seconds: null,
      mtpAcceptanceRate: null,
      posture: this._buildPosture(),
      error: this.error,
    };
  }

  // ─── HTTP helpers ────────────────────────────────────────
  _apiKey() {
    const keys = this.spark?.llmApiKeys;
    if (!keys || typeof keys !== "object") return null;
    const raw = keys[String(this.port)] ?? keys[this.port];
    const key = raw != null ? String(raw).trim() : "";
    return key || null;
  }

  async _fetch(url) {
    const headers = {};
    const apiKey = this._apiKey();
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return fetch(url, { signal: AbortSignal.timeout(LLM_PROBE_TIMEOUT_MS), headers });
  }
}
