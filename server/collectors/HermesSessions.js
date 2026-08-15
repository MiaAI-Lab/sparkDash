/**
 * Hermes Agent conversation reader (U4).
 * Projector input rows only: source, handle, origin, midTurn.
 * Recency is_active is never mid-turn. Never transcripts. Never throws.
 *
 * Local/state-dir: sessions.json plus optional config.json or profile.json
 * (`model.base_url`). URL mode: GET /api/sessions. Native sqlite (state.db)
 * is not read — better-sqlite3 is not a dependency.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOST_PATHS } from "../config.js";
import { conventionalStateDir } from "../sessionSources.js";

const HANDLE_FIELDS = ["title", "source", "id"];
const LIVE_STATUS = new Set(["working", "running"]);
const PROFILE_FILES = ["config.json", "profile.json"];

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
 * @param {object} [profiles]
 * @returns {object[]}
 */
export function mapHermesSessions(sessions, profiles) {
  const list = normalizeSessions(sessions);
  const rows = [];
  for (const item of list) {
    const row = mapOneSession(item, profiles);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * @param {{ enabled?: boolean, mode?: string, url?: string, stateDir?: string }} attach
 * @param {object} [deps]
 * @returns {Promise<object[]>}
 */
export async function collectHermesSessions(attach, deps = {}) {
  try {
    if (!attach?.enabled) return [];
    const loaded = await loadHermesPayload(attach, deps);
    if (!loaded) return [];
    return mapHermesSessions(loaded.sessions, loaded.profiles);
  } catch {
    return [];
  }
}

function mapOneSession(session, profiles) {
  if (!session || typeof session !== "object") return null;
  const origin = parseBaseUrl(originUrlOf(session, profiles));
  if (!origin) return null;
  const handle = sessionHandle(session);
  if (!handle) return null;
  return {
    source: "hermes",
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
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function midTurnOf(session) {
  if (LIVE_STATUS.has(session.status)) return true;
  return "unknown";
}

function originUrlOf(session, profiles) {
  if (typeof session.billing_base_url === "string" && session.billing_base_url.trim()) {
    return session.billing_base_url.trim();
  }
  return profileBaseUrl(profiles);
}

function profileBaseUrl(profiles) {
  if (!profiles || typeof profiles !== "object") return "";
  const nested = profiles.model?.base_url;
  if (typeof nested === "string" && nested.trim()) return nested.trim();
  if (typeof profiles.base_url === "string" && profiles.base_url.trim()) {
    return profiles.base_url.trim();
  }
  return "";
}

function normalizeSessions(sessions) {
  if (Array.isArray(sessions)) return sessions;
  if (sessions && Array.isArray(sessions.sessions)) return sessions.sessions;
  return [];
}

async function loadHermesPayload(attach, deps) {
  if (typeof deps.listSessions === "function") {
    return {
      sessions: await deps.listSessions(),
      profiles: deps.profiles ?? {},
    };
  }
  if (attach.mode === "url") return loadFromUrl(attach, deps);
  return loadFromStateDir(attach, deps);
}

async function loadFromUrl(attach, deps) {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const token = deps.token;
  const payload = await fetchJson(sessionsUrl(attach.url), { token });
  const profiles = deps.profiles ?? (await loadProfilesFromUrl(attach.url, fetchJson, token));
  return { sessions: payload, profiles };
}

function sessionsUrl(raw) {
  const base = String(raw || "").replace(/\/+$/, "");
  if (!base) return "";
  if (/\/api\/sessions(?:\?|$)/.test(base)) {
    return base.includes("?") ? base : `${base}?limit=50`;
  }
  return `${base}/api/sessions?limit=50`;
}

async function loadProfilesFromUrl(raw, fetchJson, token) {
  const base = String(raw || "").replace(/\/+$/, "");
  for (const suffix of ["/api/config", "/api/profile"]) {
    try {
      const payload = await fetchJson(`${base}${suffix}`, { token });
      if (payload && typeof payload === "object") return payload;
    } catch {
      // optional profile/config
    }
  }
  return {};
}

async function loadFromStateDir(attach, deps) {
  const dir = resolveStateDir(attach, deps);
  const readFile = deps.readFile ?? ((filePath) => fs.promises.readFile(filePath, "utf8"));
  const sessionsRaw = JSON.parse(await readFile(path.join(dir, "sessions.json")));
  const profiles = await loadProfilesFromDir(dir, readFile);
  return { sessions: sessionsRaw, profiles };
}

async function loadProfilesFromDir(dir, readFile) {
  for (const name of PROFILE_FILES) {
    try {
      const raw = JSON.parse(await readFile(path.join(dir, name)));
      if (raw && typeof raw === "object") return raw;
    } catch {
      // optional
    }
  }
  return {};
}

function resolveStateDir(attach, deps) {
  const home = deps.homedir ?? os.homedir();
  if (attach.mode === "state-dir" && attach.stateDir) {
    return expandTilde(attach.stateDir, home);
  }
  const conventional = deps.conventionalStateDir ?? conventionalStateDir("hermes");
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
