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
  sessionLastUsedAt,
  sessionAgent,
  applySessionContext,
  profileFromStateDir,
  defaultReadDir,
  stampAttachRows,
} from "./sessionIo.js";
import { hermesAuthedGetter } from "./hermesAuth.js";

export { resetHermesAuthCache } from "./hermesAuth.js";

const HANDLE_FIELDS = ["title", "source", "id"];
const LIVE_STATUS = new Set(["working", "running"]);
const PROFILE_FILES = ["config.json", "profile.json"];

/**
 * @param {unknown} sessions
 * @param {object} [profiles]
 * @returns {object[]}
 */
export function mapHermesSessions(sessions, profiles, agentFallback = "") {
  const list = normalizeSessions(sessions);
  const profileOrigin = parseBaseUrl(profileBaseUrl(profiles));
  const fallback = sessionAgent(profiles, agentFallback);
  const rows = [];
  for (const item of list) {
    const row = mapOneSession(item, profileOrigin, fallback);
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
    return stampAttachRows(mapLoadedHermes(loaded), attach);
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
    const list = hermesBundles(loaded).flatMap((bundle) => normalizeSessions(bundle.sessions));
    const rows = stampAttachRows(mapLoadedHermes(loaded), attach);
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

function hermesBundles(loaded) {
  if (Array.isArray(loaded?.bundles)) return loaded.bundles;
  return [{ sessions: loaded?.sessions, profiles: loaded?.profiles, agent: loaded?.agent }];
}

function mapLoadedHermes(loaded) {
  return hermesBundles(loaded).flatMap((bundle) =>
    mapHermesSessions(bundle.sessions, bundle.profiles, bundle.agent)
  );
}

function mapOneSession(session, profileOrigin, fallback) {
  if (!session || typeof session !== "object") return null;
  const origin = originOf(session, profileOrigin);
  if (!origin) return null;
  const handle = sessionHandle(session);
  if (!handle) return null;
  const lastUsedAt = sessionLastUsedAt(session);
  const agent = sessionAgent(session, fallback);
  const mapped = {
    source: "hermes",
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
    return hermesBundle(await deps.listSessions(), deps.profiles ?? {}, "");
  }
  if (attach.mode === "url") return loadFromUrl(attach, deps);
  return loadFromStateDir(attach, deps);
}

function hermesBundle(sessions, profiles, agent) {
  return { bundles: [{ sessions, profiles, agent: sessionAgent(profiles, agent) }] };
}

async function loadFromUrl(attach, deps) {
  const token = deps.token;
  if (typeof deps.fetchJson === "function") {
    const payload = await deps.fetchJson(sessionsUrl(attach.url), { token });
    const profiles = deps.profiles ?? (await loadProfilesFromUrl(attach.url, deps.fetchJson, token));
    return hermesBundle(payload, profiles, "");
  }
  const origin = gatewayOrigin(attach.url);
  const fetchResponse = deps.fetchResponse ?? defaultFetchResponse;
  const getJson = await hermesAuthedGetter(origin, token, fetchResponse, attach.username);
  const payload = await getJson(sessionsUrl(attach.url));
  const profiles = deps.profiles ?? (await loadProfilesFromUrl(attach.url, getJson, token));
  return hermesBundle(payload, profiles, "");
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
  if (!dir) return { bundles: [] };
  const readFile = deps.readFile ?? defaultReadFile;
  const readDir = deps.readDir ?? defaultReadDir;
  const homes = await listHermesHomes(dir, readDir);
  const bundles = [];
  for (const home of homes) {
    try {
      const sessions = JSON.parse(await readFile(path.join(home.dir, "sessions.json")));
      const profiles = await loadProfilesFromDir(home.dir, readFile);
      bundles.push({ sessions, profiles, agent: home.agent });
    } catch {
      // skip missing or unreadable profile store
    }
  }
  return { bundles };
}

async function listHermesHomes(dir, readDir) {
  let names = [];
  try {
    names = await readDir(path.join(dir, "profiles"));
  } catch {
    names = [];
  }
  const homes = [];
  for (const entry of names) {
    const name = typeof entry === "string" ? entry : entry?.name;
    if (!name || name.startsWith(".")) continue;
    homes.push({ dir: path.join(dir, "profiles", name), agent: name });
  }
  if (homes.length > 0) return homes;
  return [{ dir, agent: profileFromStateDir(dir) }];
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
