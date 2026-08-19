/**
 * Project source session rows onto Sparks by LLM listen origin (host+port).
 * Occupancy badges are per-conversation mid-turn. List order is generating
 * first, then lastUsedAt descending. Projector does not inject Date.now().
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOST_PATHS } from "../config.js";

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];
const LIST_CAP = 20;
const SKIP_IFACE = /^(lo\d*|docker|br-|veth|virbr|cni)/i;

/**
 * @param {object[]} rows
 * @param {object[]} sparks
 * @param {{ maxAgeMs?: number, now?: number }} [opts]
 * @returns {Record<string, object[]>}
 */
export function projectConversations(rows, sparks, opts = {}) {
  const list = Array.isArray(sparks) ? sparks : [];
  const nameHosts = exclusiveNameHosts(list);
  const maxAgeMs = opts.maxAgeMs ?? 0;
  const now = opts.now ?? Date.now();
  const filtered = maxAgeMs > 0 ? filterByAge(rows, maxAgeMs, now) : rows;
  const bySpark = {};
  for (const spark of list) {
    if (!spark?.id) continue;
    const projected = projectSpark(filtered, spark, nameHosts);
    if (projected.length > 0) bySpark[spark.id] = projected;
  }
  return bySpark;
}

/** Drop rows whose lastUsedAt is older than maxAgeMs. Keep rows with no timestamp. */
function filterByAge(rows, maxAgeMs, now) {
  const cutoff = now - maxAgeMs;
  return rows.filter((row) => {
    const ts = row?.lastUsedAt;
    if (ts == null || !Number.isFinite(ts)) return true;
    return ts >= cutoff;
  });
}

function projectSpark(rows, spark, nameHosts) {
  const ports = listenPorts(spark);
  if (ports.size === 0) return [];
  const hosts = listenHosts(spark, nameHosts);
  const matched = [];
  for (const row of rows) {
    const port = Number(row?.originPort);
    if (!ports.has(port)) continue;
    if (!hosts.has(normalizeHost(row?.originHost))) continue;
    matched.push(toConversationRow(row, port));
  }
  matched.sort(compareRows);
  return uniquifyIds(matched).slice(0, LIST_CAP);
}

function listenPorts(spark) {
  const ports = new Set();
  for (const value of spark.llmPorts ?? []) {
    const port = Number(value);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port);
  }
  return ports;
}

function listenHosts(spark, nameHosts) {
  const hosts = new Set();
  const lan = normalizeHost(spark.lanIp);
  if (lan) hosts.add(lan);
  const cx7 = normalizeHost(spark.cx7Ip);
  if (cx7) hosts.add(cx7);
  const named = normalizeHost(spark.name);
  if (named && nameHosts.has(named)) hosts.add(named);
  const sshHost = normalizeHost(spark.ssh?.host);
  if (sshHost) hosts.add(sshHost);
  if (spark.isLocal) {
    for (const host of LOOPBACK_HOSTS) hosts.add(host);
  }
  for (const extra of spark.occupancyHosts ?? []) {
    const host = normalizeHost(extra);
    if (host) hosts.add(host);
  }
  return hosts;
}

/**
 * IPv4 addresses on this host that an LLM URL might use.
 * Skips loopback, link-local, and container/bridge ifaces.
 * @param {NodeJS.Dict<os.NetworkInterfaceInfo[]>} [ifaces]
 * @returns {string[]}
 */
export function localInterfaceHosts(ifaces = os.networkInterfaces()) {
  const hosts = [];
  for (const [name, addrs] of Object.entries(ifaces || {})) {
    if (SKIP_IFACE.test(name)) continue;
    for (const addr of addrs || []) {
      if (!addr || addr.internal) continue;
      const family = addr.family;
      if (family !== "IPv4" && family !== 4) continue;
      const ip = String(addr.address || "").trim();
      if (isUsableListenIp(ip)) hosts.push(ip);
    }
  }
  return [...new Set(hosts)];
}

/** `/32 host LOCAL` IPv4s from a fib_trie dump. */
export function parseFibLocalIpv4(text) {
  const hosts = [];
  let prevIp = "";
  for (const line of String(text || "").split("\n")) {
    const ipMatch = line.match(/(\d{1,3}(?:\.\d{1,3}){3})\s*$/);
    if (ipMatch) prevIp = ipMatch[1];
    if (/\/32\s+host\s+LOCAL/.test(line) && prevIp) {
      hosts.push(prevIp);
      prevIp = "";
    }
  }
  return hosts;
}

