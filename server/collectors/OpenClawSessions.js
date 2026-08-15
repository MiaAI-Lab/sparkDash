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
  defaultFetchJson,
  normalizeSessionList,
} from "./sessionIo.js";

const HANDLE_FIELDS = ["label", "displayName", "key"];

export { parseBaseUrl };

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
    return mapOpenClawSessions(loaded.sessions, loaded.providers);
  } catch {
    return [];
  }
}

function mapOneSession(session, providers) {
  if (!session || typeof session !== "object") return null;
  const origin = parseBaseUrl(providers[session.modelProvider]?.baseUrl);
  if (!origin) return null;
  const handle = sessionHandle(session);
  if (!handle) return null;
  return {
    source: "openclaw",
    handle,
    originHost: origin.host,
    originPort: origin.port,
    midTurn: midTurnOf(session),
  };
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
  if (typeof deps.rpc === "function") return loadFromRpc(deps.rpc);
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  return unwrapGatewayPayload(await fetchJson(attach.url, { token: deps.token }));
}

async function loadFromRpc(rpc) {
  const [listed, config] = await Promise.all([rpc("sessions.list"), rpc("config.get")]);
  const sessions = Array.isArray(listed) ? listed : listed?.sessions ?? listed;
  return { sessions, providers: config?.models?.providers ?? {} };
}

function unwrapGatewayPayload(payload) {
  if (!payload || typeof payload !== "object") return { sessions: [], providers: {} };
  return {
    sessions: payload.sessions ?? [],
    providers: payload.providers ?? payload.models?.providers ?? {},
  };
}

async function loadFromStateDir(attach, deps) {
  const dir = resolveStateDir(
    attach,
    deps,
    deps.conventionalStateDir ?? conventionalStateDir("openclaw")
  );
  const readFile = deps.readFile ?? defaultReadFile;
  const [configRaw, sessionsRawText] = await Promise.all([
    readFile(path.join(dir, "openclaw.json")),
    readFile(path.join(dir, "sessions.json")),
  ]);
  const config = JSON.parse(configRaw);
  const sessionsRaw = JSON.parse(sessionsRawText);
  return {
    sessions: sessionsRaw?.sessions ?? sessionsRaw,
    providers: config?.models?.providers ?? {},
  };
}
