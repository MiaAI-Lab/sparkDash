// ─── Fleet topology model ──────────────────────────────────────────────────
//
// Assembles the fleet-wide topology graph from per-node registry records.
// Each node's TopologyInfo is produced by the node agent's /topology endpoint
// (shared/types.ts: TopologyInfo, RoceLink); this module is the PRODUCER of
// FleetSnapshot["topology"] — one TopologyInfo per node plus a deduplicated
// list of every RoCE link in the fleet.
//
// v1 (E11): roles/ranks are manual designation and links are stored in the
// node registry (not auto-detected). A link is directed (from→to) but
// represents a single undirected physical connection, so A→B and B→A are the
// same link and are collapsed to one entry (first seen wins).
//
// Plain JS / ESM, JSDoc types, zero deps — mirrors server/sparks/SparkMonitor.js.

/**
 * Build a canonical dedup key for an undirected node pair. `from`/`to` are
 * sorted so that A→B and B→A collide. A NUL separator is used (node ids are
 * short registry strings that never contain NUL) so that distinct pairs like
 * ("a","bc") and ("ab","c") cannot share a key under a plain join.
 *
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
function linkKey(from, to) {
  return [from, to].sort().join("\u0000");
}

/**
 * Build the fleet topology from node registry records.
 *
 * - One TopologyInfo per node (nodeId/role/rank/groupId/headId/links).
 * - `links` is undefined → []. Non-object / non-array link entries are skipped.
 * - The top-level `links` array is the union of every node's links,
 *   deduplicated as undirected pairs (A↔B kept once, first seen wins).
 * - An empty / non-array `nodes` input yields { nodes: [], links: [] }.
 *
 * Node fields are passed through; rank/groupId/headId that are undefined are
 * normalized to null (TopologyInfo declares them `| null`).
 *
 * @param {Array<{ id: string, role?: import("../../shared/types").NodeRole,
 *                 rank?: number | null, groupId?: string | null,
 *                 headId?: string | null, links?: import("../../shared/types").RoceLink[] }> |
 *          null | undefined} nodes
 *   Node registry records.
 * @returns {{ nodes: import("../../shared/types").TopologyInfo[],
 *             links: import("../../shared/types").RoceLink[] }}
 *   The FleetSnapshot["topology"] shape.
 */
export function buildTopology(nodes) {
  /** @type {import("../../shared/types").TopologyInfo[]} */
  const nodeInfos = [];
  /** @type {Map<string, import("../../shared/types").RoceLink>} */
  const seenLinks = new Map();

  if (!Array.isArray(nodes)) return { nodes: nodeInfos, links: [] };

  for (const node of nodes) {
    if (node == null || typeof node !== "object") continue;

    const links = Array.isArray(node.links) ? node.links : [];

    nodeInfos.push({
      nodeId: node.id,
      role: node.role,
      rank: node.rank ?? null,
      groupId: node.groupId ?? null,
      headId: node.headId ?? null,
      links,
    });

    for (const link of links) {
      if (link == null || typeof link !== "object") continue;
      const from = link.from;
      const to = link.to;
      if (typeof from !== "string" || from.length === 0) continue;
      if (typeof to !== "string" || to.length === 0) continue;
      const key = linkKey(from, to);
      if (!seenLinks.has(key)) seenLinks.set(key, link);
    }
  }

  return { nodes: nodeInfos, links: Array.from(seenLinks.values()) };
}

export default buildTopology;
