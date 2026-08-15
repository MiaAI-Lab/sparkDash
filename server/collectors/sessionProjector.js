/**
 * Project source session rows onto Sparks by LLM listen origin (host+port).
 * Occupancy badges are per-conversation mid-turn, never recency or clocks.
 */

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];
const LIST_CAP = 20;

/**
 * @param {object[]} rows
 * @param {object[]} sparks
 * @returns {Record<string, object[]>}
 */
export function projectConversations(rows, sparks) {
  const bySpark = {};
  for (const spark of Array.isArray(sparks) ? sparks : []) {
    if (!spark?.id) continue;
    const projected = projectSpark(Array.isArray(rows) ? rows : [], spark);
    if (projected.length > 0) bySpark[spark.id] = projected;
  }
  return bySpark;
}

function projectSpark(rows, spark) {
  const ports = listenPorts(spark);
  if (ports.size === 0) return [];
  const hosts = listenHosts(spark);
  const matched = [];
  for (const row of rows) {
    const port = Number(row?.originPort);
    if (!ports.has(port)) continue;
    if (!hosts.has(normalizeHost(row?.originHost))) continue;
    matched.push(toConversationRow(row, port));
  }
  matched.sort(compareRows);
  return matched.slice(0, LIST_CAP);
}

function listenPorts(spark) {
  const ports = new Set();
  for (const value of spark.llmPorts ?? []) {
    const port = Number(value);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port);
  }
  return ports;
}

function listenHosts(spark) {
  const hosts = new Set();
  const lan = normalizeHost(spark.lanIp);
  if (lan) hosts.add(lan);
  if (spark.isLocal) {
    for (const host of LOOPBACK_HOSTS) hosts.add(host);
  }
  return hosts;
}

function normalizeHost(value) {
  if (value == null) return "";
  let host = String(value).trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host;
}

function toConversationRow(row, port) {
  return {
    source: row.source,
    handle: String(row.handle ?? ""),
    badge: badgeFromMidTurn(row.midTurn),
    port,
  };
}

function badgeFromMidTurn(midTurn) {
  if (midTurn === true) return "generating";
  if (midTurn === false) return "stalled";
  return "unknown";
}

function compareRows(a, b) {
  return a.source.localeCompare(b.source) || a.handle.localeCompare(b.handle) || a.port - b.port;
}
