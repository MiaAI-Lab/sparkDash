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
  const handle = String(row.handle ?? "");
  const source = row.source;
  const nativeId = String(row.id ?? "").trim();
  return {
    id: nativeId || `${source}:${port}:${handle}`,
    source,
    handle,
    badge: badgeFromMidTurn(row.midTurn),
    port,
  };
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

const BADGE_RANK = { generating: 0, unknown: 1, stalled: 2 };

function compareRows(a, b) {
  const rank = (BADGE_RANK[a.badge] ?? 9) - (BADGE_RANK[b.badge] ?? 9);
  if (rank) return rank;
  return a.source.localeCompare(b.source) || a.handle.localeCompare(b.handle) || a.port - b.port || a.id.localeCompare(b.id);
}
