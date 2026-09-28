/**
 * autopowerStore — the persisted AutoPower config (switch, watch spans,
 * wake times, idle timeout, time zone).
 *
 * Same rationale as schedulerStore.js: automation state lives in its own file
 * (config/autopower.json) so it never collides with settings.json and can be
 * backed up or wiped independently. Transient counters (idle timer, last
 * action) belong to the manager's own state file, not here.
 */
import fs from "fs";
import { AUTOPOWER_JSON_PATH, AUTOPOWER_TZ } from "../config.js";
import { atomicWrite } from "../util/atomicWrite.js";
import {
  normalizeAutoPowerConfig,
  validateAutoPowerConfig,
  defaultAutoPowerConfig,
} from "../../src/shared/autopowerSchedules.js";

const DEFAULTS = Object.freeze(defaultAutoPowerConfig(AUTOPOWER_TZ));

/**
 * "UTC" and missing zones are treated as unset — exactly the schedulerStore
 * rule: a silently-wrong zone is the DST footgun these panels exist to avoid.
 */
function resolveTz(tz) {
  if (!tz || tz === "UTC") return AUTOPOWER_TZ;
  return tz;
}

let _config = null;

function _readFromDisk() {
  try {
    const raw = fs.readFileSync(AUTOPOWER_JSON_PATH, "utf-8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[autopower] failed to load config:", err.message);
    return { ...DEFAULTS };
  }
}

function _persist() {
  try {
    atomicWrite(AUTOPOWER_JSON_PATH, JSON.stringify(_config, null, 2) + "\n", 0o644);
  } catch (err) {
    console.error("[autopower] failed to save config:", err.message);
  }
}

function _finalize(cfg) {
  return { ...normalizeAutoPowerConfig(cfg), tz: resolveTz(cfg.tz) };
}

/** Lazy so importing index.js never fails when the file is absent. */
export function loadAutoPowerConfig() {
  _config = _finalize(_readFromDisk());
  _persist();
  return { ..._config };
}

export function getAutoPowerConfig() {
  if (_config == null) _config = _finalize(_readFromDisk());
  return { ..._config };
}

/**
 * Merge a validated patch. Throws (status 400) on any invalid field so the
 * dialog shows the exact reasons instead of a silently-clamped save.
 * @param {object} patch
 */
export function updateAutoPowerConfig(patch) {
  const cur = getAutoPowerConfig();
  const p = patch || {};
  const next = { ...cur };
  for (const key of ["enabled", "tz", "idleTimeoutMin"]) {
    if (typeof p[key] !== "undefined") next[key] = p[key];
  }
  // Day-type-deep merge: a {watch:{weekday:[…]}} patch must never wipe weekend.
  for (const key of ["watch", "wake"]) {
    if (p[key] && typeof p[key] === "object") {
      next[key] = { ...cur[key] };
      for (const dayType of ["weekday", "weekend"]) {
        if (typeof p[key][dayType] !== "undefined") next[key][dayType] = p[key][dayType];
      }
    }
  }
  const { ok, errors } = validateAutoPowerConfig(next);
  if (!ok) {
    const e = new Error(errors.join("; "));
    e.status = 400;
    throw e;
  }
  _config = _finalize(next);
  _persist();
  return { ..._config };
}
