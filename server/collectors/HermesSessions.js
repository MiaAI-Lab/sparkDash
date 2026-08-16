/**
 * Hermes Agent conversation reader.
 * Projector input rows only: source, handle, origin, midTurn.
 * Recency is_active is never mid-turn. running:true or status working/running
 * is mid-turn. Never transcripts. Never throws.
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
  defaultFetchResponse,
  normalizeSessionList,
  sanitizeProbeError,
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

/**
 * Connectivity probe for Settings. Counts only — never session titles or transcripts.
 * @returns {Promise<{ status: "disabled" | "ok" | "error", found: number, mapped: number, error: string | null }>}
 */
export async function diagnoseHermesSessions(attach, deps = {}) {
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
    const loaded = await loadHermesPayload(attach, deps);
    const list = normalizeSessions(loaded.sessions);
    const rows = mapHermesSessions(loaded.sessions, loaded.profiles);
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
  if (session.running === true) return true;
  return "unknown";
}

function originOf(session, profileOrigin) {
  for (const raw of [session.billing_base_url, session.base_url, session.model?.base_url]) {
    if (typeof raw === "string" && raw.trim()) {
      const origin = parseBaseUrl(raw.trim());
      if (origin) return origin;
    }
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
  const token = deps.token;
  if (typeof deps.fetchJson === "function") {
    const payload = await deps.fetchJson(sessionsUrl(attach.url), { token });
    const profiles = deps.profiles ?? (await loadProfilesFromUrl(attach.url, deps.fetchJson, token));
    return { sessions: payload, profiles };
  }
  const origin = gatewayOrigin(attach.url);
  const fetchResponse = deps.fetchResponse ?? defaultFetchResponse;
  const getJson = await hermesAuthedGetter(origin, token, fetchResponse);
  const payload = await getJson(sessionsUrl(attach.url));
  const profiles = deps.profiles ?? (await loadProfilesFromUrl(attach.url, getJson, token));
  return { sessions: payload, profiles };
}

const cookieCache = new Map();

export function resetHermesAuthCache() {
  cookieCache.clear();
}

function cookieCacheKey(origin, token) {
  return `${origin}\0${token}`;
}

async function hermesAuthedGetter(origin, token, fetchResponse) {
  if (!token) {
    return async function getJson(url) {
      const res = await fetchResponse(url);
      return res.json();
    };
  }
  let cookie = "";
  try {
    cookie = await cookieFor(origin, token, fetchResponse);
  } catch (err) {
    if (!isMissingLoginEndpoint(err)) throw err;
  }
  if (!cookie) {
    return async function getJson(url) {
      const res = await fetchResponse(url, { token });
      return res.json();
    };
  }
  return async function getJson(url) {
    try {
      const res = await fetchResponse(url, { cookie });
      return res.json();
    } catch (err) {
      if (Number(err?.status) !== 401) throw err;
      cookieCache.delete(cookieCacheKey(origin, token));
      cookie = await cookieFor(origin, token, fetchResponse);
      const res = await fetchResponse(url, { cookie });
      return res.json();
    }
  };
}

function isMissingLoginEndpoint(err) {
  const status = Number(err?.status);
  return status === 404 || status === 405;
}

async function cookieFor(origin, token, fetchResponse) {
  const key = cookieCacheKey(origin, token);
  const cached = cookieCache.get(key);
  if (cached) return cached;
  const cookie = await loginHermes(origin, token, fetchResponse);
  if (cookie) cookieCache.set(key, cookie);
  return cookie;
}

async function loginHermes(origin, token, fetchResponse) {
  const res = await fetchResponse(`${origin}/api/auth/login`, {
    method: "POST",
    extraHeaders: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: token }),
  });
  return sessionCookieFromResponse(res);
}

function sessionCookieFromResponse(res) {
  const headers = res?.headers;
  if (!headers) return "";
  const rawList =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie")].filter(Boolean);
  for (const raw of rawList) {
    const first = String(raw).split(";", 1)[0].trim();
    if (first.toLowerCase().startsWith("hermes_session=")) return first;
  }
  return "";
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
  return `${base}/api/sessions?limit=50&include_cli=1`;
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
