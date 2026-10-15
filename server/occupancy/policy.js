import dns from "node:dns/promises";
import { assertAllowedTarget } from "../validate.js";
import { fetchPinned } from "./pinnedFetch.js";
import { ACP_HARNESS_IDS, COVERAGE, HARNESS_IDS } from "./catalog.js";

const ACP = new Set(ACP_HARNESS_IDS);
const ROW_CAP = 500;

export function helperAllowlist(env = process.env) {
  const allowed = new Set(["localhost", "127.0.0.1", "::1"]);
  for (const part of String(env.SPARKDASH_HELPER_HOSTS || "").split(",")) {
    const host = part.trim();
    if (host) allowed.add(host);
  }
  return allowed;
}

export function parseHelperUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || "").trim());
  } catch {
    throw status(400, "Invalid helper URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw status(400, "Helper URL must be http or https");
  }
  if (parsed.username || parsed.password) {
    throw status(400, "URL userinfo is not allowed");
  }
  if (!parsed.hostname) throw status(400, "Helper URL needs a host");
  if (parsed.pathname === "" || parsed.pathname === "/") parsed.pathname = "/occupancy";
  return parsed;
}

/**
 * Resolve the helper host against the administrator allowlist, then GET it
 * pinned to those addresses. A second DNS lookup cannot move the connection.
 */
export async function fetchHelper(rawUrl, { token = "", allowlist, lookup = dns.lookup, signal, timeoutMs, maxBytes } = {}) {
  const parsed = parseHelperUrl(rawUrl);
  const addresses = await assertAllowedTarget(parsed.hostname, allowlist ?? helperAllowlist(), { lookup });
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetchPinned(parsed, { addresses, headers, signal, timeoutMs, maxBytes });
  let body;
  try {
    body = JSON.parse(response.body);
  } catch {
    throw status(502, "Helper response was not JSON");
  }
  return normalizeOccupancyPayload(body);
}

export function normalizeOccupancyPayload(body, now = Date.now()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw status(502, "Helper response was not an occupancy object");
  }
  const adapters = {};
  const rawAdapters = body.adapters && typeof body.adapters === "object" ? body.adapters : {};
  for (const id of HARNESS_IDS) {
    const item = rawAdapters[id];
    if (!item || typeof item !== "object") continue;
    adapters[id] = {
      coverage: COVERAGE.includes(item.coverage) ? item.coverage : "unavailable",
      stale: Boolean(item.stale),
      rows: Number.isFinite(Number(item.rows)) ? Number(item.rows) : 0,
      error: typeof item.error === "string" && item.error ? item.error.slice(0, 200) : null,
    };
  }
  const rawRows = Array.isArray(body.rows) ? body.rows : [];
  const rows = [];
  for (const raw of rawRows) {
    if (rows.length >= ROW_CAP) break;
    const row = normalizeRow(raw);
    if (row) rows.push(row);
  }
  const observed = Number(body.observedAt);
  return {
    schemaVersion: 1,
    observedAt: Number.isFinite(observed) ? observed : now,
    adapters,
    rows,
    truncated: rawRows.length > ROW_CAP,
  };
}

function normalizeRow(raw) {
  if (!raw || typeof raw !== "object") return null;
  const harness = String(raw.harness || "");
  if (!HARNESS_IDS.includes(harness)) return null;
  const sessionId = String(raw.sessionId || "").trim();
  if (!sessionId || sessionId.length > 200) return null;
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 200) : "";
  const cwd = typeof raw.cwd === "string" ? raw.cwd.trim().slice(0, 500) : "";
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : "";
  let activity = "unknown";
  let activityProvenance = "none";
  if (!ACP.has(harness) && raw.activityProvenance === "native") {
    if (raw.activity === "generating" || raw.activity === "stalled") {
      activity = raw.activity;
      activityProvenance = "native";
    }
  }
  let origin = null;
  let originProvenance = "none";
  if (
    !ACP.has(harness) &&
    raw.originProvenance === "native" &&
    raw.origin &&
    typeof raw.origin.host === "string" &&
    Number.isInteger(Number(raw.origin.port))
  ) {
    origin = { host: raw.origin.host, port: Number(raw.origin.port) };
    originProvenance = "native";
  }
  const contextUsed = finitePositive(raw.contextUsed);
  const contextWindow = finitePositive(raw.contextWindow);
  return {
    harness,
    sessionId,
    title,
    cwd,
    updatedAt,
    activity,
    activityProvenance,
    origin,
    originProvenance,
    contextUsed,
    contextWindow,
    contextApprox: raw.contextApprox === true,
    agent: typeof raw.agent === "string" ? raw.agent.trim().slice(0, 120) : "",
  };
}

function finitePositive(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function status(code, message) {
  const err = new Error(message);
  err.status = code;
  return err;
}
