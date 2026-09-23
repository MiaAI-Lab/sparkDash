/**
 * sparkdash-node-agent — memory budgeting model.
 *
 * Computes how much unified memory is free on one node and, when a caller
 * wants to reserve more than what is free, which services to stop to make
 * room (greedy, largest-first, stoppable = running && !needed).
 *
 * Seam contract: shared/types.ts → MemoryService, MakeRoomEntry, MemoryBudget.
 * Pure function: no I/O, no module state — deterministic given its inputs
 * (polledAt is the only clock read).
 */

/**
 * One service's memory footprint in the budget (shared/types.ts → MemoryService).
 * @typedef {object} MemoryService
 * @property {string} name
 * @property {string} kind
 * @property {number} footprintMB
 * @property {boolean} running
 * @property {boolean} needed
 */

/**
 * One entry in the make-room plan (shared/types.ts → MakeRoomEntry).
 * @typedef {object} MakeRoomEntry
 * @property {string} serviceName
 * @property {number} freesMB
 * @property {string} reason
 */

/**
 * Memory budget for one node (shared/types.ts → MemoryBudget).
 * @typedef {object} MemoryBudget
 * @property {string} nodeId
 * @property {number} totalMB
 * @property {number} usedMB
 * @property {number} freeMB
 * @property {number} servicesUsedMB
 * @property {number} otherUsedMB
 * @property {MemoryService[]} services
 * @property {MakeRoomEntry[]} makeRoom
 * @property {boolean} needMakeRoom
 * @property {number} polledAt
 */

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Normalize + validate one MemoryService input.
 * @param {unknown} s
 * @param {number} i
 * @returns {MemoryService}
 * @throws {TypeError}
 */
function normalizeMemoryService(s, i) {
  const label = `services[${i}]`;
  if (typeof s !== "object" || s === null || Array.isArray(s)) {
    throw new TypeError(`${label} must be an object`);
  }
  if (typeof s.name !== "string" || s.name.length === 0) {
    throw new TypeError(`${label}.name must be a non-empty string`);
  }
  const kind = typeof s.kind === "string" && s.kind.length > 0 ? s.kind : "other";
  if (!isFiniteNumber(s.footprintMB) || s.footprintMB < 0) {
    throw new TypeError(
      `${label}.footprintMB must be a non-negative finite number (got ${JSON.stringify(s.footprintMB)})`
    );
  }
  return {
    name: s.name,
    kind,
    footprintMB: s.footprintMB,
    running: s.running === true,
    needed: s.needed === true,
  };
}

/**
 * Compute the memory budget for one node.
 *
 * Steps (Batch 1B work plan):
 *  1. freeMB = totalMB - usedMB (clamped to >= 0 for inconsistent telemetry)
 *  2. freeMB >= wantMB → needMakeRoom=false, makeRoom=[]
 *  3. otherwise deficit = wantMB - freeMB; sort stoppable services
 *     (running=true, needed=false) by footprintMB desc (name asc on ties);
 *     greedily add to makeRoom until the deficit is covered.
 *
 * Invariants:
 *  - needed services are never stoppable; stopped services are never stoppable.
 *  - servicesUsedMB = Σ footprintMB over running services.
 *  - otherUsedMB = max(0, usedMB - servicesUsedMB).
 *  - needMakeRoom=true with makeRoom=[] means "infeasible": no stoppable set
 *    covers the deficit — consumers must surface that, not treat [] as OK.
 *
 * @param {number} totalMB total unified memory (MB)
 * @param {number} usedMB currently used memory (MB)
 * @param {MemoryService[]} services
 * @param {number} wantMB memory the caller wants to reserve (MB)
 * @param {{nodeId?: string}} [opts]
 * @returns {MemoryBudget}
 * @throws {TypeError} on non-finite / negative memory values or malformed services
 */
export function computeMemoryBudget(totalMB, usedMB, services, wantMB, opts = {}) {
  for (const [field, v] of [
    ["totalMB", totalMB],
    ["usedMB", usedMB],
    ["wantMB", wantMB],
  ]) {
    if (!isFiniteNumber(v) || v < 0) {
      throw new TypeError(`${field} must be a non-negative finite number (got ${JSON.stringify(v)})`);
    }
  }
  if (!Array.isArray(services)) {
    throw new TypeError("services must be an array");
  }
  const nodeId =
    typeof opts?.nodeId === "string" && opts.nodeId.length > 0 ? opts.nodeId : "unknown";

  const normalized = services.map(normalizeMemoryService);

  const servicesUsedMB = normalized.reduce(
    (sum, s) => (s.running ? sum + s.footprintMB : sum),
    0
  );
  const freeMB = Math.max(0, totalMB - usedMB);
  const otherUsedMB = Math.max(0, usedMB - servicesUsedMB);

  let needMakeRoom = false;
  let makeRoom = [];
  if (freeMB < wantMB) {
    needMakeRoom = true;
    const deficit = wantMB - freeMB;
    const stoppable = normalized
      .filter((s) => s.running && !s.needed)
      .sort((a, b) => b.footprintMB - a.footprintMB || a.name.localeCompare(b.name));
    let freed = 0;
    for (const s of stoppable) {
      if (freed >= deficit) break;
      makeRoom.push({ serviceName: s.name, freesMB: s.footprintMB, reason: "stoppable" });
      freed += s.footprintMB;
    }
  }

  return {
    nodeId,
    totalMB,
    usedMB,
    freeMB,
    servicesUsedMB,
    otherUsedMB,
    services: normalized,
    makeRoom,
    needMakeRoom,
    polledAt: Date.now(),
  };
}
