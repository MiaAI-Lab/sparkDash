/**
 * OpenClaw conversation collector.
 * Projector input rows only: source, handle, origin, midTurn.
 * Occupancy is hasActiveRun (or status===running). Never transcripts. Never throws.
 */
import path from "node:path";
import { conventionalStateDir } from "../sessionSources.js";
import {
  parseBaseUrl,
  resolveStateDir,
  defaultReadFile,
  defaultReadDir,
  readOptional,
  normalizeSessionList,
  sanitizeProbeError,
  sessionLastUsedAt,
  sessionAgent,
  applySessionContext,
  stampAttachRows,
} from "./sessionIo.js";
import { defaultOpenClawGatewayRpc, gatewayDeviceKey } from "./openclawGateway.js";

const HANDLE_FIELDS = ["label", "displayName", "key"];

/**
 * @param {unknown} sessions
 * @param {Record<string, { baseUrl?: string }>} providers
 * @returns {object[]}
 */
export function mapOpenClawSessions(sessions, providers) {
  const list = normalizeSessions(sessions);
  const byId = providers && typeof providers === "object" ? providers : {};
  const rows = [];
  for (const item of list) {
    const row = mapOneSession(item, byId);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * @param {{ enabled?: boolean, mode?: string, url?: string, stateDir?: string }} attach
 * @param {object} [deps]
 * @returns {Promise<object[]>}
 */
export async function collectOpenClawSessions(attach, deps = {}) {
  try {
    if (!attach?.enabled) return [];
    const loaded = await loadOpenClawPayload(attach, deps);
    return stampAttachRows(mapOpenClawSessions(loaded.sessions, loaded.providers), attach);
  } catch {
    return [];
  }
}

/**
 * Connectivity probe for Settings. Counts only — never session handles or transcripts.
 * @returns {Promise<{ status: "disabled" | "ok" | "error", found: number, mapped: number, error: string | null }>}
 */
export async function diagnoseOpenClawSessions(attach, deps = {}) {
  if (!attach?.enabled) {
    return { status: "disabled", found: 0, mapped: 0, error: null };
  }
  if (attach.mode === "url" && !String(attach.url || "").trim()) {
    return { status: "error", found: 0, mapped: 0, error: "URL is required" };
  }
  if (attach.mode === "state-dir" && !String(attach.stateDir || "").trim()) {
    return { status: "error", found: 0, mapped: 0, error: "State dir is required" };
  }
  try {
    const loaded = await loadOpenClawPayload(attach, deps);
    if (attach.mode !== "url" && loaded.missingConfig) {
      return { status: "error", found: 0, mapped: 0, error: "OpenClaw state not found" };
    }
    const list = normalizeSessions(loaded.sessions);
    const rows = stampAttachRows(mapOpenClawSessions(loaded.sessions, loaded.providers), attach);
    return {
      status: "ok",
      found: list.length,
      mapped: deps.countMapped?.(rows) ?? rows.length,
      error: null,
    };
  } catch (err) {
    return { status: "error", found: 0, mapped: 0, error: sanitizeProbeError(err) };
  }
}

function mapOneSession(session, providers) {
  if (!session || typeof session !== "object") return null;
  const origin = parseBaseUrl(providers[session.modelProvider]?.baseUrl);
  if (!origin) return null;
  const handle = sessionHandle(session);
  if (!handle) return null;
  const lastUsedAt = sessionLastUsedAt(session);
  const agent = sessionAgent(session);
  const mapped = {
    source: "openclaw",
    id: sessionIdentity(session) || handle,
    handle,
    originHost: origin.host,
    originPort: origin.port,
    midTurn: midTurnOf(session),
  };
  if (lastUsedAt != null) mapped.lastUsedAt = lastUsedAt;
  if (agent) mapped.agent = agent;
  return applySessionContext(mapped, session);
}

function sessionIdentity(session) {
  for (const field of ["key", "sessionId", "id"]) {
    const value = session[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function sessionHandle(session) {
  for (const field of HANDLE_FIELDS) {
    const value = session[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function midTurnOf(session) {
  if (session.hasActiveRun === true) return true;
  if (session.hasActiveRun === false) return false;
  if (session.status === "running") return true;
  return "unknown";
}

function normalizeSessions(sessions) {
  const listed = normalizeSessionList(sessions);
  if (listed) return listed;
  if (sessions && typeof sessions === "object") return sessionsFromMap(sessions);
  return [];
}

function sessionsFromMap(store) {
  const rows = [];
  for (const [key, value] of Object.entries(store)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    rows.push({ key, ...value });
  }
  return rows;
}

async function loadOpenClawPayload(attach, deps) {
  if (attach.mode === "url") return loadFromUrl(attach, deps);
  return loadFromStateDir(attach, deps);
}

async function loadFromUrl(attach, deps) {
  if (typeof deps.gatewayRpc === "function") {
    return unwrapGatewayPayload(await deps.gatewayRpc(attach.url, deps.token));
  }
  if (typeof deps.fetchJson === "function") {
    return unwrapGatewayPayload(await deps.fetchJson(attach.url, { token: deps.token }));
  }
  return unwrapGatewayPayload(
    await defaultOpenClawGatewayRpc(attach.url, deps.token, {
      deviceKey: gatewayDeviceKey(attach.url, attach.id),
    })
  );
}

function unwrapGatewayPayload(payload) {
  if (!payload || typeof payload !== "object") return { sessions: [], providers: {} };
  const sessions = Array.isArray(payload)
    ? payload
    : (normalizeSessionList(payload.sessions) ?? payload.sessions ?? []);
  return {
    sessions,
    providers: payload.providers ?? payload.models?.providers ?? {},
  };
}

async function loadAgentSessionStores(dir, readFile, readDir) {
  let names = [];
  try {
    names = await readDir(path.join(dir, "agents"));
  } catch {
    return {};
  }
  const rows = [];
  for (const entry of names) {
    const name = typeof entry === "string" ? entry : entry?.name;
    if (!name || name.startsWith(".")) continue;
    const raw = await readOptional(readFile, path.join(dir, "agents", name, "sessions", "sessions.json"));
    if (!raw) continue;
    try {
      for (const session of normalizeSessions(JSON.parse(raw))) {
        if (!session || typeof session !== "object") continue;
        rows.push(session.agentId ? session : { ...session, agentId: name });
      }
    } catch {
      /* skip corrupt agent store */
    }
  }
  return rows;
}

async function loadFromStateDir(attach, deps) {
  const dir = resolveStateDir(
    attach,
    deps,
    deps.conventionalStateDir ?? conventionalStateDir("openclaw")
  );
  if (!dir) return { sessions: [], providers: {}, missingConfig: true };
  const readFile = deps.readFile ?? defaultReadFile;
  const readDir = deps.readDir ?? defaultReadDir;
  const configRaw = await readOptional(readFile, path.join(dir, "openclaw.json"));
  if (!configRaw) return { sessions: [], providers: {}, missingConfig: true };
  const config = JSON.parse(configRaw);
  const siblingRaw = await readOptional(readFile, path.join(dir, "sessions.json"));
  let sessionsRaw;
  if (siblingRaw) {
    sessionsRaw = JSON.parse(siblingRaw);
  } else {
    sessionsRaw = await loadAgentSessionStores(dir, readFile, readDir);
  }
  return {
    sessions: sessionsRaw?.sessions ?? sessionsRaw,
    providers: config?.models?.providers ?? {},
    missingConfig: false,
  };
}
