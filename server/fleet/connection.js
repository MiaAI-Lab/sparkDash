// ─── Fleet connection manager ───────────────────────────────────────────────
//
// Polls each registry node's node-agent /telemetry endpoint over HTTP, caches
// NodeAgentSnapshot per node, tracks online/offline status, and emits events
// the dashboard server can fan out over WebSocket.
//
// Seam: the node agent is the PRODUCER of NodeAgentSnapshot (shared/types.ts,
// shared/api.schema.json); this module is a CONSUMER. It accepts any JSON
// object body (the agent is responsible for schema conformance) and warns on
// a nodeId mismatch.
//
// Zero dependencies: node built-ins only (global fetch, Node 18+).
//
// Graceful degradation: a node that is unreachable, times out, or answers
// with malformed JSON keeps its last cached snapshot and is marked offline;
// a missing/corrupt registry is handled by the registry, not here.

/** @typedef {import("./registry.js").NodeRecord} NodeRecord */
/** @typedef {import("./registry.js").RoceLink} RoceLink */
/**
 * @typedef {object} NodeAgentSnapshot
 * The /telemetry response shape from shared/types.ts (nodeId, nodeName,
 * lanIp, agentVersion, online, uptimeSeconds, gpu, cpu, mem, disk, net,
 * containers, versions, services, memory, requests, topology, polledAt).
 */

const POLL_INTERVAL_DEFAULT_MS = 2000;
const TIMEOUT_DEFAULT_MS = 5000;

/**
 * Create a fleet connection manager.
 * @param {NodeRecord[]} nodes registry records (ids, endpoints, agentPort)
 * @param {object} [opts]
 * @param {number} [opts.pollIntervalMs] poll cadence, default 2000
 * @param {number} [opts.timeoutMs] per-node HTTP timeout, default 5000
 * @param {(url: string, init?: object) => Promise<Response>} [opts.fetch]
 *   fetch override (tests / custom transports); defaults to globalThis.fetch
 *   resolved at call time (so global stubs installed after creation work)
 * @returns {{
 *   nodes: NodeRecord[],
 *   pollIntervalMs: number,
 *   timeoutMs: number,
 *   start: () => Promise<void>,
 *   stop: () => Promise<void>,
 *   getSnapshot: (nodeId: string) => NodeAgentSnapshot | null,
 *   getAllSnapshots: () => Record<string, NodeAgentSnapshot>,
 *   isOnline: (nodeId: string) => boolean,
 *   onSnapshot: (cb: (nodeId: string, snapshot: NodeAgentSnapshot) => void) => () => void,
 *   onStatus: (cb: (nodeId: string, status: "online" | "offline") => void) => () => void,
 * }}
 */
