/**
 * Memory headroom: how much a unit can still allocate, and how worried to be.
 *
 * One copy for both sides — the VRAM bar (src/shared/vramBreakdown.ts) and the
 * server's alert rules (server/alerts/rules.js) import these, so the amber/red
 * a user sees on the card and the alert that pages them can never disagree.
 *
 * A GB10 shares one pool between CPU and GPU (`unified`): headroom is
 * `unifiedMemory.available` (MemAvailable). A discrete card (`kind: "host"`)
 * has its own VRAM: headroom is total − used, because the host collector fills
 * `vram.available` with system RAM while no GPU process runs.
 */

const MB_PER_GB = 1024;

/**
 * Free memory below which the headroom turns amber (`low`) or red (`critical`),
 * in MB. A unified pool also feeds the OS and every CPU process, so it needs a
 * larger cushion than dedicated VRAM, which only a new GPU allocation can use.
 */
export const HEADROOM_THRESHOLDS_MB = Object.freeze({
  unified: Object.freeze({ low: 8 * MB_PER_GB, critical: 4 * MB_PER_GB }),
  discrete: Object.freeze({ low: 2 * MB_PER_GB, critical: 1 * MB_PER_GB }),
});

/** @param {string | null | undefined} kind */
export function memoryModelFor(kind) {
  return kind === "host" ? "discrete" : "unified";
}

/**
 * Classify free memory (MB) against the thresholds for this memory model.
 * `thresholds` overrides the defaults (the alert rules let a user tune them).
 * @param {number} freeMB
 * @param {"unified" | "discrete"} model
 * @param {{ low: number, critical: number }} [thresholds]
 * @returns {"ok" | "low" | "critical"}
 */
export function headroomTone(freeMB, model, thresholds) {
  const t = thresholds ?? HEADROOM_THRESHOLDS_MB[model];
  if (!Number.isFinite(freeMB) || freeMB < t.critical) return "critical";
  if (freeMB < t.low) return "low";
  return "ok";
}

const finite = (n) => (typeof n === "number" && Number.isFinite(n) ? n : null);

/**
 * Headroom in MB for one GPU, or null when there is nothing to measure against
 * (no unified total and no VRAM total — a unit that has not reported yet, or a
 * collector that came back empty).
 *
 * - Unified with `unifiedMemory.total > 0`: `available`, else total − GPU − CPU.
 * - Unified without it: `vram.available`, else total − used.
 * - Discrete: VRAM total − used.
 *
 * @param {"unified" | "discrete"} model
 * @param {{ total?: number, gpuUsed?: number, cpuUsed?: number, available?: number } | null | undefined} unified
 * @param {{ total?: number, used?: number, available?: number } | null | undefined} vram
 * @returns {number | null}
 */
export function headroomFreeMB(model, unified, vram) {
  const um = model === "unified" ? unified : null;
  const umTotal = finite(um?.total);
  if (um && umTotal != null && umTotal > 0) {
    const gpuUsed = Math.max(0, finite(um.gpuUsed) ?? 0);
    const cpuUsed = Math.max(0, finite(um.cpuUsed) ?? 0);
    return Math.max(0, finite(um.available) ?? umTotal - gpuUsed - cpuUsed);
  }
  const total = finite(vram?.total) ?? 0;
  if (total <= 0) return null;
  const used = Math.max(0, finite(vram?.used) ?? 0);
  return model === "unified"
    ? Math.max(0, finite(vram?.available) ?? total - used)
    : Math.max(0, total - used);
}
