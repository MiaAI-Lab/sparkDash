/**
 * OpenCode occupancy collector.
 * Projector input rows only: source, handle, origin, midTurn unknown.
 * Local attach reads sqlite session rows. URL attach polls a helper.
 * Never throws. Never reads transcript tables.
 */
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { conventionalStateDir } from "../sessionSourceRegistry.js";
import {
  parseBaseUrl,
  parseSessionTime,
  resolveStateDir,
  resolveConfigDir,
  readOptional,
  sanitizeProjectorRow,
  defaultReadFile,
  defaultFetchJson,
  sanitizeProbeError,
  stampAttachRows,
  applySessionContext,
} from "./sessionIo.js";

const SOURCE = "opencode";
const MAX_HELPER_ROWS = 500;
const SESSION_COLUMNS = ["id", "title", "model", "time_updated", "tokens_input"];
const PROJECTOR_ROW_KEYS = [
  "source",
  "id",
  "handle",
  "originHost",
  "originPort",
  "lastUsedAt",
  "midTurn",
  "contextUsed",
  "contextWindow",
  "contextApprox",
];
const BUSY_RETRY_MS = 50;

export function sanitizeOpenCodeRow(row) {
  return sanitizeProjectorRow(row, SOURCE, PROJECTOR_ROW_KEYS);
}

/**
 * Parse JSON with `//` comments and block comments. Strings are left intact.
 * Trailing commas outside strings are stripped.
 * @param {string} text
 */
export function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripJsoncComments(String(text ?? ""))));
}

/**
 * @param {unknown} sessions
 * @param {Record<string, { options?: { baseURL?: string, baseUrl?: string } }>} providers
 */
