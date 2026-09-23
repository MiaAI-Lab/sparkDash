// ─── Node registry for the fleet dashboard ──────────────────────────────────
//
// Single source of truth for config/nodes.json: which nodes exist, their
// node-agent HTTP endpoints, roles/ranks, and the RoCE links they participate
// in. Mirrors the server/sparks/SparkRegistry.js pattern:
//   - normalize records on load AND on write
//   - atomic persistence (temp file + rename) so a crash mid-write can never
//     truncate the registry and silently drop nodes
//   - graceful degradation: a missing nodes.json yields an empty registry,
//     not an error
//
// Zero dependencies: node built-ins only.
//
// NodeRecord shape (seam types: shared/types.ts — NodeRole, RoceLink):
//   {
//     id: string,             // "gx10-1c2c"
//     name: string,           // human-readable
//     endpoint: string,       // "192.168.50.226:30091" (node-agent HTTP endpoint)
//     lanIp: string,          // "192.168.50.226"
//     role: "head" | "worker" | "standalone",
//     rank: number | null,    // TP rank (0 = head), null for standalone
//     groupId: string | null, // "tp2-glm", null for standalone
//     headId: string | null,  // head node id when role is worker
//     links: RoceLink[],      // RoCE links this node participates in
//     agentPort: number,      // 30091 (node-agent HTTP port)
//     isLocal: boolean,       // true when the dashboard runs on this node
//   }

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

/**
 * Default registry path. Env-var-or-default mirrors server/config.js
 * (SPARKS_JSON_PATH & co.): NODES_JSON_PATH || <repo>/config/nodes.json.
 */
const DEFAULT_NODES_PATH =
  process.env.NODES_JSON_PATH || path.join(ROOT, "config", "nodes.json");

/** Default node-agent HTTP port. */
const AGENT_PORT_DEFAULT = 30091;

/** Id rule: 1–64 chars, starts with lowercase letter/digit (mirror SparkRegistry). */
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// ─── Types (JSDoc — no runtime) ─────────────────────────────────────────────

/** @typedef {{from: string, to: string, fromIf?: string | null, toIf?: string | null, speedMbps: number | null, transport: "roce" | "tcp", up: boolean}} RoceLink */

/**
 * @typedef {Object} NodeRecord
 * @property {string} id
 * @property {string} name
 * @property {string} endpoint
 * @property {string} lanIp
 * @property {"head" | "worker" | "standalone"} role
 * @property {number | null} rank
 * @property {string | null} groupId
 * @property {string | null} headId
 * @property {RoceLink[]} links
 * @property {number} agentPort
 * @property {boolean} isLocal
 */

// ─── Module state (in-memory registry) ──────────────────────────────────────

/** @type {string} active registry path */
let _path = DEFAULT_NODES_PATH;
/** @type {NodeRecord[] | null} */
let _nodes = null;
/** @type {boolean} */
let _loaded = false;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Load the node registry from disk and make it the active registry state.
 * Missing file → `[]` (graceful degradation, not an error). Corrupt JSON →
 * warn + `[]` (never crash the dashboard on a hand-edited file).
 * @param {string} [p] path to nodes.json (default: module default path)
 * @returns {NodeRecord[]}
 */
export function loadNodes(p) {
  const target = p || _path;
  let data;
  try {
    const raw = fs.readFileSync(target, "utf-8");
    data = JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") {
      data = { nodes: [] };
    } else {
      console.error(`[NodeRegistry] Failed to load ${target}:`, err.message);
      data = { nodes: [] };
    }
  }
  const rawNodes = Array.isArray(data?.nodes) ? data.nodes : [];
  const loaded = [];
  for (const raw of rawNodes) {
    try {
      const rec = _normalizeRecord(raw);
      if (rec) loaded.push(rec);
    } catch (err) {
      // Strict-normalize errors are only raised for records that are too
      // broken to attribute (missing id); skip + warn, keep the rest.
      console.warn(`[NodeRegistry] Skipping malformed node record:`, err.message);
    }
  }
  // Reject duplicate ids in the file; first occurrence wins.
  const seen = new Set();
  const unique = [];
  for (const rec of loaded) {
    if (seen.has(rec.id)) {
      console.warn(`[NodeRegistry] Duplicate node id ${rec.id} in ${target}; keeping first occurrence`);
      continue;
    }
    seen.add(rec.id);
    unique.push(rec);
  }
  _path = target;
  _nodes = unique;
  _loaded = true;
  return listNodes();
}

/**
 * Persist a node list atomically (temp file + rename).
 * @param {object[]} nodes raw or normalized records
 * @param {string} [p] target path (default: active registry path)
 * @returns {NodeRecord[]} the normalized records as written
 */
export function saveNodes(nodes, p) {
  if (!Array.isArray(nodes)) throw new Error("saveNodes: nodes must be an array");
  const normalized = [];
  for (const raw of nodes) {
    normalized.push(_normalizeRecord(raw, { strict: true }));
  }
  const seen = new Set();
  for (const rec of normalized) {
    if (seen.has(rec.id)) throw new Error(`saveNodes: duplicate node id ${rec.id}`);
    seen.add(rec.id);
  }
  _atomicWriteFile(p || _path, JSON.stringify({ nodes: normalized }, null, 2) + "\n");
  if ((p || _path) === _path) {
    _nodes = normalized;
    _loaded = true;
  }
  return normalized.map((rec) => _copy(rec));
}

/**
 * Find a node by id.
 * @param {string} id
 * @returns {NodeRecord | null}
 */
export function getNode(id) {
  _ensureLoaded();
  const rec = _nodes.find((n) => n.id === id) || null;
  return rec ? _copy(rec) : null;
}

