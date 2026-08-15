/**
 * OpenClaw conversation collector (U3).
 * Projector input rows only: source, handle, origin, midTurn.
 * Occupancy is hasActiveRun (or status===running). Never transcripts. Never throws.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOST_PATHS } from "../config.js";
import { conventionalStateDir } from "../sessionSources.js";

const HANDLE_FIELDS = ["label", "displayName", "key"];

/**
 * @param {string} url
 * @returns {{ host: string, port: number } | null}
 */
export function parseBaseUrl(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (!host) return null;
    const port = parsed.port
      ? Number(parsed.port)
      : parsed.protocol === "https:"
        ? 443
        : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port };
  } catch {
    return null;
  }
}

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
    if (!loaded) return [];
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
  if (Array.isArray(sessions)) return sessions;
  if (sessions && Array.isArray(sessions.sessions)) return sessions.sessions;
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
  const dir = resolveStateDir(attach, deps);
  const readFile = deps.readFile ?? ((filePath) => fs.promises.readFile(filePath, "utf8"));
  const config = JSON.parse(await readFile(path.join(dir, "openclaw.json")));
  const sessionsRaw = JSON.parse(await readFile(path.join(dir, "sessions.json")));
  return {
    sessions: sessionsRaw?.sessions ?? sessionsRaw,
    providers: config?.models?.providers ?? {},
  };
}

function resolveStateDir(attach, deps) {
  const home = deps.homedir ?? os.homedir();
  if (attach.mode === "state-dir" && attach.stateDir) {
    return expandTilde(attach.stateDir, home);
  }
  const conventional = deps.conventionalStateDir ?? conventionalStateDir("openclaw");
  return remapHostRoot(expandTilde(String(conventional || ""), home), deps);
}

function expandTilde(raw, home) {
  const value = String(raw || "");
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

function remapHostRoot(expanded, deps) {
  const hostRoot = deps.hostRoot === undefined ? HOST_PATHS.ROOT : deps.hostRoot;
  if (!hostRoot) return expanded;
  const isReadable = deps.isReadable ?? pathReadable;
  if (isReadable(expanded)) return expanded;
  if (!expanded.startsWith("/") || !isReadable(hostRoot)) return expanded;
  const mapped = path.join(hostRoot, expanded.slice(1));
  return isReadable(mapped) ? mapped : expanded;
}

function pathReadable(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

async function defaultFetchJson(url, { token } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}