export function createFleetConnection(nodes, opts = {}) {
  if (!Array.isArray(nodes)) {
    throw new TypeError("createFleetConnection: nodes must be an array");
  }
  const pollIntervalMs =
    Number.isFinite(opts.pollIntervalMs) && opts.pollIntervalMs > 0
      ? opts.pollIntervalMs
      : POLL_INTERVAL_DEFAULT_MS;
  const timeoutMs =
    Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : TIMEOUT_DEFAULT_MS;
  const fetchOverride = typeof opts.fetch === "function" ? opts.fetch : null;

  // Defensive: drop records without a usable string id (cache keys depend on it).
  const records = [];
  for (const raw of nodes) {
    if (raw && typeof raw.id === "string" && raw.id.trim()) {
      records.push({ ...raw, id: raw.id.trim() });
    } else {
      console.warn(
        "[FleetConnection] Skipping node record without a string id:",
        JSON.stringify(raw)
      );
    }
  }

  /** @type {Map<string, NodeAgentSnapshot>} nodeId -> last good snapshot */
  const snapshots = new Map();
  /** @type {Map<string, "online" | "offline">} nodeId -> last known status */
  const status = new Map();
  /** @type {Set<(nodeId: string, snapshot: NodeAgentSnapshot) => void>} */
  const snapshotListeners = new Set();
  /** @type {Set<(nodeId: string, status: "online" | "offline") => void>} */
  const statusListeners = new Set();

  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  /** @type {Promise<void> | null} in-flight poll cycle */
  let inFlight = null;
  /** true from start() entry until stop() completes */
  let running = false;

  // ─── Polling ─────────────────────────────────────────────

  /** @param {NodeRecord} node @returns {string | null} */
  function nodeUrl(node) {
    if (node.endpoint && String(node.endpoint).trim()) {
      return `http://${String(node.endpoint).trim()}/telemetry`;
    }
    if (node.lanIp && String(node.lanIp).trim()) {
      const port = Number.isInteger(node.agentPort) ? node.agentPort : 30091;
      return `http://${String(node.lanIp).trim()}:${port}/telemetry`;
    }
    return null; // unresolvable host → skip, never guess 127.0.0.1
  }

  /**
   * @param {NodeRecord} node
   * @returns {Promise<{ok: boolean, snapshot?: NodeAgentSnapshot}>}
   */
  async function pollNode(node) {
    const url = nodeUrl(node);
    if (!url) return { ok: false };
    const f = fetchOverride || globalThis.fetch;
    if (typeof f !== "function") {
      throw new Error("createFleetConnection: no fetch implementation available");
    }
    let res;
    try {
      res = await f(url, {
        signal: withTimeout(timeoutMs),
        headers: { Accept: "application/json" },
      });
    } catch (err) {
      return { ok: false };
    }
    if (!res.ok) return { ok: false };
    let body;
    try {
      body = await res.json();
    } catch {
      return { ok: false };
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { ok: false };
    }
    if (typeof body.nodeId === "string" && body.nodeId !== node.id) {
      console.warn(
        `[FleetConnection] ${url} reported nodeId ${body.nodeId}, expected ${node.id}`
      );
    }
    return { ok: true, snapshot: /** @type {NodeAgentSnapshot} */ (body) };
  }

  /** One poll cycle across all nodes (never rejects). @returns {Promise<void>} */
  async function runCycle() {
    const results = await Promise.allSettled(records.map((node) => pollNode(node)));
    for (let i = 0; i < results.length; i++) {
      const node = records[i];
      const r = results[i];
      if (r.status === "fulfilled" && r.value.ok) {
        snapshots.set(node.id, r.value.snapshot);
        _emitSnapshot(node.id, r.value.snapshot);
        _setStatus(node.id, "online");
      } else {
        // Graceful degradation: keep the last snapshot, mark offline.
        _setStatus(node.id, "offline");
      }
    }
  }

  function tick() {
    if (!running || inFlight) return; // never stack cycles
    const p = runCycle().catch((err) => {
      console.error("[FleetConnection] poll cycle failed:", err);
    });
    inFlight = p;
    p.finally(() => {
      if (inFlight === p) inFlight = null;
    });
  }

  /**
   * Begin the poll loop. Resolves after the initial poll cycle lands (warm-up),
   * then the interval takes over. Idempotent: a second start() while running
   * is a no-op.
   */
  async function start() {
    if (running) return;
    running = true;
    const first = runCycle().catch((err) => {
      console.error("[FleetConnection] initial poll failed:", err);
    });
    inFlight = first;
    try {
      await first;
    } finally {
      if (inFlight === first) inFlight = null;
    }
    if (!running) return; // stop() raced with the initial poll
    timer = setInterval(tick, pollIntervalMs);
    // Do not keep the event loop alive solely for the poll timer in tools
    // that must exit; the dashboard server keeps the loop alive anyway.
    if (typeof timer.unref === "function") timer.unref();
  }

  /**
   * Stop the poll loop. Lets an in-flight cycle finish, then no further
   * polls. Idempotent: stop() with nothing running is a no-op.
   */
  async function stop() {
    if (!running) return;
    running = false;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (inFlight) await inFlight;
  }

  // ─── Accessors / events ──────────────────────────────────

  /** @param {string} nodeId @returns {NodeAgentSnapshot | null} */
  function getSnapshot(nodeId) {
    return snapshots.get(nodeId) ?? null;
  }

  /** @returns {Record<string, NodeAgentSnapshot>} all cached snapshots */
  function getAllSnapshots() {
    return Object.fromEntries(snapshots);
  }

  /** @param {string} nodeId @returns {boolean} */
  function isOnline(nodeId) {
    return status.get(nodeId) === "online";
  }

  /**
   * Register a snapshot listener: cb(nodeId, snapshot) after each successful
   * poll of that node. Returns an unsubscribe function.
   */
  function onSnapshot(cb) {
    snapshotListeners.add(cb);
    return () => snapshotListeners.delete(cb);
  }

  /**
   * Register a status listener: cb(nodeId, status) on each online/offline
   * TRANSITION (the first observed failure of a node counts as a transition
   * to "offline"). Returns an unsubscribe function.
   */
  function onStatus(cb) {
    statusListeners.add(cb);
    return () => statusListeners.delete(cb);
  }

  function _emitSnapshot(nodeId, snapshot) {
    for (const cb of snapshotListeners) {
      try {
        cb(nodeId, snapshot);
      } catch (err) {
        console.error("[FleetConnection] snapshot listener error:", err);
      }
    }
  }

  function _setStatus(nodeId, next) {
    const prev = status.get(nodeId);
    if (prev === next) return; // transitions only
    status.set(nodeId, next);
    for (const cb of statusListeners) {
      try {
        cb(nodeId, next);
      } catch (err) {
        console.error("[FleetConnection] status listener error:", err);
      }
    }
  }

  return {
    nodes: records,
    pollIntervalMs,
    timeoutMs,
    start,
    stop,
    getSnapshot,
    getAllSnapshots,
    isOnline,
    onSnapshot,
    onStatus,
  };
}

/**
 * Per-request abort signal. Uses AbortSignal.timeout when available (Node
 * 18.17+/20+), falls back to an AbortController otherwise.
 * @param {number} ms
 * @returns {AbortSignal}
 */
function withTimeout(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(new Error("timeout")), ms);
  return ctrl.signal;
}
