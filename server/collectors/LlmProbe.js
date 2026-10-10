/**
 * LlmProbe — probes an LLM server on port 8888, auto-detects backend,
 * computes live tokens/sec (generation + prefill).
 *
 * Ported from legacy `probeLlamaServerType` and `_getLlamaMetricsFor`.
 */
import { LLM_PROBE_TIMEOUT_MS } from "../config.js";
import { classifyHostScope } from "../validate.js";
import { llmProbeHost } from "./llmHost.js";
import { openSshLlmTunnel } from "./llmTunnel.js";

const FAIL_RESET_THRESHOLD = 3;
/** Direct failures in a row before the probe tries an SSH tunnel to the unit's loopback. */
const TUNNEL_AFTER_FAILURES = 2;
/** Failures in a row through the tunnel before it is dropped and the direct path retried. */
const TUNNEL_DROP_AFTER_FAILURES = 5;
const TUNNEL_RETRY_MIN_MS = 60_000;
const TUNNEL_RETRY_MAX_MS = 15 * 60_000;
const REDETECT_INTERVAL_MS = 60_000;
/** Current SGLang names first. Deprecated aliases still work but log a warning per hit. */
const SGLANG_SERVER_INFO_PATHS = ["/server_info", "/get_server_info"];
const SGLANG_MODEL_INFO_PATHS = ["/model_info", "/get_model_info"];
/**
 * SGLang's last_gen_throughput is a sticky gauge (holds last decode rate when
 * idle). Only treat it as live after we observe a change between polls, and
 * expire back to 0 if it stops changing.
 */
const SGLANG_STICKY_TPS_LIVE_MS = 6_000;

/**
 * Prefer a short model id when the server returns a Hugging Face hub cache path.
 * e.g. /root/.cache/huggingface/hub/models--org--Name/snapshots/<hash>
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

/** True when `id` looks like a Hugging Face hub cache directory (models--org--name). */
export function isHfHubCachePath(id) {
  if (id == null) return false;
  return /(?:^|\/)models--[^/]+/.test(String(id));
}

/**
 * Set modelId (always normalized) and modelPath (omit HF hub cache paths —
 * they duplicate the short id and clutter the LLM panel).
 * @param {unknown} raw
 */
function applyModelRef(probe, raw) {
  if (raw == null || raw === "") return;
  const s = String(raw);
  probe.modelId = normalizeModelId(s);
  probe.modelPath = isHfHubCachePath(s) ? null : s;
}

export class LlmProbe {
  constructor(spark, port = 8888) {
    this.spark = spark;
    this.port = port;
    /** The unit's own address; baseUrl switches to a local forward when only SSH reaches the engine. */
    this._directBase = `http://${llmProbeHost(spark)}:${port}`;
    this.baseUrl = this._directBase;
    /** @type {{ port: number, close: () => void } | null} */
    this._tunnel = null;
    this._tunnelRetryAt = 0;
    this._tunnelBackoffMs = TUNNEL_RETRY_MIN_MS;
    this._tunnelOpening = false;
    /** Replaceable in tests. */
    this._openTunnel = openSshLlmTunnel;

    // State
    this.backendType = null; // 'vllm' | 'llama.cpp' | 'sglang' | 'ds4' | 'exl3' | 'q27' | 'tensorfold' | 'freetoken' | null
    this.serverIsOpenAI = null; // true = OpenAI-compatible
    /** Whether /v1/models (or /slots) answered without credentials. null = unknown. */
    this.authOpen = null;
    this.stepId = 0;
    this.modelId = null;
    this.modelPath = null;
    this.models = [];
    this.contextLength = null;
    this.gpuMemoryUtilization = null;
    this.slotsActive = 0;
    this.slotsTotal = 0;
    this.generationTps = 0;
    this.prefillTps = 0;
    /** Live cached-prefill tok/s when the backend splits kinds (ds4 / llama.cpp / sglang). null otherwise. */
    this.cachedPrefillTps = null;
    /** Live uncached/computed prefill tok/s when split is available. null otherwise. */
    this.uncachedPrefillTps = null;
    this.error = null;

    // Per-slot rate tracking (for llama.cpp native path)
    this.slotState = new Map();
    this.lastTokenCounts = { input: 0, output: 0 };
    /** TensorFold: first /health sample with counters seeds the baseline (lifetime total is not a rate). */
    this._tensorfoldSeeded = false;
    /** Previous TensorFold `prefill_seconds_total`. null until a sample includes it. */
    this._tensorfoldPrefillSeconds = null;
    this._tensorfoldLastPrefill = null;
    this.prefillActive = false;
    /** Previous prefill counters by kind; null until first labeled sample. */
    this.lastPrefillKinds = null;
    /** Previous vLLM TTFT histogram `_sum` (seconds). null until first sample. */
    this.lastTtftSum = null;
    /** Previous vLLM TTFT histogram `_count` (requests). null until first sample. */
    this.lastTtftCount = null;
    /** Previous `vllm:iteration_tokens_total_sum` (engine-step tokens). */
    this.lastIterSum = null;
    this.lastProbeTime = 0;

    // Cumulative total output tokens (generation) as reported by the LLM server
    this.totalOutputTokens = 0;
    /** Cumulative total prompt (prefill) tokens as reported by the LLM server. */
    this.totalPromptTokens = null;
    /**
     * Cumulative cached (prefix-cache served) prompt tokens, when the backend
     * reports the split. Subset of totalPromptTokens (for ds4/q27 the raw
     * prefill counter is computed-only, so prompt = computed + cached).
     */
    this.totalCachedTokens = null;

    // vLLM inference metrics from /metrics (null when not vLLM / missing series)
    // Metric names follow stock vLLM Prometheus exposition (versions may differ).
    this.kvCacheUsage = null; // 0–1 fraction
    /** Allocated KV-cache pool, tokens (vLLM `cache_config_info`). */
    this.kvCacheTokens = null;
    /** Free tokens in that pool. null until both pool size and usage are known. */
    this.kvCacheTokensAvailable = null;
    /** Allocated KV-cache pool, bytes. */
    this.kvCacheMemoryBytes = null;
    /** Engine KV cache pool size in GB (SGLang only). null when not reported. */
    this.kvCacheGb = null;
    /** Engine model weights resident in GPU memory, GB (SGLang only). null when not reported. */
    this.weightsGb = null;
    this.requestsRunning = null;
    this.requestsWaiting = null;
    this.ttftP95Seconds = null;
    /** Live recent-window mean TTFT (seconds) from histogram sum/count deltas. null when unavailable. */
    this.ttftSeconds = null;
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
    /** @type {{ value: number, liveUntil: number } | null} */
    this._sglangStickyTps = null;
    /** Latest gen_throughput from /v1/loads, if that payload carried one. */
    this._sglangLoadGenTps = null;
    /** Whether this poll's /server_info carried total_input/output_tokens. */
    this._sglangTotalsPolled = false;
    /**
     * Series that seeded `lastTokenCounts` — "server_info" or "prometheus".
     * They count the same work under different names, so a hand-off re-seeds
     * the baseline instead of differencing across the two.
     * @type {"server_info" | "prometheus" | null}
     */
    this._sglangTokenSource = null;
  }

  /**
   * Prefill is a short burst; decode then runs with Δprompt=0.
   * Keep the last real prefill rate while the engine is still in-flight, then 0.
   * @param {number} rate
   * @param {boolean} inflight
   */
  _setPrefillTps(rate, inflight) {
    const rounded = Math.max(0, Math.round(rate * 100) / 100);
    if (rounded > 0) this.prefillTps = rounded;
    else if (!inflight) this.prefillTps = 0;
  }

  /**
   * Live cached vs computed prefill tok/s from cumulative counters.
   * First sample seeds the baseline (0 tok/s). Missing either side clears the split.
   * @param {number|null|undefined} cachedCount
   * @param {number|null|undefined} computedCount
   * @param {number} dtSec
   */
  _setPrefillSplitRates(cachedCount, computedCount, dtSec) {
    if (cachedCount == null || computedCount == null || !Number.isFinite(cachedCount) || !Number.isFinite(computedCount)) {
      this.cachedPrefillTps = null;
      this.uncachedPrefillTps = null;
      this.lastPrefillKinds = null;
      return;
    }
    const total = cachedCount + computedCount;
    this.prefixCacheHitRate =
      total > 0 ? Math.round((cachedCount / total) * 10000) / 10000 : null;
    if (this.lastPrefillKinds == null) {
      this.lastPrefillKinds = { cached: cachedCount, computed: computedCount };
      this.cachedPrefillTps = 0;
      this.uncachedPrefillTps = 0;
      return;
    }
    if (dtSec > 0 && dtSec < 10) {
      const dCached = cachedCount - this.lastPrefillKinds.cached;
      const dComputed = computedCount - this.lastPrefillKinds.computed;
      this.cachedPrefillTps = Math.max(0, Math.round((dCached / dtSec) * 100) / 100);
      this.uncachedPrefillTps = Math.max(0, Math.round((dComputed / dtSec) * 100) / 100);
    }
    this.lastPrefillKinds = { cached: cachedCount, computed: computedCount };
  }

  /** Update probe port (and host from spark). Resets detection when the target changes. */
  setPort(port) {
    const next = Number(port);
    const prevUrl = this._directBase;
    if (Number.isInteger(next) && next >= 1 && next <= 65535) {
      this.port = next;
    }
    this._directBase = `http://${llmProbeHost(this.spark)}:${this.port}`;
    if (this._directBase !== prevUrl) {
      this._closeTunnel();
      this._tunnelRetryAt = 0;
      this._tunnelBackoffMs = TUNNEL_RETRY_MIN_MS;
      this.baseUrl = this._directBase;
      this._resetDetection();
      this._lastDetectAt = 0;
      this._consecutiveFailures = 0;
    }
  }

  /** Probe the LLM server and return a snapshot. */
  async probe() {
    const snap = await this._probeOnce();
    // Only SSH may reach the engine (its port is not exposed): after repeated direct
    // failures, forward a local port through the unit's SSH login and probe that.
    if (!snap.available && (await this._maybeOpenTunnel())) return this._probeOnce();
    this._maybeDropTunnel();
    return snap;
  }