/**
 * Listen IPs for the Spark that is this host. Prefer host PID 1's netns
 * (`/host/proc/1/net/fib_trie` in Docker) so Wi-Fi/LAN addresses are visible
 * inside the container.
 * @param {{ procPath?: string, readFileSync?: Function, ifaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]> }} [deps]
 */
export function hostListenIps(deps = {}) {
  const proc = deps.procPath ?? HOST_PATHS.PROC;
  const read = deps.readFileSync ?? fs.readFileSync;
  try {
    const text = read(path.join(proc, "1", "net", "fib_trie"), "utf8");
    const parsed = parseFibLocalIpv4(text).filter(isUsableListenIp);
    if (parsed.length > 0) return [...new Set(parsed)];
  } catch {
    /* fall through to the process netns */
  }
  return localInterfaceHosts(deps.ifaces);
}

function isUsableListenIp(ip) {
  if (!ip || typeof ip !== "string") return false;
  if (ip.startsWith("127.") || ip.startsWith("169.254.")) return false;
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return false;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
  return true;
}

/** Copy isLocal sparks with this host's extra listen IPs. Projector stays pure. */
export function withOccupancyHosts(sparks, hosts = localInterfaceHosts()) {
  const extra = Array.isArray(hosts) ? hosts.filter(Boolean) : [];
  const list = Array.isArray(sparks) ? sparks : [];
  if (extra.length === 0) return list;
  return list.map((spark) => (spark?.isLocal ? { ...spark, occupancyHosts: extra } : spark));
}

function exclusiveNameHosts(sparks) {
  const names = new Map();
  const identity = new Map();
  for (const spark of sparks) {
    if (!spark?.id) continue;
    const name = normalizeHost(spark.name);
    if (name) names.set(name, [...(names.get(name) || []), spark.id]);
    for (const host of [normalizeHost(spark.lanIp), normalizeHost(spark.ssh?.host)]) {
      if (!host) continue;
      identity.set(host, [...(identity.get(host) || []), spark.id]);
    }
  }
  const exclusive = new Set();
  for (const [name, ids] of names) {
    if (new Set(ids).size !== 1) continue;
    const owner = ids[0];
    const claimedByOther = (identity.get(name) || []).some((id) => id !== owner);
    if (claimedByOther) continue;
    exclusive.add(name);
  }
  return exclusive;
}

function normalizeHost(value) {
  if (value == null) return "";
  let host = String(value).trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host;
}

function toConversationRow(row, port) {
  const handle = String(row.handle ?? "");
  const source = row.source;
  const nativeId = String(row.id ?? "").trim();
  const lastUsedAt = Number.isFinite(row.lastUsedAt) ? row.lastUsedAt : null;
  const agent = typeof row.agent === "string" && row.agent.trim() ? row.agent.trim() : "";
  const projected = {
    id: nativeId || `${source}:${port}:${handle}`,
    source,
    handle,
    badge: badgeFromMidTurn(row.midTurn),
    port,
  };
  if (lastUsedAt != null) projected.lastUsedAt = lastUsedAt;
  if (agent) projected.agent = agent;
  if (typeof row.gateway === "string" && row.gateway.trim()) projected.gateway = row.gateway.trim();
  const used = Number(row.contextUsed);
  if (Number.isFinite(used) && used > 0) projected.contextUsed = Math.round(used);
  const window = Number(row.contextWindow);
  if (Number.isFinite(window) && window > 0) projected.contextWindow = Math.round(window);
  if (row.contextApprox === true) projected.contextApprox = true;
  return projected;
}

function uniquifyIds(rows) {
  const used = new Set();
  return rows.map((row) => {
    let { id } = row;
    if (!used.has(id)) {
      used.add(id);
      return row;
    }
    let n = 2;
    while (used.has(`${id}:${n}`)) n += 1;
    id = `${id}:${n}`;
    used.add(id);
    return { ...row, id };
  });
}

function badgeFromMidTurn(midTurn) {
  if (midTurn === true) return "generating";
  if (midTurn === false) return "stalled";
  return "unknown";
}

function compareRows(a, b) {
  const live = Number(b.badge === "generating") - Number(a.badge === "generating");
  if (live) return live;
  const tb = b.lastUsedAt ?? 0;
  const ta = a.lastUsedAt ?? 0;
  if (tb !== ta) return tb - ta;
  return a.source.localeCompare(b.source) || (a.gateway ?? "").localeCompare(b.gateway ?? "") || a.handle.localeCompare(b.handle) || a.port - b.port || (a.agent ?? "").localeCompare(b.agent ?? "") || a.id.localeCompare(b.id);
}
