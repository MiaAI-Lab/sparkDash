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
  /** Overview KPI tiles (Fleet decode, Fleet power, Memory in use, Tokens in last 24 hours) and the Recent activity card. On by default. */
  showKpiDecode: true,
  showKpiPower: true,
  showKpiMemory: true,
  showKpiTokens: true,
  showActivityFeed: true,
  /**
   * Benchmark dialogs offer the share-card format. On by default: the extra
   * control is one caret next to a button that already copies, and anyone who
   * does not want it can turn it off here (see the README's settings table).
   */
  benchShareImage: true,
  /**
   * Time zone for the Tokens, Energy and Activity charts (hour and day boundaries,
   * labels). "" follows each browser; otherwise an IANA name such as "Europe/Paris".
   */
  timeZone: "",
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
  /**
   * Serve GET /metrics in Prometheus text format for an external scraper.
   * Off by default: when off the path answers 404.
   */
  prometheusExport: false,
  /**
   * Let the Intel (xe) probe read root-only debugfs VRAM through `sudo -n`.
   * Off by default: without it VRAM falls back to the PCI BAR size and no sudo runs.
   */
  intelVramSudo: false,
  /**
   * Keep 48 h of 1-minute and 30 days of 15-minute history per unit (GPU, memory
   * headroom, CPU, RAM, network, LLM tok/s and KV) for the unit page. Off by
   * default: nothing is recorded and config/metrics-history.json is never written.
   * The GPU chart (8 h) and Temps (7 d) histories are separate and always on.
   */
  metricsHistory: false,

  /**
   * Alert notifications (Settings → Alerts). Off by default: while off nothing
   * is evaluated or sent, and the alert config / test routes refuse.
   */
  alertsEnabled: false,
  /**
   * Publish the EventLog stream and per-Spark availability to an MQTT broker.
   * Off by default. The broker password never lives here (settings.json is
   * world-readable) — it comes from the SPARKDASH_MQTT_PASSWORD env var.
   */
  mqttEnabled: false,
  /** Broker URL: mqtt://host:port, mqtts://… or ws(s)://… */
  mqttUrl: "",
  /** Username the broker requires, if any. */
  mqttUsername: "",
  /** Topic root for everything published (no wildcards, no slashes at the edges). */
  mqttTopicPrefix: "sparkdash",
  /**
   * Hide harness sessions older than this. Finite: 1 minute through 14 days.
   * A missing or out-of-range value becomes 12 hours. There is no unlimited value.
   */
  occupancyMaxAgeMs: 12 * 60 * 60 * 1000,
  /**
   * GPU temperature (°C) at which the Health "thermal" finding warns, and at
   * which it turns critical. Alerts reuse that finding, so these also decide
   * when a notification goes out. Warn must stay below critical.
   */
  healthTempWarnC: 85,
  healthTempCriticalC: 90,
});

const POLL_INTERVAL_MIN_MS = 500;
const POLL_INTERVAL_MAX_MS = 60_000;
export const OCCUPANCY_AGE_MIN_MS = 60 * 1000;
export const OCCUPANCY_AGE_MAX_MS = 14 * 24 * 60 * 60 * 1000;
export const OCCUPANCY_AGE_DEFAULT_MS = 12 * 60 * 60 * 1000;
export const HEALTH_TEMP_MIN_C = 40;
export const HEALTH_TEMP_MAX_C = 110;

/** A finite temperature inside the accepted range, otherwise null. */
function healthTemp(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= HEALTH_TEMP_MIN_C && n <= HEALTH_TEMP_MAX_C ? n : null;
}

/**
 * Reject a settings write that would leave the thermal thresholds unusable:
 * a value that is not a number in range, or a warning that is not below the
 * critical value. Only checked when the patch touches one of the two keys.
 */
function assertHealthTemps(current, patch) {
  if (!("healthTempWarnC" in patch) && !("healthTempCriticalC" in patch)) return;
  const merged = { ...current, ...patch };
  const range = `between ${HEALTH_TEMP_MIN_C} and ${HEALTH_TEMP_MAX_C} °C`;
  const warn = healthTemp(merged.healthTempWarnC);
  const critical = healthTemp(merged.healthTempCriticalC);
  if (warn == null) throw new Error(`healthTempWarnC must be a number ${range}`);
  if (critical == null) throw new Error(`healthTempCriticalC must be a number ${range}`);
  if (warn >= critical) throw new Error("healthTempWarnC must be lower than healthTempCriticalC");
}

