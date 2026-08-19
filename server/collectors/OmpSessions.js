/**
 * oh-my-pi (omp) occupancy collector.
 * Projector input rows only: source, handle, origin, midTurn unknown.
 * Local attach reads JSONL session files under ~/.omp/agent/sessions.
 * URL attach is not supported in this version. Never throws.
 * Never reads history.db, agent.db, message transcripts, or credentials.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { conventionalStateDir, conventionalConfigDir } from "../sessionSourceRegistry.js";
import {
  parseBaseUrl,
  parseSessionTime,
  resolveStateDir,
  remapHostRoot,
  expandTilde,
  defaultReadFile,
  defaultReadDir,
  defaultStat,
  sanitizeProbeError,
  stampAttachRows,
} from "./sessionIo.js";

const SOURCE = "omp";
const SESSIONS_SUBDIR = "agent/sessions";
const PROVIDERS_FILE_NAME = "models.yml";
const OMP_MAX_SESSION_FILES = 100;
const OMP_SCAN_BYTE_CAP = 1_000_000;
const OMP_SCAN_MAX_DEPTH = 4;

const PROJECTOR_ROW_KEYS = [
  "source",
  "id",
  "handle",
  "originHost",
  "originPort",
  "lastUsedAt",
  "midTurn",
];

export function sanitizeOmpRow(row) {
  const out = { source: SOURCE, midTurn: "unknown" };
  if (!row || typeof row !== "object") return out;
  for (const key of PROJECTOR_ROW_KEYS) {
    if (row[key] !== undefined) out[key] = row[key];
  }
  out.source = SOURCE;
  if (out.midTurn == null) out.midTurn = "unknown";
  return out;
}

/**
 * Parse a shallow YAML-ish subset of omp's models.yml.
 * Finds a top-level `providers:` key, then treats each deeper-indented
 * child key as a provider id whose `baseUrl:` (or `baseURL:`) scalar value
 * is copied into a flat { providerId: baseUrl } map.
 * Adjacent apiKey values are never copied — only baseUrl/baseURL.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function extractOmpProviders(text) {
  const src = String(text ?? "");
  if (!src.trim()) return {};
  const lines = src.split("\n");
  let inProviders = false;
  let providersIndent = -1;
  const map = {};
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inProviders = trimmed === "providers:";
      providersIndent = -1;
      continue;
    }
    if (!inProviders) continue;
    if (providersIndent === -1) {
      providersIndent = indent;
    }
    if (indent < providersIndent) {
      inProviders = false;
      continue;
    }
    if (indent > providersIndent) continue;
    const keyMatch = trimmed.match(/^([A-Za-z0-9_.-]+):\s*$/);
    if (keyMatch) {
      const providerId = keyMatch[1];
      for (let j = i + 1; j < lines.length; j += 1) {
        const childLine = lines[j];
        const childTrimmed = childLine.trim();
        if (!childTrimmed || childTrimmed.startsWith("#")) continue;
        const childIndent = childLine.length - childLine.trimStart().length;
        if (childIndent <= providersIndent) break;
        const urlMatch = childTrimmed.match(/^(?:baseUrl|baseURL):\s*(.+)$/);
        if (urlMatch) {
          let value = urlMatch[1].trim();
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          if (value) map[providerId] = value;
          break;
        }
      }
    }
  }
  return map;
}

/**
 * Parse JSONL session text into metadata-only session objects.
 * Reads title, model_change, session, and timestamp fields only.
 * Ignores message/custom/thinking_level_change/mode_change event content.
 * @param {string} text
 * @param {string} fileName
 * @returns {{ id: string, handle: string, model: string, lastUsedAt: number | null } | null}
 */
export function parseOmpSessionJsonl(text, fileName) {
  const src = String(text ?? "");
  if (!src) return null;
  let title = "";
  let model = "";
  let sessionId = "";
  let lastUsedAt = null;
  const lines = src.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // Torn trailing line from byte cap or live append — skip silently.
      continue;
    }
    if (!event || typeof event !== "object") continue;
    const ts = parseSessionTime(event.timestamp ?? event.updatedAt ?? event.createdAt);
    if (ts != null && (lastUsedAt == null || ts > lastUsedAt)) lastUsedAt = ts;
    const type = event.type ?? event.event;
    if (type === "title" || (event.title != null && typeof event.title === "object")) {
      const titleValue = event.title?.title ?? event.title;
      if (typeof titleValue === "string" && titleValue.trim()) title = titleValue.trim();
    }
    if (type === "model_change" || event.model != null) {
      const modelValue = event.model_change?.model ?? event.model;
      if (typeof modelValue === "string" && modelValue.trim()) model = modelValue.trim();
    }
    if (type === "session" || event.session != null) {
      const idValue = event.session?.id ?? event.id;
      if (typeof idValue === "string" && idValue.trim()) sessionId = idValue.trim();
    }
  }
  if (!sessionId) sessionId = uuidFromFileName(fileName);
  if (!sessionId) return null;
  if (!title) title = `omp-${sessionId.slice(0, 8).toLowerCase()}`;
  return { id: sessionId, handle: title, model, lastUsedAt };
}

/**
 * @param {object[]} parsed
 * @param {Record<string, string>} providers
 * @returns {object[]}
 */
export function mapOmpSessions(parsed, providers) {
  const list = Array.isArray(parsed) ? parsed : [];
  const byId = providers && typeof providers === "object" ? providers : {};
  const rows = [];
  for (const item of list) {
    const row = mapOneSession(item, byId);
    if (row) rows.push(row);
  }
  return rows;
}