  async _probeOnce() {
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

  /** True when this unit can be reached over SSH but the engine's own address may not be. */
  _canTunnel() {
    const spark = this.spark;
    return Boolean(
      spark &&
        !spark.isLocal &&
        !spark.llmHost && // a pinned llmHost is a different machine: never tunnel to the SSH host's loopback
        spark.platform !== "windows" &&
        spark.ssh?.host &&
        !this._tunnel &&
        !this._tunnelOpening
    );
  }

  async _maybeOpenTunnel() {
    if (this._consecutiveFailures < TUNNEL_AFTER_FAILURES) return false;
    if (!this._canTunnel() || Date.now() < this._tunnelRetryAt) return false;
    this._tunnelOpening = true;
    try {
      const tunnel = await this._openTunnel(this.spark, this.port);
      this._tunnel = tunnel;
      this.baseUrl = `http://127.0.0.1:${tunnel.port}`;
      this._resetDetection();
      this._lastDetectAt = 0;
      this._consecutiveFailures = 0;
      return true;
    } catch {
      this._scheduleTunnelRetry();
      return false;
    } finally {
      this._tunnelOpening = false;
    }
  }

  /** Through the tunnel and still failing (engine down, or the tunnel died): fall back to direct. */
  _maybeDropTunnel() {
    if (this._tunnel && this._consecutiveFailures >= TUNNEL_DROP_AFTER_FAILURES) {
      this._closeTunnel();
      this._scheduleTunnelRetry();
      this.baseUrl = this._directBase;
      this._resetDetection();
      this._lastDetectAt = 0;
      this._consecutiveFailures = 0;
    }
  }

  _scheduleTunnelRetry() {
    this._tunnelRetryAt = Date.now() + this._tunnelBackoffMs;
    this._tunnelBackoffMs = Math.min(this._tunnelBackoffMs * 2, TUNNEL_RETRY_MAX_MS);
  }

  _closeTunnel() {
    const tunnel = this._tunnel;
    this._tunnel = null;
    try {
      tunnel?.close();
    } catch {
      /* already gone */
    }
  }

  /** Release the SSH forward (monitor stopped, port removed). */
  dispose() {
    this._closeTunnel();
    this.baseUrl = this._directBase;
  }

  _noteSuccess() {
    this._consecutiveFailures = 0;
    if (this._tunnel) this._tunnelBackoffMs = TUNNEL_RETRY_MIN_MS;
    this.error = null;
  }

  _noteFailure(message) {
    this.models = [];
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
    this.models = [];
    this.generationTps = 0;
    this.prefillTps = 0;
    this.cachedPrefillTps = null;
    this.uncachedPrefillTps = null;
    this.contextLength = null;
    this.gpuMemoryUtilization = null;
    this.slotsActive = 0;
    this.slotsTotal = 0;
    this.totalOutputTokens = 0;
    this.totalPromptTokens = null;
    this.totalCachedTokens = null;
    this.kvCacheUsage = null;
    this._clearEngineMemory();
    this.requestsRunning = null;
    this.requestsWaiting = null;
    this.ttftP95Seconds = null;
    this.ttftSeconds = null;
    this.preemptionsTotal = null;
    this.prefixCacheHitRate = null;
    this.e2eP95Seconds = null;
    this.itlP95Seconds = null;
    this.mtpAcceptanceRate = null;
    this.slotState.clear();
    this.lastTokenCounts = { input: 0, output: 0 };
    this._tensorfoldSeeded = false;
    this._tensorfoldPrefillSeconds = null;
    this._tensorfoldLastPrefill = null;
    this.prefillActive = false;
    this.lastPrefillKinds = null;
    this.lastTtftSum = null;
    this.lastTtftCount = null;
    this.lastIterSum = null;
    this._sglangStickyTps = null;
    this._sglangLoadGenTps = null;
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
    // OpenAI-compatible backend. vLLM / sglang / ds4-server have no /slots,
    // so re-probing it on every re-detect cycle just spams 404s in the
    // backend's access log (#15). Still probe /slots on first contact, when
    // the type is unknown, or when the backend was previously llama.cpp.
    if (
      this.backendType !== "vllm" &&
      this.backendType !== "sglang" &&
      this.backendType !== "ds4" &&
      this.backendType !== "exl3" &&
      this.backendType !== "q27" &&
      this.backendType !== "tensorfold" &&
      this.backendType !== "freetoken"
    ) {
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

    // Try OpenAI-compatible (vLLM, SGLang, or ds4-server)
    try {
      const modelRes = await this._fetch(`${this.baseUrl}/v1/models`);
      const auth = this._noteAuthStatus(modelRes.status);
      if (auth === "ok" || auth === "auth") {
        this.serverIsOpenAI = true;
        let owned = null;
        if (auth === "ok") {
          try {
            const modelsData = await modelRes.json();
            const records = Array.isArray(modelsData?.data) ? modelsData.data : [];
            owned = records.find((model) => typeof model?.id === "string" && model.id.trim().length > 0)?.owned_by;
          } catch {
            /* body optional for detection */
          }
        }
        this.backendType = await this._classifyOpenAIBackend(owned);
        return;
      }
    } catch {}

    this.serverIsOpenAI = null;
    this.backendType = null;
  }

  /**
   * Classify an OpenAI-compatible server: ds4, SGLang, EXL3, q27, TensorFold, FreeToken, or vLLM (default).
   * @param {unknown} ownedBy
   * @returns {Promise<"ds4" | "sglang" | "exl3" | "q27" | "tensorfold" | "freetoken" | "vllm">}
   */
  async _classifyOpenAIBackend(ownedBy) {
    if (typeof ownedBy === "string") {
      if (/ds4/i.test(ownedBy)) return "ds4";
      if (/sglang/i.test(ownedBy)) return "sglang";
      if (/exl3/i.test(ownedBy)) return "exl3";
      // q27's /v1/models reports owned_by: "q27" (signalnine/q27 engine).
      if (/q27/i.test(ownedBy)) return "q27";
      // TensorFold (ashhart/TensorFold) reports owned_by: "tensorfold" on both MLX and CUDA servers.
      if (/tensorfold/i.test(ownedBy)) return "tensorfold";
      // FreeToken reports owned_by: "FreeToken".
      if (/freetoken/i.test(ownedBy)) return "freetoken";
    }
    if (await this._probeIsDs4()) return "ds4";
    if (await this._probeIsSglang()) return "sglang";
    if (await this._probeIsExl3()) return "exl3";
    if (await this._probeIsQ27()) return "q27";
    if (await this._probeIsFreeToken()) return "freetoken";
    return "vllm";
  }

  /**
   * True when `/v1/stats` matches FreeToken's throughput + lifetime token contract.
   * A bare JSON object is not enough.
   */
  async _probeIsFreeToken() {
    try {
      const res = await this._fetch(`${this.baseUrl}/v1/stats`);
      if (!res.ok) return false;
      const data = await res.json().catch(() => null);
      return LlmProbe._statsLookLikeFreeToken(data);
    } catch {
      return false;
    }
  }

  /** @param {unknown} data */
  static _statsLookLikeFreeToken(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    const throughput = data.throughput;
    const requests = data.requests;
    if (!throughput || typeof throughput !== "object" || Array.isArray(throughput)) return false;
    if (!requests || typeof requests !== "object" || Array.isArray(requests)) return false;
    return (
      Number.isFinite(Number(throughput.decode_tps)) &&
      Number.isFinite(Number(throughput.prefill_tps)) &&
      Number.isFinite(Number(requests.prompt_tokens_total)) &&
      Number.isFinite(Number(requests.completion_tokens_total))
    );
  }

  /**
   * True when EXL3 `tools/serve_openai.py` /health exposes backend + token totals.
   * Distinguishes from vLLM's /health (no `busy` + `completion_tokens_total`).
   */
  async _probeIsExl3() {
    try {
      const res = await this._fetch(`${this.baseUrl}/health`);
      if (!res.ok) return false;
      const data = await res.json().catch(() => null);
      return LlmProbe._healthLooksLikeExl3(data);
    } catch {
      return false;
    }
  }

  /** @param {unknown} data */
  static _healthLooksLikeExl3(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    if (data.backend === "exl3") return true;
    // tools/serve_openai.py: { ok, busy } even before token counters existed.
    return data.ok === true && typeof data.busy === "boolean";
  }

  /**
   * First successful SGLang JSON from `paths` (current name, then deprecated alias).
   * @param {string[]} paths
   * @returns {Promise<object|null>}
   */
  async _fetchSglangJson(paths) {
    for (const path of paths) {
      try {
        const res = await this._fetch(`${this.baseUrl}${path}`);
        if (!res.ok) continue;
        const data = await res.json().catch(() => null);
        if (data && typeof data === "object" && !Array.isArray(data)) return data;
      } catch {
        /* try next */
      }
    }
    return null;
  }

  /** True when SGLang native server-info endpoints respond. */
  async _probeIsSglang() {
    return (await this._fetchSglangJson(SGLANG_SERVER_INFO_PATHS)) != null;
  }

  /** True when Prometheus /metrics exposes ds4-server series (ds4-on-spark). */
  async _probeIsDs4() {
    try {
      const res = await this._fetch(`${this.baseUrl}/metrics`);
      if (!res.ok) return false;
      const txt = await res.text();
      return LlmProbe._metricsLookLikeDs4(txt);
    } catch {
      return false;
    }
  }

  /** @param {string} body */
  static _metricsLookLikeDs4(body) {
    return /(?:^|\n)ds4_tokens_decoded_total(?:\{|\s)/m.test(String(body || ""));
  }

  /** True when Prometheus /metrics exposes q27-series (signalnine/q27 engine). */
  async _probeIsQ27() {
    try {
      const res = await this._fetch(`${this.baseUrl}/metrics`);
      if (!res.ok) return false;
      const txt = await res.text();
      return LlmProbe._metricsLookLikeQ27(txt);
    } catch {
      return false;
    }
  }

  /** @param {string} body */
  static _metricsLookLikeQ27(body) {
    return /(?:^|\n)q27_(?:decode_tokens_(?:processed_)?total|requests_total)(?:\{|\s)/m.test(
      String(body || "")
    );
  }

  // ─── OpenAI-compatible path (vLLM/sglang/ds4) ────────────
  async _probeOpenAICompatible() {
    const now = Date.now();
    const dtSec = (now - this.lastProbeTime) / 1000;
    this.lastProbeTime = now;

    // Model info from /v1/models — 401/403 means protected; other failure = down
    let modelsOk = false;
    let owned = null;
    let servedModelId = null;
    this.models = [];
    try {
      const modelsRes = await this._fetch(`${this.baseUrl}/v1/models`);
      const auth = this._noteAuthStatus(modelsRes.status);
      if (auth === "auth") {
        return this._getSnapshot();
      }
      if (auth === "ok") {
        modelsOk = true;
        const modelsData = await modelsRes.json();
        const records = Array.isArray(modelsData?.data) ? modelsData.data : [];
        const validModels = records.filter((model) =>
          typeof model?.id === "string" && model.id.trim().length > 0
        );
        this.models = [...new Set(validModels.map((model) => model.id))];
        const model = validModels[0];
        servedModelId = this.models.length > 1
          ? model.id
          : normalizeModelId(model?.id || null);
        this.modelId = servedModelId;
        // Only native enrichment owns modelPath, never the served ID list.
        this.modelPath = null;
        // ds4-server uses context_length; vLLM uses max_model_len
        this.contextLength =
          model?.max_model_len ?? model?.context_length ?? null;
        owned = model?.owned_by;
      }
    } catch {}

    if (!modelsOk) {
      throw new Error("OpenAI-compatible /v1/models unreachable");
    }

    // Self-heal backend from owned_by before branching (cheap, no extra HTTP)
    if (typeof owned === "string") {
      if (/ds4/i.test(owned)) this.backendType = "ds4";
      else if (/sglang/i.test(owned) && this.backendType !== "ds4") {
        this.backendType = "sglang";
      } else if (/exl3/i.test(owned) && this.backendType !== "ds4") {
        this.backendType = "exl3";
      } else if (/tensorfold/i.test(owned) && this.backendType !== "ds4") {
        this.backendType = "tensorfold";
      } else if (/freetoken/i.test(owned) && this.backendType !== "ds4") {
        this.backendType = "freetoken";
      }
    }

    if (this.backendType === "freetoken") {
      // FreeToken reports no engine memory split; never keep another engine's.
      this._clearEngineMemory();
      try {
        const statsRes = await this._fetch(`${this.baseUrl}/v1/stats`);
        // A protected /v1/stats is "needs a key", not "no data".
        this._noteAuthStatus(statsRes.status);
        if (!statsRes.ok) {
          this._clearFreeTokenRates();
        } else {
          const stats = await statsRes.json().catch(() => null);
          this._applyFreeTokenStats(stats);
        }
      } catch {
        this._clearFreeTokenRates();
      }
      return this._getSnapshot();
    }

    // Engine pool sizes: only SGLang and vLLM report them, and they re-read
    // them every poll below, so a size never outlives the payload it came from.
    this._clearEngineMemory();

    // TensorFold: no Prometheus. /health carries cumulative token totals when the
    // server publishes them; without them tok/s stays 0 rather than guessing.
    if (this.backendType === "tensorfold") {
      try {
        const healthRes = await this._fetch(`${this.baseUrl}/health`);
        if (healthRes.ok) {
          const health = await healthRes.json().catch(() => null);
          this._applyTensorFoldHealth(health, dtSec);
          this._applyTensorFoldLive(health);
          // Newer builds report live rates in /health but cumulative totals only on Prometheus /metrics.
          const totalRaw = health?.completion_tokens_total;
          if (totalRaw == null || !Number.isFinite(Number(totalRaw))) await this._applyTensorFoldMetrics();
        } else {
          this._applyTensorFoldHealth(null, dtSec);
        }
      } catch {
        this._applyTensorFoldHealth(null, dtSec);
      }
      return this._getSnapshot();
    }

    // EXL3 serve_openai.py: live tok/s from /health cumulative counters (no Prometheus).
    if (this.backendType === "exl3" || this.backendType == null) {
      try {
        const healthRes = await this._fetch(`${this.baseUrl}/health`);
        if (healthRes.ok) {
          const health = await healthRes.json().catch(() => null);
          if (LlmProbe._healthLooksLikeExl3(health)) {
            this.backendType = "exl3";
            this._applyExl3Health(health, dtSec);
            return this._getSnapshot();
          }
        }
      } catch {
        /* health optional unless already classified exl3 */
      }
      if (this.backendType === "exl3") return this._getSnapshot();
    }

    // SGLang: native info endpoints. Skip on known vLLM/ds4 to avoid 404 spam.
    // Prefer /server_info — /get_server_info is a deprecated alias that logs every poll.
    if (this.backendType === "sglang" || this.backendType == null) {
      this._sglangTotalsPolled = false;
      const sgData = await this._fetchSglangJson(SGLANG_SERVER_INFO_PATHS);
      if (sgData) {
        this.backendType = "sglang";
        // Load before last_gen_throughput so inflight can keep a steady rate live.
        await this._probeSglangLoad();
        this._applySglangServerInfo(sgData, dtSec);
        // Engine tile: Active vs Sleeping. SGLang has no live sleep gauge
        // (sleep_on_idle is a launch flag, not current state). A reachable
        // server with weights resident is Active / ready.
        if (this.gpuMemoryUtilization == null) this.gpuMemoryUtilization = 1;
      }
    }

    if (this.backendType === "sglang") {
      // KV fill comes from /metrics only; unknown when that poll misses it.
      this.kvCacheUsage = null;
      // Prometheus is optional (--enable-metrics). Do not mix those counters
      // into lastTokenCounts when this poll's server-info totals own them.
      // Gate on which series answered, never on the displayed rates: a live
      // rate keeps the split path selected forever, and the split path is not
      // allowed to clear prefillTps — the value then latches (#99).
      try {
        const metricsRes = await this._fetch(`${this.baseUrl}/metrics`);
        if (metricsRes.ok) {
          const txt = await metricsRes.text();
          this._applySglangKvMetrics(txt);
          if (this._sglangTotalsPolled) this._applySglangPrefillSplit(txt, dtSec);
          else this._applySglangMetrics(txt, dtSec);
        }
      } catch {
        /* metrics optional */
      }
      await this._enrichSglangModelInfo();
      // Native SGLang endpoints expose the storage path (often just `/model`).
      // Keep that as modelPath, but show/use the client-facing served model ID.
      if (servedModelId) this.modelId = servedModelId;
      return this._getSnapshot();
    }

    // Single /metrics fetch: ds4-server or vLLM Prometheus exposition
    try {
      const metricsRes = await this._fetch(`${this.baseUrl}/metrics`);
      if (metricsRes.ok) {
        const txt = await metricsRes.text();
        if (
          this.backendType === "ds4" ||
          LlmProbe._metricsLookLikeDs4(txt)
        ) {
          this.backendType = "ds4";
          this._applyDs4Metrics(txt, dtSec);
        } else if (
          this.backendType === "q27" ||
          LlmProbe._metricsLookLikeQ27(txt)
        ) {
          this.backendType = "q27";
          this._applyQ27Metrics(txt, dtSec);
        } else {
          this.backendType = "vllm";
          this._applyVllmMetrics(txt, dtSec);
        }
      } else if (
        this.backendType !== "ds4" &&
        this.backendType !== "exl3" &&
        this.backendType !== "q27"
      ) {
        this.backendType = "vllm";
      }
    } catch {
      if (
        this.backendType !== "ds4" &&
        this.backendType !== "exl3" &&
        this.backendType !== "q27"
      ) {
        this.backendType = "vllm";
      }
    }

    return this._getSnapshot();
  }

  /**
   * Apply ds4-server Prometheus /metrics (Entrpi/ds4-on-spark).
   * Live tok/s from counter diffs (same as vLLM) so idle → 0. The engine's
   * `ds4_decode_tok_s` / `ds4_prefill_tok_s` gauges are ~60s windows and stay
   * non-zero long after requests finish — do not use them for the live panel.
   * @param {string} txt
   * @param {number} dtSec
   */
  _applyDs4Metrics(txt, dtSec) {
    const decoded = this._getPromMetric(txt, "ds4_tokens_decoded_total");
    const computedPrefill = this._getPromMetricLabeled(
      txt,
      "ds4_tokens_prefilled_total",
      "kind",
      "computed"
    );
    const prefilled =
      computedPrefill ?? this._getPromMetric(txt, "ds4_tokens_prefilled_total");
    const inflightHint = this._getPromMetric(txt, "ds4_requests_inflight");
    const inflight = inflightHint != null && inflightHint > 0;
    // Cumulative cached prefill for the token ledger (kind="cached" label).
    const cachedTotal = this._getPromMetricLabeled(
      txt,
      "ds4_tokens_prefilled_total",
      "kind",
      "cached"
    );

    if (decoded != null) {
      if (prefilled != null && dtSec > 0 && dtSec < 10) {
        const deltaIn = prefilled - this.lastTokenCounts.input;
        const deltaOut = decoded - this.lastTokenCounts.output;
        this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
        this.prefillTps = Math.max(0, Math.round((deltaIn / dtSec) * 100) / 100);
      } else if (dtSec > 0 && dtSec < 10) {
        const deltaOut = decoded - this.lastTokenCounts.output;
        this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
        if (!inflight && deltaOut <= 0) this.prefillTps = 0;
      }
      if (prefilled != null) this.lastTokenCounts.input = prefilled;
      this.lastTokenCounts.output = decoded;
      this.totalOutputTokens = decoded;
      // ds4's prefill counter is COMPUTED-only when the kind labels exist;
      // the token ledger wants the full prompt, so add the cached share.
      if (prefilled != null) {
        this.totalPromptTokens =
          cachedTotal != null && computedPrefill != null
            ? prefilled + cachedTotal
            : prefilled;
      }
      if (cachedTotal != null) this.totalCachedTokens = cachedTotal;
    } else {
      // No counters — fall back to window gauges only while something is in flight
      const gaugeGen = this._getPromMetric(txt, "ds4_decode_tok_s");
      const gaugePrefill = this._getPromMetric(txt, "ds4_prefill_tok_s");
      if (inflight) {
        if (gaugeGen != null) {
          this.generationTps = Math.max(0, Math.round(gaugeGen * 100) / 100);
        }
        if (gaugePrefill != null) {
          this.prefillTps = Math.max(0, Math.round(gaugePrefill * 100) / 100);
        }
      } else {
        this.generationTps = 0;
        this.prefillTps = 0;
      }
    }

    const inflightCount = this._getPromMetric(txt, "ds4_requests_inflight");
    this.requestsRunning = inflightCount;
    if (inflightCount != null) this.slotsActive = Math.round(inflightCount);

    const banksTotal = this._getPromMetric(txt, "ds4_banks_total");
    if (banksTotal != null) this.slotsTotal = Math.round(banksTotal);

    const specAccept = this._getPromMetric(txt, "ds4_spec_accept_ratio");
    this.mtpAcceptanceRate =
      specAccept != null ? Math.round(specAccept * 10000) / 10000 : null;

    // Prefix-cache hit rate + live tok/s from prefill kind labels
    const cached = this._getPromMetricLabeled(
      txt,
      "ds4_tokens_prefilled_total",
      "kind",
      "cached"
    );
    const computed = this._getPromMetricLabeled(
      txt,
      "ds4_tokens_prefilled_total",
      "kind",
      "computed"
    );
    this._setPrefillSplitRates(cached, computed, dtSec);

    // Clear tiles that are vLLM-histogram-specific (no ds4 equivalent yet)
    this.kvCacheUsage = null;
    this._clearKvPool();
    this.requestsWaiting = null;
    this.ttftP95Seconds = null;
    this.ttftSeconds = null;
    this.preemptionsTotal = null;
    this.e2eP95Seconds = null;
    this.itlP95Seconds = null;
  }

  /**
   * Apply q27 (signalnine/q27 engine) Prometheus /metrics.
   *
   * The engine exposes the [req]-universe telemetry that was previously only
   * in stderr logs, under q27_* series with an api= label (chat / completions /
   * messages / responses). The probe sums across label sets, exactly like the
   * ds4/vLLM paths: live tok/s from counter deltas so idle → 0.
   *
   * Semantics vs the vLLM path: prefill accounting is EXACT (per-request
   * token counts, not vLLM's estimates) and the prefix split (computed/cached)
   * doubles as the prefix-cache hit rate; the main prefill tile follows the
   * ds4 convention and counts COMPUTED tokens only. The waiting tile stays
   * null → the panel shows "—" (q27 FIFO-queues, no scheduler wait), while
   * preemptions are exposed as a constant-0 counter so Preempts reads 0.
   * @param {string} txt
   * @param {number} dtSec
   */
  _applyQ27Metrics(txt, dtSec) {
    // Live processed counters first (move during generation -> real-time
    // tok/s); fall back to the completion-based per-api totals for older
    // q27 binaries (step function: 0 during generation, jump at completion).
    const decoded =
      this._getPromMetric(txt, "q27_decode_tokens_processed_total") ??
      this._getPromMetric(txt, "q27_decode_tokens_total");
    // Exact prefill (not estimated like vLLM). Follow the ds4 convention:
    // the main prefill tile counts COMPUTED tokens only -- cache-served
    // tokens go to the cached/uncached split below, so a cache hit does not
    // inflate the "real work" rate.
    const computed =
      this._getPromMetric(txt, "q27_prefill_computed_tokens_processed_total") ??
      this._getPromMetric(txt, "q27_prefill_computed_tokens_total");
    if (decoded != null) {
      if (dtSec > 0 && dtSec < 10) {
        const deltaOut = decoded - this.lastTokenCounts.output;
        this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
        if (computed != null) {
          const deltaIn = computed - this.lastTokenCounts.input;
          this.prefillTps = Math.max(0, Math.round((deltaIn / dtSec) * 100) / 100);
        }
      }
      if (computed != null) this.lastTokenCounts.input = computed;
      this.lastTokenCounts.output = decoded;
      this.totalOutputTokens = decoded;
      // q27's prefill counter is computed-only; the token ledger wants the
      // full prompt (computed + cached).
      const cachedTok =
        this._getPromMetric(txt, "q27_prefill_cached_tokens_processed_total") ??
        this._getPromMetric(txt, "q27_prefill_cached_tokens_total");
      if (computed != null) {
        this.totalPromptTokens = cachedTok != null ? computed + cachedTok : computed;
      }
      if (cachedTok != null) this.totalCachedTokens = cachedTok;
    }

    const inflight = this._getPromMetric(txt, "q27_requests_inflight");
    this.requestsRunning = inflight;
    if (inflight != null) this.slotsActive = Math.round(inflight);

    const slotsTotal = this._getPromMetric(txt, "q27_slots_total");
    if (slotsTotal != null) this.slotsTotal = Math.round(slotsTotal);

    this.kvCacheUsage = this._getPromMetric(txt, "q27_kv_usage_perc");
    this._clearKvPool();
    this.requestsWaiting = null; // not exposed: q27 FIFO-queues, no wait gauge
    // q27 never preempts (FIFO admission) — the server exposes a constant-0
    // counter, so the Preempts tile reads 0 instead of "—".
    this.preemptionsTotal = this._getPromMetric(txt, "q27_preemptions_total");
    // Engine state: q27 keeps weights resident and is ready whenever the
    // server is up (no sleep state / memory release), so report Active like
    // the SGLang path does.
    if (this.gpuMemoryUtilization == null) this.gpuMemoryUtilization = 1;

    // Histograms (cumulative buckets, +Inf == _count by construction).
    const ttftHist = this._parseHistogram(
      txt,
      "q27_ttft_seconds",
      "q27_ttft_seconds_count"
    );
    const ttftP95 = this._histogramQuantile(ttftHist.buckets, ttftHist.total, 0.95);
    this.ttftP95Seconds = ttftP95 == null ? null : Math.round(ttftP95 * 1000) / 1000;

    const e2eHist = this._parseHistogram(
      txt,
      "q27_e2e_seconds",
      "q27_e2e_seconds_count"
    );
    const e2eP95 = this._histogramQuantile(e2eHist.buckets, e2eHist.total, 0.95);
    this.e2eP95Seconds = e2eP95 == null ? null : Math.round(e2eP95 * 1000) / 1000;

    const itlHist = this._parseHistogram(
      txt,
      "q27_itl_seconds",
      "q27_itl_seconds_count"
    );
    const itlP95 = this._histogramQuantile(itlHist.buckets, itlHist.total, 0.95);
    this.itlP95Seconds = itlP95 == null ? null : Math.round(itlP95 * 1000) / 1000;

    // Prefix-cache hit rate + live cached/uncached prefill split (live
    // processed counters, with completion-based fallback).
    const cachedSplit =
      this._getPromMetric(txt, "q27_prefill_cached_tokens_processed_total") ??
      this._getPromMetric(txt, "q27_prefill_cached_tokens_total");
    const computedSplit =
      this._getPromMetric(txt, "q27_prefill_computed_tokens_processed_total") ??
      this._getPromMetric(txt, "q27_prefill_computed_tokens_total");
    this._setPrefillSplitRates(cachedSplit, computedSplit, dtSec);

    const specAccept = this._getPromMetric(txt, "q27_spec_accept_ratio");
    this.mtpAcceptanceRate =
      specAccept != null ? Math.round(specAccept * 10000) / 10000 : null;
  }

  /**
   * Apply EXL3 tools/serve_openai.py GET /health.
   * Live tok/s from cumulative counter diffs so idle → 0.
   * @param {Record<string, unknown>} data
   * @param {number} dtSec
   */
  _applyExl3Health(data, dtSec) {
    const prompt = Number(data?.prompt_tokens_total);
    const completion = Number(data?.completion_tokens_total);
    const busy = data?.busy === true;
    const ctx = Number(data?.context_length);
    if (Number.isFinite(ctx) && ctx > 0) this.contextLength = Math.round(ctx);

    this.requestsRunning = busy ? 1 : 0;
    this.slotsActive = busy ? 1 : 0;
    this.slotsTotal = 1;
    this.kvCacheUsage = null;
    this._clearKvPool();
    this.requestsWaiting = null;
    this.ttftP95Seconds = null;
    this.ttftSeconds = null;
    this.preemptionsTotal = null;
    this.prefixCacheHitRate = null;
    this.e2eP95Seconds = null;
    this.itlP95Seconds = null;
    this.mtpAcceptanceRate = null;
    this.cachedPrefillTps = null;
    this.uncachedPrefillTps = null;

    if (!Number.isFinite(completion)) {
      this.generationTps = busy ? this.generationTps : 0;
      if (!busy) this.prefillTps = 0;
      return;
    }

    if (dtSec > 0 && dtSec < 10) {
      const deltaOut = completion - this.lastTokenCounts.output;
      this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
      if (Number.isFinite(prompt)) {
        const deltaIn = prompt - this.lastTokenCounts.input;
        this.prefillTps = Math.max(0, Math.round((deltaIn / dtSec) * 100) / 100);
      } else if (!busy && this.generationTps <= 0) {
        this.prefillTps = 0;
      }
    } else if (!busy) {
      this.generationTps = 0;
      this.prefillTps = 0;
    }

    if (Number.isFinite(prompt)) this.lastTokenCounts.input = prompt;
    this.lastTokenCounts.output = completion;
    this.totalOutputTokens = completion;
    if (Number.isFinite(prompt)) this.totalPromptTokens = prompt;
  }

  /** Drop live FreeToken rates after a failed or empty `/v1/stats`. Totals stay. */
  _clearFreeTokenRates() {
    this.generationTps = 0;
    this.prefillTps = 0;
    this.kvCacheUsage = null;
    this.kvCacheTokens = null;
    this.kvCacheTokensAvailable = null;
    this.kvCacheMemoryBytes = null;
    this.ttftSeconds = null;
    this.ttftP95Seconds = null;
    this.e2eP95Seconds = null;
    this.requestsWaiting = null;
    this.preemptionsTotal = null;
  }

  /**
   * Apply FreeToken GET /v1/stats.
   * `throughput.*_tps` is already a 5s sliding window (0 when idle), so it is
   * not differenced. `requests.ttft_mean_ms` is a mean. `requests.p95_ms` is
   * end-to-end request latency, not TTFT p95. Queue length, slot capacity, and
   * preemptions are not in the payload and stay unset.
   * @param {unknown} data
   */
  _applyFreeTokenStats(data) {
    if (!LlmProbe._statsLookLikeFreeToken(data)) {
      this._clearFreeTokenRates();
      return;
    }
    const stats = /** @type {Record<string, any>} */ (data);
    // Rates come from FreeToken's window, not from differencing these totals,
    // so a restart (new instance_id, or counters that went backwards) cannot
    // spike tok/s. The new totals are adopted as-is.

    const decode = Number(stats.throughput.decode_tps);
    const prefill = Number(stats.throughput.prefill_tps);
    this.generationTps = Math.max(0, Math.round(decode * 100) / 100);
    this.prefillTps = Math.max(0, Math.round(prefill * 100) / 100);

    const requests = stats.requests;
    const active = Number(requests.active);
    this.requestsRunning = Number.isFinite(active) && active >= 0 ? Math.round(active) : null;
    // No concurrency capacity in /v1/stats. Do not invent a slot total from `active`.
    this.slotsActive = 0;
    this.slotsTotal = 0;
    this.requestsWaiting = null;
    this.preemptionsTotal = null;
    this.ttftP95Seconds = null;

    const prompt = Number(requests.prompt_tokens_total);
    const completion = Number(requests.completion_tokens_total);
    if (Number.isFinite(prompt) && prompt >= 0) this.totalPromptTokens = prompt;
    if (Number.isFinite(completion) && completion >= 0) this.totalOutputTokens = completion;

    const ttftMeanMs = Number(requests.ttft_mean_ms);
    this.ttftSeconds =
      Number.isFinite(ttftMeanMs) && ttftMeanMs >= 0
        ? Math.round((ttftMeanMs / 1000) * 1000) / 1000
        : null;
    const p95Ms = Number(requests.p95_ms);
    this.e2eP95Seconds =
      Number.isFinite(p95Ms) && p95Ms >= 0 ? Math.round((p95Ms / 1000) * 1000) / 1000 : null;

    const kv = stats.kv;
    if (
      kv &&
      typeof kv === "object" &&
      Number(kv.total_pages) > 0 &&
      Number.isFinite(Number(kv.used_pages))
    ) {
      const total = Number(kv.total_pages);
      const used = Math.max(0, Number(kv.used_pages));
      this.kvCacheUsage = Math.round((Math.min(used, total) / total) * 1000) / 1000;
      const page = Number(kv.page_size);
      if (Number.isFinite(page) && page > 0) {
        this.kvCacheTokens = Math.round(total * page);
        this.kvCacheTokensAvailable = Math.max(0, Math.round((total - used) * page));
      } else {
        this.kvCacheTokens = null;
        this.kvCacheTokensAvailable = null;
      }
    } else {
      this.kvCacheUsage = null;
      this.kvCacheTokens = null;
      this.kvCacheTokensAvailable = null;
    }

    const ctx = Number(stats.model?.ctx);
    if (Number.isFinite(ctx) && ctx > 0) this.contextLength = Math.round(ctx);
    if (stats.model?.id) applyModelRef(this, stats.model.id);
  }

  /**
   * Apply TensorFold GET /health.
   * Live decode tok/s is the completion-counter diff (idle → 0). The first sample
   * only seeds the baseline. Prefill tok/s uses `prefill_seconds_total` when the
   * server sends it (prompt tokens ÷ actual prefill time), otherwise the EXL3
   * poll-window diff. `{ok: true}` with no counters stays at 0.
   * CUDA 0.6.0 sizes the slot tile from `streams.max`; MLX uses `max_batch_size`.
   * @param {Record<string, unknown> | null} data
   * @param {number} dtSec
   */
  _applyTensorFoldHealth(data, dtSec) {
    const health = data && typeof data === "object" && !Array.isArray(data) ? data : {};
    // A prompt is being processed right now (no live rate exists for it, see below).
    this.prefillActive = Number(health.streams?.prefilling) > 0;
    // Number(null) is 0: a null counter means "absent", not "zero".
    const prompt = health.prompt_tokens_total == null ? NaN : Number(health.prompt_tokens_total);
    const completion = health.completion_tokens_total == null ? NaN : Number(health.completion_tokens_total);
    const prefillSec = Number(health.prefill_seconds_total);
    if (Number.isFinite(completion) && !this._tensorfoldSeeded) {
      if (Number.isFinite(prompt)) this.lastTokenCounts.input = prompt;
      this.lastTokenCounts.output = completion;
      if (Number.isFinite(prefillSec)) this._tensorfoldPrefillSeconds = prefillSec;
      this._tensorfoldSeeded = true;
      this.generationTps = 0;
      this.prefillTps = 0;
    }
    const prevIn = this.lastTokenCounts.input;
    const prevPrefillSec = this._tensorfoldPrefillSeconds;
    this._applyExl3Health(health, dtSec);
    // TensorFold 0.5.0 (cuda/health.py) publishes cumulative cached prompt tokens
    // alongside the EXL3-style counters; older builds omit it (stays null).
    const cached = Number(health.cached_tokens_total);
    if (Number.isFinite(cached) && cached >= 0) this.totalCachedTokens = cached;
    const batch = Number(health.max_batch_size);
    if (Number.isFinite(batch) && batch > 0) this.slotsTotal = Math.round(batch);
    // TensorFold 0.6.0 CUDA serves several streams at once: `streams.max` is the
    // slot count and `requests_running` the busy ones. The EXL3 path above only
    // knows a single `busy` flag, which would pin the tile at 1/1.
    const streams =
      health.streams && typeof health.streams === "object" && !Array.isArray(health.streams)
        ? health.streams
        : {};
    const max = Number(streams.max);
    if (Number.isFinite(max) && max > 0) this.slotsTotal = Math.round(max);
    // null must not read as 0 busy streams (Number(null) === 0).
    const count = (v) => (v == null ? NaN : Number(v));
    let running = count(health.requests_running);
    if (!Number.isFinite(running)) {
      const decoding = count(streams.decoding);
      const prefilling = count(streams.prefilling);
      if (Number.isFinite(decoding) || Number.isFinite(prefilling)) {
        running =
          (Number.isFinite(decoding) ? decoding : 0) +
          (Number.isFinite(prefilling) ? prefilling : 0);
      }
    }
    if (Number.isFinite(running) && running >= 0) {
      this.requestsRunning = Math.round(running);
      this.slotsActive = Math.round(running);
    }
    // 0.6.0 CUDA sizes its KV pool in tokens: `pool_tokens` in all,
    // `pool_free_tokens` not held by a request (kept prompts count as held).
    const pool = count(health.pool_tokens);
    const poolFree = count(health.pool_free_tokens);
    if (Number.isFinite(pool) && pool > 0 && Number.isFinite(poolFree) && poolFree >= 0) {
      const used = 1 - Math.min(poolFree, pool) / pool;
      this.kvCacheUsage = Math.round(used * 10000) / 10000;
    }
    if (!Number.isFinite(prefillSec) || !Number.isFinite(prompt)) return;
    if (prevPrefillSec == null) {
      this._tensorfoldPrefillSeconds = prefillSec;
      return;
    }
    if (!(dtSec > 0 && dtSec < 10)) return;
    const dSec = prefillSec - prevPrefillSec;
    const dIn = prompt - prevIn;
    if (dSec > 0 && dIn > 0) {
      // A request just finished: its average prefill rate. TensorFold publishes token and time
      // totals only for finished requests, so nothing is measurable while a long prefill runs;
      // keep the last finished rate on screen for a while instead of flashing to 0.
      this._tensorfoldLastPrefill = { tps: Math.max(0, Math.round((dIn / dSec) * 100) / 100), at: Date.now() };
      this.prefillTps = this._tensorfoldLastPrefill.tps;
    } else if (this._tensorfoldLastPrefill && Date.now() - this._tensorfoldLastPrefill.at < 20_000) {
      this.prefillTps = this._tensorfoldLastPrefill.tps;
    } else {
      this.prefillTps = 0;
    }
    this._tensorfoldPrefillSeconds = prefillSec;
  }

  /**
   * Newer TensorFold builds put the server's own live rates in /health:
   * `live: { decode_tokens_per_second, prefill_tokens_per_second, connections, waiting }`.
   * Those are used as-is (no counter diff needed). Older builds have no `live` block.
   * @param {Record<string, unknown> | null} data
   */
  _applyTensorFoldLive(data) {
    const live = data && typeof data === "object" ? data.live : null;
    if (!live || typeof live !== "object" || Array.isArray(live)) return;
    const rate = (v) => {
      const n = v == null ? NaN : Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
    };
    const decode = rate(live.decode_tokens_per_second);
    const prefill = rate(live.prefill_tokens_per_second);
    if (decode != null) this.generationTps = decode;
    if (prefill != null) this.prefillTps = prefill;
    const waiting = live.waiting == null ? NaN : Number(live.waiting);
    if (Number.isFinite(waiting) && waiting >= 0) this.requestsWaiting = Math.round(waiting);
    const conns = live.connections == null ? NaN : Number(live.connections);
    if (Number.isFinite(conns) && conns >= 0 && !(this.requestsRunning > 0)) {
      this.requestsRunning = Math.round(conns);
      this.slotsActive = Math.round(conns);
    }
  }

  /**
   * TensorFold Prometheus /metrics (`tensorfold:*`): cumulative token totals (finished requests),
   * running / waiting requests and the MTP draft acceptance rate. Best effort: a miss changes nothing.
   */
  async _applyTensorFoldMetrics() {
    let txt;
    try {
      const res = await this._fetch(`${this.baseUrl}/metrics`);
      if (!res.ok) return;
      txt = await res.text();
    } catch {
      return;
    }
    if (typeof txt !== "string" || !txt.includes("tensorfold:")) return;
    const m = (name) => this._getPromMetric(txt, `tensorfold:${name}`);
    const gen = m("generation_tokens_total");
    const prompt = m("prompt_tokens_total");
    if (Number.isFinite(gen) && gen >= 0) this.totalOutputTokens = gen;
    if (Number.isFinite(prompt) && prompt >= 0) this.totalPromptTokens = prompt;
    const running = m("requests_running");
    if (Number.isFinite(running) && running >= 0) {
      this.requestsRunning = Math.round(running);
      this.slotsActive = Math.round(running);
    }
    const waiting = m("requests_waiting");
    if (Number.isFinite(waiting) && waiting >= 0) this.requestsWaiting = Math.round(waiting);
    const drafted = m("mtp_drafted_total");
    const accepted = m("mtp_accepted_total");
    if (Number.isFinite(drafted) && drafted > 0 && Number.isFinite(accepted)) {
      this.mtpAcceptanceRate = Math.max(0, Math.min(1, accepted / drafted));
    }
  }

  /**
   * Apply stock vLLM Prometheus /metrics (tok/s + inference tiles).
   * @param {string} txt
   * @param {number} dtSec
   */
  _applyVllmMetrics(txt, dtSec) {
    const promptTokens = this._getVllmMetric(txt, "prompt_tokens_total");
    const genTokens = this._getVllmMetric(txt, "generation_tokens_total");
    const running = this._getVllmMetric(txt, "num_requests_running");
    const iterSum = this._getVllmMetric(txt, "iteration_tokens_total_sum");
    if (promptTokens != null && genTokens != null) {
      const deltaIn = promptTokens - this.lastTokenCounts.input;
      const deltaOut = genTokens - this.lastTokenCounts.output;
      this.lastTokenCounts.input = promptTokens;
      this.lastTokenCounts.output = genTokens;
      this.totalOutputTokens = genTokens;
      this.totalPromptTokens = promptTokens;
      // vLLM prefix-cache counters are token-granular (queries += prompt
      // tokens/request, hits += tokens served from cache), so cached_tokens
      // is directly the cumulative cached share of the prompt.
      const cachedTok = this._getVllmMetric(txt, "prefix_cache_hits_total");
      if (cachedTok != null) this.totalCachedTokens = cachedTok;
      const ttftSum = this._getVllmMetric(txt, "time_to_first_token_seconds_sum");
      const deltaIter =
        iterSum != null && this.lastIterSum != null ? iterSum - this.lastIterSum : 0;
      if (dtSec > 0 && dtSec < 10) {
        this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
        const deltaTtft =
          ttftSum != null && this.lastTtftSum != null ? ttftSum - this.lastTtftSum : 0;
        // Engine-step tokens include prefill+decode. Surplus over generation is
        // prefill, including the common case where a short/cached prefill lands
        // in the same poll as the first decode tokens.
        const prefillIter = Math.max(0, deltaIter - Math.max(0, deltaOut));
        const specNoise = deltaOut > 0 && prefillIter > 0 && prefillIter < deltaOut * 0.5;
        const livePrefill =
          prefillIter > 0 && !specNoise ? prefillIter / dtSec : 0;
        const finishedPrefill =
          deltaIn > 0 && deltaTtft > 0
            ? deltaIn / deltaTtft
            : deltaIn > 0 && livePrefill <= 0
              ? deltaIn / dtSec
              : 0;
        this.prefillTps = Math.max(
          0,
          Math.round((livePrefill > 0 ? livePrefill : finishedPrefill) * 100) / 100
        );
      }
      // Live mean TTFT over the last poll window from histogram sum/count deltas.
      // Computed BEFORE lastTtftSum is advanced so the delta is real, not 0.
      const ttftCount = this._getVllmMetric(txt, "time_to_first_token_seconds_count");
      if (ttftCount != null) {
        const deltaSum =
          ttftSum != null && this.lastTtftSum != null ? ttftSum - this.lastTtftSum : null;
        const deltaCount =
          this.lastTtftCount != null ? ttftCount - this.lastTtftCount : null;
        this.ttftSeconds =
          deltaSum != null && deltaCount != null && deltaCount > 0 && deltaSum >= 0
            ? Math.round((deltaSum / deltaCount) * 1000) / 1000
            : null;
        this.lastTtftCount = ttftCount;
      } else {
        this.ttftSeconds = null;
      }
      if (ttftSum != null) this.lastTtftSum = ttftSum;
    }
    if (iterSum != null) this.lastIterSum = iterSum;

    this.requestsRunning = running;
    if (running != null) this.slotsActive = Math.round(running);

    if (this.gpuMemoryUtilization == null) {
      const sleepState = this._getVllmMetric(txt, "engine_sleep_state");
      if (sleepState != null) this.gpuMemoryUtilization = sleepState;
    }

    this.requestsWaiting = this._getVllmMetric(txt, "num_requests_waiting");
    // Older vLLM (V0 engine) names the same gauge gpu_cache_usage_perc.
    this.kvCacheUsage =
      this._getVllmMetric(txt, "kv_cache_usage_perc") ??
      this._getVllmMetric(txt, "gpu_cache_usage_perc");
    this._applyVllmKvPool(txt);
    this.preemptionsTotal = this._getVllmMetric(txt, "num_preemptions_total");

    const ttftHist = this._parseVllmHistogram(txt, "vllm:time_to_first_token_seconds");
    const ttftP95 = this._histogramQuantile(ttftHist.buckets, ttftHist.total, 0.95);
    this.ttftP95Seconds = ttftP95 == null ? null : Math.round(ttftP95 * 1000) / 1000;

    const e2eHist = this._parseVllmHistogram(txt, "vllm:e2e_request_latency_seconds");
    const e2eP95 = this._histogramQuantile(e2eHist.buckets, e2eHist.total, 0.95);
    this.e2eP95Seconds = e2eP95 == null ? null : Math.round(e2eP95 * 1000) / 1000;

    const itlHist = this._parseVllmHistogram(txt, "vllm:inter_token_latency_seconds");
    const itlP95 = this._histogramQuantile(itlHist.buckets, itlHist.total, 0.95);
    this.itlP95Seconds = itlP95 == null ? null : Math.round(itlP95 * 1000) / 1000;

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

  /**
   * Apply SGLang /server_info (or deprecated /get_server_info).
   * Older builds expose total_input_tokens / total_output_tokens.
   * Current builds (metrics often off) expose sticky last_gen_throughput under
   * internal_states[i]. Only treat it as live after the value changes between
   * polls, then expire to 0 when it stops moving (idle leftover).
   * @param {Record<string, unknown>} sgData
   * @param {number} dtSec
   */
  _applySglangServerInfo(sgData, dtSec) {
    this._clearKvPool();
    // Where the engine's memory went: model weights and the KV pool it
    // pre-allocated at start-up (GB, from the first scheduler that reports).
    const mem = LlmProbe._sglangMemoryUsage(sgData);
    this.weightsGb = LlmProbe._positiveNumber(mem?.weight);
    this.kvCacheGb = LlmProbe._positiveNumber(mem?.kvcache);

    // Prefer true max context (context_length / max_total_tokens). Do NOT use
    // max_total_num_tokens — that is the KV-cache pool budget across concurrent
    // sequences and is often ~2× the configured context (showed 2.1M for a 1M run).
    const explicitCtx =
      LlmProbe._positiveNumber(sgData.context_length) ??
      LlmProbe._positiveNumber(sgData.max_total_tokens);
    if (explicitCtx != null) {
      this.contextLength = explicitCtx;
    } else if (this.contextLength == null) {
      this.contextLength =
        LlmProbe._positiveNumber(sgData.max_req_input_len) ??
        LlmProbe._positiveNumber(sgData.max_total_num_tokens) ??
        null;
    }

    if (sgData.model_path) {
      applyModelRef(this, sgData.model_path);
    }

    const maxRunning = Number(sgData.max_running_requests);
    if (Number.isFinite(maxRunning) && maxRunning > 0) {
      this.slotsTotal = Math.round(maxRunning);
    }

    const inTok = sgData.total_input_tokens;
    const outTok = sgData.total_output_tokens;
    // Newer SGLang builds expose total_cached_tokens (radix/prefix cache
    // served) next to the totals; older ones fall back to Prometheus.
    const cachedNum = Number(sgData.total_cached_tokens);
    const sgCached = Number.isFinite(cachedNum) && cachedNum >= 0 ? cachedNum : null;
    if (inTok != null && outTok != null) {
      const input = Number(inTok);
      const output = Number(outTok);
      if (Number.isFinite(input) && Number.isFinite(output)) {
        const deltaIn = input - this.lastTokenCounts.input;
        const deltaOut = output - this.lastTokenCounts.output;
        this.lastTokenCounts.input = input;
        this.lastTokenCounts.output = output;
        this.totalOutputTokens = output;
        this.totalPromptTokens = input;
        if (sgCached != null) this.totalCachedTokens = sgCached;
        this._sglangTotalsPolled = true;
        this._sglangTokenSource = "server_info";
        if (dtSec > 0 && dtSec < 10) {
          this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
          this._setPrefillTps(deltaIn / dtSec, deltaOut > 0);
        }
        return;
      }
    }

    // No cumulative counters — sticky last_gen_throughput only while it moves,
    // unless /v1/loads (or /get_load) says requests are in flight.
    const lastGen = LlmProbe._sglangLastGenThroughput(sgData);
    this.generationTps = this._sglangStickyThroughput(lastGen, this._sglangInflight());
  }

  /**
   * `internal_states[i].memory_usage` = `{ weight, kvcache, graph, … }` in GB.
   * @param {Record<string, unknown>} sgData
   * @returns {Record<string, unknown> | null}
   */
  static _sglangMemoryUsage(sgData) {
    const states = sgData?.internal_states;
    if (!Array.isArray(states)) return null;
    for (const st of states) {
      const mem = st && typeof st === "object" ? st.memory_usage : null;
      if (mem && typeof mem === "object" && !Array.isArray(mem)) return mem;
    }
    return null;
  }

  /**
   * KV pool fill (and its size, when /server_info did not give one) from
   * SGLang /metrics. `token_usage` is the share of the pool held by running
   * requests; builds without it get kv_used_tokens / max_total_num_tokens.
   * Max, not sum: tensor-parallel ranks each report the same pool.
   * @param {string} txt
   */
  _applySglangKvMetrics(txt) {
    const series = (name) =>
      this._getPromMetricMax(txt, `sglang:${name}`) ??
      this._getPromMetricMax(txt, `sglang_${name}`);
    let usage = series("token_usage");
    if (usage == null) {
      const used = series("kv_used_tokens");
      const total = series("max_total_num_tokens");
      if (used != null && total != null && total > 0) usage = used / total;
    }
    this.kvCacheUsage =
      usage != null && usage >= 0 ? Math.round(Math.min(1, usage) * 10000) / 10000 : null;
    if (this.kvCacheGb == null) {
      this.kvCacheGb = LlmProbe._positiveNumber(series("kv_cache_memory_usage_gb"));
    }
  }

  /** True when SGLang load probe reported running or waiting requests. */
  _sglangInflight() {
    return (
      this.slotsActive > 0 ||
      (this.requestsRunning != null && this.requestsRunning > 0) ||
      (this.requestsWaiting != null && this.requestsWaiting > 0)
    );
  }

  /**
   * Prefer /v1/loads (num_running_reqs). Fall back to /get_load, where
   * num_reqs is running + waiting.
   */
  async _probeSglangLoad() {
    this._sglangLoadGenTps = null;
    for (const path of ["/v1/loads", "/get_load"]) {
      try {
        const res = await this._fetch(`${this.baseUrl}${path}`);
        if (!res.ok) continue;
        const data = await res.json().catch(() => null);
        if (this._applySglangLoad(data)) return;
      } catch {
        /* try next */
      }
    }
  }

  /**
   * Apply SGLang /v1/loads or /get_load. Returns true when a row was applied.
   * @param {unknown} payload
   * @returns {boolean}
   */
  _applySglangLoad(payload) {
    const rows = LlmProbe._sglangLoadRows(payload);
    if (!rows.length) return false;
    let running = 0;
    let waiting = 0;
    let saw = false;
    let loadGen = null;
    for (const row of rows) {
      const gen = Number(row.gen_throughput);
      if (Number.isFinite(gen) && gen >= 0) {
        loadGen = loadGen == null ? gen : Math.max(loadGen, gen);
      }
      const wait = Number(row.num_waiting_reqs);
      const runDirect = Number(row.num_running_reqs);
      const total = Number(row.num_reqs);
      if (Number.isFinite(wait) && wait >= 0) {
        waiting += wait;
        saw = true;
      }
      if (Number.isFinite(runDirect) && runDirect >= 0) {
        running += runDirect;
        saw = true;
      } else if (Number.isFinite(total) && total >= 0) {
        const waitPart = Number.isFinite(wait) && wait >= 0 ? wait : 0;
        running += Math.max(0, total - waitPart);
        saw = true;
      }
    }
    if (!saw) return false;
    this._sglangLoadGenTps = loadGen;
    this.requestsRunning = running;
    this.requestsWaiting = waiting;
    this.slotsActive = Math.round(running);
    return true;
  }

  /**
   * @param {unknown} payload
   * @returns {Array<Record<string, unknown>>}
   */
  static _sglangLoadRows(payload) {
    if (payload == null) return [];
    if (Array.isArray(payload)) {
      return payload.filter((row) => row && typeof row === "object");
    }
    if (typeof payload !== "object") return [];
    if (Array.isArray(payload.loads)) {
      return payload.loads.filter((row) => row && typeof row === "object");
    }
    if (payload.num_reqs != null || payload.num_running_reqs != null) {
      return [payload];
    }
    return [];
  }

  /**
   * Map SGLang's sticky last_gen_throughput gauge to a live panel rate.
   * Returns 0 until the value changes between polls (avoids showing a stale
   * leftover after idle); stays live for a short window after each change.
   * When `inflight` is true (independent load signal), keep a positive rate
   * even if the gauge is not moving — a busy decode can report a constant value.
   * @param {number | null} raw
   * @param {boolean} [inflight]
   * @returns {number}
   */
  _sglangStickyThroughput(raw, inflight = false) {
    if (raw == null || !Number.isFinite(raw) || raw < 0) {
      this._sglangStickyTps = null;
      return 0;
    }
    const rounded = Math.round(raw * 100) / 100;
    const now = Date.now();
    const prev = this._sglangStickyTps;

    if (!prev) {
      // First sample after reset/start — seed only unless load says we are busy
      this._sglangStickyTps = {
        value: rounded,
        liveUntil: inflight && rounded > 0 ? now + SGLANG_STICKY_TPS_LIVE_MS : 0,
      };
      return inflight && rounded > 0 ? rounded : 0;
    }

    if (rounded !== prev.value) {
      this._sglangStickyTps = {
        value: rounded,
        liveUntil: now + SGLANG_STICKY_TPS_LIVE_MS,
      };
      return rounded;
    }

    if (prev.liveUntil > now) {
      return rounded;
    }
    if (inflight && rounded > 0) {
      return rounded;
    }
    return 0;
  }

  /**
   * @param {unknown} v
   * @returns {number | null}
   */
  static _positiveNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /**
   * Max last_gen_throughput across internal_states (or top-level).
   * @param {Record<string, unknown>} sgData
   * @returns {number | null}
   */
  static _sglangLastGenThroughput(sgData) {
    if (!sgData || typeof sgData !== "object") return null;
    const top = Number(sgData.last_gen_throughput);
    if (Number.isFinite(top) && top >= 0) return top;

    const states = sgData.internal_states;
    if (!Array.isArray(states) || !states.length) return null;
    let best = null;
    for (const st of states) {
      if (!st || typeof st !== "object") continue;
      const v = Number(st.last_gen_throughput);
      if (!Number.isFinite(v) || v < 0) continue;
      if (best == null || v > best) best = v;
    }
    return best;
  }

  /**
   * Live decode tok/s. Current SGLang builds publish gen_throughput while a
   * request runs, and only then add the whole completion to
   * generation_tokens_total. Differencing that counter stays at 0 for the
   * whole decode and spikes once when the request ends.
   * Max, not sum: tensor-parallel ranks repeat the same gauge.
   * @param {string} txt
   * @returns {number | null}
   */
  _sglangGenGauge(txt) {
    const prom =
      this._getPromMetricMax(txt, "sglang:gen_throughput") ??
      this._getPromMetricMax(txt, "sglang_gen_throughput");
    if (prom != null) return prom;
    return this._sglangLoadGenTps;
  }

  /**
   * Cumulative prefill tokens that actually did compute (cache misses).
   * Prefers the per-mode counters; falls back to prompt − cached when only the
   * plain prompt counter exists. Kept separate from prompt_tokens_total, which
   * also counts cache-served tokens (the bulk of a warm session).
   * @param {string} txt
   * @returns {number | null}
   */
  _sglangPrefillComputeTokens(txt) {
    const direct =
      this._getPromMetricLabeled(txt, "sglang:realtime_tokens_total", "mode", "prefill_compute") ??
      this._getPromMetricLabeled(txt, "sglang_realtime_tokens_total", "mode", "prefill_compute") ??
      this._getPromMetricLabeled(txt, "sglang:prefill_effective_tokens_total", "mode", "input") ??
      this._getPromMetricLabeled(txt, "sglang_prefill_effective_tokens_total", "mode", "input");
    if (direct != null) return direct;
    const prompt =
      this._getPromMetric(txt, "sglang:prompt_tokens_total") ??
      this._getPromMetric(txt, "sglang_prompt_tokens_total");
    const cached = this._sglangCachedTokens(txt);
    if (prompt != null && cached != null) return Math.max(0, prompt - cached);
    return null;
  }

  /**
   * Apply SGLang Prometheus /metrics (--enable-metrics).
   * Supports both `sglang:` and `sglang_` prefixes.
   * @param {string} txt
   * @param {number} dtSec
   */
  _applySglangMetrics(txt, dtSec) {
    this._clearKvPool();
    const gen =
      this._getPromMetric(txt, "sglang:generation_tokens_total") ??
      this._getPromMetric(txt, "sglang_generation_tokens_total");
    const prompt =
      this._getPromMetric(txt, "sglang:prompt_tokens_total") ??
      this._getPromMetric(txt, "sglang_prompt_tokens_total");
    const running =
      this._getPromMetric(txt, "sglang:num_running_reqs") ??
      this._getPromMetric(txt, "sglang_num_running_reqs");
    if (running != null) {
      this.requestsRunning = running;
      this.slotsActive = Math.round(running);
    }
    if (gen == null) {
      const gauge = this._sglangGenGauge(txt);
      if (gauge != null) {
        this.generationTps = Math.max(0, Math.round(gauge * 100) / 100);
      }
      return;
    }

    // Prefill accounting: the tile counts every prompt token taken in this
    // window — cache-served + computed — and the split rows below break it
    // down. The per-mode counters are exact; prompt_tokens_total alone cannot
    // tell the two apart (it also folds in host/storage hits), so it is the
    // fallback for builds without the realtime series.
    const prefillCompute = this._sglangPrefillComputeTokens(txt);
    const cached = this._sglangCachedTokens(txt);

    // Difference only against our own baseline; after a server-info hand-off
    // the first sample seeds instead of reporting the gap between two series.
    const ownsBaseline = this._sglangTokenSource !== "server_info";
    const canDiff = ownsBaseline && dtSec > 0 && dtSec < 10;
    if (canDiff) {
      const deltaOut = gen - this.lastTokenCounts.output;
      const gauge = this._sglangGenGauge(txt);
      const busy = (running != null && running > 0) || this._sglangInflight();
      if (gauge != null && busy) {
        this.generationTps = Math.max(0, Math.round(gauge * 100) / 100);
      } else if (gauge != null) {
        // Idle, or the completion just landed in the counter. The gauge already
        // carried the live rate; the counter jump is not another tok/s sample.
        this.generationTps = 0;
      } else {
        this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
      }
      if (prefillCompute == null && prompt != null) {
        // No per-mode counters: the prompt counter is the only total we have.
        const deltaIn = prompt - this.lastTokenCounts.input;
        this.prefillTps = Math.max(0, Math.round((deltaIn / dtSec) * 100) / 100);
      } else if (prefillCompute == null && deltaOut <= 0) {
        this.prefillTps = 0;
      }
    }
    // Seed outside the rate window too: on the first poll after a restart the
    // window is unusable, and a stale 0 baseline would turn the engine's
    // lifetime prompt counter into a rate on the next poll (#99).
    this.lastTokenCounts.output = gen;
    if (prompt != null) this.lastTokenCounts.input = prompt;
    this._sglangTokenSource = "prometheus";
    this.totalOutputTokens = gen;
    this.totalPromptTokens = prompt ?? null;
    // Cached share from the same exposition (device layer preferred).
    const cachedNow = this._sglangCachedTokens(txt);
    if (cachedNow != null) this.totalCachedTokens = cachedNow;

    // The tile reads cache-served + computed; the split rows below show the
    // two parts. Poll-window rates, not latches: a window that prefilled
    // nothing reads 0 even while unrelated requests are still decoding
    // (holding the last value here kept a stale number on screen for hours).
    if (prefillCompute != null && cached != null) {
      this._setPrefillSplitRates(cached, prefillCompute, dtSec);
      if (
        canDiff &&
        this.uncachedPrefillTps != null &&
        this.cachedPrefillTps != null
      ) {
        const total = this.uncachedPrefillTps + this.cachedPrefillTps;
        this.prefillTps = Math.max(0, Math.round(total * 100) / 100);
      }
    }
  }

  /**
   * Cache split only — does not touch generation/prefill lastTokenCounts.
   * Prefers cache_source="device" so HiCache L1/L2/L3 labels are not summed.
   */
  _applySglangPrefillSplit(txt, dtSec) {
    const compute = this._sglangPrefillComputeTokens(txt);
    const cached = this._sglangCachedTokens(txt);
    if (cached != null) this.totalCachedTokens = cached;
    if (compute != null && cached != null) {
      this._setPrefillSplitRates(cached, compute, dtSec);
    }
  }

  _sglangCachedTokens(txt) {
    return (
      this._getPromMetricLabeled(txt, "sglang:realtime_tokens_total", "mode", "prefill_cache") ??
      this._getPromMetricLabeled(txt, "sglang_realtime_tokens_total", "mode", "prefill_cache") ??
      this._getPromMetricLabeled(txt, "sglang:cached_tokens_total", "cache_source", "device") ??
      this._getPromMetricLabeled(txt, "sglang_cached_tokens_total", "cache_source", "device") ??
      this._getPromMetricMax(txt, "sglang:cached_tokens_total") ??
      this._getPromMetricMax(txt, "sglang_cached_tokens_total")
    );
  }

  /** Prefer SGLang /model_info (or deprecated /get_model_info) over raw HF cache paths. */
  async _enrichSglangModelInfo() {
    for (const path of SGLANG_MODEL_INFO_PATHS) {
      try {
        const res = await this._fetch(`${this.baseUrl}${path}`);
        if (!res.ok) continue;
        const data = await res.json();
        const raw = data?.model_path || data?.tokenizer_path;
        if (!raw) continue;
        applyModelRef(this, raw);
        return;
      } catch {
        /* try next */
      }
    }
  }

  // ─── llama.cpp native path ────────────────────────────────
  async _probeLlamaCpp() {
    this._clearEngineMemory();
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
          let promptedSum = 0;
          let cachedSum = 0;
          let sawCache = false;

          for (const slot of slots) {
            const slotId = slot.id ?? "default";
            const decoded = this._getSlotDecoded(slot);
            const prompted = this._getSlotPrefilled(slot);
            const cached = this._getSlotCached(slot);
            totalDecoded += decoded;
            promptedSum += prompted;
            if (cached != null) {
              sawCache = true;
              cachedSum += cached;
            }
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
          this.totalPromptTokens = promptedSum;
          if (sawCache) this.totalCachedTokens = cachedSum;
          this.generationTps = Math.max(0, Math.round(totalGen * 100) / 100);
          this._setPrefillTps(totalPrefill, totalGen > 0);
          if (sawCache) this._setPrefillSplitRates(cachedSum, promptedSum, dtSec);
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
        const raw = props.model_alias || props.model_path || this.modelId;
        if (props.model_path && !isHfHubCachePath(props.model_path)) {
          this.modelPath = props.model_path;
        } else if (isHfHubCachePath(props.model_path) || isHfHubCachePath(props.model_alias)) {
          this.modelPath = null;
        }
        if (raw) this.modelId = normalizeModelId(raw);
        this.contextLength = props.total_context_length || props.context_length || this.contextLength;
      }
    } catch {}

    this.backendType = "llama.cpp";
    return this._getSnapshot();
  }

  // ─── Metrics helpers ─────────────────────────────────────
  /**
   * Sum all Prometheus series matching `name` (optional labels).
   * @param {string} body
   * @param {string} name Full metric name, e.g. "ds4_decode_tok_s" or "vllm:prompt_tokens_total"
   * @returns {number | null}
   */
  _getPromMetric(body, name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${esc}(?:\\{[^}]*\\})?\\s+([\\d.eE+-]+)\\s*$`, "gm");
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
    return found ? sum : null;
  }

  /**
   * Max of Prometheus series matching `name` (avoids summing HiCache layers).
   * @param {string} body
   * @param {string} name
   * @returns {number | null}
   */
  _getPromMetricMax(body, name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${esc}(?:\\{[^}]*\\})?\\s+([\\d.eE+-]+)\\s*$`, "gm");
    let best = null;
    let m;
    while ((m = re.exec(body)) !== null) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v)) best = best == null ? v : Math.max(best, v);
    }
    return best;
  }

  /**
   * Sum series of `name` whose label `labelKey` equals `labelValue`.
   * @param {string} body
   * @param {string} name
   * @param {string} labelKey
   * @param {string} labelValue
   * @returns {number | null}
   */
  _getPromMetricLabeled(body, name, labelKey, labelValue) {
    const escName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escKey = labelKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escVal = labelValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `^${escName}\\{[^}]*\\b${escKey}="${escVal}"[^}]*\\}\\s+([\\d.eE+-]+)\\s*$`,
      "gm"
    );
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
    return found ? sum : null;
  }

  _getVllmMetric(body, name) {
    return this._getPromMetric(body, `vllm:${name}`);
  }

  /**
   * Sum a numeric Prometheus label across every series of `name`.
   * vLLM publishes the KV pool on the info series `vllm:cache_config_info`
   * (value is always 1; `kv_cache_size_tokens` / `kv_cache_memory_bytes` are labels).
   * @param {string} body
   * @param {string} name
   * @param {string} label
   * @returns {number | null}
   */
  _sumPromLabel(body, name, label) {
    const escName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${escName}\\{([^}]*)\\}\\s+[\\d.eE+-]+\\s*$`, "gm");
    const labelRe = new RegExp(`(?:^|,)\\s*${escLabel}="([^"]*)"`);
    let sum = 0;
    let found = false;
    let m;
    while ((m = re.exec(body)) !== null) {
      const lm = labelRe.exec(m[1]);
      if (!lm) continue;
      const v = Number(lm[1]);
      if (Number.isFinite(v) && v > 0) {
        sum += v;
        found = true;
      }
    }
    return found ? sum : null;
  }

  /** Drop every engine memory figure: the KV pool and the weights/KV GB split. */
  _clearEngineMemory() {
    this._clearKvPool();
    this.kvCacheGb = null;
    this.weightsGb = null;
  }

  /** Drop a previously observed KV pool (other backends do not expose one). */
  _clearKvPool() {
    this.kvCacheTokens = null;
    this.kvCacheTokensAvailable = null;
    this.kvCacheMemoryBytes = null;
  }

  /**
   * vLLM KV-cache pool from `cache_config_info` plus the usage gauge.
   * Free tokens = pool × (1 − usage). Usage is clamped to 0–1 so a
   * multi-engine sum cannot drive the free count negative.
   * @param {string} txt
   */
  _applyVllmKvPool(txt) {
    const tokens = this._sumPromLabel(txt, "vllm:cache_config_info", "kv_cache_size_tokens");
    const bytes = this._sumPromLabel(txt, "vllm:cache_config_info", "kv_cache_memory_bytes");
    this.kvCacheTokens = tokens;
    this.kvCacheMemoryBytes = bytes;
    if (tokens != null && this.kvCacheUsage != null && Number.isFinite(this.kvCacheUsage)) {
      const used = Math.min(1, Math.max(0, this.kvCacheUsage));
      this.kvCacheTokensAvailable = Math.max(0, Math.round(tokens * (1 - used)));
    } else {
      this.kvCacheTokensAvailable = null;
    }
  }

  /**
   * Parse a Prometheus histogram from /metrics text.
   * Returns { buckets: [{upper, count}], total } with cumulative counts per
   * `le`, summed across label sets. `total` is the summed `_count` series
   * (or null). `countMetricName` is the full metric name (with prefix).
   */
  _parseHistogram(body, metricPrefix, countMetricName) {
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
    const total = this._getPromMetric(body, countMetricName);
    // Prometheus invariant: +Inf bucket count == _count. Mismatch → refuse quantile.
    if (total != null && infCount > 0 && Math.abs(infCount - total) > 1e-6) {
      return { buckets: [], total: null };
    }
    const buckets = Array.from(byUpper, ([upper, count]) => ({ upper, count }));
    buckets.sort((a, b) => a.upper - b.upper);
    return { buckets, total };
  }

  /**
   * Parse a vLLM Prometheus histogram from /metrics text (vllm: prefix).
   */
  _parseVllmHistogram(body, metricPrefix) {
    const name = metricPrefix.replace(/^vllm:/, "");
    return this._parseHistogram(body, metricPrefix, `vllm:${name}_count`);
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
    if (slot?.n_prompt_tokens_processed != null) {
      const n = Number(slot.n_prompt_tokens_processed);
      if (Number.isFinite(n)) return n;
    }
    return slot?.n_prompt_tokens || 0;
  }

  /** Cached prompt tokens on a llama.cpp slot, or null when the field is absent. */
  _getSlotCached(slot) {
    if (slot == null || slot.n_prompt_tokens_cache == null) return null;
    const n = Number(slot.n_prompt_tokens_cache);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Observational exposure hint from probe target + unauthenticated reachability.
   * Does not claim process bind address (0.0.0.0 vs interface).
   */
  _buildPosture() {
    if (this.authOpen == null) return null;

    const host = llmProbeHost(this.spark);
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
      via: this._tunnel ? "ssh-tunnel" : "direct",
      backend: this.backendType,
      modelId: this.models.length > 1 ? this.models[0] : this.modelId || null,
      modelPath: this.modelPath || null,
      models: metricsLive ? [...this.models] : [],
      // Native enrichment may set a context limit; routers have no shared limit.
      contextLength: this.models.length > 1 ? null : this.contextLength,
      gpuMemoryUtilization: this.gpuMemoryUtilization,
      slotsActive: this.slotsActive,
      slotsTotal: this.slotsTotal,
      generationTps: this.generationTps,
      prefillTps: this.prefillTps,
      prefillActive: this.prefillActive === true,
      cachedPrefillTps: this.cachedPrefillTps,
      uncachedPrefillTps: this.uncachedPrefillTps,
      totalOutputTokens: this.totalOutputTokens,
      totalPromptTokens: this.totalPromptTokens ?? null,
      totalCachedTokens: this.totalCachedTokens ?? null,
      kvCacheUsage: this.kvCacheUsage,
      kvCacheTokens: this.kvCacheTokens,
      kvCacheTokensAvailable: this.kvCacheTokensAvailable,
      kvCacheMemoryBytes: this.kvCacheMemoryBytes,
      kvCacheGb: this.kvCacheGb,
      weightsGb: this.weightsGb,
      requestsRunning: this.requestsRunning,
      requestsWaiting: this.requestsWaiting,
      ttftP95Seconds: this.ttftP95Seconds,
      ttftSeconds: this.ttftSeconds,
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
      models: [],
      contextLength: null,
      gpuMemoryUtilization: null,
      slotsActive: 0,
      slotsTotal: 0,
      generationTps: 0,
      prefillTps: 0,
      prefillActive: false,
      cachedPrefillTps: null,
      uncachedPrefillTps: null,
      totalOutputTokens: 0,
      totalCachedTokens: null,
      kvCacheUsage: null,
      kvCacheTokens: null,
      kvCacheTokensAvailable: null,
      kvCacheMemoryBytes: null,
      kvCacheGb: null,
      weightsGb: null,
      requestsRunning: null,
      requestsWaiting: null,
      ttftP95Seconds: null,
      ttftSeconds: null,
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
