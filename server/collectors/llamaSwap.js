/**
 * llama-swap (https://github.com/mostlygeek/llama-swap) behind one LLM port.
 *
 * llama-swap is a proxy that starts and stops engines on demand: one port,
 * many model IDs, usually one loaded at a time. Probing it like a single
 * engine goes wrong in two ways: its own `/metrics` holds host gauges, not
 * token counters, so tok/s reads 0; and any POST naming an unloaded model
 * evicts the loaded one and cold-starts the other.
 *
 * So for a llama-swap port this module:
 * - reads which model is loaded from `GET /running` (never `/upstream/…`,
 *   which starts a model when it is not running);
 * - probes the loaded engine's own upstream address with a nested engine
 *   probe, so vLLM / llama.cpp / SGLang / TensorFold counters still work;
 * - reads completed requests from `GET /api/metrics/activity` for token
 *   totals and a "last request" summary, which covers engines that publish
 *   no counters at all.
 *
 * Every call here is a GET llama-swap answers itself; none loads a model.
 */

const ACTIVITY_PAGE = 200;
const VERSION_TTL_MS = 10 * 60_000;

/** Engine fields copied from the nested probe of the loaded model. */
const ENGINE_FIELDS = [
  "generationTps",
  "prefillTps",
  "prefillActive",
  "cachedPrefillTps",
  "uncachedPrefillTps",
  "slotsActive",
  "slotsTotal",
  "gpuMemoryUtilization",
  "kvCacheUsage",
  "kvCacheTokens",
  "kvCacheTokensAvailable",
  "kvCacheMemoryBytes",
  "kvCacheGb",
  "weightsGb",
  "requestsRunning",
  "requestsWaiting",
  "ttftP95Seconds",
  "ttftSeconds",
  "preemptionsTotal",
  "prefixCacheHitRate",
  "e2eP95Seconds",
  "itlP95Seconds",
  "mtpAcceptanceRate",
];

