// ─── Fleet requests aggregation ────────────────────────────────────────────
//
// Aggregates per-node request stats (queued/running/finished) into the three
// views the frontend wants: byModel, byEngine, byMachine. The node agent is
// the PRODUCER of NodeAgentSnapshot.requests (RequestStats); the dashboard
// server (this module) is the PRODUCER of FleetSnapshot["requests"].
//
// Shapes come from shared/types.ts (RequestStat, RequestStats, NodeAgentSnapshot,
// FleetSnapshot). This file is plain JS / ESM with JSDoc types, zero deps
// (node built-ins only), mirroring the style of server/sparks/SparkMonitor.js.

/**
 * Push a stat into a grouping Record, keyed by `key`. Skips (no-op) when the
 * key is not a usable non-empty string, so a malformed stat degrades to
 * "not counted in this view" instead of polluting the output with a garbage
 * key like "undefined".
 *
 * @param {Record<string, import("../../shared/types").RequestStat[]>} record
 * @param {unknown} key
 * @param {import("../../shared/types").RequestStat} stat
 */
function groupInto(record, key, stat) {
  if (typeof key !== "string" || key.length === 0) return;
  if (!Array.isArray(record[key])) record[key] = [];
  record[key].push(stat);
}

/**
 * Aggregate request stats across all node snapshots.
 *
 * Each RequestStat is contributed to all three views:
 *   - byModel[modelId]
 *   - byEngine[engine]
 *   - byMachine[nodeId]   (stat.nodeId, falling back to the snapshot key)
 *
 * Graceful degradation: a snapshot whose `requests` is null / missing / not an
 * object, or whose `stats` is not an array, is skipped without throwing. An
 * empty (or non-object) `snapshots` input yields three empty Records. Stats
 * are pushed by reference — callers pass fresh per-poll snapshots, so no
 * defensive clone is required.
 *
 * @param {Record<string, import("../../shared/types").NodeAgentSnapshot> | null | undefined} snapshots
 *   Map of nodeId → NodeAgentSnapshot (from the fleet connection manager).
 * @returns {{ byModel: Record<string, import("../../shared/types").RequestStat[]>,
 *             byEngine: Record<string, import("../../shared/types").RequestStat[]>,
 *             byMachine: Record<string, import("../../shared/types").RequestStat[]> }}
 *   The FleetSnapshot["requests"] shape.
 */
export function aggregateRequests(snapshots) {
  /** @type {Record<string, import("../../shared/types").RequestStat[]>} */
  const byModel = {};
  /** @type {Record<string, import("../../shared/types").RequestStat[]>} */
  const byEngine = {};
  /** @type {Record<string, import("../../shared/types").RequestStat[]>} */
  const byMachine = {};

  if (snapshots == null || typeof snapshots !== "object") {
    return { byModel, byEngine, byMachine };
  }

  for (const [nodeId, snapshot] of Object.entries(snapshots)) {
    // `requests` is RequestStats | null on NodeAgentSnapshot; null means
    // "not polled / not available" — skip, don't crash.
    const requests = snapshot?.requests;
    if (requests == null || typeof requests !== "object") continue;
    const stats = Array.isArray(requests.stats) ? requests.stats : [];

    for (const stat of stats) {
      if (stat == null || typeof stat !== "object") continue;

      // byMachine prefers the stat's own nodeId; falls back to the snapshot
      // key when the stat is missing it (defensive — schema says it's present).
      const machineId =
        typeof stat.nodeId === "string" && stat.nodeId.length > 0
          ? stat.nodeId
          : nodeId;

      groupInto(byModel, stat.modelId, stat);
      groupInto(byEngine, stat.engine, stat);
      groupInto(byMachine, machineId, stat);
    }
  }

  return { byModel, byEngine, byMachine };
}

export default aggregateRequests;