export function mapOpenCodeSessions(sessions, providers) {
  const list = Array.isArray(sessions) ? sessions : [];
  const byId = providers && typeof providers === "object" ? providers : {};
  const rows = [];
  for (const item of list) {
    const row = mapOneSession(item, byId);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * One sqlite/helper read for collect, diagnose, and the occupancy helper.
 * @returns {Promise<{ missingState: boolean, invalidHelper: boolean, found: number, rows: object[] }>}
 */
export async function loadOpenCodeOccupancy(attach, deps = {}) {
  const loaded = await loadOpenCodePayload(attach, deps);
  const rows = stampMapped(loaded, attach).map(sanitizeOpenCodeRow);
  const found = loaded.found ?? (Array.isArray(loaded.sessions) ? loaded.sessions.length : rows.length);
  return {
    missingState: Boolean(loaded.missingState),
    invalidHelper: Boolean(loaded.invalidHelper),
    found,
    rows,
  };
}

export async function collectOpenCodeSessions(attach, deps = {}) {
  try {
    if (!attach?.enabled) return [];
    return (await loadOpenCodeOccupancy(attach, deps)).rows;
  } catch {
    return [];
  }
}

/**
 * @returns {Promise<{ status: "disabled" | "ok" | "error", found: number, mapped: number, error: string | null }>}
 */
export async function diagnoseOpenCodeSessions(attach, deps = {}) {
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
    const loaded = await loadOpenCodeOccupancy(attach, deps);
    if (loaded.invalidHelper) {
      return { status: "error", found: 0, mapped: 0, error: "Invalid occupancy payload" };
    }
    if (attach.mode !== "url" && loaded.missingState) {
      return { status: "error", found: 0, mapped: 0, error: "OpenCode state not found" };
    }
    return {
      status: "ok",
      found: loaded.found,
      mapped: deps.countMapped?.(loaded.rows) ?? loaded.rows.length,
      error: null,
    };
  } catch (err) {
    return { status: "error", found: 0, mapped: 0, error: sanitizeProbeError(err) };
  }
}

function stampMapped(loaded, attach) {
  if (loaded.preMapped) return stampAttachRows(loaded.preMapped, attach);
  return stampAttachRows(mapOpenCodeSessions(loaded.sessions, loaded.providers), attach);
}

function mapOneSession(session, providers) {
  if (!session || typeof session !== "object") return null;
  const handle = typeof session.title === "string" ? session.title.trim() : "";
  if (!handle) return null;
  const providerId = providerIdFromModel(session.model);
  if (!providerId) return null;
  const origin = parseBaseUrl(providerBaseUrl(providers[providerId]));
  if (!origin) return null;
  const lastUsedAt = parseSessionTime(session.time_updated) ?? parseSessionTime(session.updatedAt);
  const mapped = {
    source: SOURCE,
    id: sessionIdentity(session) || handle,
    handle,
    originHost: origin.host,
    originPort: origin.port,
    midTurn: "unknown",
  };
  if (lastUsedAt != null) mapped.lastUsedAt = lastUsedAt;
  // tokens_input is cumulative session usage, not KV-cache fill.
  return applySessionContext(mapped, {
    input_tokens: session.tokens_input,
    totalTokensFresh: false,
  });
}

function sessionIdentity(session) {
  const value = session.id;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function providerIdFromModel(model) {
  if (model == null || model === "") return "";
  let parsed = model;
  if (typeof model === "string") {
    try {
      parsed = JSON.parse(model);
    } catch {
      return "";
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const id = parsed.providerID ?? parsed.providerId;
  return typeof id === "string" && id.trim() ? id.trim() : "";
}

function providerBaseUrl(entry) {
  if (!entry || typeof entry !== "object") return "";
  const options = entry.options && typeof entry.options === "object" ? entry.options : {};
  const raw = options.baseURL ?? options.baseUrl ?? entry.baseURL ?? entry.baseUrl;
  return typeof raw === "string" ? raw.trim() : "";
}

async function loadOpenCodePayload(attach, deps) {
  if (attach.mode === "url") return loadFromUrl(attach, deps);
  return loadFromStateDir(attach, deps);
}

async function loadFromUrl(attach, deps) {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const payload = await fetchJson(String(attach.url || "").trim(), { token: deps.token });
  const parsed = parseHelperPayload(payload);
  if (parsed.error) return { sessions: [], providers: {}, preMapped: [], found: 0, invalidHelper: true };
  const preMapped = parsed.rows
    .filter((row) => row && typeof row === "object")
    .map((row) => sanitizeOpenCodeRow(row));
  return {
    sessions: parsed.rows,
    providers: {},
    preMapped,
    found: parsed.found,
  };
}

function parseHelperPayload(payload) {
  if (Array.isArray(payload)) {
    if (payload.length > MAX_HELPER_ROWS) return { error: true };
    return { found: payload.length, rows: payload };
  }
  if (!payload || typeof payload !== "object") return { error: true };
  if (!Array.isArray(payload.rows)) return { error: true };
  if (payload.rows.length > MAX_HELPER_ROWS) return { error: true };
  const found = Number.isFinite(Number(payload.found)) ? Number(payload.found) : payload.rows.length;
  return { found, rows: payload.rows };
}

async function loadFromStateDir(attach, deps) {
  const dataDir = resolveStateDir(
    attach,
    deps,
    deps.conventionalStateDir ?? conventionalStateDir(SOURCE)
  );
  const configDir = resolveConfigDir(SOURCE, deps);
  if (!dataDir) return { sessions: [], providers: {}, missingState: true };
  const readFile = deps.readFile ?? defaultReadFile;
  const providers = await loadProviders(configDir, readFile);
  try {
    const sessions = await readSessionRows(path.join(dataDir, "opencode.db"), deps);
    return { sessions, providers, missingState: false };
  } catch (err) {
    if (err?.code === "ENOENT") return { sessions: [], providers, missingState: true };
    throw err;
  }
}

async function loadProviders(configDir, readFile) {
  if (!configDir) return {};
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const raw = await readOptional(readFile, path.join(configDir, name));
    if (!raw) continue;
    try {
      const parsed = name.endsWith(".jsonc") ? parseJsonc(raw) : JSON.parse(raw);
      const providers = parsed?.provider;
      if (providers && typeof providers === "object") return providers;
    } catch {
      /* try the next config name */
    }
  }
  return {};
}

async function readSessionRows(dbPath, deps, attempt = 0) {
  const open = deps.openDatabase ?? defaultOpenDatabase;
  let db;
  try {
    db = open(dbPath);
  } catch (err) {
    if (isBusy(err) && attempt < 1) {
      await delay(BUSY_RETRY_MS);
      return readSessionRows(dbPath, deps, attempt + 1);
    }
    throw err;
  }
  try {
    const columns = tableColumns(db, "session");
    if (columns.length === 0) return [];
    const selected = SESSION_COLUMNS.filter((name) => columns.includes(name));
    if (selected.length === 0) return [];
    let sql = `SELECT ${selected.join(", ")} FROM session`;
    if (columns.includes("time_updated")) {
      sql += ` ORDER BY time_updated DESC LIMIT ${MAX_HELPER_ROWS}`;
    } else {
      sql += ` LIMIT ${MAX_HELPER_ROWS}`;
    }
    return db.prepare(sql).all() ?? [];
  } catch (err) {
    if (isBusy(err) && attempt < 1) {
      db.close?.();
      db = null;
      await delay(BUSY_RETRY_MS);
      return readSessionRows(dbPath, deps, attempt + 1);
    }
    throw err;
  } finally {
    db?.close?.();
  }
}

function tableColumns(db, table) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() ?? [];
  return info
    .map((row) => (typeof row?.name === "string" ? row.name : ""))
    .filter(Boolean);
}

function defaultOpenDatabase(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true, timeout: 1000 });
}

function isBusy(err) {
  const code = String(err?.code ?? "");
  return code.includes("BUSY") || /busy/i.test(String(err ?? ""));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripTrailingCommas(src) {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inString) {
      out += c;
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j += 1;
      if (src[j] === "}" || src[j] === "]") continue;
    }
    out += c;
  }
  return out;
}

function stripJsoncComments(src) {
  let out = "";
  let i = 0;
  let inString = false;
  let escape = false;
  while (i < src.length) {
    const c = src[i];
    if (inString) {
      out += c;
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      i += 2;
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}