/** "" (follow the browser) or an IANA zone name this runtime knows. */
export function isValidTimeZone(value) {
  if (typeof value !== "string") return false;
  const name = value.trim();
  if (!name || name.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** A usable MQTT topic root: no wildcards, no slashes at the edges, bounded length. */
function isValidMqttPrefix(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  return (
    v.length > 0 &&
    v.length <= 128 &&
    !v.includes("+") &&
    !v.includes("#") &&
    !v.startsWith("/") &&
    !v.endsWith("/")
  );
}

/**
 * The broker URL, normalised, or "" when it is not usable: an mqtt(s):// or
 * ws(s):// URL with a host and no embedded credentials. settings.json is
 * world-readable, so `mqtt://user:secret@host` is refused outright — the
 * username has its own setting and the password comes from the environment.
 */
function normalizeMqttUrl(value) {
  if (typeof value !== "string") return "";
  const v = value.trim();
  if (!v || v.length > 256 || !/^(mqtt|ws)s?:\/\//i.test(v)) return "";
  let url;
  try {
    url = new URL(v);
  } catch {
    return "";
  }
  if (!url.hostname || url.username || url.password) return "";
  return v;
}

/** Whether a raw broker URL carries a username or password in its authority. */
function mqttUrlHasCredentials(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value.trim());
    return Boolean(url.username || url.password);
  } catch {
    // Unparseable, but an "@" before the host still means credentials were typed in.
    return /^[a-z]+:\/\/[^/]*@/i.test(value.trim());
  }
}

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
  s.showKpiDecode = Boolean(s.showKpiDecode);
  s.showKpiPower = Boolean(s.showKpiPower);
  s.showKpiMemory = Boolean(s.showKpiMemory);
  s.showKpiTokens = Boolean(s.showKpiTokens);
  s.showActivityFeed = Boolean(s.showActivityFeed);
  // Electricity price: a non-negative finite number, otherwise "not set".
  const price = s.energyPricePerKwh == null || s.energyPricePerKwh === "" ? null : Number(s.energyPricePerKwh);
  s.energyPricePerKwh = Number.isFinite(price) && price >= 0 && price <= 100 ? price : null;
  s.energyCurrency =
    typeof s.energyCurrency === "string" && s.energyCurrency.trim() && s.energyCurrency.trim().length <= 4
      ? s.energyCurrency.trim()
      : DEFAULTS.energyCurrency;
  s.timeZone = isValidTimeZone(s.timeZone) ? String(s.timeZone).trim() : "";
  s.showVramBreakdown = Boolean(s.showVramBreakdown);
  s.prometheusExport = Boolean(s.prometheusExport);
  s.intelVramSudo = Boolean(s.intelVramSudo);
  s.metricsHistory = Boolean(s.metricsHistory);
  s.alertsEnabled = Boolean(s.alertsEnabled);
  s.mqttEnabled = Boolean(s.mqttEnabled);
  s.mqttUrl = normalizeMqttUrl(s.mqttUrl);
  s.mqttUsername = typeof s.mqttUsername === "string" ? s.mqttUsername.trim().slice(0, 128) : "";
  // Trailing slashes are normal while typing; strip them instead of rejecting.
  const prefix = typeof s.mqttTopicPrefix === "string" ? s.mqttTopicPrefix.trim().replace(/\/+$/, "") : "";
  s.mqttTopicPrefix = isValidMqttPrefix(prefix) ? prefix : DEFAULTS.mqttTopicPrefix;
  const age = Number(s.occupancyMaxAgeMs);
  s.occupancyMaxAgeMs =
    Number.isFinite(age) && age >= OCCUPANCY_AGE_MIN_MS && age <= OCCUPANCY_AGE_MAX_MS
      ? Math.round(age)
      : OCCUPANCY_AGE_DEFAULT_MS;
  // A hand-edited settings.json can hold unusable thresholds; updateSettings()
  // rejects them on write, so here both fall back together to keep warn < critical.
  const warnC = healthTemp(s.healthTempWarnC);
  const criticalC = healthTemp(s.healthTempCriticalC);
  if (warnC != null && criticalC != null && warnC < criticalC) {
    s.healthTempWarnC = warnC;
    s.healthTempCriticalC = criticalC;
  } else {
    s.healthTempWarnC = DEFAULTS.healthTempWarnC;
    s.healthTempCriticalC = DEFAULTS.healthTempCriticalC;
  }
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
    // A broker URL with credentials written by an older build (or by hand) is
    // dropped above; rewrite the file so the secret does not linger on disk.
    if (mqttUrlHasCredentials(parsed?.mqttUrl)) {
      console.warn("[settings] Removed an MQTT broker URL containing credentials from settings.json");
      saveSettings();
    }
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
 * Throws when the GPU temperature thresholds in the patch are not usable.
 * @param {Partial<typeof DEFAULTS>} patch
 * @returns {typeof DEFAULTS}
 */
export function updateSettings(patch) {
  assertHealthTemps(_settings, _whitelist(patch));
  const merged = _clampSettings({ ..._settings, ..._whitelist(patch) });
  _settings = merged;
  saveSettings();
  return { ..._settings };
}
