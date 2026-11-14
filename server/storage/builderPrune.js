/**
 * Docker build cache: clearing what nothing uses on the builder built into the Spark's Docker daemon (roadmap §7, the
 * default-builder adapter). The unit program is scripts/docker-builder-prune.sh; this module validates the request
 * and reads its answer. Sizes are Docker's own figures, never estimated here.
 */
import { parseDockerSize, programResult } from "./commands.js";

export const BUILDER_PRUNE_MIN_DAYS = 1;
export const BUILDER_PRUNE_MAX_DAYS = 365;

/**
 * `olderThanDays` from a request body: a whole number of days from 1 to 365 (cache last used before then goes).
 * Throws a 400 for anything else, before anything reaches the unit.
 * @param {unknown} v
 * @returns {number}
 */
export function parseOlderThanDays(v) {
  if (!Number.isInteger(v) || v < BUILDER_PRUNE_MIN_DAYS || v > BUILDER_PRUNE_MAX_DAYS) {
    throw Object.assign(new Error(`olderThanDays must be a whole number from ${BUILDER_PRUNE_MIN_DAYS} to ${BUILDER_PRUNE_MAX_DAYS}`), {
      status: 400,
      code: "bad-days",
    });
  }
  return /** @type {number} */ (v);
}

/** " (Docker reports 1.2 GB reclaimed)" for an Activity message, in Docker's own decimal units; "" when unknown. */
export function reclaimedNote(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const [div, unit] = bytes >= 1e12 ? [1e12, "TB"] : bytes >= 1e9 ? [1e9, "GB"] : bytes >= 1e6 ? [1e6, "MB"] : bytes >= 1e3 ? [1e3, "kB"] : [1, "B"];
  return ` (Docker reports ${div === 1 ? bytes : (bytes / div).toFixed(1)} ${unit} reclaimed)`;
}

/**
 * The program's answer. `adapter`: "buildx" (the builder named after the Docker context, driver "docker") or
 * "daemon" (no buildx: the daemon's own builder). `reclaimedBytes`: what Docker says it reclaimed, or null when it
 * did not say.
 * @returns {{ ok: true, adapter: "buildx" | "daemon" | null, olderThanDays: number | null, reclaimedBytes: number | null }
 *   | { ok: false, code: string, message: string }}
 */
export function parseBuilderPruneOutput(out) {
  const r = programResult(out);
  if (!r.ok) return r;
  const v = r.values;
  return {
    ok: true,
    adapter: v.ADAPTER === "buildx" || v.ADAPTER === "daemon" ? v.ADAPTER : null,
    olderThanDays: /^\d{1,3}$/.test(v.DAYS ?? "") ? Number(v.DAYS) : null,
    reclaimedBytes: parseDockerSize(v.RECLAIMED),
  };
}
