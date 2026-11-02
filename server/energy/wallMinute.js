/**
 * Wall power for one minute bucket, shared by the tracker's views and the monthly fold so
 * they always agree. Only used while external meters are configured.
 *
 * Per node:
 *  - measured: what a meter reported (`bucket.wall[id]`, see FleetEnergyTracker);
 *  - filled:   time the GPU+CPU estimate covered but no meter did, valued at
 *              estimate × the node's learned wall/estimate ratio. Kept apart from measured.
 *
 * The fleet figure needs every node covered (measured or filled) and uses the shortest
 * coverage, pro rata, like the estimate's own fleet figures.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Minutes of full overlap a node needs before its own ratio is trusted. */
export const MIN_RATIO_MINUTES = 60;
export const RATIO_WINDOW_MS = 7 * DAY_MS;
/** Ratios outside this range mean the outlet measures something else too; they are not used. */
const RATIO_BOUNDS = [0.5, 4];
const FULL_MINUTE_MS = MINUTE_MS - 1_000;

/**
 * @param {object} bucket                 a tracker minute bucket
 * @param {string[]} nodeIds              every node in the fleet
 * @param {ReadonlySet<string>} wallNodeIds nodes that have a meter
 * @param {Map<string, number> | null} ratios  node → wall/estimate ratio (absent = no fill)
 */
export function wallMinute(bucket, nodeIds, wallNodeIds, ratios) {
  // Plain loops: this runs for every stored minute (44k of them) on each snapshot.
  const count = nodeIds.length;
  const wall = bucket?.wall;
  const estimateCoverage = bucket?.nodeCoverageMs;
  const estimateEnergy = bucket?.nodeWh;
  const nodes = {};
  const covered = new Array(count);
  let any = false;
  let common = MINUTE_MS;
  for (let i = 0; i < count; i++) {
    const id = nodeIds[i];
    const measured = wall && wallNodeIds.has(id) ? wall[id] : null;
    const wh = measured ? measured[0] : 0;
    const coverageMs = measured ? measured[1] : 0;
    const meteredMs = measured ? measured[2] : 0;
    const estimateMs = estimateCoverage?.[id] ?? 0;
    let filledWh = 0;
    let filledMs = 0;
    const ratio = estimateMs > coverageMs ? ratios?.get(id) : undefined;
    if (Number.isFinite(ratio)) {
      filledMs = Math.min(MINUTE_MS - coverageMs, estimateMs - coverageMs);
      filledWh = ((estimateEnergy?.[id] ?? 0) / estimateMs) * filledMs * ratio;
    }
    if (coverageMs > 0 || filledMs > 0) any = true;
    covered[i] = Math.min(MINUTE_MS, coverageMs + filledMs);
    if (covered[i] < common) common = covered[i];
    nodes[id] = { wh, coverageMs, meteredMs, filledWh, filledMs };
  }
  if (!any) return null;
  let fleet = null;
  if (count > 0 && common > 0) {
    let wh = 0;
    let filledWh = 0;
    for (let i = 0; i < count; i++) {
      const n = nodes[nodeIds[i]];
      wh += ((n.wh + n.filledWh) * common) / covered[i];
      filledWh += (n.filledWh * common) / covered[i];
    }
    fleet = { coverageMs: common, wh, filledWh, full: common >= FULL_MINUTE_MS };
  }
  return { nodes, fleet };
}

/**
 * Wall power for one clock hour before the wall boundary, where the meter's record is an
 * hourly figure rather than minutes (see FleetEnergyTracker.importWallHistory). A metered node
 * with an hourly figure is measured for the whole hour, and its minutes add nothing; a node
 * without one is filled from its minutes' estimate, exactly as wallMinute fills it. The fleet
 * figure uses the shortest coverage, pro rata, like wallMinute's, and an hour counts as full
 * when it misses less than a minute.
 *
 * @param {Iterable<object>} buckets         the hour's minute buckets (may be empty)
 * @param {string[]} nodeIds
 * @param {ReadonlySet<string>} wallNodeIds
 * @param {Map<string, number> | null} ratios
 * @param {Map<string, number>} hourWh       metered node → the meter's Wh for the hour
 * @returns {{ nodes: Record<string, object>, fleet: object | null, outputTokens: number } | null}
 */
