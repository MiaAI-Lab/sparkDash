/**
 * schedulerStore — the persisted global scheduler switch (+ time zone).
 *
 * Separate from settings.json on purpose: the launcher's automation state is
 * its own file, so merging upstream changes to settings never touches it, and
 * so an operator can back up / wipe the automation without losing dashboard
 * preferences. Model-level windows live on the model records (models.json);
 * this file only answers "is the automation armed, in which zone".
 */
import fs from "fs";
import { SCHEDULER_JSON_PATH, MODEL_SCHEDULER_TZ } from "../config.js";
import { atomicWrite } from "../util/atomicWrite.js";
import { normalizeSchedulerConfig } from "../../src/shared/modelSchedules.js";

const DEFAULTS = Object.freeze({ enabled: false, tz: MODEL_SCHEDULER_TZ });

/**
 * The operator's effective zone. "UTC" and a missing zone are treated as
 * "unset" — scheduling on UTC is exactly the silent DST drift this module
 * exists to prevent, so both always resolve to MODEL_SCHEDULER_TZ. A real,
 * different zone is honoured as-is.
 */
function resolveTz(tz) {
  if (!tz || tz === "UTC") return MODEL_SCHEDULER_TZ;
  return tz;
}

let _config = { ...DEFAULTS };
let _loaded = false;

function _readFromDisk() {
  try {
    const raw = fs.readFileSync(SCHEDULER_JSON_PATH, "utf-8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[scheduler] failed to load config:", err.message);
    return { ...DEFAULTS };
  }
}

function _persist() {
  try {
    atomicWrite(SCHEDULER_JSON_PATH, JSON.stringify(_config, null, 2) + "\n", 0o644);
  } catch (err) {
    console.error("[scheduler] failed to save config:", err.message);
  }
}

/** Lazy so importing index.js never fails when the file is absent. */
export function loadSchedulerConfig() {
  const cfg = normalizeSchedulerConfig({ ...DEFAULTS, ..._readFromDisk() });
  _config = { ...cfg, tz: resolveTz(cfg.tz) };
  _loaded = true;
  _persist();
  return { ..._config };
}

export function getSchedulerConfig() {
  if (!_loaded) {
    const cfg = normalizeSchedulerConfig(_readFromDisk());
    return { ...cfg, tz: resolveTz(cfg.tz) };
  }
  return { ..._config };
}

/**
 * @param {{ enabled?: boolean, tz?: string }} patch
 */
export function updateSchedulerConfig(patch) {
  const next = { ..._config, ...(patch || {}) };
  if (typeof patch?.enabled !== "undefined") next.enabled = Boolean(patch.enabled);
  if (typeof patch?.tz === "string" && patch.tz.trim()) {
    // Reject an unusable zone rather than silently falling back to UTC —
    // a silently-wrong zone is exactly the DST footgun this avoids.
    const tz = patch.tz.trim();
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    } catch {
      const e = new Error(`Unknown time zone: ${tz}`);
      e.status = 400;
      throw e;
    }
    // "UTC" means "operator's zone" (see resolveTz), never a real schedule zone.
    next.tz = resolveTz(tz);
  }
  _config = normalizeSchedulerConfig(next);
  _loaded = true;
  _persist();
  return { ..._config };
}
