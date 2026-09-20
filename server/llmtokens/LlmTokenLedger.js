/**
 * LlmTokenLedger — cumulative prompt/completion token totals per model.
 *
 * Local-only sparkdash module (kept outside upstream-touched files so an
 * upstream pull only needs the documented anchor lines — see README.md).
 *
 * How it works: LlmProbe already reports cumulative server counters in every
 * snapshot (`totalOutputTokens`, and `totalPromptTokens` added locally). This
 * ledger diffs consecutive observations per (sparkId, port) series and credits
 * the delta to the model the server reported at that moment. Counters that go
 * backwards mean the engine restarted — the baseline is re-seeded without
 * crediting anything.
 *
 * Storage shape (config/llm-token-totals.json):
 * {
 *   "version": 1,
 *   "series": {
 *     "<sparkId>:<port>": {
 *       "updatedAt": 1730000000000,
 *       "lastModelId": "org/model",
 *       "counters": { "output": 1234, "prompt": 5678 },
 *       "models": {
 *         "org/model": {
 *           "promptTokens": 5678, "completionTokens": 1234, "lastSeenAt": ...
 *         }
 *       }
 *     }
 *   }
 * }
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWrite } from "../util/atomicWrite.js";
import { addTokens, addTokensTo } from "../../src/shared/tokenFormat.js";
import { LLM_TOKEN_JSON_PATH } from "../config.js";

const FLUSH_MS = 30_000;
const MAX_MODELS_PER_SERIES = 100;
const MAX_SERIES = 200;
/** Daily per-model buckets retained for range queries (covers "last month" + margin). */
const MAX_DAILY_DAYS = 35;
/** Any per-sample delta above this is a counter anomaly, not real traffic. */
const MAX_CREDITABLE_DELTA = 1e9;
const UNKNOWN_MODEL = "unknown";
const MODEL_ID_MAX_LEN = 200;

/** Valid range keys for GET /api/llm-token-totals?range=… ("all" = lifetime). */
export function normalizeLlmTokenRange(value) {
  return value === "today" || value === "7d" || value === "14d" || value === "30d"
    ? value
    : "all";
}

/** Number of UTC date keys a range covers (null = lifetime). */
function rangeDayCount(range) {
  if (range === "today") return 1;
  if (range === "7d") return 7;
  if (range === "14d") return 14;
  if (range === "30d") return 30;
  return null;
}

function utcDateKey(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_LEDGER_PATH = LLM_TOKEN_JSON_PATH;

function finiteCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Pair each spark's metrics.llm entries with its llmPorts and pull the token
 * counters. Mirrors the FleetEnergy tokenObservation alignment contract:
 * entries[i] <-> llmPorts[i]. Rows without an output counter (probe down,
 * older probe without totalPromptTokens support is fine — only the output
 * counter is mandatory) are skipped.
 * @param {Array<unknown>} snapshots
 * @returns {Array<{ sparkId: string, port: number, modelId: string|null, output: number, prompt: number|null }>}
 */
export function extractTokenObservations(snapshots) {
  const rows = [];
  for (const snap of Array.isArray(snapshots) ? snapshots : []) {
    if (!snap || typeof snap !== "object") continue;
    const entries = snap.metrics?.llm;
    const ports = snap.llmPorts;
    if (!Array.isArray(entries) || !Array.isArray(ports)) continue;
    if (entries.length !== ports.length) continue;
    const sparkId = typeof snap.id === "string" ? snap.id : null;
    if (!sparkId) continue;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const port = ports[i];
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      if (entry?.available !== true) continue;
      const output = finiteCount(entry.totalOutputTokens);
      if (output == null) continue;
      const prompt = entry.totalPromptTokens == null ? null : finiteCount(entry.totalPromptTokens);
      const rawModel = typeof entry.modelId === "string" ? entry.modelId.trim() : "";
      const modelId = rawModel ? rawModel.slice(0, MODEL_ID_MAX_LEN) : null;
      rows.push({ sparkId, port, modelId, output, prompt });
    }
  }
  return rows;
}

function seriesKey(sparkId, port) {
  return `${sparkId}:${port}`;
}

