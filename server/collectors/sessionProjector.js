/**
 * Project source session rows onto Sparks by LLM listen origin (host+port).
 * Occupancy badges are per-conversation mid-turn. List order is generating
 * first, then lastUsedAt descending. Projector does not inject Date.now().
 */

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];
const LIST_CAP = 20;

/**
 * @param {object[]} rows
 * @param {object[]} sparks
 * @returns {Record<string, object[]>}
 */
export function projectConversations(rows, sparks) {
  const list = Array.isArray(sparks) ? sparks : [];
  const nameHosts = exclusiveNameHosts(list);
  const bySpark = {};
  for (const spark of list) {
    if (!spark?.id) continue;
    const projected = projectSpark(Array.isArray(rows) ? rows : [], spark, nameHosts);
    if (projected.length > 0) bySpark[spark.id] = projected;
  }
  return bySpark;
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
  const named = normalizeHost(spark.name);
  if (named && nameHosts.has(named)) hosts.add(named);
  const sshHost = normalizeHost(spark.ssh?.host);
  if (sshHost) hosts.add(sshHost);
  if (spark.isLocal) {
    for (const host of LOOPBACK_HOSTS) hosts.add(host);
  }
  return hosts;
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
  const projected = {
    id: nativeId || `${source}:${port}:${handle}`,
    source,
    handle,
    badge: badgeFromMidTurn(row.midTurn),
    port,
  };
  if (lastUsedAt != null) projected.lastUsedAt = lastUsedAt;
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
  return a.source.localeCompare(b.source) || a.handle.localeCompare(b.handle) || a.port - b.port || a.id.localeCompare(b.id);
}