function mapOneSession(item, providers) {
  if (!item || typeof item !== "object") return null;
  const providerId = providerIdFromModel(item.model);
  const origin = providerId ? parseBaseUrl(providers[providerId] ?? "") : null;
  const mapped = {
    source: SOURCE,
    id: item.id || item.handle,
    handle: item.handle || "",
    midTurn: "unknown",
  };
  if (origin) {
    mapped.originHost = origin.host;
    mapped.originPort = origin.port;
  }
  if (item.lastUsedAt != null) mapped.lastUsedAt = item.lastUsedAt;
  return mapped;
}

function providerIdFromModel(model) {
  if (typeof model !== "string" || !model.trim()) return "";
  const slashIndex = model.indexOf("/");
  return slashIndex > 0 ? model.slice(0, slashIndex).trim() : "";
}

function uuidFromFileName(fileName) {
  const base = path.basename(String(fileName || ""), ".jsonl");
  const uuidMatch = base.match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/);
  if (uuidMatch) return uuidMatch[1];
  const shortMatch = base.match(/^([A-Za-z0-9-]{8,})/);
  return shortMatch ? shortMatch[1] : "";
}

/**
 * One read for collect and diagnose.
 * @returns {Promise<{ missingState: boolean, invalidHelper: boolean, found: number, rows: object[] }>}
 */
export async function loadOmpOccupancy(attach, deps = {}) {
  const stateDir = resolveStateDir(
    attach,
    deps,
    deps.conventionalStateDir ?? conventionalStateDir(SOURCE)
  );
  const configDir = resolveConfigDir(deps);
  const sessionsDir = stateDir ? path.join(stateDir, SESSIONS_SUBDIR) : "";
  if (!sessionsDir || !pathReadableDir(sessionsDir, deps)) {
    return { missingState: true, invalidHelper: false, found: 0, rows: [] };
  }
  const readFile = deps.readFile ?? defaultReadFile;
  const readDir = deps.readDir ?? defaultReadDir;
  const stat = deps.stat ?? defaultStat;
  const providers = await loadProviders(configDir, readFile);
  const files = await scanOmpSessions(sessionsDir, deps, readDir, stat);
  const parsed = [];
  for (const filePath of files) {
    try {
      const raw = await readFile(filePath);
      const text = String(raw).slice(0, OMP_SCAN_BYTE_CAP);
      const session = parseOmpSessionJsonl(text, path.basename(filePath));
      if (session) parsed.push(session);
    } catch {
      // One bad file never aborts the sweep. Live jsonl appends may torn-truncate.
      continue;
    }
  }
  const rows = stampAttachRows(mapOmpSessions(parsed, providers), attach).map(sanitizeOmpRow);
  return { missingState: false, invalidHelper: false, found: files.length, rows };
}

export async function collectOmpSessions(attach, deps = {}) {
  try {
    if (!attach?.enabled) return [];
    return (await loadOmpOccupancy(attach, deps)).rows;
  } catch {
    return [];
  }
}

/**
 * @returns {Promise<{ status: "disabled" | "ok" | "error", found: number, mapped: number, error: string | null }>}
 */
export async function diagnoseOmpSessions(attach, deps = {}) {
  if (!attach?.enabled) {
    return { status: "disabled", found: 0, mapped: 0, error: null };
  }
  if (attach.mode === "state-dir" && !String(attach.stateDir || "").trim()) {
    return { status: "error", found: 0, mapped: 0, error: "State dir is required" };
  }
  try {
    const loaded = await loadOmpOccupancy(attach, deps);
    if (loaded.missingState) {
      return { status: "error", found: 0, mapped: 0, error: "oh-my-pi sessions not found" };
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

function resolveConfigDir(deps) {
  const conventional = deps.conventionalConfigDir ?? conventionalConfigDir(SOURCE);
  if (!conventional) return "";
  const home = deps.homedir ?? os.homedir();
  return remapHostRoot(expandTilde(String(conventional), home), deps);
}

async function loadProviders(configDir, readFile) {
  if (!configDir) return {};
  const raw = await readOptional(readFile, path.join(configDir, PROVIDERS_FILE_NAME));
  if (!raw) return {};
  try {
    return extractOmpProviders(raw);
  } catch {
    return {};
  }
}

async function readOptional(readFile, filePath) {
  try {
    return await readFile(filePath);
  } catch {
    return null;
  }
}

function pathReadableDir(dirPath, deps) {
  const stat = deps.stat ?? defaultStat;
  try {
    fs.accessSync(dirPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively discover .jsonl files under sessionsDir up to OMP_SCAN_MAX_DEPTH.
 * Symlink-loop guard via visited realpaths. Sort newest-first by mtime.
 * Slice to OMP_MAX_SESSION_FILES.
 * @returns {Promise<string[]>}
 */
async function scanOmpSessions(sessionsDir, deps, readDir, stat) {
  const results = [];
  const visited = new Set();
  async function walk(dir, depth) {
    if (depth > OMP_SCAN_MAX_DEPTH) return;
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    let entries;
    try {
      entries = await readDir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      let info;
      try {
        info = await stat(fullPath);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (info.isFile() && entry.endsWith(".jsonl")) {
        results.push({ path: fullPath, mtime: info.mtimeMs });
      }
    }
  }
  await walk(sessionsDir, 0);
  results.sort((a, b) => b.mtime - a.mtime);
  return results.slice(0, OMP_MAX_SESSION_FILES).map((r) => r.path);
}
