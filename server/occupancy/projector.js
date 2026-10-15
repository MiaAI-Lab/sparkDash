import { OCCUPANCY_AGE_DEFAULT_MS } from "../settings.js";
import { ACP_HARNESS_IDS, HARNESS_IDS } from "./catalog.js";

const ACP = new Set(ACP_HARNESS_IDS);

const LIST_CAP = 20;

/**
 * Assign helper rows onto Spark LLM ports.
 * ACP metadata never becomes "generating" or "stalled". A row with no explicit
 * route and no native endpoint stays unmapped.
 *
 * @returns {{ bySpark: Record<string, Record<string, object[]>>, unmapped: number }}
 */
export function projectOccupancy({ helpers, caches, sparks, now, maxAgeMs }) {
  const age = finiteAge(maxAgeMs);
  const list = Array.isArray(sparks) ? sparks : [];
  /** @type {Record<string, Record<string, object[]>>} */
  const bySpark = {};
  let unmapped = 0;
  for (const helper of helpers || []) {
    if (!helper?.enabled || !helper.id) continue;
    const payload = caches?.get?.(helper.id) || caches?.[helper.id];
    if (!payload || !Array.isArray(payload.rows)) continue;
    for (const row of payload.rows) {
      if (!fresh(row, now, age)) continue;
      const target = assignRow(row, helper, list);
      if (!target) {
        unmapped += 1;
        continue;
      }
      const port = String(target.port);
      const bucket = (bySpark[target.sparkId] ??= {});
      (bucket[port] ??= []).push(toConversation(helper, row, payload, target));
    }
  }
  for (const sparkId of Object.keys(bySpark)) {
    for (const port of Object.keys(bySpark[sparkId])) {
      bySpark[sparkId][port] = uniquify(bySpark[sparkId][port]).sort(compareRows).slice(0, LIST_CAP);
    }
  }
  return { bySpark, unmapped };
}

function finiteAge(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return OCCUPANCY_AGE_DEFAULT_MS;
  return n;
}

function fresh(row, now, maxAgeMs) {
  const ts = timestamp(row);
  if (ts == null) return true;
  return now - ts <= maxAgeMs;
}

function timestamp(row) {
  if (!row?.updatedAt) return null;
  const parsed = Date.parse(row.updatedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function assignRow(row, helper, sparks) {
  const routes = (helper.routes || []).filter((route) => route && route.harness === row.harness);
  const cwd = row.cwd || "";
  const prefixed = routes
    .filter((route) => route.cwdPrefix && cwd.startsWith(route.cwdPrefix))
    .sort((a, b) => b.cwdPrefix.length - a.cwdPrefix.length);
  if (prefixed.length > 0) {
    return { sparkId: prefixed[0].sparkId, port: prefixed[0].port, provenance: "configured-route" };
  }
  const general = routes.filter((route) => !route.cwdPrefix);
  if (general.length === 1) {
    return { sparkId: general[0].sparkId, port: general[0].port, provenance: "configured-route" };
  }
  if (general.length > 1) return null;
  if (!ACP.has(row.harness) && row.originProvenance === "native" && row.origin) {
    const spark = sparks.find(
      (item) => item?.id && hostMatches(item, row.origin.host) && listenPorts(item).has(row.origin.port)
    );
    if (spark) return { sparkId: spark.id, port: row.origin.port, provenance: "native-endpoint" };
  }
  return null;
}

function hostMatches(spark, host) {
  const want = normalizeHost(host);
  if (!want) return false;
  const candidates = [spark.lanIp, spark.name, spark.ssh?.host, ...(spark.occupancyHosts || [])];
  return candidates.some((value) => normalizeHost(value) === want);
}

function listenPorts(spark) {
  const ports = new Set();
  for (const value of spark.llmPorts || []) {
    const port = Number(value);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port);
  }
  return ports;
}

function normalizeHost(value) {
  if (value == null) return "";
  let host = String(value).trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host;
}

function toConversation(helper, row, payload, target) {
  const adapter = payload.adapters?.[row.harness];
  const stale = Boolean(payload.stale || adapter?.stale);
  const lastUsedAt = timestamp(row);
  const handle = row.title || row.sessionId.slice(0, 8);
  const projected = {
    id: `${helper.id}:${row.harness}:${row.sessionId}`,
    source: row.harness,
    handle,
    badge: badgeFor(row),
    port: target.port,
    routingProvenance: target.provenance,
    stale,
  };
  if (lastUsedAt != null) projected.lastUsedAt = lastUsedAt;
  if (row.agent) projected.agent = row.agent;
  if (row.contextUsed != null) projected.contextUsed = row.contextUsed;
  if (row.contextWindow != null) projected.contextWindow = row.contextWindow;
  if (row.contextApprox) projected.contextApprox = true;
  return projected;
}

function badgeFor(row) {
  if (!HARNESS_IDS.includes(row.harness) || ACP.has(row.harness)) return "unknown";
  if (row.activityProvenance !== "native") return "unknown";
  if (row.activity === "generating") return "generating";
  if (row.activity === "stalled") return "stalled";
  return "unknown";
}

function uniquify(rows) {
  const used = new Set();
  return rows.map((row) => {
    if (!used.has(row.id)) {
      used.add(row.id);
      return row;
    }
    let n = 2;
    while (used.has(`${row.id}:${n}`)) n += 1;
    const id = `${row.id}:${n}`;
    used.add(id);
    return { ...row, id };
  });
}

function compareRows(a, b) {
  const live = Number(b.badge === "generating") - Number(a.badge === "generating");
  if (live) return live;
  const delta = (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);
  if (delta) return delta;
  return String(a.handle).localeCompare(String(b.handle)) || String(a.id).localeCompare(String(b.id));
}