/** What an engine probe reports while nothing is loaded. */
const IDLE_ENGINE = {
  generationTps: 0,
  prefillTps: 0,
  prefillActive: false,
  cachedPrefillTps: null,
  uncachedPrefillTps: null,
  slotsActive: 0,
  slotsTotal: 0,
  gpuMemoryUtilization: null,
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
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** True when `owned_by` from `/v1/models` names llama-swap. */
export function ownedByLlamaSwap(ownedBy) {
  return typeof ownedBy === "string" && /^llama-swap$/i.test(ownedBy.trim());
}

/** A finite count >= 0, else 0 (llama-swap writes -1 or 0 when a reply had no usage). */
function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** A finite rate > 0, else null. */
function rate(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/**
 * `/running` entries → { ready, starting } model ids plus the proxy of each.
 * @param {unknown} body
 */
export function parseRunning(body) {
  const list = Array.isArray(body?.running) ? body.running : [];
  /** @type {Array<{ model: string, state: string, proxy: string | null }>} */
  const entries = [];
  for (const item of list) {
    const model = typeof item?.model === "string" ? item.model.trim() : "";
    if (!model) continue;
    const state = typeof item?.state === "string" ? item.state : "unknown";
    const proxy = typeof item?.proxy === "string" && /^https?:\/\//i.test(item.proxy) ? item.proxy : null;
    entries.push({ model, state, proxy });
  }
  return {
    entries,
    ready: entries.filter((e) => e.state === "ready").map((e) => e.model),
    starting: entries.filter((e) => e.state === "starting").map((e) => e.model),
  };
}

/**
 * Where to probe a loaded engine. llama-swap reports its upstream as seen from
 * its own host (usually loopback); from elsewhere, swap in the address we reach
 * llama-swap at. The engine may still bind loopback only, in which case the
 * nested probe just fails and activity data carries the panel.
 * @param {string} proxy
 * @param {string} swapBaseUrl
 */
export function engineBaseUrl(proxy, swapBaseUrl) {
  try {
    const engine = new URL(proxy);
    const swap = new URL(swapBaseUrl);
    if (LOOPBACK.has(engine.hostname) && !LOOPBACK.has(swap.hostname)) {
      engine.hostname = swap.hostname;
    }
    return engine.origin;
  } catch {
    return null;
  }
}

/** One activity row → the "last request" summary the panel shows. `timestamp` is when it finished. */
export function summarizeActivityRow(row) {
  const t = row?.tokens || {};
  const at = Date.parse(row?.timestamp);
  return {
    id: Number(row?.id) || 0,
    model: typeof row?.model === "string" ? row.model : null,
    status: Number.isInteger(row?.resp_status_code) ? row.resp_status_code : null,
    at: Number.isFinite(at) ? at : null,
    durationMs: Number.isFinite(Number(row?.duration_ms)) ? Number(row.duration_ms) : null,
    inputTokens: count(t.input_tokens),
    cachedTokens: count(t.cache_tokens),
    outputTokens: count(t.output_tokens),
    prefillTps: rate(t.prompt_per_second),
    decodeTps: rate(t.tokens_per_second),
  };
}

export class LlamaSwapState {
  /**
   * @param {{
   *   baseUrl: () => string,
   *   fetch: (url: string) => Promise<any>,
   *   makeEngineProbe: (baseUrl: string) => { probe: () => Promise<any>, dispose?: () => void },
   *   viaTunnel?: () => boolean,
   * }} deps
   */
  constructor(deps) {
    this._deps = deps;
    this.version = null;
    this._versionAt = 0;
    /** @type {{ entries: any[], ready: string[], starting: string[] }} */
    this.running = { entries: [], ready: [], starting: [] };
    /** @type {Array<{ id: string, name: string | null, state: string, contextLength: number | null }>} */
    this.models = [];
    this.loadedModelId = null;
    this.contextLength = null;
    /** @type {{ url: string, probe: any } | null} */
    this._engine = null;
    /** Last nested engine snapshot (null while nothing is loaded or it is unreachable). */
    this.engineSnapshot = null;
    /** null until the first activity read; false when this llama-swap has no activity API. */
    this._activitySupported = null;
    this._lastActivityId = null;
    /** Tokens of requests completed since this probe started (monotonic; the ledger diffs them). */
    this.totals = { output: 0, prompt: 0, cached: 0 };
    this.lastRequest = null;
  }

  dispose() {
    this._engine?.probe?.dispose?.();
    this._engine = null;
  }

  /**
   * One poll. `records` are the `/v1/models` entries the caller already fetched.
   * @param {any[]} records
   * @returns {Promise<Record<string, unknown>>} engine fields to apply to the outer probe
   */
  async poll(records) {
    const base = this._deps.baseUrl();
    await this._pollVersion(base);
    await this._pollRunning(base);
    this._applyModels(records);
    await this._pollActivity(base);
    return this._pollEngine(base);
  }

  async _pollVersion(base) {
    if (Date.now() - this._versionAt < VERSION_TTL_MS) return;
    this._versionAt = Date.now();
    try {
      const res = await this._deps.fetch(`${base}/api/version`);
      if (!res.ok) return;
      const body = await res.json().catch(() => null);
      if (typeof body?.version === "string") this.version = body.version.slice(0, 40);
    } catch {
      /* version is cosmetic */
    }
  }

  async _pollRunning(base) {
    const res = await this._deps.fetch(`${base}/running`);
    if (!res.ok) throw new Error(`llama-swap /running answered ${res.status}`);
    this.running = parseRunning(await res.json().catch(() => null));
    this.loadedModelId = this.running.ready[0] ?? null;
  }

  _applyModels(records) {
    const running = new Map(this.running.entries.map((e) => [e.model, e.state]));
    this.models = (Array.isArray(records) ? records : [])
      .filter((r) => typeof r?.id === "string" && r.id.trim())
      .map((r) => {
        const listed = typeof r.status?.value === "string" ? r.status.value : null;
        const ctx = Number(r.context_length ?? r.max_model_len);
        return {
          id: r.id,
          name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 120) : null,
          // /running is authoritative for what is up; /v1/models status fills in the rest.
          state: running.get(r.id) ?? listed ?? "unloaded",
          contextLength: Number.isFinite(ctx) && ctx > 0 ? ctx : null,
        };
      });
    const loaded = this.models.find((m) => m.id === this.loadedModelId);
    this.contextLength = loaded?.contextLength ?? null;
  }

  async _pollActivity(base) {
    if (this._activitySupported === false) return;
    try {
      if (this._lastActivityId == null) {
        // Seed from the newest row: history before this probe started is not ours to credit.
        const res = await this._deps.fetch(`${base}/api/metrics/activity?limit=1`);
        if (res.status === 404) {
          this._activitySupported = false;
          return;
        }
        if (!res.ok) return;
        const body = await res.json().catch(() => null);
        const newest = Array.isArray(body?.data) ? body.data[0] : null;
        this._lastActivityId = Number(newest?.id) || 0;
        if (newest) this.lastRequest = summarizeActivityRow(newest);
        this._activitySupported = true;
        return;
      }
      const url =
        `${base}/api/metrics/activity?min_id=${this._lastActivityId + 1}` +
        `&limit=${ACTIVITY_PAGE}&sort=id&order=asc`;
      const res = await this._deps.fetch(url);
      if (!res.ok) return;
      const body = await res.json().catch(() => null);
      const rows = Array.isArray(body?.data) ? body.data : [];
      for (const row of rows) {
        const id = Number(row?.id);
        if (!Number.isFinite(id) || id <= this._lastActivityId) continue;
        this._lastActivityId = id;
        const s = summarizeActivityRow(row);
        this.totals.output += s.outputTokens;
        this.totals.prompt += s.inputTokens;
        this.totals.cached += Math.min(s.cachedTokens, s.inputTokens);
        this.lastRequest = s;
      }
    } catch {
      /* activity is optional; the panel still shows state and engine counters */
    }
  }

  async _pollEngine(base) {
    const loaded = this.running.entries.find((e) => e.model === this.loadedModelId);
    const url = loaded?.proxy && !this._deps.viaTunnel?.() ? engineBaseUrl(loaded.proxy, base) : null;
    if (!url) {
      this.dispose();
      this.engineSnapshot = null;
      return { ...IDLE_ENGINE };
    }
    if (this._engine?.url !== url) {
      this.dispose();
      this._engine = { url, probe: this._deps.makeEngineProbe(url) };
    }
    let snap = null;
    try {
      snap = await this._engine.probe.probe();
    } catch {
      snap = null;
    }
    this.engineSnapshot = snap?.available ? snap : null;
    if (!this.engineSnapshot) return { ...IDLE_ENGINE };
    /** @type {Record<string, unknown>} */
    const fields = {};
    for (const key of ENGINE_FIELDS) fields[key] = snap[key] ?? IDLE_ENGINE[key];
    return fields;
  }

  /** Public snapshot block (`llm.llamaSwap`). */
  snapshot() {
    const engine = this.engineSnapshot;
    return {
      version: this.version,
      loaded: [...this.running.ready],
      starting: [...this.running.starting],
      models: this.models.map((m) => ({ id: m.id, name: m.name, state: m.state })),
      engine: this._engine
        ? {
            url: this._engine.url,
            available: Boolean(engine),
            backend: engine?.backend ?? null,
            modelId: engine?.modelId ?? null,
          }
        : null,
      activity: this._activitySupported === true,
      lastRequest: this.lastRequest,
    };
  }
}

/**
 * Bench model for a llama-swap port: the requested model when it is loaded,
 * otherwise the loaded model. Refuses (409) rather than letting a bench swap
 * models: a POST naming an unloaded model would evict the loaded one.
 * Reads `/running` live so a swap since the last poll is not missed.
 * @param {{ baseUrl: string, requested: string | null, fetch?: typeof fetch }} opts
 * @returns {Promise<string>}
 */
export async function resolveLlamaSwapBenchModel({ baseUrl, requested, fetch: fetchImpl = fetch }) {
  let ready = [];
  try {
    const res = await fetchImpl(`${baseUrl}/running`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ready = parseRunning(await res.json()).ready;
  } catch (err) {
    throw httpError(503, `Could not read llama-swap /running (${err.message}); not starting a bench that could swap models`);
  }
  if (ready.length === 0) {
    throw httpError(409, "No model is loaded in llama-swap. Load one there first; a bench never starts or swaps models.");
  }
  if (requested && !ready.includes(requested)) {
    throw httpError(
      409,
      `${requested} is not loaded in llama-swap (loaded: ${ready.join(", ")}). Load it there first; a bench never swaps models.`
    );
  }
  return requested || ready[0];
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
