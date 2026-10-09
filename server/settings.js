import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWrite } from "./util/atomicWrite.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const SETTINGS_PATH =
  process.env.SETTINGS_JSON_PATH || path.join(ROOT, "config", "settings.json");

const DEFAULTS = Object.freeze({
  pollIntervalMs: 2000,
  defaultLlmPort: 8888,
  autoHideOffline: false,
  /** Hide worker-role Sparks from Overview and the tab bar. */
  hideWorkers: false,
  temperatureUnit: "celsius",
  /** Persist prompts / HTTP traces / GPU samples on decode benchmark runs. */
  benchDebugTraces: false,
  /** Layout density — compact (default) or comfortable. */
  density: "compact",
  /** Overview Fleet Energy card. On by default. */
  showFleetEnergy: true,
  /** Overview active fleet exceptions strip. Off by default. */
  showFleetExceptions: false,
  /** Overview search + status filter row. Off by default. */
  showOverviewSearch: false,
  /** Overview LLM token totals card (cumulative tokens per model). On by default. */
  showLlmTokenTotals: true,
  /**
   * Benchmark dialogs offer the share-card format. On by default: the extra
   * control is one caret next to a button that already copies, and anyone who
   * does not want it can turn it off here (see the README's settings table).
   */
  benchShareImage: true,
  /** Electricity price per kWh, used to show estimated cost on the Fleet energy page. null = hide cost. */
  energyPricePerKwh: null,
  /** Currency symbol shown next to the estimated cost. */
  energyCurrency: "$",
  /**
   * VRAM bars on the Overview cards and the GPU panel split memory into LLM
   * engine / system / other / free and judge severity by absolute headroom.
   * On by default; off restores the single percentage-coloured bar. The UI
   * falls back to the same value before settings load — keep the two in step.
   */
  showVramBreakdown: true,
});

const POLL_INTERVAL_MIN_MS = 500;
const POLL_INTERVAL_MAX_MS = 60_000;

/** Keep only known setting keys. */
function _whitelist(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const k of Object.keys(DEFAULTS)) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

/** @type {typeof DEFAULTS} */
let _settings = { ...DEFAULTS };

function _clampSettings(settings) {
  const s = { ...settings };
  // Clamp poll interval to a sane range (a huge value would overflow setInterval to 1 ms).
  if (typeof s.pollIntervalMs !== "number" || !Number.isFinite(s.pollIntervalMs)) {
    s.pollIntervalMs = DEFAULTS.pollIntervalMs;
  }
  s.pollIntervalMs = Math.min(POLL_INTERVAL_MAX_MS, Math.max(POLL_INTERVAL_MIN_MS, Math.round(s.pollIntervalMs)));
  // Clamp LLM port to 1–65535
  if (typeof s.defaultLlmPort !== "number" || s.defaultLlmPort < 1 || s.defaultLlmPort > 65535) {
    s.defaultLlmPort = DEFAULTS.defaultLlmPort;
  }
  // Ensure autoHideOffline is boolean
  s.autoHideOffline = Boolean(s.autoHideOffline);
  s.hideWorkers = Boolean(s.hideWorkers);
  // Ensure benchDebugTraces is boolean
  s.benchDebugTraces = Boolean(s.benchDebugTraces);
  s.showFleetEnergy = Boolean(s.showFleetEnergy);
  s.showFleetExceptions = Boolean(s.showFleetExceptions);
  s.showOverviewSearch = Boolean(s.showOverviewSearch);
  s.showLlmTokenTotals = Boolean(s.showLlmTokenTotals);
  // Electricity price: a non-negative finite number, otherwise "not set".
  const price = s.energyPricePerKwh == null || s.energyPricePerKwh === "" ? null : Number(s.energyPricePerKwh);
  s.energyPricePerKwh = Number.isFinite(price) && price >= 0 && price <= 100 ? price : null;
  s.energyCurrency =
    typeof s.energyCurrency === "string" && s.energyCurrency.trim() && s.energyCurrency.trim().length <= 4
      ? s.energyCurrency.trim()
      : DEFAULTS.energyCurrency;
  s.showVramBreakdown = Boolean(s.showVramBreakdown);
  // Ensure temperatureUnit is valid
  if (s.temperatureUnit !== "celsius" && s.temperatureUnit !== "fahrenheit") {
    s.temperatureUnit = DEFAULTS.temperatureUnit;
  }
  // Ensure density is valid
  if (s.density !== "comfortable" && s.density !== "compact") {
    s.density = DEFAULTS.density;
  }
  return s;
}

/** Load settings from disk, falling back to defaults. */
export function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    _settings = _clampSettings({ ...DEFAULTS, ..._whitelist(parsed) });
  } catch (err) {
    if (err.code === "ENOENT") {
      _settings = { ...DEFAULTS };
      saveSettings();
    } else {
      console.error("[settings] Failed to load settings.json:", err.message);
      _settings = { ...DEFAULTS };
    }
  }
  return { ..._settings };
}

/** Persist current settings to disk. */
export function saveSettings() {
  try {
    // Atomic write (tmp + rename) — a SIGKILL/power loss mid-write must not
    // truncate settings.json. atomicWrite ensures the dir is created.
    atomicWrite(SETTINGS_PATH, JSON.stringify(_settings, null, 2) + "\n", 0o644);
  } catch (err) {
    console.error("[settings] Failed to save settings.json:", err.message);
  }
}

/** Get current settings (clamped). */
export function getSettings() {
  return { ..._settings };
}

/**
 * Apply a partial patch, persist, and return the new settings.
 * @param {Partial<typeof DEFAULTS>} patch
 * @returns {typeof DEFAULTS}
 */
export function updateSettings(patch) {
  const merged = _clampSettings({ ..._settings, ..._whitelist(patch) });
  _settings = merged;
  saveSettings();
  return { ..._settings };
}