export function wallHour(buckets, nodeIds, wallNodeIds, ratios, hourWh) {
  const nodes = {};
  const unmeasured = [];
  for (const id of nodeIds) {
    const measured = wallNodeIds.has(id) ? hourWh?.get(id) : undefined;
    if (Number.isFinite(measured)) {
      nodes[id] = { wh: measured, coverageMs: HOUR_MS, meteredMs: HOUR_MS, filledWh: 0, filledMs: 0 };
    } else {
      nodes[id] = { wh: 0, coverageMs: 0, meteredMs: 0, filledWh: 0, filledMs: 0 };
      unmeasured.push(id);
    }
  }
  // Only nodes without the meter's figure are filled from the minutes (a node's fill depends
  // on its own minutes alone); when every node has one, the minutes only count tokens.
  let outputTokens = 0;
  for (const bucket of buckets) {
    outputTokens += bucket.outputTokens ?? 0;
    if (unmeasured.length === 0) continue;
    const minute = wallMinute(bucket, unmeasured, wallNodeIds, ratios);
    if (!minute) continue;
    for (const id of unmeasured) {
      nodes[id].filledWh += minute.nodes[id].filledWh;
      nodes[id].filledMs += minute.nodes[id].filledMs;
    }
  }
  if (!nodeIds.some((id) => nodes[id].coverageMs > 0 || nodes[id].filledMs > 0)) return null;
  let fleet = null;
  const covered = nodeIds.map((id) => Math.min(HOUR_MS, nodes[id].coverageMs + nodes[id].filledMs));
  if (nodeIds.length > 0 && covered.every((ms) => ms > 0)) {
    const common = Math.min(...covered);
    let wh = 0;
    let filledWh = 0;
    nodeIds.forEach((id, i) => {
      wh += ((nodes[id].wh + nodes[id].filledWh) * common) / covered[i];
      filledWh += (nodes[id].filledWh * common) / covered[i];
    });
    fleet = { coverageMs: common, wh, filledWh, full: common >= HOUR_MS - MINUTE_MS };
  }
  return { nodes, fleet, outputTokens };
}

/**
 * Learn wall/estimate ratios from minutes where a node was fully measured and fully
 * estimated, over the last RATIO_WINDOW_MS. A node with too little overlap (or one without
 * a meter) uses the fleet ratio.
 * @returns {{ byNode: Map<string, number>, own: Record<string, number | null>, fleet: number | null, minutes: Record<string, number> }}
 */
export function learnWallRatios(buckets, nodeIds, wallNodeIds, atMs) {
  const since = atMs - RATIO_WINDOW_MS;
  const sums = new Map([...wallNodeIds].map((id) => [id, { wall: 0, estimate: 0, minutes: 0 }]));
  for (const bucket of buckets) {
    if (!bucket?.wall || bucket.minuteStartMs < since || bucket.minuteStartMs > atMs) continue;
    for (const [id, sum] of sums) {
      const measured = bucket.wall[id];
      if (!measured || measured[1] < FULL_MINUTE_MS || (bucket.nodeCoverageMs?.[id] ?? 0) < FULL_MINUTE_MS) continue;
      sum.wall += measured[0];
      sum.estimate += bucket.nodeWh[id];
      sum.minutes += 1;
    }
  }
  const usable = (r) => Number.isFinite(r) && r >= RATIO_BOUNDS[0] && r <= RATIO_BOUNDS[1];
  const own = {};
  const minutes = {};
  let fleetWall = 0;
  let fleetEstimate = 0;
  for (const [id, sum] of sums) {
    minutes[id] = sum.minutes;
    const ratio = sum.minutes >= MIN_RATIO_MINUTES && sum.estimate > 0 ? sum.wall / sum.estimate : null;
    own[id] = usable(ratio) ? ratio : null;
    if (own[id] !== null) {
      fleetWall += sum.wall;
      fleetEstimate += sum.estimate;
    }
  }
  const fleet = fleetEstimate > 0 && usable(fleetWall / fleetEstimate) ? fleetWall / fleetEstimate : null;
  const byNode = new Map();
  for (const id of nodeIds) {
    const ratio = own[id] ?? fleet;
    if (ratio !== null && ratio !== undefined) byNode.set(id, ratio);
  }
  return { byNode, own, fleet, minutes };
}
