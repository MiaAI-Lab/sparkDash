/**
 * ModelPrices — hosted-API price catalog for the Cost compare page.
 *
 * Fetches BerriAI/litellm's community-maintained per-token price list and serves
 * a slimmed chat-shaped slice of it. The parsed catalog is cached in memory for
 * a day and the last good copy is persisted to config/, so the page keeps
 * working when GitHub is unreachable (stale prices beat no prices).
 */
import { atomicWrite } from "../util/atomicWrite.js";
import { MODEL_PRICES_JSON_PATH } from "../config.js";

export const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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

/**
 * Build the GET /api/model-prices handler: serve the memory cache while fresh,
 * otherwise refresh from GitHub; on failure fall back to the memory copy and
 * then to the last catalog persisted on disk.
 *
 * @param {{ cachePath?: string, ttlMs?: number, now?: () => number,
 *           fetchJson?: (url: string) => Promise<unknown>, log?: Console }} [opts]
 */
export function createModelPricesHandler(opts = {}) {
  const cachePath = opts.cachePath ?? MODEL_PRICES_JSON_PATH;
  const ttlMs = opts.ttlMs ?? CACHE_TTL_MS;
  const now = opts.now ?? Date.now;
  const fetchJson =
    opts.fetchJson ??
    (async (url) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`price source returned HTTP ${res.status}`);
      return res.json();
    });
  const log = opts.log ?? console;

  let mem = null; // { at, payload }

  const persist = (payload) => {
    try {
      atomicWrite(cachePath, JSON.stringify(payload));
    } catch (error) {
      log.warn?.(`[sparkDash] could not persist model prices: ${error?.message || error}`);
    }
  };

  return async (_req, res) => {
    const at = now();
    if (mem && at - mem.at < ttlMs) {
      res.json(mem.payload);
      return;
    }
    try {
      const models = parseModelPrices(await fetchJson(LITELLM_PRICES_URL));
      if (models.length === 0) throw new Error("price source had no usable entries");
      const payload = { models, fetchedAt: at, source: LITELLM_PRICES_URL, stale: false };
      mem = { at, payload };
      persist(payload);
      res.json(payload);
      return;
    } catch (error) {
      log.warn?.(
        `[sparkDash] model price refresh failed (${error?.message || error}); serving cached prices`
      );
    }
    // Memory copy even if stale, else the last good catalog from disk.
    if (mem) {
      res.json({ ...mem.payload, stale: true });
      return;
    }
    try {
      const fs = await import("fs");
      const disk = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (Array.isArray(disk?.models) && disk.models.length > 0) {
        mem = { at, payload: disk };
        res.json({ ...disk, stale: true });
        return;
      }
    } catch {
      /* no disk fallback either */
    }
    res.status(502).json({ error: "Could not fetch the model price catalog. Try again shortly." });
  };
}
