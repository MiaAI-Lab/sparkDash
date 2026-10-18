/**
 * ModelPrices — hosted-API price catalog for the Cost compare page.
 *
 * Fetches BerriAI/litellm's community-maintained per-token price list and serves
 * a slimmed chat-shaped slice of it. The parsed catalog is cached in memory for
 * a day and the last good copy is persisted to config/, so the page keeps
 * working when GitHub is unreachable (stale prices beat no prices).
 *
 * The outbound refresh is opt-in (MODEL_PRICES_FETCH): until enabled the route
 * serves the catalog from disk and never touches the network.
 */
import fs from "fs";
import { atomicWrite } from "../util/atomicWrite.js";
import { MODEL_PRICES_JSON_PATH, MODEL_PRICES_FETCH } from "../config.js";

export const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Wait this long before re-attempting a failed refresh (negative cache). */
const RETRY_MS = 60_000;
/** Refuse catalogs larger than this (the real one is ~2 MB); guards a runaway mirror. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Modes whose per-token input/output costs map onto our prompt/completion counters. */
const CHAT_MODES = new Set(["chat", "completion"]);

/** Numbers only; anything else is "unknown" and the entry is skipped. */
function num(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function str(v) {
  return typeof v === "string" && v ? v : null;
}

/**
 * Pure mapper over the litellm payload → chat-shaped price rows, sorted by id.
 * Entries without both an input and an output token cost are dropped; everything
 * else keeps only the fields the Cost page renders.
 * @param {unknown} payload parsed JSON of model_prices_and_context_window.json
 * @returns {Array} price rows
 */
export function parseModelPrices(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const out = [];
  for (const [id, v] of Object.entries(payload)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    if (!id) continue;
    const mode = typeof v.mode === "string" ? v.mode : "chat";
    if (!CHAT_MODES.has(mode)) continue;
    const input = num(v.input_cost_per_token);
    const output = num(v.output_cost_per_token);
    if (input == null || output == null) continue;
    out.push({
      id,
      provider: str(v.litellm_provider),
      mode,
      inputCostPerToken: input,
      outputCostPerToken: output,
      // Preferred key today; the older `_amount` spelling still appears on some entries.
      cacheReadCostPerToken:
        num(v.cache_read_input_token_cost) ?? num(v.cache_read_input_token_amount),
      cacheWriteCostPerToken:
        num(v.cache_creation_input_token_cost) ??
        num(v.cache_creation_input_token_amount),
      maxInputTokens: num(v.max_input_tokens),
      maxOutputTokens: num(v.max_output_tokens),
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/** Default fetch: no redirects (the URL is a constant), hard size cap, short timeout. */
async function fetchJsonCapped(url) {
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`price source returned HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) {
    throw new Error(`price source body too large (${declared} bytes)`);
  }
  const text = await res.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
    throw new Error(`price source body too large (${Buffer.byteLength(text)} bytes)`);
  }
  return JSON.parse(text);
}

/**
 * Build the GET /api/model-prices handler: serve the memory cache while fresh,
 * otherwise refresh from GitHub (at most one attempt in flight, failures retried
 * at most once per RETRY_MS); on failure fall back to the memory copy and then
 * to the last catalog persisted on disk — always flagged `stale` so the page can
 * say the prices may be out of date.
 *
 * @param {{ enabled?: boolean, cachePath?: string, ttlMs?: number, retryMs?: number,
 *           now?: () => number,
 *           fetchJson?: (url: string) => Promise<unknown>, log?: Console }} [opts]
 */
export function createModelPricesHandler(opts = {}) {
  const enabled = opts.enabled ?? MODEL_PRICES_FETCH;
  const cachePath = opts.cachePath ?? MODEL_PRICES_JSON_PATH;
  const ttlMs = opts.ttlMs ?? CACHE_TTL_MS;
  const retryMs = opts.retryMs ?? RETRY_MS;
  const now = opts.now ?? Date.now;
  const fetchJson = opts.fetchJson ?? fetchJsonCapped;
  const log = opts.log ?? console;

  let mem = null; // { at, payload } — last good fetch, fresh for ttlMs
  let disk = null; // parsed disk fallback — served stale, never promoted to fresh
  let lastAttempt = 0; // ms timestamp of the last refresh attempt
  let inflight = null; // shared refresh promise

  const persist = (payload) => {
    try {
      atomicWrite(cachePath, JSON.stringify(payload));
    } catch (error) {
      log.warn?.(`[sparkDash] could not persist model prices: ${error?.message || error}`);
    }
  };

  const loadDisk = () => {
    if (disk) return disk;
    try {
      const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (Array.isArray(parsed?.models) && parsed.models.length > 0) disk = parsed;
    } catch {
      /* no disk fallback */
    }
    return disk;
  };

  const refresh = async (at) => {
    const models = parseModelPrices(await fetchJson(LITELLM_PRICES_URL));
    if (models.length === 0) throw new Error("price source had no usable entries");
    const payload = { models, fetchedAt: at, source: LITELLM_PRICES_URL, stale: false };
    mem = { at, payload };
    persist(payload);
    return payload;
  };

  return async (_req, res) => {
    const at = now();
    if (mem && at - mem.at < ttlMs) {
      res.json(mem.payload);
      return;
    }
    if (enabled) {
      // One attempt per retry window, shared by concurrent requests.
      if (!inflight && at - lastAttempt >= retryMs) {
        lastAttempt = at;
        inflight = refresh(at)
          .catch((error) => {
            log.warn?.(
              `[sparkDash] model price refresh failed (${error?.message || error}); serving cached prices`
            );
          })
          .finally(() => {
            inflight = null;
          });
      }
      if (inflight) {
        const fresh = await inflight;
        if (fresh) {
          res.json(fresh);
          return;
        }
      }
    }
    // Memory copy even if stale, else the last good catalog from disk — both out of date.
    if (mem) {
      res.json({ ...mem.payload, stale: true });
      return;
    }
    const fallback = loadDisk();
    if (fallback) {
      res.json({ ...fallback, stale: true });
      return;
    }
    res.status(502).json({
      error: enabled
        ? "Could not fetch the model price catalog. Try again shortly."
        : "Model prices are not loaded. Set MODEL_PRICES_FETCH=1 to fetch the catalog, or drop a catalog at MODEL_PRICES_JSON_PATH.",
    });
  };
}
