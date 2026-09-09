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
  /** Overview Fleet Energy card. Off by default. */
  showFleetEnergy: false,
  /** Overview active fleet exceptions strip. Off by default. */
  showFleetExceptions: false,
  /** Overview search + status filter row. Off by default. */
  showOverviewSearch: false,
  /**
   * Per-Spark manual gauge scale maxima: { [sparkId]: { gen, prefill } } in
   * tok/s. An empty entry defers to the model-keyed scale in
   * src/config/display.js MODEL_SCALES.
   */
  gaugeScales: {},
});

/** @type {typeof DEFAULTS} */
let _settings = { ...DEFAULTS };

function _clampSettings(settings) {
  const s = { ...settings };
  // Clamp poll interval to 1000ms minimum
  if (typeof s.pollIntervalMs !== "number" || s.pollIntervalMs < 1000) {
    s.pollIntervalMs = 1000;
  }
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
  // Ensure temperatureUnit is valid
  if (s.temperatureUnit !== "celsius" && s.temperatureUnit !== "fahrenheit") {
    s.temperatureUnit = DEFAULTS.temperatureUnit;
  }
  // Ensure density is valid
  if (s.density !== "comfortable" && s.density !== "compact") {
    s.density = DEFAULTS.density;
  }
  // Sanitize gaugeScales — per-Spark { gen, prefill } positive numbers or null
  // (null = defer to the model-keyed scale).
  if (s.gaugeScales == null || typeof s.gaugeScales !== "object" || Array.isArray(s.gaugeScales)) {
    s.gaugeScales = {};
  } else {
    const num = (x) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : null);
    const clean = {};
    for (const [id, v] of Object.entries(s.gaugeScales)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      clean[id] = { gen: num(v.gen), prefill: num(v.prefill) };
    }
    s.gaugeScales = clean;
  }
  return s;
}

/** Load settings from disk, falling back to defaults. */
export function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    _settings = _clampSettings({ ...DEFAULTS, ...parsed });
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
  const merged = _clampSettings({ ..._settings, ...patch });
  _settings = merged;
  saveSettings();
  return { ..._settings };
}
