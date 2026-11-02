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
const TELEMETRY_STALE_MS = 30_000;
const ACTIVE_MODEL_STATUSES = new Set(["active", "loaded", "ready", "running", "serving"]);
const INACTIVE_MODEL_STATUSES = new Set([
  "idle",
  "loading",
  "starting",
  "stopped",
  "stopping",
  "unloaded",
  "exited",
]);
const LMSTUDIO_MODELS_PATH = "/api/v0/models";
const LMSTUDIO_PROBE_TIMEOUT_MS = 8000;
const OLLAMA_TAGS_PATH = "/api/tags";
/**
 * Fields a genuine SGLang /server_info|/get_server_info payload carries. Some
 * servers (LM Studio) answer 200 with a JSON body on EVERY path, so "is it an
 * object" is not enough to classify — require SGLang-shaped fields.
 */
const SGLANG_INFO_FIELDS = [
  "context_length",
  "max_total_tokens",
  "max_req_input_len",
  "max_total_num_tokens",
  "max_running_requests",
  "total_input_tokens",
  "total_output_tokens",
  "total_cached_tokens",
  "model_path",
  "tokenizer_path",
  "load_format",
];
/**
 * SGLang's last_gen_throughput is a sticky gauge (holds last decode rate when
 * idle). Only treat it as live after we observe a change between polls, and
 * expire back to 0 if it stops changing.
 */
const SGLANG_STICKY_TPS_LIVE_MS = 6_000;
/** Back-off after an oMLX admin login or activity read fails. */
const OMLX_ADMIN_RETRY_MS = 60_000;

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
  const nextId = normalizeModelId(s);
  if (probe.modelId && nextId && probe.modelId !== nextId) probe._resetRateBaselines();
  probe.modelId = nextId;
  probe.modelPath = isHfHubCachePath(s) ? null : s;
}

function modelStatusValue(model) {
  if (!model || typeof model !== "object") return null;
  let value = model.status ?? model.state ?? model.model_status;
  if (value && typeof value === "object") value = value.value;
  if (typeof value === "string") return value.trim().toLowerCase() || null;
  if (model.active === true || model.loaded === true || model.ready === true) return "active";
  if (model.loaded === false || model.active === false) return "unloaded";
  return null;
}

/**
 * Select the one model that the telemetry source says is resident/usable.
 * A single unqualified model is the normal OpenAI-compatible server shape;
 * multiple unqualified router entries are intentionally ambiguous.
 * @param {unknown} entries
 * @returns {{ model: Record<string, unknown> | null, modelId: string | null, models: string[], reason: string | null }}
 */
export function selectActiveModel(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  const valid = rows.filter(
    (row) => row && typeof row === "object" && typeof row.id === "string" && row.id.trim().length > 0
  );
  // The served list is exactly what the catalog said — not normalized, not
  // trimmed — so a router's real request values are never invented or hidden.
  const catalog = [];
  const seen = new Set();
  for (const row of valid) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      catalog.push(row.id);
    }
  }
  if (!valid.length) {
    return { model: null, modelId: null, models: catalog, reason: "no_active_model" };
  }
  const active = valid.filter((row) => ACTIVE_MODEL_STATUSES.has(modelStatusValue(row)));
  if (active.length > 1) {
    return { model: null, modelId: null, models: catalog, reason: "ambiguous_model" };
  }
  if (active.length === 1) {
    return {
      model: active[0],
      modelId: normalizeModelId(active[0].id),
      models: catalog,
      reason: null,
    };
  }
  if (valid.length === 1 && modelStatusValue(valid[0]) == null) {
    return {
      model: valid[0],
      modelId: normalizeModelId(valid[0].id),
      models: catalog,
      reason: null,
    };
  }
  if (valid.every((row) => INACTIVE_MODEL_STATUSES.has(modelStatusValue(row)))) {
    return { model: null, modelId: null, models: catalog, reason: "no_active_model" };
  }
  return { model: null, modelId: null, models: catalog, reason: "ambiguous_model" };
}

/** Parse the small label grammar used by Prometheus exposition. */
function parsePromLabels(raw) {
  const labels = {};
  if (typeof raw !== "string") return labels;
  // Keep the alternatives disjoint: a backslash is either an escape prefix
  // or a non-escape character, never both. This prevents malformed labels
  // from causing catastrophic backtracking on the Node event loop.
  const re = /([A-Za-z_][A-Za-z0-9_]*)="((?:\\.|[^"\\])*)"/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    labels[match[1]] = match[2].replace(/\\([\\"nrt])/g, (_all, escaped) => {
      if (escaped === "n") return "\n";
      if (escaped === "r") return "\r";
      if (escaped === "t") return "\t";
      return escaped;
    });
  }
  return labels;
}

function promLabelValue(raw, key) {
  return parsePromLabels(raw)[key] ?? null;
}

