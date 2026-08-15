/**
 * Hermes Agent conversation reader.
 * Projector input rows only: source, handle, origin, midTurn.
 * Recency is_active is never mid-turn. Never transcripts. Never throws.
 *
 * Local/state-dir: sessions.json plus optional config.json or profile.json
 * (`model.base_url`). URL mode: GET /api/sessions. Native sqlite (state.db)
 * is not read — better-sqlite3 is not a dependency.
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

const HANDLE_FIELDS = ["title", "source", "id"];
const LIVE_STATUS = new Set(["working", "running"]);
const PROFILE_FILES = ["config.json", "profile.json"];

/**
 * @param {unknown} sessions
 * @param {object} [profiles]
 * @returns {object[]}
 */
export function mapHermesSessions(sessions, profiles) {
  const list = normalizeSessions(sessions);
  const profileOrigin = parseBaseUrl(profileBaseUrl(profiles));
  const rows = [];
  for (const item of list) {
    const row = mapOneSession(item, profileOrigin);
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
    return mapHermesSessions(loaded.sessions, loaded.profiles);
  } catch {
    return [];
  }
}

function mapOneSession(session, profileOrigin) {
  if (!session || typeof session !== "object") return null;
  const origin = originOf(session, profileOrigin);
  if (!origin) return null;
  const handle = sessionHandle(session);
  if (!handle) return null;
  return {
    source: "hermes",
    id: sessionIdentity(session) || handle,
    handle,
    originHost: origin.host,
    originPort: origin.port,
    midTurn: midTurnOf(session),
  };
}

function sessionIdentity(session) {
  for (const field of ["id", "session_id", "sessionId"]) {
    const value = session[field];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
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

function originOf(session, profileOrigin) {
  if (typeof session.billing_base_url === "string" && session.billing_base_url.trim()) {
    return parseBaseUrl(session.billing_base_url.trim());
  }
  return profileOrigin;
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
  return normalizeSessionList(sessions) ?? [];
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

function gatewayOrigin(raw) {
  return String(raw || "")
    .replace(/\/+$/, "")
    .replace(/\/api\/sessions(?:\?.*)?$/, "");
}

function sessionsUrl(raw) {
  const base = gatewayOrigin(raw);
  if (!base) return "";
  const original = String(raw || "");
  if (/\/api\/sessions\?/.test(original)) return original.replace(/\/+$/, "");
  return `${base}/api/sessions?limit=50`;
}

async function loadProfilesFromUrl(raw, fetchJson, token) {
  const base = gatewayOrigin(raw);
  for (const suffix of ["/api/config", "/api/profile"]) {
    try {
      const payload = await fetchJson(`${base}${suffix}`, { token });
      if (profileBaseUrl(payload)) return payload;
    } catch {
      // optional profile/config
    }
  }
  return {};
}

async function loadFromStateDir(attach, deps) {
  const dir = resolveStateDir(
    attach,
    deps,
    deps.conventionalStateDir ?? conventionalStateDir("hermes")
  );
  if (!dir) return { sessions: [], profiles: {} };
  const readFile = deps.readFile ?? defaultReadFile;
  const [sessionsRaw, profiles] = await Promise.all([
    readFile(path.join(dir, "sessions.json")).then((raw) => JSON.parse(raw)),
    loadProfilesFromDir(dir, readFile),
  ]);
  return { sessions: sessionsRaw, profiles };
}

async function loadProfilesFromDir(dir, readFile) {
  for (const name of PROFILE_FILES) {
    try {
      const raw = JSON.parse(await readFile(path.join(dir, name)));
      if (profileBaseUrl(raw)) return raw;
    } catch {
      // optional
    }
  }
  return {};
}