/** @returns {NodeRecord[]} a fresh copy of the full registry */
export function listNodes() {
  _ensureLoaded();
  return _nodes.map((rec) => _copy(rec));
}

/**
 * Add a node. Normalizes with defaults; throws on missing/invalid id or a
 * duplicate id. Persists.
 * @param {object} record
 * @returns {NodeRecord}
 */
export function addNode(record) {
  _ensureLoaded();
  const rec = _normalizeRecord(record, { strict: true });
  if (_nodes.some((n) => n.id === rec.id)) {
    throw new Error(`Node ${rec.id} already exists`);
  }
  _nodes = [..._nodes, rec];
  _persist();
  return _copy(rec);
}

/**
 * Update a node by id. Merges `updates` over the stored record; `id` is never
 * changed (an `id` key in updates is silently ignored). Throws if the node is
 * missing. Persists.
 * @param {string} id
 * @param {object} updates partial record
 * @returns {NodeRecord}
 */
export function updateNode(id, updates) {
  _ensureLoaded();
  const idx = _nodes.findIndex((n) => n.id === id);
  if (idx === -1) throw new Error(`Node ${id} not found`);
  const prev = _nodes[idx];
  const { id: _dropId, ...rest } = updates || {};
  const merged = { ...prev, ...rest, id: prev.id };
  const rec = _normalizeRecord(merged, { strict: true });
  const next = [..._nodes];
  next[idx] = rec;
  _nodes = next;
  _persist();
  return _copy(rec);
}

/**
 * Remove a node by id.
 * @param {string} id
 * @returns {NodeRecord | null} the removed record, or null if not found
 */
export function removeNode(id) {
  _ensureLoaded();
  const idx = _nodes.findIndex((n) => n.id === id);
  if (idx === -1) return null;
  const removed = _nodes[idx];
  _nodes = _nodes.filter((n) => n.id !== id);
  _persist();
  return _copy(removed);
}

// ─── Internal ───────────────────────────────────────────────────────────────

/** @returns {string} active registry path (introspection for wiring/tests). */
export function registryPath() {
  return _path;
}

function _ensureLoaded() {
  if (!_loaded) loadNodes(_path);
}

/**
 * @param {object[]} nodes
 */
function _persist(nodes) {
  const source = nodes ?? _nodes;
  try {
    _atomicWriteFile(_path, JSON.stringify({ nodes: source }, null, 2) + "\n");
  } catch (cause) {
    const err = new Error("Node registry persistence failed", { cause });
    err.status = 500;
    throw err;
  }
}

/**
 * Atomic write: temp file in the same directory, then rename. A SIGKILL or
 * power loss mid-write leaves either the old or the new file, never a
 * truncated one. Mirrors SparkRegistry._save().
 * @param {string} filePath
 * @param {string} content
 */
function _atomicWriteFile(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { mode: 0o644 });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp already gone */
    }
    throw err;
  }
}

/**
 * Normalize one record. `strict` (write path) throws on missing/invalid id;
 * load path skips the record instead.
 * @param {object} raw
 * @param {{strict?: boolean}} [opts]
 * @returns {NodeRecord | null} null only when non-strict and id is missing
 */
function _normalizeRecord(raw, opts = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (opts.strict) throw new Error("node record must be an object");
    return null;
  }
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!ID_RE.test(id)) {
    if (opts.strict) {
      throw new Error(
        `Invalid node id: ${JSON.stringify(raw.id)} (must match ${ID_RE})`
      );
    }
    return null;
  }
  const roleRaw = typeof raw.role === "string" ? raw.role.trim().toLowerCase() : "";
  const role =
    roleRaw === "head" || roleRaw === "worker" || roleRaw === "standalone"
      ? roleRaw
      : "standalone";
  const rank = Number.isInteger(raw.rank) && raw.rank >= 0 ? raw.rank : null;
  const groupId =
    typeof raw.groupId === "string" && raw.groupId.trim() ? raw.groupId.trim() : null;
  const headIdRaw = typeof raw.headId === "string" ? raw.headId.trim() : "";
  const headId = headIdRaw && headIdRaw !== id ? headIdRaw : null;
  const links = (Array.isArray(raw.links) ? raw.links : [])
    .map(_normalizeLink)
    .filter(Boolean);
  const agentPortRaw = Number(raw.agentPort);
  const agentPort =
    Number.isInteger(agentPortRaw) && agentPortRaw >= 1 && agentPortRaw <= 65535
      ? agentPortRaw
      : AGENT_PORT_DEFAULT;
  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    endpoint: typeof raw.endpoint === "string" ? raw.endpoint.trim() : "",
    lanIp: typeof raw.lanIp === "string" ? raw.lanIp.trim() : "",
    role,
    rank,
    groupId,
    headId,
    links,
    agentPort,
    isLocal: Boolean(raw.isLocal),
  };
}

/** @param {object} raw @returns {RoceLink | null} */
function _normalizeLink(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const from = typeof raw.from === "string" ? raw.from.trim() : "";
  const to = typeof raw.to === "string" ? raw.to.trim() : "";
  if (!from || !to) return null;
  const speed =
    typeof raw.speedMbps === "number" && Number.isFinite(raw.speedMbps)
      ? raw.speedMbps
      : null;
  return {
    from,
    to,
    fromIf: typeof raw.fromIf === "string" ? raw.fromIf : null,
    toIf: typeof raw.toIf === "string" ? raw.toIf : null,
    speedMbps: speed,
    transport: raw.transport === "tcp" ? "tcp" : "roce",
    up: Boolean(raw.up),
  };
}

/** Deep-enough copy so callers cannot mutate registry state. */
function _copy(rec) {
  return { ...rec, links: rec.links.map((l) => ({ ...l })) };
}