export class LlmTokenLedger {
  /**
   * @param {string} [filePath]
   */
  constructor(filePath = DEFAULT_LEDGER_PATH) {
    this.filePath = filePath;
    /** @type {{ version: number, series: Record<string, unknown> }} */
    this._data = { version: 1, series: {} };
    this._dirty = false;
    this._flushTimer = null;
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!raw || typeof raw !== "object" || !raw.series || typeof raw.series !== "object") return;
      this._data = { version: 1, series: this._sanitize(raw.series) };
    } catch {
      this._data = { version: 1, series: {} };
    }
  }

  /** Coerce an on-disk payload (possibly from an older local version) to the current shape. */
  _sanitize(series) {
    const out = {};
    for (const [key, value] of Object.entries(series)) {
      if (!value || typeof value !== "object") continue;
      const models = {};
      if (value.models && typeof value.models === "object") {
        for (const [modelId, row] of Object.entries(value.models)) {
          if (!row || typeof row !== "object") continue;
          models[modelId] = {
            promptTokens: Math.max(0, Math.round(Number(row.promptTokens) || 0)),
            completionTokens: Math.max(0, Math.round(Number(row.completionTokens) || 0)),
            lastSeenAt: Number(row.lastSeenAt) || 0,
          };
        }
      }
      out[key] = {
        updatedAt: Number(value.updatedAt) || 0,
        lastModelId: typeof value.lastModelId === "string" ? value.lastModelId : null,
        counters: {
          output: finiteCount(value.counters?.output),
          prompt: value.counters?.prompt == null ? null : finiteCount(value.counters.prompt),
        },
        models,
      };
      // Daily range buckets (optional — files written before ranges lack them).
      if (value.daily && typeof value.daily === "object") {
        const daily = {};
        for (const [dayKey, dayVal] of Object.entries(value.daily)) {
          if (!dayVal || typeof dayVal !== "object") continue;
          const dayModels = {};
          for (const [mId, r] of Object.entries(dayVal)) {
            if (!r || typeof r !== "object") continue;
            dayModels[mId] = {
              promptTokens: Math.max(0, Math.round(Number(r.promptTokens) || 0)),
              completionTokens: Math.max(0, Math.round(Number(r.completionTokens) || 0)),
            };
          }
          daily[dayKey] = dayModels;
        }
        out[key].daily = daily;
      }
    }
    return out;
  }

  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush();
    }, FLUSH_MS);
    this._flushTimer.unref?.();
  }

  flush() {
    if (!this._dirty) return;
    try {
      atomicWrite(this.filePath, JSON.stringify(this._data));
      this._dirty = false;
    } catch (err) {
      console.error("[LlmTokenLedger] write failed:", err.message);
    }
  }

  close() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    this.flush();
  }

  /**
   * Credit deltas from one batch of observations. Returns true when state changed.
   * @param {Array<{ sparkId: string, port: number, modelId: string|null, output: number, prompt: number|null }>} observations
   * @param {number} [now]
   */
  record(observations, now = Date.now()) {
    let changed = false;
    for (const obs of Array.isArray(observations) ? observations : []) {
      const key = seriesKey(obs.sparkId, obs.port);
      let series = this._data.series[key];
      if (!series) {
        series = {
          updatedAt: 0,
          lastModelId: null,
          counters: { output: null, prompt: null },
          models: {},
        };
        this._data.series[key] = series;
      }

      // Attribute to the model the server reports now; when the probe could not
      // name one, stick to the series' last known model (never lose attribution).
      const modelId = obs.modelId ?? series.lastModelId ?? UNKNOWN_MODEL;
      if (obs.modelId) series.lastModelId = obs.modelId;

      // First observation after start/reload only seeds the baseline.
      if (series.counters.output == null) {
        series.counters.output = obs.output;
        series.counters.prompt = obs.prompt;
        series.updatedAt = now;
        changed = true;
        continue;
      }

      const dOut = obs.output - series.counters.output;
      let dIn =
        obs.prompt != null && series.counters.prompt != null
          ? obs.prompt - series.counters.prompt
          : null;
      series.counters.output = obs.output;
      series.counters.prompt = obs.prompt;
      series.updatedAt = now;

      // Counter went backwards or jumped implausibly → engine restarted or a
      // counter anomaly: re-seed the baseline and credit nothing.
      if (dOut < 0 || dOut > MAX_CREDITABLE_DELTA) {
        changed = true;
        continue;
      }
      if (dIn != null && (dIn < 0 || dIn > MAX_CREDITABLE_DELTA)) {
        dIn = null;
      }

      if (dOut > 0 || (dIn != null && dIn > 0)) {
        let row = series.models[modelId];
        if (!row) {
          row = { promptTokens: 0, completionTokens: 0, lastSeenAt: now };
          series.models[modelId] = row;
        }
        if (dOut > 0) addTokensTo(row, "completionTokens", dOut);
        if (dIn != null && dIn > 0) addTokensTo(row, "promptTokens", dIn);
        row.lastSeenAt = now;

        // Same deltas into the per-UTC-day buckets that power range queries.
        if (!series.daily || typeof series.daily !== "object") series.daily = {};
        const dayKey = utcDateKey(now);
        const day = series.daily[dayKey] || (series.daily[dayKey] = {});
        const dayRow = day[modelId] || (day[modelId] = { promptTokens: 0, completionTokens: 0 });
        if (dOut > 0) addTokensTo(dayRow, "completionTokens", dOut);
        if (dIn != null && dIn > 0) addTokensTo(dayRow, "promptTokens", dIn);
        changed = true;
      }
    }
    if (changed) {
      this._prune();
      this._dirty = true;
      this._scheduleFlush();
    }
    return changed;
  }

  _prune() {
    const keys = Object.keys(this._data.series);
    if (keys.length > MAX_SERIES) {
      keys.sort((a, b) => (this._data.series[a].updatedAt || 0) - (this._data.series[b].updatedAt || 0));
      for (const k of keys.slice(0, keys.length - MAX_SERIES)) delete this._data.series[k];
    }
    for (const series of Object.values(this._data.series)) {
      const models = Object.values(series.models);
      if (models.length > MAX_MODELS_PER_SERIES) {
        models.sort((a, b) => (a.lastSeenAt || 0) - (b.lastSeenAt || 0));
        for (const m of models.slice(0, models.length - MAX_MODELS_PER_SERIES)) {
          const modelId = Object.keys(series.models).find((k) => series.models[k] === m);
          if (modelId) delete series.models[modelId];
        }
      }
      // Daily buckets: keep only the newest MAX_DAILY_DAYS UTC date keys.
      if (series.daily && typeof series.daily === "object") {
        const dayKeys = Object.keys(series.daily).sort();
        if (dayKeys.length > MAX_DAILY_DAYS) {
          for (const k of dayKeys.slice(0, dayKeys.length - MAX_DAILY_DAYS)) {
            delete series.daily[k];
          }
        }
      }
    }
  }

  /**
   * Read-only public shape for GET /api/llm-token-totals.
   * `range`: "all" (lifetime) or a daily-bucket window (today / 7d / 14d / 30d).
   * Ranged rows aggregate the retained UTC-day buckets; day boundaries are UTC,
   * matching the LlmDaily convention. `lastSeenAt` is null for ranged rows.
   * @param {string} [range]
   * @param {number} [nowMs]
   */
  snapshot(range = "all", nowMs = Date.now()) {
    const dayCount = rangeDayCount(range);
    const series = [];
    for (const [key, s] of Object.entries(this._data.series)) {
      const sep = key.lastIndexOf(":");
      if (sep <= 0) continue;
      let models;
      if (dayCount == null) {
        models = Object.entries(s.models).map(([modelId, row]) => ({
          modelId,
          promptTokens: row.promptTokens || 0,
          completionTokens: row.completionTokens || 0,
          lastSeenAt: row.lastSeenAt || 0,
        }));
      } else {
        const wanted = new Set();
        for (let i = 0; i < dayCount; i++) wanted.add(utcDateKey(nowMs - i * 86_400_000));
        const agg = new Map();
        for (const dateKey of Object.keys(s.daily || {}).sort().reverse()) {
          if (!wanted.has(dateKey)) continue;
          for (const [modelId, row] of Object.entries(s.daily[dateKey])) {
            const acc = agg.get(modelId) || { promptTokens: 0, completionTokens: 0 };
            acc.promptTokens = addTokens(acc.promptTokens, row.promptTokens || 0);
            acc.completionTokens = addTokens(acc.completionTokens, row.completionTokens || 0);
            agg.set(modelId, acc);
          }
        }
        models = [...agg.entries()].map(([modelId, row]) => ({
          modelId,
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          lastSeenAt: null,
        }));
      }
      models = models
        .filter((row) => row.promptTokens > 0 || row.completionTokens > 0)
        .sort(
          (a, b) =>
            b.completionTokens + b.promptTokens - (a.completionTokens + a.promptTokens)
        );
      const totals = models.reduce(
        (acc, row) => ({
          promptTokens: addTokens(acc.promptTokens, row.promptTokens),
          completionTokens: addTokens(acc.completionTokens, row.completionTokens),
        }),
        { promptTokens: 0, completionTokens: 0 }
      );
      series.push({
        sparkId: key.slice(0, sep),
        port: Number(key.slice(sep + 1)),
        updatedAt: s.updatedAt || null,
        lastModelId: s.lastModelId ?? null,
        totals,
        models,
      });
    }
    series.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return { range: dayCount == null ? "all" : range, series };
  }
}

export const llmTokenLedger = new LlmTokenLedger();