export class LlmProbe {
  constructor(spark, port = 8888, options = {}) {
    this.spark = spark;
    this.port = Number.isInteger(Number(port)) ? Number(port) : 8888;
    const configuredTelemetryPort = Number(options?.telemetryPort);
    this.telemetryPort =
      Number.isInteger(configuredTelemetryPort) && configuredTelemetryPort >= 1 && configuredTelemetryPort <= 65535
        ? configuredTelemetryPort
        : this.port;
    this.telemetrySource = this.telemetryPort === this.port ? "direct" : "relay";
    /** The unit's own telemetry address; baseUrl switches to a local forward when only SSH reaches the engine. */
    this._directBase = `http://${llmProbeHost(spark)}:${this.telemetryPort}`;
    this.baseUrl = this._directBase;
    /** @type {{ port: number, close: () => void } | null} */
    this._tunnel = null;
    this._tunnelRetryAt = 0;
    this._tunnelBackoffMs = TUNNEL_RETRY_MIN_MS;
    this._tunnelOpening = false;
    /** Replaceable in tests. */
    this._openTunnel = openSshLlmTunnel;

    // State
    this.backendType = null; // 'vllm' | 'mlx-serve' | 'llama.cpp' | 'sglang' | 'lmstudio' | 'ollama' | 'ds4' | 'exl3' | 'q27' | 'tensorfold' | 'freetoken' | 'radiance' | 'strata' | 'flare' | 'omlx' | null
    /** oMLX admin session cookie, the time before which login is not retried, and the last per-request decode sample. */
    this._omlxAdminCookie = null;
    this._omlxAdminRetryAt = 0;
    this._omlxPrevGen = new Map();
    /** Native identity survives unavailable observations; rates must re-seed. */
    this._mlxServeDetected = false;
    /** Last native mlx-serve observation, never a sum of completed + live prefill. */
    this._mlxServeLive = null;
    this.serverIsOpenAI = null; // true = OpenAI-compatible
    /** Whether /v1/models (or /slots) answered without credentials. null = unknown. */
    this.authOpen = null;
    this.stepId = 0;
    this.modelId = null;
    this.modelPath = null;
    this.benchmarkModel = null;
    this.models = [];
    this.contextLength = null;
    this.gpuMemoryUtilization = null;
    this.slotsActive = 0;
    this.slotsTotal = 0;
    this.generationTps = 0;
    this.prefillTps = 0;
    this.decodeActive = false;
    this.generationTpsSource = null;
    /** Seconds the oldest running request has been open; null when idle. */
    this.inFlightSeconds = null;
    this._runningSince = null;
    /** Last per-request prefill totals, for the true prefill rate. */
    this._lastPrefillTotals = null;
    /** Live cached-prefill tok/s when the backend splits kinds (ds4 / llama.cpp / sglang). null otherwise. */
    this.cachedPrefillTps = null;
    /** Live uncached/computed prefill tok/s when split is available. null otherwise. */
    this.uncachedPrefillTps = null;
    this.error = null;
    /** Fresh telemetry state; unavailable is never rendered as idle. */
    this.status = "unavailable";
    this.statusReason = "not_observed";
    this.lastObservedAt = null;
    this.metricsAvailable = false;
    this._metricsModelMatched = false;
    this._metricsModelSeen = false;

    // Per-slot rate tracking (for llama.cpp native path)
    this.slotState = new Map();
    this.lastTokenCounts = { input: 0, output: 0 };
    /** TensorFold: first /health sample with counters seeds the baseline (lifetime total is not a rate). */
    this._tensorfoldSeeded = false;
    /** Previous TensorFold `prefill_seconds_total`. null until a sample includes it. */
    this._tensorfoldPrefillSeconds = null;
    this._tensorfoldPrevCached = null;
    this._tensorfoldLastPrefill = null;
    /** Previous TensorFold /metrics `generation_tokens_total + generation_tokens_running`. */
    this._tensorfoldPromProduced = null;
    /**
     * Average decode tok/s of ONE stream (TensorFold): 1 / mean seconds per
     * output token over the last poll window, from the server's own TPOT
     * histogram. null when the backend reports no such histogram; held (not
     * zeroed) across a window in which no request finished, because the
     * histogram only updates on completion.
     */
    this.perStreamTps = null;
    /** Previous `tensorfold:request_time_per_output_token_seconds` _count / _sum. */
    this._tensorfoldTpotCount = null;
    this._tensorfoldTpotSum = null;
    /**
     * Effective prefill tok/s of ONE request (TensorFold /metrics-only builds):
     * Δprompt_tokens_total / Δprefill-seconds over finished requests. Labeled
     * "effective" because prompt_tokens_total includes prefix-cache hits and
     * the engine exposes no cached counter on /metrics. null until a request
     * with prefill time has finished; held (not zeroed) between completions.
     */
    this.perStreamPrefillTps = null;
    /** When the last SANITY-PASSING prefill measurement was taken (hold expires after 20 s). */
    this._tensorfoldPrefillMeasuredAt = null;
    /** Previous prompt_tokens_total / prefill histogram _sum / _count for the /metrics prefill window. */
    this._tensorfoldPromptTokens = null;
    this._tensorfoldPrefillSum = null;
    this._tensorfoldPrefillCount = null;
    this.prefillActive = false;
    /** Previous prefill counters by kind; null until first labeled sample. */
    this.lastPrefillKinds = null;
    /** Previous vLLM TTFT histogram `_sum` (seconds). null until first sample. */
    this.lastTtftSum = null;
    /** Previous vLLM TTFT histogram `_count` (requests). null until first sample. */
    this.lastTtftCount = null;
    /** Previous `vllm:iteration_tokens_total_sum` (engine-step tokens). */
    this.lastIterSum = null;
    /** Previous `vllm:prompt_tokens_by_source_total{source="local_compute"}` (computed-only prefill counter). */
    this.lastPromptCompute = null;
    this.lastRadianceSteps = null;
    this.lastProbeTime = 0;
    this._rateBaselineReady = false;

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
    // Cumulative completed requests, when reported by the backend.
    this.completedRequestsTotal = null;
    this._promptCounterObserved = false;
    this._outputCounterObserved = false;
    this._completedCounterObserved = false;

    // vLLM inference metrics from /metrics (null when not vLLM / missing series)
    // Metric names follow stock vLLM Prometheus exposition (versions may differ).
    this.kvCacheUsage = null; // 0–1 fraction
    /** Engine-reported total KV cache token pool. */
    this.kvCacheCapacityTokens = null;
    /** Engine-reported theoretical max concurrency at configured model length. */
    this.kvCacheMaxConcurrency = null;
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
    /**
     * False when the engine answered but this poll's stats could not be read (an error status, or a body with no
     * counters). The rates are then unknown, not zero: history, Prometheus and the UI leave them out.
     */
    this.measurementValid = true;
    /** Why the last poll's stats were unreadable; null while they are readable. */
    this.measurementError = null;
    /** The next stats sample only re-seeds the counter baselines (set when a read failed). */
    this._seedNext = false;
    /** Locals: the last sample's per-engine counters; null until one is read. */
    this._localsBase = null;
    /** Splash: the last scrape's decode and prefill counters; null until one is read. */
    this._splashBase = null;

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
    /** Previous `sglang:realtime_tokens_total` counts by mode; null until first sample. */
    this._sglangRealtimeLast = null;
    /**
     * Counter family that seeded `lastPrefillKinds` ("realtime" | "cumulative").
     * Different families count different series, so a switch re-seeds.
     * @type {"realtime" | "cumulative" | null}
     */
    this._prefillSplitSource = null;
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
   * @param {"realtime" | "cumulative" | null} [source] Counter family; a
   *   different family re-seeds instead of differencing across two series.
   */
  _setPrefillSplitRates(cachedCount, computedCount, dtSec, source = null) {
    if (cachedCount == null || computedCount == null || !Number.isFinite(cachedCount) || !Number.isFinite(computedCount)) {
      this.cachedPrefillTps = null;
      this.uncachedPrefillTps = null;
      this.lastPrefillKinds = null;
      this._prefillSplitSource = null;
      return;
    }
    const total = cachedCount + computedCount;
    this.prefixCacheHitRate =
      total > 0 ? Math.round((cachedCount / total) * 10000) / 10000 : null;
    if (source != null && source !== this._prefillSplitSource) {
      this._prefillSplitSource = source;
      this.lastPrefillKinds = null;
    }
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
    const wasDirect = this.telemetryPort === this.port;
    const prevUrl = this._directBase;
    if (Number.isInteger(next) && next >= 1 && next <= 65535) {
      this.port = next;
      if (wasDirect) this.telemetryPort = next;
    }
    this.telemetrySource = this.telemetryPort === this.port ? "direct" : "relay";
    this._directBase = `http://${llmProbeHost(this.spark)}:${this.telemetryPort}`;
    if (this._directBase !== prevUrl) {
      this._closeTunnel();
      this._tunnelRetryAt = 0;
      this._tunnelBackoffMs = TUNNEL_RETRY_MIN_MS;
      this.baseUrl = this._directBase;
      this._mlxServeDetected = false;
      this._resetDetection();
      this._lastDetectAt = 0;
      this._consecutiveFailures = 0;
    }
  }

  /** Update the telemetry/model-discovery port while preserving request-port API keys. */
  setTelemetryPort(port) {
    const next = Number(port);
    if (!Number.isInteger(next) || next < 1 || next > 65535) return;
    const prevUrl = this._directBase;
    this.telemetryPort = next;
    this.telemetrySource = this.telemetryPort === this.port ? "direct" : "relay";
    this._directBase = `http://${llmProbeHost(this.spark)}:${this.telemetryPort}`;
    if (this._directBase !== prevUrl) {
      this._closeTunnel();
      this._tunnelRetryAt = 0;
      this._tunnelBackoffMs = TUNNEL_RETRY_MIN_MS;
      this.baseUrl = this._directBase;
      this._mlxServeDetected = false;
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
    this.measurementValid = true;
    this.measurementError = null;
    this.decodeActive = false;
    this.generationTpsSource = null;
    this.prefillActive = false;
    if (this.backendType === "strata") this._clearStrataRates();
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
      this._mlxServeDetected = false;
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
    this.metricsAvailable = false;
    this._mlxServeLive = null;
    this._metricsModelMatched = false;
    this._metricsModelSeen = false;
    this.statusReason = message || "telemetry_unavailable";
    this.status = this.lastObservedAt != null ? "stale" : "unavailable";
    this._consecutiveFailures += 1;
    if (this._consecutiveFailures >= FAIL_RESET_THRESHOLD) {
      this._resetDetection();
    }
    // Whatever the engine counted while it could not be reached must not read as one interval's rate.
    this._seedNext = true;
  }

  _resetDetection() {
    this.serverIsOpenAI = null;
    this.backendType = this._mlxServeDetected ? "mlx-serve" : null;
    this.authOpen = null;
    this.modelId = null;
    this.modelPath = null;
    this.benchmarkModel = null;
    this.models = [];
    this.generationTps = 0;
    this.prefillTps = 0;
    this.decodeActive = false;
    this.generationTpsSource = null;
    this.cachedPrefillTps = null;
    this.uncachedPrefillTps = null;
    this.status = "unavailable";
    this.statusReason = "not_observed";
    this.lastObservedAt = null;
    this.metricsAvailable = false;
    this._metricsModelMatched = false;
    this._metricsModelSeen = false;
    this.contextLength = null;
    this.gpuMemoryUtilization = null;
    this.slotsActive = 0;
    this.slotsTotal = 0;
    this.totalOutputTokens = 0;
    this.totalPromptTokens = null;
    this.totalCachedTokens = null;
    this.completedRequestsTotal = null;
    this._promptCounterObserved = false;
    this._outputCounterObserved = false;
    this._completedCounterObserved = false;
    this.kvCacheUsage = null;
    this.kvCacheCapacityTokens = null;
    this.kvCacheMaxConcurrency = null;
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
    this.measurementValid = true;
    this.measurementError = null;
    this._seedNext = false;
    this._localsBase = null;
    this._splashBase = null;
    this.slotState.clear();
    this.lastTokenCounts = { input: 0, output: 0 };
    // The counters restart from zero, so the next poll may only seed them. The
    // per-backend `dtSec < 10` guards do that when the probe clock is zero too;
    // failed polls keep advancing it, which is how lifetime totals used to be
    // reported as one interval's worth of tokens.
    this.lastProbeTime = 0;
    this._tensorfoldSeeded = false;
    this._tensorfoldPrefillSeconds = null;
    this._tensorfoldPrevCached = null;
    this._tensorfoldLastPrefill = null;
    this._tensorfoldPromProduced = null;
    this.perStreamTps = null;
    this._tensorfoldTpotCount = null;
    this._tensorfoldTpotSum = null;
    this.perStreamPrefillTps = null;
    this._tensorfoldPrefillMeasuredAt = null;
    this._tensorfoldPromptTokens = null;
    this._tensorfoldPrefillSum = null;
    this._tensorfoldPrefillCount = null;
    this.prefillActive = false;
    this.lastPrefillKinds = null;
    this._prefillSplitSource = null;
    this._mlxServeLive = null;
    this.lastTtftSum = null;
    this.lastTtftCount = null;
    this.lastIterSum = null;
    this.lastPromptCompute = null;
    this.lastRadianceSteps = null;
    this._sglangStickyTps = null;
    this._sglangLoadGenTps = null;
    this._sglangRealtimeLast = null;
    this.totalPromptTokens = null;
    this.totalOutputTokens = 0;
    this.completedRequestsTotal = null;
    this._promptCounterObserved = false;
    this._outputCounterObserved = false;
    this._completedCounterObserved = false;
    this._rateBaselineReady = false;
  }

  /** Clear all counter-delta state after a model swap or source change. */
  _resetRateBaselines() {
    this.generationTps = 0;
    this.prefillTps = 0;
    this.cachedPrefillTps = null;
    this.uncachedPrefillTps = null;
    this.inFlightSeconds = null;
    this._runningSince = null;
    this._lastPrefillTotals = null;
    this.slotState.clear();
    this.lastTokenCounts = { input: 0, output: 0 };
    this.lastPrefillKinds = null;
    this._mlxServeLive = null;
    this.lastTtftSum = null;
    this.lastIterSum = null;
    this.lastPromptCompute = null;
    this._sglangStickyTps = null;
    this.totalPromptTokens = null;
    this.totalOutputTokens = 0;
    this.completedRequestsTotal = null;
    this._promptCounterObserved = false;
    this._outputCounterObserved = false;
    this._completedCounterObserved = false;
    this._rateBaselineReady = false;
  }

  /** Apply the model catalog and select exactly one resident/usable model. */
  _acceptModelCatalog(models) {
    const selection = selectActiveModel(models);
    const rows = Array.isArray(models) ? models : [];
    // A plain multi-row catalog with no status field at all is the normal
    // shape for most OpenAI-compatible routers (and Strata's one engine
    // advertised under several alias names): serve the first entry instead
    // of refusing with "ambiguous_model". oMLX is the one backend where
    // guessing among several resident models is actively dangerous (it may
    // benchmark or display the wrong one), so it keeps the stricter block;
    // a genuine conflict — more than one row explicitly marked active — also
    // stays blocked everywhere.
    const anyStatused = rows.some((m) => m && typeof m === "object" && modelStatusValue(m) != null);
    if (
      selection.reason === "ambiguous_model" &&
      selection.models.length &&
      !anyStatused &&
      this.backendType !== "omlx"
    ) {
      const firstId = selection.models[0];
      const row = rows.find((m) => m && typeof m === "object" && m.id === firstId);
      selection.model = row || { id: firstId };
      selection.modelId = firstId;
      selection.reason = null;
    }
    const previous = this.modelId;
    this.models = selection.models;
    if (
      selection.modelId &&
      previous &&
      normalizeModelId(previous) !== normalizeModelId(selection.modelId)
    ) {
      this._resetRateBaselines();
      this.statusReason = "model_changed";
    }

    if (selection.modelId && selection.model) {
      this.modelId = selection.modelId;
      this.benchmarkModel = selection.modelId;
      this.modelPath = isHfHubCachePath(selection.model.id) ? null : String(selection.model.id);
      this.contextLength =
        selection.model.max_model_len ??
        selection.model.context_length ??
        this.contextLength;
      this.statusReason = null;
      return selection;
    }

    this.modelId = null;
    this.modelPath = selection.models.join(", ") || null;
    this.benchmarkModel = null;
    this.contextLength = null;
    this.metricsAvailable = false;
    this._metricsModelMatched = false;
    this._metricsModelSeen = false;
    this.status = selection.reason === "ambiguous_model" ? "ambiguous_model" : "unavailable";
    this.statusReason = selection.reason;
    this._resetRateBaselines();
    return selection;
  }

  /** Mark a successful fresh metrics/model observation and derive active vs idle. */
  _noteFreshTelemetry(observedAt = Date.now()) {
    this.metricsAvailable = true;
    this.lastObservedAt = observedAt;
    this._setWorkloadStatus();
  }

  _setWorkloadStatus() {
    if (!this.metricsAvailable) return;
    if (this._metricsModelSeen && this._metricsModelMatched === false) {
      this.status = "unknown";
      this.statusReason = "metric_model_mismatch";
      return;
    }
    const running =
      (this.requestsRunning != null && this.requestsRunning > 0) ||
      (this.backendType === "mlx-serve" && this.prefillActive) ||
      this.slotsActive > 0 ||
      this.generationTps > 0 ||
      this.prefillTps > 0;
    const waiting = this.requestsWaiting != null && this.requestsWaiting > 0;
    if (running || waiting) {
      this.status = "active";
      this.statusReason = null;
      return;
    }
    // A fresh metrics response is only evidence of idleness when it contains
    // an explicit zero-work signal. Counters alone (or an otherwise empty
    // metrics body) must not be rendered as a proven zero rate. These
    // backends validate their payload shape before this point (an invalid
    // one throws), so reaching here is itself the zero-work signal — unlike
    // vLLM/ds4/sglang's bare counters, which say nothing on their own.
    const selfValidatingBackend = [
      "strata",
      "freetoken",
      "locals",
      "splash",
      "flare",
      "tensorfold",
      "radiance",
    ].includes(this.backendType);
    const hasWorkloadSignal =
      selfValidatingBackend ||
      this.requestsRunning != null ||
      this.requestsWaiting != null ||
      this.slotsTotal > 0;
    if (hasWorkloadSignal && (this.requestsRunning == null || this.requestsRunning === 0) &&
        (this.requestsWaiting == null || this.requestsWaiting === 0) &&
        (this.slotsActive == null || this.slotsActive === 0)) {
      this.status = "idle";
      this.statusReason = null;
      return;
    }
    this.status = "unknown";
    this.statusReason = "workload_state_unavailable";
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
    // Strata deliberately provides llama.cpp-shaped /slots, but those slots
    // omit its live decode counters. Check the explicit fingerprint first.
    if (this.backendType == null || this.backendType === "llama.cpp" || this.backendType === "strata") {
      let otherServer = false;
      try {
        const healthRes = await this._fetch(`${this.baseUrl}/health`);
        if (healthRes.ok) {
          const health = await healthRes.json();
          if (health?.service === "strata") {
            this.serverIsOpenAI = true;
            this.backendType = "strata";
            return;
          }
          // A JSON object that is not Strata's means another server took the port.
          otherServer = health != null && typeof health === "object" && !Array.isArray(health);
        }
      } catch { /* continue with the other backend signatures */ }
      // A transient health failure must not demote a known Strata to its
      // compatibility shim. Repeated actual probe failures reset detection.
      if (this.backendType === "strata") {
        if (!otherServer) return;
        this.backendType = null;
      }
    }
    // Skip the llama.cpp /slots probe once we've positively identified an
    // OpenAI-compatible backend. vLLM / sglang / ds4-server have no /slots,
    // so re-probing it on every re-detect cycle just spams 404s in the
    // backend's access log (#15). Still probe /slots on first contact, when
    // the type is unknown, or when the backend was previously llama.cpp.
    if (
      this.backendType !== "vllm" &&
      this.backendType !== "mlx-serve" &&
      this.backendType !== "sglang" &&
      this.backendType !== "lmstudio" &&
      this.backendType !== "ollama" &&
      this.backendType !== "ds4" &&
      this.backendType !== "exl3" &&
      this.backendType !== "q27" &&
      this.backendType !== "locals" &&
      this.backendType !== "splash" &&
      this.backendType !== "tensorfold" &&
      this.backendType !== "freetoken" &&
      this.backendType !== "radiance" &&
      this.backendType !== "flare" &&
      this.backendType !== "omlx"
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
        let flareCard = false;
        if (auth === "ok") {
          try {
            const modelsData = await modelRes.json();
            const records = Array.isArray(modelsData?.data) ? modelsData.data : [];
            owned = records.find((model) => typeof model?.id === "string" && model.id.trim().length > 0)?.owned_by;
            flareCard = LlmProbe._modelsLookLikeFlare(records);
          } catch {
            /* body optional for detection */
          }
        }
        // llama-server's OpenAI card says owned_by "llamacpp"; its tok/s lives in /slots,
        // so don't let a first contact that missed /slots lock it in as vLLM.
        if (typeof owned === "string" && /^llama\.?cpp$/i.test(owned)) {
          this.serverIsOpenAI = false;
          this.backendType = "llama.cpp";
          return;
        }
        this.backendType = await this._classifyOpenAIBackend(owned, flareCard);
        return;
      }
    } catch {}

    this.serverIsOpenAI = null;
    this.backendType = this._mlxServeDetected ? "mlx-serve" : null;
  }

  /**
   * Classify an OpenAI-compatible server: LM Studio, Ollama, oMLX, ds4, SGLang,
   * EXL3, q27, TensorFold, FreeToken, Radiance, Flare, or vLLM (default).
   * @param {unknown} ownedBy
   * @param {boolean} [flareCard] `/v1/models` carried Flare's `flare` object (its
   *   `owned_by` is the generic "local", so the card shape is the signal)
   * @returns {Promise<"lmstudio" | "ollama" | "omlx" | "mlx-serve" | "ds4" | "sglang" | "exl3" | "q27" | "tensorfold" | "freetoken" | "radiance" | "flare" | "vllm">}
   */
  async _classifyOpenAIBackend(ownedBy, flareCard = false) {
    // LM Studio first: it answers 200 + JSON on every path, so the heuristic
    // probes below (notably SGLang's /server_info) would misfire on it.
    if (await this._probeIsLmStudio()) {
      this._mlxServeDetected = false;
      return "lmstudio";
    }
    // Locals (Generated-Computers/Locals) reports owned_by: "locals" and also answers Ollama's /api/tags,
    // so it has to be recognised before the Ollama probe claims it.
    if (typeof ownedBy === "string" && /^locals$/i.test(ownedBy)) return "locals";
    // mlx-serve (often behind a model switch that also answers Ollama's /api/tags)
    // has different completion/cache semantics from its vLLM compatibility names.
    if (typeof ownedBy === "string" && /^mlx-serve$/i.test(ownedBy)) {
      this._mlxServeDetected = true;
      return "mlx-serve";
    }
    const genericOwner = !ownedBy || /^(?:local|vllm)$/i.test(String(ownedBy));
    if (!genericOwner) this._mlxServeDetected = false;
    if (!this._mlxServeDetected && genericOwner) {
      // A proxy may answer Ollama tags as well: native metrics are stronger
      // evidence than that compatibility endpoint, even on first contact.
      try {
        const res = await this._fetch(`${this.baseUrl}/metrics`);
        if (res.ok && LlmProbe._metricsLookLikeMlxServe(await res.text())) {
          this._mlxServeDetected = true;
          return "mlx-serve";
        }
      } catch { /* Normal classification still handles unavailable metrics. */ }
    }
    // A known native endpoint can return a generic proxy card on redetection.
    // Keep its stronger metric fingerprint rather than accepting /api/tags.
    if (this._mlxServeDetected && genericOwner) {
      return "mlx-serve";
    }
    // Ollama second: its native /api/tags contract is unique among engines.
    if (await this._probeIsOllama()) return "ollama";
    if (flareCard) return "flare";
    if (typeof ownedBy === "string") {
      if (/^omlx$/i.test(ownedBy)) return "omlx";
      if (/ds4/i.test(ownedBy)) return "ds4";
      if (/sglang/i.test(ownedBy)) return "sglang";
      if (/exl3/i.test(ownedBy)) return "exl3";
      // q27's /v1/models reports owned_by: "q27" (signalnine/q27 engine).
      if (/q27/i.test(ownedBy)) return "q27";
      // Splash (incoai/splash) reports owned_by: "splash" and serves its own splash_* /metrics.
      if (/splash/i.test(ownedBy)) return "splash";
      // TensorFold (ashhart/TensorFold) reports owned_by: "tensorfold" on both MLX and CUDA servers.
      if (/tensorfold/i.test(ownedBy)) return "tensorfold";
      // FreeToken reports owned_by: "FreeToken".
      if (/freetoken/i.test(ownedBy)) return "freetoken";
      // Radiance (native RDNA engine) reports owned_by: "radiance" and serves vLLM-format /metrics.
      if (/radiance/i.test(ownedBy)) return "radiance";
      // Ollama's OpenAI-compat /v1/models may report its own name.
      if (/^ollama$/i.test(ownedBy)) return "ollama";
    }
    if (await this._probeIsDs4()) return "ds4";
    if (await this._probeIsSglang()) return "sglang";
    if (await this._probeIsExl3()) return "exl3";
    if (await this._probeIsQ27()) return "q27";
    if (await this._probeIsFlare()) return "flare";
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
    const sgData = await this._fetchSglangJson(SGLANG_SERVER_INFO_PATHS);
    if (sgData == null) return false;
    // Some catch-all servers (LM Studio) answer 200 + {"error": ...} on every
    // path. A real SGLang server-info payload carries SGLang-shaped fields.
    return SGLANG_INFO_FIELDS.some((f) => f in sgData);
  }

  /**
   * True when `/api/v0/models` matches LM Studio's REST contract — model
   * entries with a load `state` (plus publisher/arch/quantization metadata).
   * No other OpenAI-compatible server exposes this shape.
   */
  async _probeIsLmStudio() {
    // LM Studio is a single-threaded server on the probed machine; while it is busy
    // (generating) responses can exceed the normal probe timeout, and a miss silently
    // downgrades the backend label to "vllm", so detection gets a longer budget. One
    // attempt only: a port that hangs on this path must not stall the poll for twice that.
    try {
      const res = await this._fetch(`${this.baseUrl}${LMSTUDIO_MODELS_PATH}`, LMSTUDIO_PROBE_TIMEOUT_MS);
      if (!res.ok) return false;
      const data = await res.json().catch(() => null);
      if (!data || typeof data !== "object" || !Array.isArray(data.data) || data.data.length === 0) {
        return false;
      }
      return data.data.every((m) => m && typeof m === "object" && typeof m.id === "string" && "state" in m);
    } catch {
      return false;
    }
  }

  /**
   * True when `/api/tags` matches Ollama's native contract — a top-level
   * `models` array (even empty). No other engine serves this shape; Ollama
   * 404s unknown paths so the catch-all hazards don't apply, but without a
   * positive probe it would fall through to the "vllm" default label.
   */
  async _probeIsOllama() {
    try {
      const res = await this._fetch(`${this.baseUrl}${OLLAMA_TAGS_PATH}`);
      if (!res.ok) return false;
      const data = await res.json().catch(() => null);
      if (!data || typeof data !== "object" || !Array.isArray(data.models)) return false;
      return data.models.every((m) => m == null || typeof m === "object");
    } catch {
      return false;
    }
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

  static _metricsLookLikeMlxServe(body) {
    return /(?:^|\n)mlx_serve:(?:prefill_tokens_(?:live|total)|generation_tokens_live|prefix_cache_tokens_total|process_start_time_seconds)(?:\{|\s)/m.test(String(body || ""));
  }

  /**
   * mlx-serve's completed counters are ledgers, not live throughput. In
   * particular, live prefill disappears at the end of the prefill phase, but
   * completed prefill/cache tokens are credited only after decode completes.
   * Never replay that credit as live work. The two-second aggregate sampler
   * has no request IDs: prefill rates assume observed single-request continuity
   * with an unchanged target, and refuse resets, turnover and concurrent work.
   * Even an accepted rate is work per scrape window, not GPU execution time;
   * cancellation/replacement entirely between samples is unobservable.
   */
  _applyMlxServeMetrics(txt, dtSec) {
    const metric = (name) => {
      const value = this._getPromMetric(txt, name);
      return value != null && value >= 0 ? value : null;
    };
    const cur = {
      start: metric("mlx_serve:process_start_time_seconds"),
      gen: metric("mlx_serve:generation_tokens_live"),
      prefill: metric("mlx_serve:prefill_tokens_live"),
      expected: metric("mlx_serve:prefill_tokens_expected"),
      prefilling: metric("mlx_serve:requests_prefilling"),
      computed: metric("mlx_serve:prefill_tokens_total"),
      cached: metric("mlx_serve:prefix_cache_tokens_total"),
      prompt: metric("vllm:prompt_tokens_total"),
      output: metric("vllm:generation_tokens_total"),
      completed: metric("vllm:request_success_total"),
      cancelled: metric("vllm:request_cancelled_total"),
      failed: metric("mlx_serve:request_failed_total"),
      running: metric("vllm:num_requests_running"),
    };
    const prev = this._mlxServeLive;
    this._mlxServeLive = cur;
    this.generationTps = null;
    this.prefillTps = null;
    this.cachedPrefillTps = null;
    this.uncachedPrefillTps = null;
    this.perStreamTps = null;
    this.perStreamPrefillTps = null;
    const continuityFields = ["computed", "cached", "prompt", "output", "completed", "cancelled", "failed", "gen"];
    const continuous = prev != null && !this._seedNext && dtSec > 0 && dtSec < 10 &&
      cur.start != null && prev.start === cur.start &&
      !continuityFields.some((key) => cur[key] != null && prev[key] != null && cur[key] < prev[key]);
    this._seedNext = false;
    // A cancellation/error can remove in-flight decode tokens from the live
    // aggregate, masking work even when the overall gauge still increased.
    const losslessDecode = prev != null && ["cancelled", "failed"].every(
      (key) => cur[key] != null && prev[key] != null && cur[key] === prev[key]);
    const rate = (delta) => Math.round((delta / dtSec) * 100) / 100;
    if (continuous && losslessDecode && cur.gen != null && prev.gen != null) {
      this.generationTps = rate(cur.gen - prev.gen);
      this.generationTpsSource = "mlx_serve:generation_tokens_live";
    } else {
      this.generationTpsSource = null;
    }
    if (continuous && cur.prefill != null && prev.prefill != null) {
      const sameLedger = ["computed", "completed", "cancelled", "failed"].every(
        (key) => cur[key] != null && cur[key] === prev[key]);
      const singlePrefill = cur.running === 1 && prev.running === 1 &&
        cur.prefilling === 1 && prev.prefilling === 1 &&
        cur.expected != null && cur.expected > 0 && cur.expected === prev.expected;
      if (sameLedger && singlePrefill && cur.prefill >= prev.prefill && cur.prefill <= cur.expected) {
        this.prefillTps = rate(cur.prefill - prev.prefill);
      } else if (sameLedger && cur.prefilling === 0 && prev.prefilling === 0 &&
                 cur.prefill === 0 && prev.prefill === 0) {
        this.prefillTps = 0;
      } else if (cur.running === 0 && cur.prefilling === 0 && cur.prefill === 0) {
        // Explicit idle is a zero-work fact; completed prefill is never a rate.
        this.prefillTps = 0;
      }
    }
    this.uncachedPrefillTps = this.prefillTps;
    this.prefillActive = cur.prefilling != null && cur.prefilling > 0;
    this.decodeActive = this.generationTps != null && this.generationTps > 0;
    this.totalPromptTokens = cur.prompt;
    this.totalOutputTokens = cur.output;
    this.totalCachedTokens = cur.cached;
    this.completedRequestsTotal = cur.completed;
    this._promptCounterObserved = cur.prompt != null;
    this._outputCounterObserved = cur.output != null;
    this._completedCounterObserved = cur.completed != null;
    this.requestsRunning = cur.running;
    this.requestsWaiting = metric("vllm:num_requests_waiting");
    this.slotsActive = cur.running;
    this.slotsTotal = 0;
    if (cur.running != null && cur.running > 0) {
      if (this._runningSince == null || !continuous) this._runningSince = Date.now();
    } else {
      this._runningSince = null;
    }
    this.inFlightSeconds = this._runningSince == null
      ? null : Math.round((Date.now() - this._runningSince) / 100) / 10;
    const hits = metric("vllm:prefix_cache_hits_total");
    const queries = metric("vllm:prefix_cache_queries_total");
    // Unlike stock vLLM these count lookups/requests, never cached tokens.
    this.prefixCacheHitRate = hits != null && queries > 0 && hits <= queries
      ? Math.round((hits / queries) * 10000) / 10000 : null;
    for (const [field, name] of [
      ["ttftP95Seconds", "time_to_first_token_seconds"],
      ["e2eP95Seconds", "e2e_request_latency_seconds"],
      ["itlP95Seconds", "inter_token_latency_seconds"],
    ]) {
      const hist = this._parseVllmHistogram(txt, `vllm:${name}`);
      const value = this._histogramQuantile(hist.buckets, hist.total, 0.95);
      this[field] = value == null ? null : Math.round(value * 1000) / 1000;
    }
    const ttftSum = metric("vllm:time_to_first_token_seconds_sum");
    const ttftCount = metric("vllm:time_to_first_token_seconds_count");
    this.ttftSeconds = continuous && ttftSum != null && this.lastTtftSum != null &&
      ttftCount != null && this.lastTtftCount != null && ttftCount > this.lastTtftCount &&
      ttftSum >= this.lastTtftSum
      ? Math.round(((ttftSum - this.lastTtftSum) / (ttftCount - this.lastTtftCount)) * 1000) / 1000
      : null;
    this.lastTtftSum = ttftSum;
    this.lastTtftCount = ttftCount;
    // No native measurements support the vLLM KV/preemption/speculation tiles.
    this.kvCacheUsage = null;
    this.kvCacheCapacityTokens = null;
    this.kvCacheMaxConcurrency = null;
    this._clearEngineMemory();
    this.preemptionsTotal = null;
    this.mtpAcceptanceRate = null;
  }

  /**
   * True when a `/v1/models` list carries NVIDIA Flare's model card. Helios
   * reports `owned_by: "local"` and adds a `flare` object with its serving limits.
   * @param {unknown} records
   */
  static _modelsLookLikeFlare(records) {
    if (!Array.isArray(records)) return false;
    return records.some((m) => {
      const f = m?.flare;
      return !!f && typeof f === "object" && !Array.isArray(f) && "max_concurrency" in f && "prefill_chunk_size" in f;
    });
  }

  /** True when Prometheus /metrics exposes Flare (Helios) series. */
  async _probeIsFlare() {
    try {
      const res = await this._fetch(`${this.baseUrl}/metrics`);
      if (!res.ok) return false;
      const txt = await res.text();
      return LlmProbe._metricsLookLikeFlare(txt);
    } catch {
      return false;
    }
  }

  /** @param {string} body */
  static _metricsLookLikeFlare(body) {
    return /(?:^|\n)flare_generated_tokens_total(?:\{|\s)/m.test(String(body || ""));
  }

  /** @param {string} body */
  static _metricsLookLikeSplash(body) {
    return /(?:^|\n)splash_(?:decode_output_tokens_total|requests_submitted_total)(?:\{|\s)/m.test(
      String(body || "")
    );
  }

  // ─── OpenAI-compatible path (vLLM/sglang/ds4) ────────────
  async _probeOpenAICompatible() {
    const now = Date.now();
    const dtSec = (now - this.lastProbeTime) / 1000;
    this.lastProbeTime = now;
    this.metricsAvailable = false;
    this._metricsModelMatched = false;
    this._metricsModelSeen = false;

    // Model info from /v1/models — 401/403 means protected; other failure = down
    let modelsOk = false;
    let owned = null;
    let flareCard = false;
    let flareInfo = null;
    let servedModelId = null;
    /** oMLX /api/status body for this poll (undefined when not fetched, null when unavailable). */
    let omlxStatus;
    this.models = [];
    try {
      const modelsRes = await this._fetch(`${this.baseUrl}/v1/models`);
      const auth = this._noteAuthStatus(modelsRes.status);
      if (auth === "auth") {
        this.status = "unavailable";
        this.statusReason = "model_catalog_auth_required";
        this.models = [];
        this.modelId = null;
        this.benchmarkModel = null;
        this._mlxServeLive = null;
        return this._getSnapshot();
      }
      if (auth === "ok") {
        modelsOk = true;
        const modelsData = await modelsRes.json();
        let models = Array.isArray(modelsData?.data) ? modelsData.data : [];
        // oMLX lists every model on disk; only the loaded ones are serving.
        if (models.length > 0 && models.every((m) => /^omlx$/i.test(String(m?.owned_by ?? "")))) {
          this.backendType = "omlx";
          omlxStatus = await this._fetchOmlxStatus();
          if (omlxStatus) models = LlmProbe._omlxLoadedModels(models, omlxStatus);
        }
        flareCard = LlmProbe._modelsLookLikeFlare(models);
        const selection = this._acceptModelCatalog(models);
        if (selection.model) {
          owned = selection.model.owned_by;
          flareInfo = flareCard ? selection.model.flare : null;
        }
        if (selection.modelId) servedModelId = selection.modelId;
        if (selection.reason) return this._getSnapshot();
      }
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : "OpenAI-compatible model catalog invalid");
    }

    if (!modelsOk) {
      throw new Error("OpenAI-compatible /v1/models unreachable");
    }

    // Self-heal backend from owned_by before branching (cheap, no extra HTTP)
    if (flareCard && this.backendType !== "ds4" && this.backendType !== "omlx") {
      this.backendType = "flare";
    } else if (typeof owned === "string") {
      if (/^mlx-serve$/i.test(owned)) {
        this._mlxServeDetected = true;
        this.backendType = "mlx-serve";
      } else if (/^omlx$/i.test(owned)) this.backendType = "omlx";
      else if (/ds4/i.test(owned)) this.backendType = "ds4";
      else if (/sglang/i.test(owned) && this.backendType !== "ds4") {
        this.backendType = "sglang";
      } else if (/exl3/i.test(owned) && this.backendType !== "ds4") {
        this.backendType = "exl3";
      } else if (/tensorfold/i.test(owned) && this.backendType !== "ds4") {
        this.backendType = "tensorfold";
      } else if (/freetoken/i.test(owned) && this.backendType !== "ds4") {
        this.backendType = "freetoken";
      } else if (/radiance/i.test(owned) && this.backendType !== "ds4") {
        this.backendType = "radiance";
      }
    }

    if (this.backendType && this.backendType !== "mlx-serve" && this.backendType !== "vllm") {
      this._mlxServeDetected = false;
    }

    // oMLX (Apple Silicon MLX server): no Prometheus exposition; its JSON
    // /api/status carries request, token and cache counters.
    if (this.backendType === "omlx") {
      const st = omlxStatus === undefined ? await this._fetchOmlxStatus() : omlxStatus;
      if (st) {
        this._metricsModelMatched = true;
        this._applyOmlxStatus(st);
        const activity = (this.requestsRunning ?? 0) > 0 ? await this._fetchOmlxActivity() : null;
        if (activity) this._applyOmlxActivity(activity);
        else this._omlxPrevGen = new Map();
        this._noteFreshTelemetry(Date.now());
      } else {
        this.status = "unavailable";
        this.statusReason = "metrics_unavailable";
      }
      return this._getSnapshot();
    }

    if (this.backendType === "strata") {
      const res = await this._fetch(`${this.baseUrl}/metrics`, LLM_PROBE_TIMEOUT_MS, {
        headers: { Accept: "application/json" },
      });
      const auth = this._noteAuthStatus(res.status);
      if (auth === "auth") return this._getSnapshot();
      if (!res.ok) throw new Error("Strata /metrics unreachable");
      const data = await res.json();
      this._applyStrataMetrics(data);
      if (data.live.state === "unloaded") return this._defaultLlm();
      this._noteFreshTelemetry(now);
      return this._getSnapshot();
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
          this._noteFreshTelemetry(now);
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
          if (totalRaw == null || !Number.isFinite(Number(totalRaw))) {
            // A decode rate the server reports itself wins over the /metrics counter diff.
            const liveDecode = health?.live?.decode_tokens_per_second;
            const hasLiveDecode = liveDecode != null && Number.isFinite(Number(liveDecode));
            await this._applyTensorFoldMetrics(hasLiveDecode ? undefined : dtSec);
          } else if (this.requestsWaiting == null) {
            // A /health with token totals but no waiting count (TensorFold's Python engine) keeps
            // its queue gauge in /metrics alone: poll it queue-only, so /health stays the authority
            // for totals, rates, drafts and slots, and only the waiting gauge refreshes. A
            // `live.waiting` the server reports itself is not overwritten.
            await this._applyTensorFoldMetrics(undefined, true);
          }
          this._noteFreshTelemetry(now);
        } else {
          this._applyTensorFoldHealth(null, dtSec);
        }
      } catch {
        this._applyTensorFoldHealth(null, dtSec);
      }
      return this._getSnapshot();
    }

    // Flare (NVIDIA Helios): Prometheus counters on /metrics, limits on the model card.
    if (this.backendType === "flare") {
      this._clearEngineMemory();
      try {
        const metricsRes = await this._fetch(`${this.baseUrl}/metrics`);
        this._noteAuthStatus(metricsRes.status);
        if (metricsRes.ok) {
          this._applyFlareMetrics(await metricsRes.text(), dtSec, flareInfo);
          this._noteFreshTelemetry(now);
        } else {
          this._clearFlareRates();
        }
      } catch {
        this._clearFlareRates();
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
            this._noteFreshTelemetry(now);
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
      // Catch-all servers (LM Studio) answer 200 + {"error": …} on every path;
      // only latch sglang when the payload actually looks like SGLang.
      if (sgData && SGLANG_INFO_FIELDS.some((f) => f in sgData)) {
        this.backendType = "sglang";
        this._metricsModelMatched = true;
        // Load before last_gen_throughput so inflight can keep a steady rate live.
        await this._probeSglangLoad();
        this._applySglangServerInfo(sgData, dtSec);
        // Engine tile: Active vs Sleeping. SGLang has no live sleep gauge
        // (sleep_on_idle is a launch flag, not current state). A reachable
        // server with weights resident is Active / ready.
        if (this.gpuMemoryUtilization == null) this.gpuMemoryUtilization = 1;
        this._noteFreshTelemetry(now);
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
          this._noteFreshTelemetry(Date.now());
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

    if (this.backendType === "locals") {
      const res = await this._fetch(`${this.baseUrl}/stats`, LLM_PROBE_TIMEOUT_MS, {
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        this._applyLocalsStats(await res.json().catch(() => null), dtSec);
        this._noteFreshTelemetry(now);
      } else {
        this._markUnmeasured(`stats endpoint answered ${res.status}`);
      }
      return this._getSnapshot();
    }

    // Single /metrics fetch: ds4-server or vLLM Prometheus exposition.
    // Skip it for backends that never serve Prometheus — LM Studio answers
    // 200 + JSON on every path, and each fetch just spams its access log.
    const wantsPrometheus =
      this.backendType == null ||
      this.backendType === "vllm" ||
      this.backendType === "mlx-serve" ||
      this.backendType === "radiance" ||
      this.backendType === "ds4" ||
      this.backendType === "q27" ||
      this.backendType === "splash" ||
      this.backendType === "sglang";
    if (wantsPrometheus) {
      try {
        const metricsRes = await this._fetch(`${this.baseUrl}/metrics`);
        if (metricsRes.ok) {
          const txt = await metricsRes.text();
          if (this.backendType === "mlx-serve" || LlmProbe._metricsLookLikeMlxServe(txt)) {
            this._mlxServeDetected = true;
            this.backendType = "mlx-serve";
            this._applyMlxServeMetrics(txt, dtSec);
          } else if (
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
          } else if (
            this.backendType === "splash" ||
            LlmProbe._metricsLookLikeSplash(txt)
          ) {
            this.backendType = "splash";
            this._applySplashMetrics(txt, dtSec);
          } else {
            // Only claim vLLM when the backend is still unclassified — a
            // positively-identified backend (LM Studio, tensorfold, …) must not
            // be downgraded just because its /metrics body isn't Prometheus text
            // (LM Studio answers 200 + JSON on every path).
            if (this.backendType === "radiance") {
              // Radiance exports the vLLM series names (prompt/generation totals, TTFT histogram).
              this._applyVllmMetrics(txt, dtSec);
              this._applyRadianceLiveRates(txt);
            } else if (this.backendType == null || this.backendType === "vllm") {
              this.backendType = "vllm";
              this._applyVllmMetrics(txt, dtSec);
            }
          }
          this._noteFreshTelemetry(Date.now());
        } else if (this.backendType === "splash") {
          this._markUnmeasured(`metrics endpoint answered ${metricsRes.status}`);
        } else {
          this.status = "unavailable";
          this.statusReason = "metrics_unavailable";
          this._mlxServeLive = null;
          if (
            (this.backendType == null || this.backendType === "vllm") &&
            this.backendType !== "ds4" &&
            this.backendType !== "exl3" &&
            this.backendType !== "q27"
          ) {
            this.backendType = "vllm";
          }
        }
      } catch {
        if (this.backendType === "splash") {
          this._markUnmeasured("metrics request failed");
        } else {
          this.status = "unavailable";
          this.statusReason = "metrics_unavailable";
          this._mlxServeLive = null;
          if (
            (this.backendType == null || this.backendType === "vllm") &&
            this.backendType !== "ds4" &&
            this.backendType !== "exl3" &&
            this.backendType !== "q27"
          ) {
            this.backendType = "vllm";
          }
        }
      }
    }

    return this._getSnapshot();
  }

  /** oMLX `GET /api/status` body, or null when it is unavailable. */
  async _fetchOmlxStatus() {
    try {
      const res = await this._fetch(`${this.baseUrl}/api/status`);
      if (!res.ok) return null;
      const body = await res.json();
      return body && typeof body === "object" ? body : null;
    } catch {
      return null;
    }
  }

  /**
   * oMLX `GET /admin/api/activity` (`active_models`), or null when no API key
   * is configured or the admin API refuses it. The admin API takes a session
   * cookie from `POST /admin/api/login`, so log in once, reuse the cookie, and
   * log in again when it expires.
   */
  async _fetchOmlxActivity() {
    const apiKey = this._apiKey();
    if (!apiKey || Date.now() < this._omlxAdminRetryAt) return null;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!this._omlxAdminCookie) this._omlxAdminCookie = await this._omlxAdminLogin(apiKey);
        if (!this._omlxAdminCookie) break;
        const res = await this._fetch(`${this.baseUrl}/admin/api/activity`, {
          headers: { Cookie: this._omlxAdminCookie },
        });
        if (res.ok) {
          const body = await res.json();
          const active = body?.active_models;
          return active && typeof active === "object" ? active : null;
        }
        this._omlxAdminCookie = null;
        if (res.status !== 401 && res.status !== 403) break;
      }
    } catch {
      this._omlxAdminCookie = null;
    }
    this._omlxAdminRetryAt = Date.now() + OMLX_ADMIN_RETRY_MS;
    return null;
  }

  /** Log in to the oMLX admin API; returns the `omlx_admin_session` cookie pair or null. */
  async _omlxAdminLogin(apiKey) {
    const res = await this._fetch(`${this.baseUrl}/admin/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, remember: true }),
    });
    if (!res.ok) return null;
    const headers = res.headers;
    const setCookie =
      typeof headers?.getSetCookie === "function"
        ? headers.getSetCookie().join("; ")
        : String(headers?.get?.("set-cookie") ?? "");
    const match = /(?:^|[;,]\s*)omlx_admin_session=([^;,\s]+)/.exec(setCookie);
    return match ? `omlx_admin_session=${match[1]}` : null;
  }

  /**
   * Live rates from oMLX's admin activity feed, summed over loaded models.
   * Decode is each generating request's token delta since the previous poll
   * (its own running average on first sight); prefill is the tracker's
   * current speed for each prefilling request.
   * @param {{ models?: unknown[] }} activity
   */
  _applyOmlxActivity(activity) {
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const list = (v) => (Array.isArray(v) ? v : []);
    const prev = this._omlxPrevGen;
    const next = new Map();
    let decode = 0;
    let prefill = 0;
    for (const model of list(activity?.models)) {
      for (const req of list(model?.generating)) {
        const id = String(req?.request_id ?? "");
        const tokens = num(req?.generated_tokens);
        const elapsed = num(req?.elapsed_seconds);
        const before = id ? prev.get(id) : undefined;
        const dt = before ? elapsed - before.elapsed : 0;
        decode +=
          before && dt > 0 && tokens >= before.tokens
            ? (tokens - before.tokens) / dt
            : num(req?.tokens_per_second);
        if (id) next.set(id, { tokens, elapsed });
      }
      for (const req of list(model?.prefilling)) prefill += num(req?.speed);
    }
    this._omlxPrevGen = next;
    this.generationTps = Math.max(0, Math.round(decode * 100) / 100);
    this.prefillTps = Math.max(0, Math.round(prefill * 100) / 100);
  }

  /**
   * An explicit loaded_models list is authoritative, including an empty list.
   * Keep unloaded catalog entries discoverable without treating the configured
   * default as resident. Older status responses may omit the loaded list.
   */
  static _omlxLoadedModels(models, st) {
    if (Array.isArray(st?.loaded_models)) {
      const loaded = new Set(st.loaded_models.map(String));
      return models.map((model) => ({
        ...model,
        status: loaded.has(String(model?.id)) ? "ready" : "unloaded",
      }));
    }
    const wanted = st?.default_model ? [String(st.default_model)] : [];
    const picked = models.filter((m) => wanted.includes(String(m?.id)));
    return picked.length > 0 ? picked : models;
  }

  /**
   * Apply oMLX `GET /api/status`. oMLX bumps its token counters only when a
   * request finishes, so per-poll counter deltas are 0 mid-request and spike at
   * completion. While requests are active the live tiles therefore use oMLX's
   * own rolling `avg_generation_tps` / `avg_prefill_tps`; idle reads 0.
   * With an API key the admin activity feed then replaces those averages with
   * live per-request rates (`_applyOmlxActivity`). Counters still feed the
   * running totals.
   * @param {Record<string, unknown>} st
   */
  _applyOmlxStatus(st) {
    const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const prompt = n(st?.total_prompt_tokens);
    const decoded = n(st?.total_completion_tokens);
    const active = n(st?.active_requests);
    const waiting = n(st?.waiting_requests);
    const busy = (active ?? 0) > 0;

    const avg = (v) => Math.max(0, Math.round((n(v) ?? 0) * 100) / 100);
    this.generationTps = busy ? avg(st?.avg_generation_tps) : 0;
    this.prefillTps = busy ? avg(st?.avg_prefill_tps) : 0;
    this.cachedPrefillTps = null;
    this.uncachedPrefillTps = null;
    this.lastPrefillKinds = null;
    if (decoded != null) {
      this.totalOutputTokens = decoded;
      this._outputCounterObserved = true;
    }
    if (prompt != null) {
      this.totalPromptTokens = prompt;
      this._promptCounterObserved = true;
    }
    const efficiency = n(st?.cache_efficiency);
    if (efficiency != null) this.prefixCacheHitRate = Math.round(efficiency * 100) / 10000;

    this.requestsRunning = active;
    this.requestsWaiting = waiting;
    this.slotsActive = active != null ? Math.round(active) : 0;
    const total = n(st?.total_requests);
    this.completedRequestsTotal = total != null ? Math.max(0, total - (active ?? 0)) : null;
    this._completedCounterObserved = this.completedRequestsTotal != null;

    const used = n(st?.model_memory_used);
    const max = n(st?.model_memory_max);
    this.gpuMemoryUtilization = used != null && max ? Math.round((used / max) * 10000) / 10000 : null;

    // No oMLX equivalents for the vLLM histogram / KV tiles.
    this.kvCacheUsage = null;
    this.kvCacheCapacityTokens = null;
    this.kvCacheMaxConcurrency = null;
    this.ttftP95Seconds = null;
    this.preemptionsTotal = null;
    this.e2eP95Seconds = null;
    this.itlP95Seconds = null;
    this.mtpAcceptanceRate = null;
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
    this.generationTps = 0;
    this.prefillTps = 0;
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
      const baselineReady =
        this._rateBaselineReady ||
        this.lastTokenCounts.input !== 0 ||
        this.lastTokenCounts.output !== 0;
      const counterReset =
        (prefilled != null && prefilled < this.lastTokenCounts.input) ||
        decoded < this.lastTokenCounts.output;
      if (prefilled != null && dtSec > 0 && dtSec < 10) {
        const deltaIn = prefilled - this.lastTokenCounts.input;
        const deltaOut = decoded - this.lastTokenCounts.output;
        if (!baselineReady || counterReset) {
          this.generationTps = 0;
          this.prefillTps = 0;
        } else {
          this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
          this.prefillTps = Math.max(0, Math.round((deltaIn / dtSec) * 100) / 100);
        }
      } else if (dtSec > 0 && dtSec < 10) {
        const deltaOut = decoded - this.lastTokenCounts.output;
        this.generationTps = !baselineReady || counterReset
          ? 0
          : Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
        if (!inflight && (counterReset || deltaOut <= 0)) this.prefillTps = 0;
      }
      if (prefilled != null) this.lastTokenCounts.input = prefilled;
      this.lastTokenCounts.output = decoded;
      this._rateBaselineReady = true;
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
      this._outputCounterObserved = true;
      this._promptCounterObserved = prefilled != null;
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

    this.completedRequestsTotal =
      this._getPromMetric(txt, "ds4_requests_completed_total") ??
      this._getPromMetric(txt, "ds4_requests_completed");
    this._completedCounterObserved = this.completedRequestsTotal != null;

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
    this.kvCacheCapacityTokens = null;
    this.kvCacheMaxConcurrency = null;
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
      this._outputCounterObserved = true;
      // q27's prefill counter is computed-only; the token ledger wants the
      // full prompt (computed + cached).
      const cachedTok =
        this._getPromMetric(txt, "q27_prefill_cached_tokens_processed_total") ??
        this._getPromMetric(txt, "q27_prefill_cached_tokens_total");
      if (computed != null) {
        this.totalPromptTokens = cachedTok != null ? computed + cachedTok : computed;
        this._promptCounterObserved = true;
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
   * Apply NVIDIA Flare (Helios) Prometheus /metrics.
   *
   * Live tok/s from counter deltas so idle → 0. `flare_prefill_tokens_total`
   * counts computed prompt tokens only (prefix reuse excluded), so it is the
   * uncached side of the split; `flare_cache_reused_tokens_total` is the cached
   * side. The KV pool is reported in logical tokens. Flare has no waiting-queue
   * histograms or sleep state; the Preempts tile reads the preemption counter.
   * @param {string} txt
   * @param {number} dtSec
   * @param {Record<string, unknown> | null} [card] the model card's `flare` object
   */
  _applyFlareMetrics(txt, dtSec, card = null) {
    const generated = this._getPromMetric(txt, "flare_generated_tokens_total");
    const computed = this._getPromMetric(txt, "flare_prefill_tokens_total");
    const cached = this._getPromMetric(txt, "flare_cache_reused_tokens_total");
    if (generated != null) {
      if (dtSec > 0 && dtSec < 10) {
        const deltaOut = generated - this.lastTokenCounts.output;
        this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
        if (computed != null) {
          const deltaIn = computed - this.lastTokenCounts.input;
          this.prefillTps = Math.max(0, Math.round((deltaIn / dtSec) * 100) / 100);
        }
      }
      if (computed != null) this.lastTokenCounts.input = computed;
      this.lastTokenCounts.output = generated;
      this.totalOutputTokens = generated;
      this._outputCounterObserved = true;
      if (computed != null) {
        this.totalPromptTokens = cached != null ? computed + cached : computed;
        this._promptCounterObserved = true;
      }
      if (cached != null) this.totalCachedTokens = cached;
    }
    this._setPrefillSplitRates(cached, computed, dtSec);

    const active = this._getPromMetric(txt, "flare_active_requests");
    const freeSlots = this._getPromMetric(txt, "flare_free_request_slots");
    const cardSlots = Number(card?.max_concurrency);
    this.requestsRunning = active;
    if (active != null) this.slotsActive = Math.round(active);
    if (Number.isFinite(cardSlots) && cardSlots > 0) this.slotsTotal = Math.round(cardSlots);
    else if (active != null && freeSlots != null) this.slotsTotal = Math.round(active + freeSlots);
    this.requestsWaiting = this._getPromMetric(txt, "flare_pending_requests");
    this.preemptionsTotal = this._getPromMetric(txt, "flare_preemptions_total");

    const totalKv = this._getPromMetric(txt, "flare_total_kv_tokens");
    const freeKv = this._getPromMetric(txt, "flare_free_kv_tokens");
    if (totalKv != null && totalKv > 0 && freeKv != null) {
      const free = Math.min(totalKv, Math.max(0, freeKv));
      this.kvCacheTokens = Math.round(totalKv);
      this.kvCacheTokensAvailable = Math.round(free);
      this.kvCacheUsage = Math.round((1 - free / totalKv) * 10000) / 10000;
    } else {
      this._clearKvPool();
      this.kvCacheUsage = null;
    }
    this.ttftP95Seconds = null;
    this.ttftSeconds = null;
    this.e2eP95Seconds = null;
    this.itlP95Seconds = null;
    this.mtpAcceptanceRate = null;
    // Weights stay resident whenever the server is up (no sleep state).
    if (this.gpuMemoryUtilization == null) this.gpuMemoryUtilization = 1;
  }

  /** Drop live Flare rates after a failed `/metrics`. Totals stay. */
  _clearFlareRates() {
    this.generationTps = 0;
    this.prefillTps = 0;
    this.cachedPrefillTps = null;
    this.uncachedPrefillTps = null;
    this.lastPrefillKinds = null;
  }

  /**
   * This poll's stats could not be read although the endpoint answered: say so instead of showing zero
   * throughput. Rates read 0 for consumers that ignore the flag, the fields that need a measurement are
   * cleared, and the next good sample only re-seeds the counter baselines, so tokens generated while the
   * stats were unreadable are not read as one interval's rate.
   * @param {string} reason
   */
  _markUnmeasured(reason, { reseed = true } = {}) {
    this.measurementValid = false;
    this.measurementError = reason;
    this.generationTps = 0;
    this.prefillTps = 0;
    this.cachedPrefillTps = null;
    this.uncachedPrefillTps = null;
    this.lastPrefillKinds = null;
    this.prefixCacheHitRate = null;
    this.requestsRunning = null;
    this.requestsWaiting = null;
    this.ttftP95Seconds = null;
    this.itlP95Seconds = null;
    this.e2eP95Seconds = null;
    this.mtpAcceptanceRate = null;
    this._seedNext = reseed;
    // The endpoint answered (even if with a failing status, or a body this
    // poll could not parse into counters): the backend is reachable, so
    // "available" stays true. measurementValid/measurementError carry the
    // real signal.
    this._noteFreshTelemetry(Date.now());
  }

  /**
   * Apply Locals (Generated-Computers/Locals) `GET /stats`: JSON counters per engine.
   *
   * Live tok/s are counter deltas, so idle → 0. `tokens_out` moves with every decode step (an engine
   * without it falls back to its completion-based `completion_tokens`). Prompt tokens are counted when
   * their prefill finishes, so a long prompt reads 0 and then lands in one poll; its rate is then taken
   * over the engine's own `prefill_s`, not the poll interval, which would overstate it. `cached_tokens`
   * are prompt-cache hits.
   *
   * Counters are read strictly (a number, finite, not negative: `null` and `""` are not 0) and kept per
   * engine. A poll has no rate, and says so, when there is no earlier sample within 10 s to measure
   * against, when the set of reporting engines changed, or when a counter went backwards (the engine
   * restarted): the baselines are replaced and the next poll measures.
   * @param {Record<string, any> | null} data
   * @param {number} dtSec
   */
  _applyLocalsStats(data, dtSec) {
    const counter = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
    /** @type {Record<string, {out: number, prefill: number|null, prefillSec: number|null, prompt: number|null, cached: number|null}>} */
    const now = {};
    for (const [name, e] of Object.entries(data?.engines ?? {})) {
      if (!e || typeof e !== "object" || Array.isArray(e)) continue;
      const out = counter(e.tokens_out) ?? counter(e.completion_tokens);
      if (out == null) continue; // this engine publishes no decode counter
      now[name] = { out, prefill: counter(e.prefill_tokens), prefillSec: counter(e.prefill_s), prompt: counter(e.prompt_tokens), cached: counter(e.cached_tokens) };
    }
    const names = Object.keys(now);
    if (!names.length) {
      this._markUnmeasured("stats had no token counters");
      return;
    }
    const before = this._localsBase;
    let why = null;
    if (this._seedNext) why = "re-seeding counters after an interruption";
    else if (!before) why = "no earlier sample to measure against";
    else if (!(dtSec > 0 && dtSec < 10)) why = "no earlier sample within 10 s to measure against";
    else if (names.length !== Object.keys(before).length || names.some((n) => !before[n])) why = "the set of reporting engines changed";
    else if (names.some((n) => now[n].out < before[n].out || (now[n].prefill != null && before[n].prefill != null && now[n].prefill < before[n].prefill))) {
      why = "engine counters restarted";
    }
    this._seedNext = false;
    this._localsBase = now;
    const round2 = (v) => Math.max(0, Math.round(v * 100) / 100);
    // Engines with a batched-prefill counter, in both this sample and the last one.
    const pairs = why ? [] : names.filter((n) => now[n].prefill != null && before[n].prefill != null);
    if (why) {
      this._markUnmeasured(why, { reseed: false });
    } else {
      this.measurementValid = true;
      this.measurementError = null;
      this.generationTps = round2(names.reduce((a, n) => a + (now[n].out - before[n].out), 0) / dtSec);
      if (pairs.length) {
        const deltaIn = pairs.reduce((a, n) => a + (now[n].prefill - before[n].prefill), 0);
        const timed = pairs.every((n) => now[n].prefillSec != null && before[n].prefillSec != null);
        const deltaSec = timed ? pairs.reduce((a, n) => a + (now[n].prefillSec - before[n].prefillSec), 0) : 0;
        this.prefillTps = round2(deltaIn / (deltaIn > 0 && deltaSec > 0 ? deltaSec : dtSec));
      }
    }
    this.totalOutputTokens = names.reduce((a, n) => a + now[n].out, 0);
    this._outputCounterObserved = true;

    const total = (key, list = names) => {
      const vals = list.map((n) => now[n][key]);
      return vals.length && vals.every((v) => v != null) ? vals.reduce((a, b) => a + b, 0) : null;
    };
    const promptTotal = total("prompt");
    const cached = total("cached");
    if (promptTotal != null) {
      this.totalPromptTokens = promptTotal;
      this._promptCounterObserved = true;
    }
    if (cached != null) this.totalCachedTokens = cached;
    const batched = names.filter((n) => now[n].prefill != null);
    this._setPrefillSplitRates(total("cached", batched), total("prefill", batched), dtSec);
    if (this.uncachedPrefillTps != null) this.uncachedPrefillTps = this.prefillTps;

    this.requestsRunning = Array.isArray(data?.active) ? data.active.length : null;
    this.requestsWaiting = null; // Locals has no scheduler queue to report
  }

  /**
   * Apply Splash (incoai/splash) Prometheus /metrics.
   *
   * Live tok/s are counter deltas like the ds4/q27 paths, so idle → 0. The
   * engine's own `splash_*_tokens_per_second` gauges are lifetime averages and
   * stay non-zero when idle, so they are not used. Prefill counts the tokens
   * actually computed; prefix-cache hits are the separate reused counter.
   * @param {string} txt
   * @param {number} dtSec
   */
  _applySplashMetrics(txt, dtSec) {
    // A counter is a finite, non-negative number; a series that is absent or malformed is not 0.
    const counter = (name) => {
      const v = this._getPromMetric(txt, name);
      return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
    };
    const decoded = counter("splash_decode_output_tokens_total");
    const computed = counter("splash_prefill_input_tokens_total");
    if (decoded == null) {
      this._markUnmeasured("metrics had no splash token counters");
      return;
    }
    const before = this._splashBase;
    let why = null;
    if (this._seedNext) why = "re-seeding counters after an interruption";
    else if (!before) why = "no earlier sample to measure against";
    else if (!(dtSec > 0 && dtSec < 10)) why = "no earlier sample within 10 s to measure against";
    else if (decoded < before.out || (computed != null && before.in != null && computed < before.in)) why = "engine counters restarted";
    this._seedNext = false;
    this._splashBase = { out: decoded, in: computed };
    if (why) {
      // No rate on this poll, and it says so; the next one measures against these counters.
      this._markUnmeasured(why, { reseed: false });
    } else {
      this.measurementValid = true;
      this.measurementError = null;
      this.generationTps = Math.round(((decoded - before.out) / dtSec) * 100) / 100;
      if (computed != null && before.in != null) this.prefillTps = Math.round(((computed - before.in) / dtSec) * 100) / 100;
    }
    this.totalOutputTokens = decoded;
    this._outputCounterObserved = true;

    const reused = this._getPromMetric(txt, "splash_cache_reused_tokens_total");
    // The token ledger wants the full prompt: computed plus cache-served.
    if (computed != null) {
      this.totalPromptTokens = reused != null ? computed + reused : computed;
      this._promptCounterObserved = true;
    }
    if (reused != null) this.totalCachedTokens = reused;
    this._setPrefillSplitRates(reused, computed, dtSec);

    const prefilling = this._getPromMetric(txt, "splash_scheduler_prefilling");
    const decoding = this._getPromMetric(txt, "splash_scheduler_decoding");
    this.requestsRunning = prefilling != null || decoding != null ? (prefilling ?? 0) + (decoding ?? 0) : null;
    this.requestsWaiting = this._getPromMetric(txt, "splash_scheduler_queued");

    // p95 gauges are milliseconds in Splash's exposition.
    const ttftMs = this._getPromMetric(txt, "splash_ttft_p95_milliseconds");
    this.ttftP95Seconds = ttftMs == null ? null : Math.round(ttftMs) / 1000;
    const itlMs = this._getPromMetric(txt, "splash_itl_p95_milliseconds");
    this.itlP95Seconds = itlMs == null ? null : Math.round(itlMs) / 1000;

    const accept = this._getPromMetric(txt, "splash_draft_acceptance_ratio");
    this.mtpAcceptanceRate = accept == null ? null : Math.round(accept * 10000) / 10000;
    if (this._getPromMetric(txt, "splash_ready") === 1) this.gpuMemoryUtilization = 1;
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
    this._outputCounterObserved = true;
    if (Number.isFinite(prompt)) {
      this.totalPromptTokens = prompt;
      this._promptCounterObserved = true;
    }
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
    if (Number.isFinite(prompt) && prompt >= 0) {
      this.totalPromptTokens = prompt;
      this._promptCounterObserved = true;
    }
    if (Number.isFinite(completion) && completion >= 0) {
      this.totalOutputTokens = completion;
      this._outputCounterObserved = true;
    }

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

  _clearStrataRates() {
    this.generationTps = 0;
    this.prefillTps = 0;
    this.decodeActive = false;
    this.prefillActive = false;
    this.generationTpsSource = null;
    this.slotsActive = 0;
    this.requestsRunning = null;
    this.requestsWaiting = null;
  }

  /**
   * Strata v0.1.45 JSON /metrics. Totals advance only at completion, so never
   * difference them for live TPS. Slot states can differ from live.state,
   * which describes only the newest active request in batch mode.
   */
  _applyStrataMetrics(data) {
    this._clearStrataRates();
    const live = data?.live;
    if (!data?.engine || typeof data.engine !== "object" || Array.isArray(data.engine) ||
      !live || !["idle", "unloaded", "reading", "generating"].includes(live.state)) {
      throw new Error("Invalid Strata /metrics payload");
    }
    const nonnegative = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    const rate = (value) => Math.round(value * 100) / 100;
    // Solo mode omits slots. A malformed/missing batch list must not be
    // mistaken for solo mode and authorize a rate from the selected request.
    if ((Object.hasOwn(live, "slots") && !Array.isArray(live.slots)) ||
      (nonnegative(live.parallel) > 0 && !Array.isArray(live.slots))) {
      throw new Error("Invalid Strata slot metrics");
    }
    const slots = Array.isArray(live.slots) ? live.slots : [];
    const reading = slots.filter((s) => s?.state === "reading");
    const decoding = slots.filter((s) => s?.state === "decoding");
    const occupied = reading.length + decoding.length;
    const capacity = nonnegative(live.parallel);
    this.slotsTotal = capacity > 0 ? capacity : slots.length || 1;
    this.slotsActive = slots.length > 0 ? occupied : (live.state === "reading" || live.state === "generating" ? 1 : 0);
    this.requestsRunning = nonnegative(live.running) ?? this.slotsActive;
    // FIFO queued, engine waiting and admitting are different/overlapping
    // populations; adding them would double-count waiting requests.
    this.requestsWaiting = nonnegative(live.queued);
    if (live.state !== "unloaded") {
      this.decodeActive = decoding.length > 0 || live.state === "generating";
      this.prefillActive = reading.length > 0 || live.state === "reading";
    }

    const windowRate = nonnegative(live.tok_s);
    if (this.decodeActive && live.state === "generating" && windowRate != null) {
      this.generationTps = rate(windowRate);
      this.generationTpsSource = "window";
    } else if (this.decodeActive && decoding.length > 0 &&
      (!Object.hasOwn(live, "outside_slots") || nonnegative(live.outside_slots) === 0) &&
      decoding.every((s) => nonnegative(s.tok_s) != null)) {
      // The newest request may be reading, hiding the aggregate window rate.
      // Slot TPS is generated/(now-first_token), so label this decode mean
      // explicitly. Never publish a partial sum when any slot rate is missing.
      this.generationTps = rate(decoding.reduce((sum, s) => sum + s.tok_s, 0));
      this.generationTpsSource = "slot-mean";
    }
    // PP progress is engine-global and can survive an earlier batch request.
    // The UI labels this as the last reported mean, never aggregate prefill.
    // Oversized prompts can take Strata's solo path even with batch enabled.
    // Confirm unfinished engine progress before showing its mean while every
    // batch slot is idle; queued requests alone are not prefill evidence.
    const promptRead = nonnegative(live.prompt_read);
    const promptTotal = nonnegative(live.prompt_total);
    const outsidePrefill = nonnegative(live.outside_slots) > 0 &&
      promptRead > 0 && promptTotal > promptRead;
    if (this.prefillActive && live.state === "reading" &&
      (slots.length === 0 || reading.length > 0 || outsidePrefill)) {
      this.prefillTps = rate(nonnegative(live.prefill_tok_s_mean) ?? 0);
    }

    const totals = data.totals ?? {};
    this.totalPromptTokens = nonnegative(totals.prompt_tokens);
    this._promptCounterObserved = this.totalPromptTokens != null;
    this.totalOutputTokens = nonnegative(totals.output_tokens) ?? 0;
    this._outputCounterObserved = true;
    this.totalCachedTokens = nonnegative(totals.reused);
    this.completedRequestsTotal = nonnegative(totals.requests);
    this._completedCounterObserved = this.completedRequestsTotal != null;
    // Keep the /v1/models value when this payload carries no usable limit.
    const maxContext = nonnegative(data.engine.max_context);
    if (maxContext > 0) this.contextLength = maxContext;
    this.gpuMemoryUtilization = null;
    this.kvCacheUsage = null;
    this._clearEngineMemory();
    this.cachedPrefillTps = null;
    this.uncachedPrefillTps = null;
    this.ttftSeconds = null;
    this.ttftP95Seconds = null;
    this.e2eP95Seconds = null;
    this.itlP95Seconds = null;
    this.preemptionsTotal = null;
    this.prefixCacheHitRate = null;
    this.mtpAcceptanceRate = null;
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
    this.prefillActive = Number(health.streams?.prefilling ?? health.streams?.filling) > 0;
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
    const prevCached = this._tensorfoldPrevCached ?? null;
    this._applyExl3Health(health, dtSec);
    // TensorFold 0.5.0 (cuda/health.py) publishes cumulative cached prompt tokens
    // alongside the EXL3-style counters; older builds omit it (stays null).
    const cached = health.cached_tokens_total == null ? NaN : Number(health.cached_tokens_total);
    if (Number.isFinite(cached) && cached >= 0) this.totalCachedTokens = cached;
    this._tensorfoldPrevCached = Number.isFinite(cached) && cached >= 0 ? cached : null;
    const batch = Number(health.max_batch_size);
    if (Number.isFinite(batch) && batch > 0) this.slotsTotal = Math.round(batch);
    // CUDA health.requests_running counts open generate calls, including waiting
    // work. Prefer occupied streams over that legacy fallback; streams.max is
    // capacity, not a cap to hide a request/slot semantic mismatch.
    const streams =
      health.streams && typeof health.streams === "object" && !Array.isArray(health.streams)
        ? health.streams
        : {};
    const max = Number(streams.max);
    if (Number.isFinite(max) && max > 0) this.slotsTotal = Math.round(max);
    // null must not read as 0 busy streams (Number(null) === 0).
    const count = (v) => (v == null ? NaN : Number(v));
    const decoding = count(streams.decoding);
    // prefilling/filling describe the same lanes; never add both.
    const prefilling = count(streams.prefilling ?? streams.filling);
    const paused = count(streams.paused);
    const laneCounts = [decoding, prefilling, paused];
    const hasStreams = health.streams && typeof health.streams === "object" && !Array.isArray(health.streams);
    const running = hasStreams
      ? laneCounts.some((n) => Number.isFinite(n) && n >= 0)
        ? laneCounts.reduce((sum, n) => sum + (Number.isFinite(n) && n >= 0 ? n : 0), 0)
        : NaN
      : count(health.requests_running); // Older health shapes have no stream breakdown.
    // EXL3's busy flag is not a measurement of TensorFold's concurrency.
    this.requestsRunning = Number.isFinite(running) && running >= 0 ? Math.round(running) : null;
    this.slotsActive = this.requestsRunning;
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
    // `prompt_tokens_total` counts every prompt token, including those served from the prefix
    // cache (an agent re-sending a growing 50k-token conversation is ~95% cache hits), while
    // `prefill_seconds_total` is only the time spent computing. Dividing one by the other gave
    // 100k+ tok/s. Use computed (uncached) tokens when the build reports the cached total.
    const dCached =
      Number.isFinite(cached) && prevCached != null ? Math.max(0, cached - prevCached) : null;
    const dComputed = dCached == null ? dIn : Math.max(0, dIn - dCached);
    if (dSec > 0 && dComputed > 0) {
      // A request just finished: its average prefill rate. TensorFold publishes token and time
      // totals only for finished requests, so nothing is measurable while a long prefill runs;
      // keep the last finished rate on screen for a while instead of flashing to 0.
      this._tensorfoldLastPrefill = { tps: Math.max(0, Math.round((dComputed / dSec) * 100) / 100), at: Date.now() };
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
    if (Number.isFinite(conns) && conns >= 0 && this.requestsRunning == null) {
      this.requestsRunning = Math.round(conns);
      this.slotsActive = Math.round(conns);
    }
  }

  /**
   * TensorFold Prometheus /metrics (`tensorfold:*`): cumulative token totals (finished requests),
   * running / waiting requests and the MTP draft acceptance rate. Best effort: a miss changes nothing.
   * Builds whose /health is only `{"status": "ok"}` (tensorfold-native) report counters here alone,
   * so decode tok/s comes from this poll-window diff.
   * @param {number} [dtSec]
   * @param {boolean} [queueOnly=false] apply only the waiting gauge: for builds whose /health
   * carries the totals but no waiting count, /metrics is still the queue's only source.
   */
  async _applyTensorFoldMetrics(dtSec, queueOnly = false) {
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
    const gen = queueOnly ? null : m("generation_tokens_total");
    const prompt = queueOnly ? null : m("prompt_tokens_total");
    if (Number.isFinite(gen) && gen >= 0) {
      this.totalOutputTokens = gen;
      this._outputCounterObserved = true;
    }
    if (Number.isFinite(prompt) && prompt >= 0) {
      this.totalPromptTokens = prompt;
      this._promptCounterObserved = true;
    }
    // TensorFold publishes the prompt-cache split of finished requests, either under
    // its own name or as vLLM's prefix-cache hits. Keep it from this scrape's prompt
    // total and never let a cached count exceed the prompt it belongs to. Builds that
    // publish neither leave the previous value alone.
    const cached = queueOnly ? null : m("prompt_tokens_cached_total");
    const cachedFallback =
      queueOnly || (Number.isFinite(cached) && cached >= 0) ? null : m("prefix_cache_hits_total");
    const cachedTotal =
      Number.isFinite(cached) && cached >= 0
        ? cached
        : Number.isFinite(cachedFallback) && cachedFallback >= 0
          ? cachedFallback
          : null;
    if (cachedTotal != null) {
      this.totalCachedTokens =
        Number.isFinite(prompt) && prompt >= 0 ? Math.min(cachedTotal, prompt) : cachedTotal;
    }
    // The total moves only when a request finishes; `generation_tokens_running` counts the
    // tokens of requests still decoding. Their sum grows steadily while tokens are produced
    // (a finishing request moves its tokens from one to the other), so its diff is the live rate.
    // Prefill stays as is: prompt_tokens_total includes cached prefix tokens.
    if (Number.isFinite(gen) && gen >= 0) {
      const inFlight = m("generation_tokens_running");
      const produced = gen + (Number.isFinite(inFlight) && inFlight >= 0 ? inFlight : 0);
      const prev = this._tensorfoldPromProduced;
      this._tensorfoldPromProduced = produced;
      if (prev != null && Number.isFinite(dtSec) && dtSec > 0) {
        this.generationTps = Math.max(0, Math.round(((produced - prev) / dtSec) * 100) / 100);
      }
    }
    // One source of truth for the concurrency count. TensorFold exports both
    // `requests_running` and the vLLM-style alias `num_requests_running` with
    // identical values (verified live); read the canonical name and fall back
    // to the alias only when the canonical series is absent. Never sum them.
    let running = queueOnly ? null : m("requests_running");
    if ((!Number.isFinite(running) || running < 0) && !queueOnly) running = m("num_requests_running");
    if (Number.isFinite(running) && running >= 0) {
      this.requestsRunning = Math.round(running);
      this.slotsActive = Math.round(running);
    }
    let waiting = m("requests_waiting");
    if (!Number.isFinite(waiting) || waiting < 0) waiting = m("num_requests_waiting");
    if (Number.isFinite(waiting) && waiting >= 0) this.requestsWaiting = Math.round(waiting);

    if (!queueOnly) {
      // TensorFold exposes Prometheus histograms under the same names as its
      // vLLM-compatible aliases. A malformed/partial histogram yields null,
      // never a guessed percentile.
      const p95 = (metric) => {
        const hist = this._parseHistogram(txt, `tensorfold:${metric}`, `tensorfold:${metric}_count`);
        const { buckets, total } = hist;
        if (!Number.isFinite(total) || total <= 0 || !buckets.length) return null;
        const last = buckets[buckets.length - 1];
        if (last.upper !== Infinity || Math.abs(last.count - total) > 1e-6) return null;
        let previousCount = 0;
        let previousUpper = -Infinity;
        for (const { upper, count } of buckets) {
          if (!Number.isFinite(count) || count < previousCount || count > total ||
              upper < 0 || upper <= previousUpper || (upper !== Infinity && !Number.isFinite(upper))) return null;
          previousCount = count;
          previousUpper = upper;
        }
        const value = this._histogramQuantile(buckets, total, 0.95);
        return value == null ? null : Math.round(value * 1000) / 1000;
      };
      this.ttftP95Seconds = p95("time_to_first_token_seconds");
      this.e2eP95Seconds = p95("request_latency_seconds");
      this.itlP95Seconds = p95("request_time_per_output_token_seconds");

      const mean = (metric) => {
        const sum = this._getPromMetric(txt, `tensorfold:${metric}_sum`);
        const count = this._getPromMetric(txt, `tensorfold:${metric}_count`);
        if (!Number.isFinite(sum) || sum < 0 || !Number.isFinite(count) || count <= 0) return null;
        return Math.round((sum / count) * 1000) / 1000;
      };
      this.ttftSeconds = mean("time_to_first_token_seconds");

      const queries = m("prefix_cache_queries_total");
      const hits = m("prefix_cache_hits_total");
      this.prefixCacheHitRate =
        Number.isFinite(queries) && queries > 0 && Number.isFinite(hits)
          ? Math.max(0, Math.min(1, hits / queries))
          : null;

      const preemptions = m("preemptions_total");
      this.preemptionsTotal =
        Number.isFinite(preemptions) && preemptions >= 0 ? Math.round(preemptions) : null;
    }

    const kv = queueOnly ? null : m("kv_cache_usage_ratio");
    if (Number.isFinite(kv) && kv >= 0) this.kvCacheUsage = Math.min(1, kv);
    const drafted = queueOnly ? null : m("mtp_drafted_total");
    const accepted = queueOnly ? null : m("mtp_accepted_total");
    if (Number.isFinite(drafted) && drafted > 0 && Number.isFinite(accepted)) {
      this.mtpAcceptanceRate = Math.max(0, Math.min(1, accepted / drafted));
    }
    // Per-stream decode rate from the server's own time-per-output-token
    // histogram: 1 / mean over the tokens finished since the last poll. The
    // histogram only moves when a request finishes, so with no finished
    // request in this window the previous value is held rather than flashed
    // to 0; with no histogram at all, fall back to aggregate / active streams.
    if (!queueOnly) {
      const tpotCount = m("request_time_per_output_token_seconds_count");
      const tpotSum = m("request_time_per_output_token_seconds_sum");
      if (Number.isFinite(tpotCount) && Number.isFinite(tpotSum) && tpotCount >= 0 && tpotSum >= 0) {
        if (
          this._tensorfoldTpotCount != null &&
          this._tensorfoldTpotSum != null &&
          tpotCount >= this._tensorfoldTpotCount
        ) {
          const dCount = tpotCount - this._tensorfoldTpotCount;
          const dSum = tpotSum - this._tensorfoldTpotSum;
          if (dCount > 0 && dSum > 0) {
            this.perStreamTps = Math.max(0, Math.round((dCount / dSum) * 100) / 100);
          }
        }
        this._tensorfoldTpotCount = tpotCount;
        this._tensorfoldTpotSum = tpotSum;
      } else {
        const running = Number(this.requestsRunning);
        const gen = Number(this.generationTps);
        if (Number.isFinite(gen) && gen > 0 && Number.isFinite(running) && running > 0) {
          this.perStreamTps = Math.max(0, Math.round((gen / running) * 100) / 100);
        } else if ((Number.isFinite(running) ? running : 0) <= 0 && (!(Number.isFinite(gen)) || gen <= 0)) {
          // Truly idle with nothing ever measured: no per-stream rate to show.
          this.perStreamTps = null;
        }
      }
    }
    // Prefill on /metrics-only builds (verified on a live server): during a
    // 35-second prefill prompt_tokens_total AND every prefill histogram stay
    // frozen — they advance only in the poll where the request finishes. So no
    // mid-prefill rate exists; derive the effective per-request rate from the
    // completion window and HOLD it until the next finish, with a "prefilling"
    // indicator while a request is open and no tokens have been produced yet.
    // CAVEAT: prompt_tokens_total counts prefix-cache tokens too and this
    // surface has no cached counter — the number is an effective rate, not raw
    // GPU compute speed (the label says so).
    if (!queueOnly && Number.isFinite(dtSec) && dtSec > 0) {
      let prefillPrefix = null;
      if (m("request_prefill_seconds_count") != null) prefillPrefix = "request_prefill_seconds";
      else if (m("request_prefill_time_seconds_count") != null) prefillPrefix = "request_prefill_time_seconds";
      if (prefillPrefix && Number.isFinite(prompt) && prompt >= 0) {
        const pSum = m(`${prefillPrefix}_sum`);
        const pCount = m(`${prefillPrefix}_count`);
        if (Number.isFinite(pSum) && Number.isFinite(pCount) && pSum >= 0 && pCount >= 0) {
          const prevPrompt = this._tensorfoldPromptTokens;
          const prevSum = this._tensorfoldPrefillSum;
          const prevCount = this._tensorfoldPrefillCount;
          if (
            prevPrompt != null && prevSum != null && prevCount != null &&
            prompt >= prevPrompt && pSum >= prevSum && pCount >= prevCount
          ) {
            const dPrompt = prompt - prevPrompt;
            const dSec = pSum - prevSum;
            if (pCount > prevCount && dPrompt > 0) {
              // Sub-millisecond and tiny-prompt windows are too noisy to
              // measure reliably: require at least 50 ms and 50 tokens.
              // Effective rates include cache credit and vary by host; do not
              // cap them using one machine's cold-compute throughput.
              const rate = Math.round((dPrompt / dSec) * 100) / 100;
              if (dSec >= 0.05 && dPrompt >= 50) {
                // Window ratio = mean over the requests finished in it; the
                // aggregate is the same measurement (no per-request split here).
                this.perStreamPrefillTps = Math.max(0, rate);
                this._tensorfoldPrefillMeasuredAt = Date.now();
                // Wins over the /health zeroing that ran earlier this poll.
                this.prefillTps = this.perStreamPrefillTps;
              } else if (
                this.perStreamPrefillTps != null &&
                this._tensorfoldPrefillMeasuredAt != null &&
                Date.now() - this._tensorfoldPrefillMeasuredAt < 20_000
              ) {
                // Hold across polls (and across rejected noise windows), but
                // expire like the /health path: a stale rate must not masquerade
                // as current, and _applyExl3Health zeroes it every poll anyway.
                this.prefillTps = this.perStreamPrefillTps;
              } else {
                this.perStreamPrefillTps = null;
                this.prefillTps = 0;
              }
            } else if (
              this.perStreamPrefillTps != null &&
              this._tensorfoldPrefillMeasuredAt != null &&
              Date.now() - this._tensorfoldPrefillMeasuredAt < 20_000
            ) {
              // Hold across polls: _applyExl3Health zeroes prefillTps from the
              // counterless /health every poll, so re-state the last real rate.
              this.prefillTps = this.perStreamPrefillTps;
            } else {
              this.perStreamPrefillTps = null;
              this.prefillTps = 0;
            }
          }
          // Server restart / counter reset: re-seed, keep the held rate.
          this._tensorfoldPromptTokens = prompt;
          this._tensorfoldPrefillSum = pSum;
          this._tensorfoldPrefillCount = pCount;
        }
      }
      // The only live prefill signal this build has: a request is open and no
      // decode has been produced yet. (Queue-only waits keep running at 0.)
      const openReq = Number.isFinite(this.requestsRunning) && this.requestsRunning > 0;
      const genRunning = m("generation_tokens_running");
      if (openReq && Number.isFinite(genRunning)) {
        this.prefillActive = genRunning === 0;
      }
    }
    if (typeof txt === "string" && txt.includes("tensorfold:")) {
      this._noteFreshTelemetry(Date.now());
    }
  }

  /**
   * Radiance only advances vllm:{prompt,generation}_tokens_total when a request
   * finishes, so counter deltas read 0 during a request and then spike on the
   * poll it completes in. It also exports live engine-rate gauges; use them
   * while the matching engine-step counters advance (the gauges decay slowly
   * after the engine goes idle, so the step counters gate them).
   * Older builds without the gauges keep the counter-derived rates.
   * @param {string} txt
   */
  _applyRadianceLiveRates(txt) {
    const decodeRate = this._getPromMetric(txt, "radiance:decode_tokens_per_second");
    const prefillRate = this._getPromMetric(txt, "radiance:prefill_tokens_per_second");
    const prefillSteps = this._getPromMetric(txt, "radiance:engine_steps_prefill_total");
    const decodeSteps = this._getPromMetric(txt, "radiance:engine_steps_decode_total");
    const mixedSteps = this._getPromMetric(txt, "radiance:engine_steps_mixed_total") ?? 0;
    if (decodeRate == null || prefillRate == null || prefillSteps == null || decodeSteps == null) {
      this.lastRadianceSteps = null;
      return;
    }
    const steps = { prefill: prefillSteps + mixedSteps, decode: decodeSteps + mixedSteps };
    const last = this.lastRadianceSteps;
    this.lastRadianceSteps = steps;
    if (last == null) return;
    const round2 = (v) => Math.max(0, Math.round(v * 100) / 100);
    const prefilling = steps.prefill > last.prefill;
    this.generationTps = steps.decode > last.decode ? round2(decodeRate) : 0;
    this.prefillTps = prefilling ? round2(prefillRate) : 0;
    this.prefillActive = prefilling && (this.requestsRunning ?? 0) > 0;
  }

  /**
   * Apply stock vLLM Prometheus /metrics (tok/s + inference tiles).
   * @param {string} txt
   * @param {number} dtSec
   */
  _applyVllmMetrics(txt, dtSec) {
    this.generationTps = 0;
    this.prefillTps = 0;
    const promptTokens = this._getVllmMetric(txt, "prompt_tokens_total");
    const genTokens = this._getVllmMetric(txt, "generation_tokens_total");
    const running = this._getVllmMetric(txt, "num_requests_running");
    const iterSum = this._getVllmMetric(txt, "iteration_tokens_total_sum");
    if (promptTokens != null && genTokens != null) {
      const baselineReady =
        this._rateBaselineReady ||
        this.lastTokenCounts.input !== 0 ||
        this.lastTokenCounts.output !== 0;
      const deltaIn = promptTokens - this.lastTokenCounts.input;
      const deltaOut = genTokens - this.lastTokenCounts.output;
      const counterReset = deltaIn < 0 || deltaOut < 0;
      this.lastTokenCounts.input = promptTokens;
      this.lastTokenCounts.output = genTokens;
      this.totalPromptTokens = promptTokens;
      this.totalOutputTokens = genTokens;
      // vLLM prefix-cache counters are token-granular (queries += prompt
      // tokens/request, hits += tokens served from cache), so cached_tokens
      // is directly the cumulative cached share of the prompt.
      const cachedTok =
        this._getVllmMetric(txt, "prompt_tokens_cached_total") ??
        this._getVllmMetric(txt, "prefix_cache_hits_total");
      if (cachedTok != null) this.totalCachedTokens = cachedTok;
      // vLLM splits prompt tokens by source: local_compute is the share that
      // actually ran prefill; the rest was served from prefix/external cache.
      // prompt_tokens_total counts both, so prefill rates derived from it are
      // inflated whenever the prefix cache hits. Prefer this split when the
      // engine reports it; older builds only expose the plain cached counter.
      const srcCompute = this._getPromMetricLabeled(
        txt, "vllm:prompt_tokens_by_source_total", "source", "local_compute");
      const srcHit = this._getPromMetricLabeled(
        txt, "vllm:prompt_tokens_by_source_total", "source", "local_cache_hit");
      const srcExternal = this._getPromMetricLabeled(
        txt, "vllm:prompt_tokens_by_source_total", "source", "external_kv_transfer");
      // vLLM advances its prompt/compute counters when a request finishes, so a
      // delta over the poll window is a completion burst, not a rate. The engine
      // also publishes prefill seconds and computed tokens per finished request;
      // divide those to get the rate the prefill actually ran at.
      const prefillCount = this._getVllmMetric(txt, "request_prefill_time_seconds_count");
      const prefillTime = this._getVllmMetric(txt, "request_prefill_time_seconds_sum");
      const kvComputed = this._getVllmMetric(txt, "request_prefill_kv_computed_tokens_sum");
      const cacheServed = srcHit ?? cachedTok;
      const hasPrefillTiming =
        prefillCount != null && prefillTime != null && kvComputed != null && cacheServed != null;
      let completedPrefill = false;
      if (hasPrefillTiming) {
        const lastPrefill = this._lastPrefillTotals;
        if (lastPrefill != null && prefillCount > lastPrefill.count) {
          const dPrefillTime = prefillTime - lastPrefill.time;
          const dKvComputed = kvComputed - lastPrefill.kv;
          const dCacheServed = cacheServed - lastPrefill.cache;
          if (dPrefillTime > 0 && dKvComputed >= 0 && dCacheServed >= 0) {
            const prefillRate = Math.max(0, Math.round((dKvComputed / dPrefillTime) * 100) / 100);
            this.prefillTps = prefillRate;
            this.uncachedPrefillTps = prefillRate;
            this.cachedPrefillTps = Math.max(0, Math.round((dCacheServed / dPrefillTime) * 100) / 100);
            completedPrefill = true;
          }
        }
        this._lastPrefillTotals = {
          count: prefillCount, time: prefillTime, kv: kvComputed, cache: cacheServed,
        };
      }
      let deltaCompute = null;
      let computedCounterAvailable = srcCompute != null && srcHit != null;
      if (computedCounterAvailable) {
        if (!hasPrefillTiming) {
          this._setPrefillSplitRates(srcHit + (srcExternal ?? 0), srcCompute, dtSec, "cumulative");
        }
        deltaCompute =
          this.lastPromptCompute != null ? Math.max(0, srcCompute - this.lastPromptCompute) : 0;
        this.lastPromptCompute = srcCompute;
      } else {
        this.lastPromptCompute = null;
        // prompt_tokens_total counts prefix-cache hits too; a 97%-cached agent
        // prompt would otherwise read as 100k+ tok/s "prefill". Only the
        // computed share is real prefill work.
        const prevCached = this.lastPrefillKinds?.cached;
        computedCounterAvailable = cachedTok != null && prevCached != null;
        const deltaCached =
          cachedTok != null && prevCached != null ? Math.max(0, cachedTok - prevCached) : 0;
        deltaCompute = Math.max(0, deltaIn - deltaCached);
        if (!hasPrefillTiming) {
          this._setPrefillSplitRates(
            cachedTok,
            cachedTok != null ? Math.max(0, promptTokens - cachedTok) : null,
            dtSec
          );
        }
      }
      this._promptCounterObserved = true;
      this._outputCounterObserved = true;
      const ttftSum = this._getVllmMetric(txt, "time_to_first_token_seconds_sum");
      const deltaIter =
        iterSum != null && this.lastIterSum != null ? iterSum - this.lastIterSum : 0;
      if (dtSec > 0 && dtSec < 10) {
        this.generationTps = !baselineReady || counterReset
          ? 0
          : Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
        // All live rates share the wall-clock scrape window. Prefer the exact
        // computed-source counter; engine-step tokens provide the same work
        // count on builds without it. TTFT includes queueing and belongs only
        // in the latency tiles, never in this throughput denominator.
        if (!hasPrefillTiming) {
          const iterationReady = iterSum != null && this.lastIterSum != null && deltaIter >= 0;
          const deltaWork = computedCounterAvailable
            ? deltaCompute
            : iterationReady
              ? Math.max(0, deltaIter - Math.max(0, deltaOut))
              : deltaCompute;
          this.prefillTps = !baselineReady || counterReset
            ? 0
            : Math.max(0, Math.round((deltaWork / dtSec) * 100) / 100);
        }
      }
      // An open request that has not produced a decode token yet is in prefill;
      // the card shows "prefilling" instead of a zero rate.
      this.prefillActive =
        Number.isFinite(running) && running > 0 && deltaOut <= 0 && !completedPrefill;
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
      this._rateBaselineReady = true;
    }
    if (iterSum != null) this.lastIterSum = iterSum;

    this.requestsRunning = running;
    if (running != null) this.slotsActive = Math.round(running);
    if (Number.isFinite(running) && running > 0) {
      if (this._runningSince == null) this._runningSince = Date.now();
    } else {
      this._runningSince = null;
    }
    this.inFlightSeconds =
      this._runningSince == null
        ? null
        : Math.round((Date.now() - this._runningSince) / 100) / 10;

    if (this.gpuMemoryUtilization == null) {
      const sleepState = this._getVllmMetric(txt, "engine_sleep_state");
      if (sleepState != null) this.gpuMemoryUtilization = sleepState;
    }

    this.requestsWaiting = this._getVllmMetric(txt, "num_requests_waiting");
    // Older vLLM (V0 engine) names the same gauge gpu_cache_usage_perc.
    this.kvCacheUsage =
      this._getVllmMetric(txt, "kv_cache_usage_perc") ??
      this._getVllmMetric(txt, "gpu_cache_usage_perc");
    this.kvCacheCapacityTokens = this._getPromInfoNumber(
      txt,
      "vllm:cache_config_info",
      "kv_cache_size_tokens"
    );
    this.kvCacheMaxConcurrency = this._getPromInfoNumber(
      txt,
      "vllm:cache_config_info",
      "kv_cache_max_concurrency"
    );
    this._applyVllmKvPool(txt);
    this.preemptionsTotal = this._getVllmMetric(txt, "num_preemptions_total");
    this.completedRequestsTotal =
      this._getVllmMetric(txt, "num_requests_success_total") ??
      this._getVllmMetric(txt, "request_success_total");
    this._completedCounterObserved = this.completedRequestsTotal != null;

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
    this.kvCacheCapacityTokens = null;
    this.kvCacheMaxConcurrency = null;
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

    if (sgData.model_path && !this.modelId) {
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
        const baselineReady =
          this._rateBaselineReady ||
          this.lastTokenCounts.input !== 0 ||
          this.lastTokenCounts.output !== 0;
        const deltaIn = input - this.lastTokenCounts.input;
        const deltaOut = output - this.lastTokenCounts.output;
        const counterReset = deltaIn < 0 || deltaOut < 0;
        this.lastTokenCounts.input = input;
        this.lastTokenCounts.output = output;
        this.totalPromptTokens = input;
        this.totalOutputTokens = output;
        if (sgCached != null) this.totalCachedTokens = sgCached;
        this._sglangTotalsPolled = true;
        this._sglangTokenSource = "server_info";
        this._promptCounterObserved = true;
        this._outputCounterObserved = true;
        if (dtSec > 0 && dtSec < 10) {
          this.generationTps = !baselineReady || counterReset
            ? 0
            : Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
          this._setPrefillTps(!baselineReady || counterReset ? 0 : deltaIn / dtSec, deltaOut > 0);
        }
        this._rateBaselineReady = true;
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
   * Per-step token counters (`sglang:realtime_tokens_total{mode=...}`) on
   * recent builds. Unlike the log-interval gauges (gen_throughput,
   * num_running_reqs) they tick while the request runs, so their deltas are the
   * live decode / prefill rates, and prefill_compute vs prefill_cache is the
   * computed vs cache-served split. Max, not sum: tensor-parallel ranks repeat
   * the same counter.
   * @param {string} txt
   * @param {number} dtSec
   * @returns {{ counts: Record<string, number|null>, rates: Record<string, number|null> }}
   */
  _sglangRealtimeRates(txt, dtSec) {
    const count = (mode) =>
      this._getPromMetricMax(txt, "sglang:realtime_tokens_total", "mode", mode);
    const counts = {
      decode: count("decode"),
      prefillCompute: count("prefill_compute"),
      prefillCache: count("prefill_cache"),
    };
    if (counts.decode == null && counts.prefillCompute == null && counts.prefillCache == null) {
      this._sglangRealtimeLast = null;
      return { counts, rates: { decode: null, prefillCompute: null, prefillCache: null } };
    }
    const prev = this._sglangRealtimeLast;
    this._sglangRealtimeLast = counts;
    const rate = (now, before) =>
      prev != null && now != null && before != null && dtSec > 0 && dtSec < 10 && now >= before
        ? Math.max(0, Math.round(((now - before) / dtSec) * 100) / 100)
        : null;
    return {
      counts,
      rates: {
        decode: rate(counts.decode, prev?.decode ?? null),
        prefillCompute: rate(counts.prefillCompute, prev?.prefillCompute ?? null),
        prefillCache: rate(counts.prefillCache, prev?.prefillCache ?? null),
      },
    };
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
    this.generationTps = 0;
    this.prefillTps = 0;
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

    // Per-step counters tick during the request; the gauges below only move on
    // the decode log interval, so their deltas are the live signal.
    const realtime = this._sglangRealtimeRates(txt, dtSec);
    const liveDecode = realtime.rates.decode;
    const livePrefill = realtime.rates.prefillCompute;
    const inflight =
      this._sglangInflight() ||
      (liveDecode != null && liveDecode > 0) ||
      (livePrefill != null && livePrefill > 0);

    // SGLang's prompt counter includes cache-served tokens, so the prefill work
    // is the computed share (prompt − cached) — or the realtime split when the
    // build reports it directly. The split owns both rates and the hit rate.
    const cachedNow = this._sglangCachedTokens(txt);
    const cachedTotal = cachedNow ?? realtime.counts.prefillCache;
    if (cachedTotal != null) this.totalCachedTokens = cachedTotal;
    if (realtime.counts.prefillCompute != null && realtime.counts.prefillCache != null) {
      this._setPrefillSplitRates(
        realtime.counts.prefillCache,
        realtime.counts.prefillCompute,
        dtSec,
        "realtime"
      );
    } else if (cachedNow != null && prompt != null) {
      this._setPrefillSplitRates(cachedNow, Math.max(0, prompt - cachedNow), dtSec, "cumulative");
    } else {
      // No split source: clear any prior rates so the prefill fallback below
      // reads the prompt counter, not a stale split.
      this._setPrefillSplitRates(null, null, dtSec);
    }

    if (gen == null) {
      const gauge = this._sglangGenGauge(txt);
      if (liveDecode != null) this.generationTps = liveDecode;
      else if (gauge != null) {
        this.generationTps = Math.max(0, Math.round(gauge * 100) / 100);
      }
      if (livePrefill != null) this._setPrefillTps(livePrefill, inflight);
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
    const baselineReady =
      this._rateBaselineReady ||
      this.lastTokenCounts.input !== 0 ||
      this.lastTokenCounts.output !== 0;
    const canDiff = ownsBaseline && dtSec > 0 && dtSec < 10;
    if (canDiff) {
      const deltaOut = gen - this.lastTokenCounts.output;
      const deltaIn = prompt != null ? prompt - this.lastTokenCounts.input : null;
      const counterReset = deltaOut < 0 || (deltaIn != null && deltaIn < 0);
      const gauge = this._sglangGenGauge(txt);
      const busy = (running != null && running > 0) || this._sglangInflight();
      if (!baselineReady || counterReset) {
        this.generationTps = 0;
      } else if (liveDecode != null) {
        // The per-step counter is ahead of the log-interval gauge.
        this.generationTps = liveDecode;
      } else if (gauge != null && busy) {
        this.generationTps = Math.max(0, Math.round(gauge * 100) / 100);
      } else if (gauge != null) {
        // Idle, or the completion just landed in the counter. The gauge already
        // carried the live rate; the counter jump is not another tok/s sample.
        this.generationTps = 0;
      } else {
        this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
      }
      const prefillRate =
        livePrefill ?? this.uncachedPrefillTps ?? (deltaIn != null ? deltaIn / dtSec : null);
      if (prefillRate != null) {
        this._setPrefillTps(!baselineReady || counterReset ? 0 : prefillRate, inflight || deltaOut > 0);
      } else if (deltaOut <= 0) {
        this.prefillTps = 0;
      }
    }
    // Seed outside the rate window too: on the first poll after a restart the
    // window is unusable, and a stale 0 baseline would turn the engine's
    // lifetime prompt counter into a rate on the next poll (#99).
    this.lastTokenCounts.output = gen;
    if (prompt != null) this.lastTokenCounts.input = prompt;
    this._sglangTokenSource = "prometheus";
    this._rateBaselineReady = true;
    this._promptCounterObserved = prompt != null;
    this._outputCounterObserved = true;
    this.completedRequestsTotal =
      this._getPromMetric(txt, "sglang:request_success_total") ??
      this._getPromMetric(txt, "sglang_request_success_total");
    this._completedCounterObserved = this.completedRequestsTotal != null;
    this.totalOutputTokens = gen;
    this.totalPromptTokens = prompt ?? null;
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
      // prompt_tokens_total includes the cache-served share; `compute` is the
      // computed-only prefill work (direct per-mode counter when the engine
      // reports it, else prompt − cached).
      this._setPrefillSplitRates(cached, compute, dtSec, "cumulative");
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
    this.metricsAvailable = false;
    this._metricsModelMatched = false;
    this._metricsModelSeen = false;

    // Slots
    let slotsOk = false;
    try {
      const slotsRes = await this._fetch(`${this.baseUrl}/slots`);
      const auth = this._noteAuthStatus(slotsRes.status);
      if (auth === "auth") {
        this.status = "unavailable";
        this.statusReason = "metrics_auth_required";
        return this._getSnapshot();
      }
      if (auth === "ok") {
        const slots = await slotsRes.json();
        if (Array.isArray(slots)) {
          slotsOk = true;
          this._metricsModelMatched = true;
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
            const hasBaseline = this.slotState.has(slotId);
            const lastState = this.slotState.get(slotId) || { decoded: 0, prompted: 0 };
            const dDecoded = decoded - lastState.decoded;
            const dPrompted = prompted - lastState.prompted;
            this.slotState.set(slotId, { decoded, prompted });
            if (hasBaseline && dtSec > 0 && dtSec < 10) {
              // A restarted slot can expose lower counters; clamp per slot so
              // it cannot cancel another slot's progress. A slot seen for the
              // first time has no baseline, so its lifetime counters are
              // never misread as this interval's rate.
              totalGen += Math.max(0, dDecoded) / dtSec;
              totalPrefill += Math.max(0, dPrompted) / dtSec;
            }
          }

          this.totalOutputTokens = totalDecoded;
          this.totalPromptTokens = promptedSum;
          if (sawCache) this.totalCachedTokens = cachedSum;
          this._outputCounterObserved = true;
          this._promptCounterObserved = true;
          this.generationTps = Math.max(0, Math.round(totalGen * 100) / 100);
          this._setPrefillTps(totalPrefill, totalGen > 0);
          if (sawCache) this._setPrefillSplitRates(cachedSum, promptedSum, dtSec);
          this._noteFreshTelemetry(now);
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
        if (raw) {
          applyModelRef(this, raw);
          this.benchmarkModel = this.modelId;
          this.models = this.modelId ? [this.modelId] : [];
        }
        // Preserve the native server's explicit model path even though the
        // alias is the user-facing model id.
        if (props.model_path && !isHfHubCachePath(props.model_path)) {
          this.modelPath = props.model_path;
        }
        this.contextLength = props.total_context_length || props.context_length || this.contextLength;
      }
    } catch {}

    this.backendType = "llama.cpp";
    return this._getSnapshot();
  }

  // ─── Metrics helpers ─────────────────────────────────────
  /**
   * Keep labeled Prometheus series scoped to the exact model selected from
   * /v1/models. Unlabeled legacy series remain usable; labeled series without
   * a selected model are rejected instead of being guessed or summed.
   */
  _promLabelsMatchModel(rawLabels) {
    const labels = parsePromLabels(rawLabels);
    const labeledModel = labels.model_name ?? labels.model;
    if (labeledModel == null) {
      // A malformed model label must not be mistaken for an unlabeled legacy
      // series. Reject it so malformed exposition cannot bypass model scoping.
      if (typeof rawLabels === "string" && /(?:^|,)\s*(?:model_name|model)\s*=/.test(rawLabels)) {
        this._metricsModelSeen = true;
        return false;
      }
      return true;
    }
    this._metricsModelSeen = true;
    // Direct helper callers and legacy native backends may not have a model
    // id yet. Live OpenAI-compatible probing never reaches metrics without a
    // selected model, so retaining this compatibility does not permit a
    // model guess on the monitored path.
    if (!this.modelId) {
      this._metricsModelMatched = true;
      return true;
    }
    const matches = normalizeModelId(labeledModel) === normalizeModelId(this.modelId);
    if (matches) this._metricsModelMatched = true;
    return matches;
  }

  /**
   * Sum all Prometheus series matching `name` (optional labels).
   * @param {string} body
   * @param {string} name Full metric name, e.g. "ds4_decode_tok_s" or "vllm:prompt_tokens_total"
   * @returns {number | null}
   */
  _getPromMetric(body, name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${esc}(?:\\{([^}]*)\\})?\\s+([\\d.eE+-]+)\\s*$`, "gm");
    let sum = 0;
    let found = false;
    let m;
    while ((m = re.exec(body)) !== null) {
      if (!this._promLabelsMatchModel(m[1])) continue;
      const v = parseFloat(m[2]);
      if (Number.isFinite(v)) {
        sum += v;
        found = true;
      }
    }
    return found ? sum : null;
  }

  /**
   * Max of Prometheus series matching `name` (avoids summing HiCache layers,
   * tensor-parallel repeats of the same counter, …).
   * @param {string} body
   * @param {string} name
   * @param {string|null} [labelKey] Only series carrying this label…
   * @param {string|null} [labelValue] …with this value.
   * @returns {number | null}
   */
  _getPromMetricMax(body, name, labelKey = null, labelValue = null) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${esc}(?:\\{([^}]*)\\})?\\s+([\\d.eE+-]+)\\s*$`, "gm");
    let best = null;
    let m;
    while ((m = re.exec(body)) !== null) {
      if (labelKey != null && promLabelValue(m[1], labelKey) !== labelValue) continue;
      if (!this._promLabelsMatchModel(m[1])) continue;
      const v = parseFloat(m[2]);
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
    const re = new RegExp(`^${escName}\\{([^}]*)\\}\\s+([\\d.eE+-]+)\\s*$`, "gm");
    let sum = 0;
    let found = false;
    let m;
    while ((m = re.exec(body)) !== null) {
      if (promLabelValue(m[1], labelKey) !== labelValue) continue;
      if (!this._promLabelsMatchModel(m[1])) continue;
      const v = parseFloat(m[2]);
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

  /** Read a numeric label from a Prometheus info metric. */
  _getPromInfoNumber(body, name, labelKey) {
    const escName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const line = new RegExp(`^${escName}\\{([^}]*)\\}\\s+[\\d.eE+-]+\\s*$`, "m").exec(body);
    if (!line) return null;
    if (!this._promLabelsMatchModel(line[1])) return null;
    const raw = promLabelValue(line[1], labelKey);
    if (raw == null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
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
    // Radiance has no cache_config_info; it reports the pool as radiance:kv_cache_max_{tokens,bytes} gauges.
    const tokens =
      this._sumPromLabel(txt, "vllm:cache_config_info", "kv_cache_size_tokens") ??
      this._getPromMetric(txt, "radiance:kv_cache_max_tokens");
    const bytes =
      this._sumPromLabel(txt, "vllm:cache_config_info", "kv_cache_memory_bytes") ??
      this._getPromMetric(txt, "radiance:kv_cache_max_bytes");
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
    const bucketRe = new RegExp(`^${esc}_bucket\\{([^}]*)\\}\\s+([\\d.eE+-]+)\\s*$`, "gm");
    const byUpper = new Map();
    let infCount = 0;
    let m;
    while ((m = bucketRe.exec(body)) !== null) {
      if (!this._promLabelsMatchModel(m[1])) continue;
      const le = promLabelValue(m[1], "le");
      if (le == null) continue;
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

  _snapshotStatus() {
    if (this.status === "ambiguous_model") return "ambiguous_model";
    if (this.metricsAvailable && (this.status === "active" || this.status === "idle")) {
      return this.status;
    }
    if (
      this.lastObservedAt != null &&
      Date.now() - this.lastObservedAt > TELEMETRY_STALE_MS
    ) {
      return "stale";
    }
    return this.status === "unknown" ? "unknown" : "unavailable";
  }

  _getSnapshot() {
    const status = this._snapshotStatus();
    const metricsLive = this.metricsAvailable && (status === "active" || status === "idle");
    // A backend we successfully read this poll is "available" even when we
    // cannot yet tell busy from idle (no workload series on a native-info-only
    // read): that is a genuinely unknown RATE, not an unreachable backend. The
    // two disqualifying forms of "unknown" — telemetry that does not match the
    // served model, and a router catalog we refuse to guess from — stay
    // unavailable, same as a stale or outright failed poll.
    const available =
      this.metricsAvailable &&
      status !== "stale" &&
      status !== "ambiguous_model" &&
      !(status === "unknown" && this.statusReason === "metric_model_mismatch");
    // These backends report tok/s as a direct engine-computed window rate,
    // not a counter-diff over the poll interval, so an active-but-zero
    // reading is a genuine fact, not ambiguous with "no delta captured yet".
    const directRateBackend = ["strata", "freetoken", "flare", "radiance"].includes(
      this.backendType
    );
    const liveRate = (value) => {
      if (!Number.isFinite(value)) return null;
      // These backends' own apply/clear methods always leave a trustworthy
      // number (0 after a failed or unmeasured poll, the real rate
      // otherwise), so show it even while "available" is false.
      if (directRateBackend) return Math.max(0, value);
      if (!metricsLive) return null;
      if (this.backendType === "mlx-serve") return Math.max(0, value);
      if (status === "idle") return 0;
      return value > 0 ? value : null;
    };
    const liveCounter = (value, observed) =>
      metricsLive && observed && Number.isFinite(value) ? value : null;
    return {
      port: this.port,
      available,
      status,
      lastObservedAt: this.lastObservedAt,
      statusReason:
        status === "active" || status === "idle"
          ? null
          : this.statusReason || (status === "stale" ? "telemetry_stale" : "telemetry_unavailable"),
      via: this._tunnel ? "ssh-tunnel" : "direct",
      backend: this.backendType,
      modelId: this.modelId || null,
      modelPath: this.modelPath || null,
      benchmarkModel: this.benchmarkModel || null,
      models: [...this.models],
      // Strata advertises aliases for one loaded engine, sharing its native
      // context limit. Genuine multi-model routers still have no shared limit.
      contextLength: this.models.length > 1 && this.backendType !== "strata" ? null : this.contextLength,
      gpuMemoryUtilization: this.gpuMemoryUtilization,
      slotsActive: this.slotsActive,
      slotsTotal: this.slotsTotal,
      generationTps: liveRate(this.generationTps),
      perStreamTps: liveRate(this.perStreamTps),
      perStreamPrefillTps: liveRate(this.perStreamPrefillTps),
      prefillTps: liveRate(this.prefillTps),
      decodeActive: this.decodeActive === true,
      generationTpsSource: this.generationTpsSource,
      prefillActive: this.prefillActive === true,
      cachedPrefillTps: liveRate(this.cachedPrefillTps),
      uncachedPrefillTps: liveRate(this.uncachedPrefillTps),
      totalPromptTokens: liveCounter(this.totalPromptTokens, this._promptCounterObserved),
      totalOutputTokens: liveCounter(this.totalOutputTokens, this._outputCounterObserved),
      totalCachedTokens: this.backendType === "mlx-serve" && !available
        ? null : this.totalCachedTokens ?? null,
      completedRequestsTotal: liveCounter(
        this.completedRequestsTotal,
        this._completedCounterObserved
      ),
      telemetrySource: this.telemetrySource,
      // These describe what the engine's payload itself said (pool sizes,
      // queue depth, latency), not this poll's busy/idle guess, so they stay
      // visible whenever the backend answered — same bar as "available".
      kvCacheUsage: available ? this.kvCacheUsage : null,
      kvCacheCapacityTokens: available ? this.kvCacheCapacityTokens : null,
      kvCacheMaxConcurrency: available ? this.kvCacheMaxConcurrency : null,
      kvCacheTokens: available ? this.kvCacheTokens : null,
      kvCacheTokensAvailable: available ? this.kvCacheTokensAvailable : null,
      kvCacheMemoryBytes: available ? this.kvCacheMemoryBytes : null,
      kvCacheGb: available ? this.kvCacheGb : null,
      weightsGb: available ? this.weightsGb : null,
      requestsRunning: available ? this.requestsRunning : null,
      requestsWaiting: available ? this.requestsWaiting : null,
      ttftP95Seconds: available ? this.ttftP95Seconds : null,
      inFlightSeconds: available ? this.inFlightSeconds ?? null : null,
      ttftSeconds: available ? this.ttftSeconds : null,
      preemptionsTotal: available ? this.preemptionsTotal : null,
      prefixCacheHitRate: available ? this.prefixCacheHitRate : null,
      e2eP95Seconds: available ? this.e2eP95Seconds : null,
      itlP95Seconds: available ? this.itlP95Seconds : null,
      mtpAcceptanceRate: available ? this.mtpAcceptanceRate : null,
      measurementValid: this.measurementValid,
      measurementError: this.measurementError,
      posture: this._buildPosture(),
      error: this.error,
    };
  }

  _defaultLlm() {
    return this._getSnapshot();
  }

  // ─── HTTP helpers ────────────────────────────────────────
  _apiKey() {
    const keys = this.spark?.llmApiKeys;
    if (!keys || typeof keys !== "object") return null;
    const raw = keys[String(this.port)] ?? keys[this.port];
    const key = raw != null ? String(raw).trim() : "";
    return key || null;
  }

  /**
   * Accepts either calling convention used across this file:
   * `_fetch(url, { method, headers, body })` or `_fetch(url, timeoutMs, { headers, ... })`.
   * @param {string} url
   * @param {number | { method?: string, headers?: Record<string, string>, body?: unknown }} [optsOrTimeout]
   * @param {{ method?: string, headers?: Record<string, string>, body?: unknown }} [init]
   */
  async _fetch(url, optsOrTimeout = {}, init = {}) {
    let timeoutMs = LLM_PROBE_TIMEOUT_MS;
    let options = optsOrTimeout || {};
    if (typeof optsOrTimeout === "number") {
      timeoutMs = optsOrTimeout;
      options = init || {};
    }
    const { method = "GET", headers = {}, body } = options;
    const merged = { ...headers };
    const apiKey = this._apiKey();
    if (apiKey) merged.Authorization = `Bearer ${apiKey}`;
    return fetch(url, { method, body, signal: AbortSignal.timeout(timeoutMs), headers: merged });
  }
}
