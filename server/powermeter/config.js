/**
 * Power-meter configuration: which external meter measures which unit.
 *
 * Opt-in by file. Nothing runs unless `config/power-meters.json` exists (or the file
 * POWER_METERS_CONFIG_PATH names). The file holds no secrets: a meter that needs a
 * credential names the environment variable that carries it (`tokenEnv`).
 *
 * {
 *   "meters": { "ha": { "type": "homeassistant", "url": "https://ha.lan", "tokenEnv": "HOME_ASSISTANT_TOKEN" } },
 *   "units": {
 *     "spark-a": { "meter": "ha", "channel": "sensor.strip_power_3", "since": "2026-08-13T00:00:00Z" }
 *   }
 * }
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.js";
import { providerClass, providerTypes } from "./providers/index.js";

export const POWER_METERS_CONFIG_PATH =
  process.env.POWER_METERS_CONFIG_PATH || path.join(ROOT, "config", "power-meters.json");

export const DEFAULT_POLL_INTERVAL_MS = 10_000;
// HA-style meters report every few seconds at most; polling faster only adds load.
const MIN_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 300_000;
const DEFAULT_BACKFILL_DAYS = 400;
const MAX_BACKFILL_DAYS = 3650;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function intInRange(value, fallback, min, max, label, problems) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${label} must be an integer from ${min} to ${max}`);
    return fallback;
  }
  return value;
}

/**
 * Validate a parsed config object. Returns `{ config }` or `{ error }`; never throws.
 * Provider-specific fields are checked by the provider's own `validate`.
 */
export function validatePowerMeterConfig(raw) {
  const problems = [];
  if (!isPlainObject(raw)) return { error: "the file must contain a JSON object" };

  const meters = {};
  if (!isPlainObject(raw.meters) || Object.keys(raw.meters).length === 0) {
    problems.push("meters must be an object with at least one meter");
  } else {
    for (const [id, spec] of Object.entries(raw.meters)) {
      if (!ID_PATTERN.test(id)) {
        problems.push(`meter id "${id}" may only use letters, digits, '.', '_' and '-'`);
        continue;
      }
      if (!isPlainObject(spec)) {
        problems.push(`meters.${id} must be an object`);
        continue;
      }
      const provider = providerClass(spec.type);
      if (!provider) {
        problems.push(`meters.${id}.type must be one of: ${providerTypes().join(", ")}`);
        continue;
      }
      for (const problem of provider.validate(spec)) problems.push(`meters.${id}: ${problem}`);
      meters[id] = { ...spec };
    }
  }

  const units = {};
  if (!isPlainObject(raw.units) || Object.keys(raw.units).length === 0) {
    problems.push("units must map at least one unit id to a meter channel");
  } else {
    for (const [unitId, spec] of Object.entries(raw.units)) {
      if (!isPlainObject(spec)) {
        problems.push(`units.${unitId} must be an object`);
        continue;
      }
      if (typeof spec.meter !== "string" || !(spec.meter in (raw.meters ?? {}))) {
        problems.push(`units.${unitId}.meter must name a configured meter`);
        continue;
      }
      if (typeof spec.channel !== "string" || spec.channel.trim() === "") {
        problems.push(`units.${unitId}.channel must be a non-empty string`);
        continue;
      }
      const provider = providerClass(raw.meters[spec.meter]?.type);
      const channelProblem = provider?.validateChannel?.(spec.channel);
      if (channelProblem) {
        problems.push(`units.${unitId}.channel: ${channelProblem}`);
        continue;
      }
      let sinceMs = null;
      if (spec.since !== undefined) {
        sinceMs = typeof spec.since === "string" ? Date.parse(spec.since) : NaN;
        if (!Number.isFinite(sinceMs)) {
          problems.push(`units.${unitId}.since must be an ISO 8601 timestamp`);
          continue;
        }
      }
      units[unitId] = { meter: spec.meter, channel: spec.channel.trim(), sinceMs };
    }
  }

  const pollIntervalMs = intInRange(
    raw.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    MIN_POLL_INTERVAL_MS,
    MAX_POLL_INTERVAL_MS,
    "pollIntervalMs",
    problems
  );
  const staleAfterMs = intInRange(
    raw.staleAfterMs,
    Math.max(30_000, pollIntervalMs * 3),
    pollIntervalMs,
    MAX_POLL_INTERVAL_MS * 3,
    "staleAfterMs",
    problems
  );
  if (raw.history !== undefined && !isPlainObject(raw.history)) problems.push("history must be an object");
  const history = isPlainObject(raw.history) ? raw.history : {};
  if (history.enabled !== undefined && typeof history.enabled !== "boolean") {
    problems.push("history.enabled must be true or false");
  }
  const backfillDays = intInRange(
    history.backfillDays,
    DEFAULT_BACKFILL_DAYS,
    0,
    MAX_BACKFILL_DAYS,
    "history.backfillDays",
    problems
  );

  if (problems.length) return { error: problems.join("; ") };
  return {
    config: {
      meters,
      units,
      pollIntervalMs,
      staleAfterMs,
      history: { enabled: history.enabled !== false, backfillDays },
    },
  };
}

/**
 * Read the opt-in file.
 * @returns {{ status: "absent" } | { status: "disabled", filePath: string } |
 *   { status: "invalid", filePath: string, error: string } | { status: "ok", filePath: string, config: object }}
 */
export function loadPowerMeterConfig({ filePath = POWER_METERS_CONFIG_PATH, fileSystem = fs } = {}) {
  let text;
  try {
    text = fileSystem.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "absent" };
    return { status: "invalid", filePath, error: `cannot read ${filePath}: ${error.message}` };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { status: "invalid", filePath, error: `${filePath} is not valid JSON: ${error.message}` };
  }
  if (isPlainObject(raw) && raw.enabled === false) return { status: "disabled", filePath };
  const { config, error } = validatePowerMeterConfig(raw);
  if (error) return { status: "invalid", filePath, error };
  return { status: "ok", filePath, config };
}
