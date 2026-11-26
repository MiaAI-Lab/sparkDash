import { OCCUPANCY_AGE_DEFAULT_MS } from "../settings.js";
import { llmProbeHost } from "../collectors/llmHost.js";
import { ACP_HARNESS_IDS, HARNESS_IDS } from "./catalog.js";
import { PI_EXPIRE_MS, PI_GENERATION_MS, PI_STALE_MS, baseUrlEndpoint } from "./piSchema.js";

const ACP = new Set(ACP_HARNESS_IDS);

const LIST_CAP = 20;

/**
 * Assign helper rows onto Spark LLM ports.
 * ACP metadata never becomes "generating" or "stalled". A row with no explicit
 * route and no native endpoint stays unmapped. Pi is placed only by its request
 * destination, matched against the endpoint the card monitors.
 *
 * @returns {{ bySpark: Record<string, Record<string, object[]>>, unmapped: number }}
 */
export function projectOccupancy({ helpers, caches, sparks, now, maxAgeMs, endpoints }) {
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
      if (row.harness === "pi" && !piLive(row, now)) continue;
      const target = assignRow(row, helper, list, endpoints);
      if (!target) {
        unmapped += 1;
        continue;
      }
      const port = String(target.port);
      const bucket = (bySpark[target.sparkId] ??= {});
      (bucket[port] ??= []).push(toConversation(helper, row, payload, { ...target, now }));
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

function assignRow(row, helper, sparks, endpoints) {
  // Pi never uses saved routes or generic native-origin matching: only the
  // request destination can place it, so a cloud session in the same folder
  // stays off the Spark card.
  if (row.harness === "pi") return assignPi(row, helper, sparks, endpoints);
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

/**
 * The live LLM entries each card monitors, keyed by Spark id. A Pi destination
 * is matched against these, so a port alone is not enough: the card must also
 * report the model the session asked for.
 */
export function llmEndpoints(snapshots) {
  const out = {};
  for (const snap of Array.isArray(snapshots) ? snapshots : []) {
    if (!snap?.id) continue;
    out[snap.id] = (snap.metrics?.llm || []).map((entry) => ({
      port: Number(entry.port),
      modelId: typeof entry.modelId === "string" ? entry.modelId : null,
      models: Array.isArray(entry.models) ? entry.models.filter((model) => typeof model === "string") : [],
    }));
  }
  return out;
}

function endpointsFor(endpoints, sparkId) {
  if (endpoints instanceof Map) return endpoints.get(sparkId) || [];
  return endpoints?.[sparkId] || [];
}

function assignPi(row, helper, sparks, endpoints) {
  if (row.destinationEvidence !== "provider-matched" || !row.requestDestination) return null;
  const destination = row.requestDestination;
  const endpoint = baseUrlEndpoint(destination.baseUrl);
  if (!endpoint) return null;
  // A loopback destination means `this machine`, which for a Pi session is the
  // machine its helper runs on — never the dashboard host. A session on another
  // Spark that calls its own http://localhost:8000 therefore lands on that
  // Spark, or nowhere, and cannot claim the dashboard host's local Spark.
  const host = loopbackHost(endpoint.host) ? helperHost(helper) : endpoint.host;
  if (!host) return null;
  const spark = sparks.find(
    (item) => item?.id && monitoredHostMatches(item, host) && listenPorts(item).has(endpoint.port)
  );
  if (!spark) return null;
  const served = endpointsFor(endpoints, spark.id).find((entry) => entry.port === endpoint.port);
  if (!served) return null;
  const models = served.models.length > 0 ? served.models : served.modelId ? [served.modelId] : [];
  if (!models.includes(destination.model)) return null;
  return { sparkId: spark.id, port: endpoint.port, provenance: "pi-destination" };
}

/** Pi rows expire on their own clocks, independent of cache or poll freshness. */
function piLive(row, now) {
  const seen = row.lastSeenAt;
  return Number.isFinite(seen) && now - seen <= PI_EXPIRE_MS;
}

function piStale(row, now) {
  const seen = row.lastSeenAt;
  return !Number.isFinite(seen) || now - seen > PI_STALE_MS;
}

function piBadge(row, now, helperStale) {
  if (helperStale || piStale(row, now)) return "unknown";
  // Tools, requesting, idle and unknown phases are never a GPU-generation claim.
  if (row.phase !== "receiving") return "unknown";
  if (!row.requestOpen || row.destinationEvidence !== "provider-matched" || !row.requestDestination) return "unknown";
  if (!Number.isFinite(row.lastDeltaAt)) return "unknown";
  return now - row.lastDeltaAt <= PI_GENERATION_MS ? "generating" : "unknown";
}

function hostMatches(spark, host) {
  const want = normalizeHost(host);
  if (!want) return false;
  const candidates = [spark.lanIp, spark.name, spark.ssh?.host, ...(spark.occupancyHosts || [])];
  return candidates.some((value) => normalizeHost(value) === want);
}

/** Host the dashboard fetches this helper from; that host is the helper's own unit. */
function helperHost(helper) {
  try {
    return normalizeHost(new URL(String(helper?.url || "")).hostname);
  } catch {
    return "";
  }
}

function loopbackHost(value) {
  const host = normalizeHost(value);
  return host === "127.0.0.1" || host === "::1";
}

/**
 * A Pi destination must name the host the card's LLM probe actually talks to.
 * A pinned `llmHost` is a different machine from the SSH host, and a local
 * Spark is probed on loopback, so the origin aliases above would place a
 * session on a card that never sees its traffic. A loopback destination is
 * resolved to the helper's own host before this check.
 */function monitoredHostMatches(spark, host) {
  const want = normalizeHost(host);
  if (!want) return false;
  return normalizeHost(llmProbeHost(spark)) === want;
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
  if (host === "localhost" || host === "::1") host = "127.0.0.1";
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
    badge: row.harness === "pi" ? piBadge(row, target.now, stale) : badgeFor(row),
    port: target.port,
    routingProvenance: target.provenance,
    stale: row.harness === "pi" ? stale || piStale(row, target.now) : stale,
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
