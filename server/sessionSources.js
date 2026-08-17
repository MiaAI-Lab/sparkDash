/**
 * Dashboard-level conversation-source attach config.
 * Tokens live in secretsStore, never in this JSON file.
 * Each product is a list of attaches (legacy singleton objects migrate on load).
 * Kind ids come from sessionSourceRegistry (OpenClaw and Hermes in U1).
 */
import fs from "fs";
import { SESSION_SOURCES_JSON_PATH } from "./config.js";
import { atomicWrite } from "./util/atomicWrite.js";
import { isAllowedTargetHost } from "./validate.js";
import {
  dropSessionSourceDevices,
  loadSessionSourceTokens,
  patchSessionSourceTokens,
} from "./secretsStore.js";
import {
  SOURCE_IDS,
  conventionalStateDir,
  sessionSourceIds,
} from "./sessionSourceRegistry.js";

const MODES = new Set(["local", "url", "state-dir"]);
const PUBLIC_ONLY = new Set(["token", "hasToken", "conventionalStateDir"]);
const ATTACH_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

const DEFAULT_ATTACH = Object.freeze({
  enabled: false,
  mode: "local",
  url: "",
  stateDir: "",
  label: "",
  username: "",
});

export { SOURCE_IDS, conventionalStateDir };

export function attachList(source) {
  if (Array.isArray(source)) return source.filter((item) => item && typeof item === "object");
  if (source && typeof source === "object") return [source];
  return [];
}

function nextAttachId(kind, used) {
  if (!used.has(kind)) return kind;
  let n = 2;
  while (used.has(`${kind}-${n}`)) n += 1;
  return `${kind}-${n}`;
}

function assignAttachId(rawId, kind, used) {
  const id = typeof rawId === "string" ? rawId.trim() : "";
  if (ATTACH_ID_RE.test(id) && !used.has(id)) return id;
  return nextAttachId(kind, used);
}

function normalizeAttach(raw, kind, used) {
  const extras = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  for (const key of PUBLIC_ONLY) delete extras[key];
  const mode = MODES.has(extras.mode) ? extras.mode : DEFAULT_ATTACH.mode;
  const id = assignAttachId(extras.id, kind, used);
  return {
    ...extras,
    id,
    enabled: Boolean(extras.enabled),
    mode,
    url: typeof extras.url === "string" ? extras.url.trim() : "",
    stateDir: typeof extras.stateDir === "string" ? extras.stateDir.trim() : "",
    label: typeof extras.label === "string" ? extras.label.trim() : "",
    username: typeof extras.username === "string" ? extras.username.trim() : "",
  };
}

function normalizeKindList(kind, raw) {
  const used = new Set();
  const list = attachList(raw).map((item) => {
    const attach = normalizeAttach(item, kind, used);
    used.add(attach.id);
    return attach;
  });
  if (list.length === 0) {
    const attach = normalizeAttach({ id: kind }, kind, used);
    list.push(attach);
  }
  return list;
}

function normalizeConfig(raw) {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  const next = { ...base };
  for (const kind of sessionSourceIds()) {
    next[kind] = normalizeKindList(kind, base[kind]);
  }
  return next;
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function originKey(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "";
  }
}

function validateAttach(attach) {
  if (attach.enabled && attach.mode === "state-dir" && !attach.stateDir) {
    throw new Error("State dir is required");
  }
  if (attach.mode === "state-dir" && attach.stateDir && /[\0\r\n]/.test(attach.stateDir)) {
    throw new Error("Invalid state dir");
  }
  if (attach.mode !== "url" || !attach.url) return;
  let parsed;
  try {
    parsed = new URL(attach.url);
  } catch {
    throw new Error(`Invalid or disallowed host: ${attach.url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid URL protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("URL userinfo is not allowed");
  }
  const host = parsed.hostname || hostFromUrl(attach.url);
  if (!host || !isAllowedTargetHost(host)) {
    throw new Error(`Invalid or disallowed host: ${host || attach.url}`);
  }
}

function persistableAttach(attach) {
  const rest = { ...attach };
  for (const key of PUBLIC_ONLY) delete rest[key];
  return rest;
}

function saveSessionSources(config) {
  const payload = { ...config };
  for (const kind of sessionSourceIds()) {
    payload[kind] = attachList(config[kind]).map(persistableAttach);
  }
  atomicWrite(SESSION_SOURCES_JSON_PATH, JSON.stringify(payload, null, 2) + "\n", 0o644);
}

export function loadSessionSources() {
  try {
    const raw = fs.readFileSync(SESSION_SOURCES_JSON_PATH, "utf8");
    return normalizeConfig(JSON.parse(raw));
  } catch (err) {
    if (err.code === "ENOENT") return normalizeConfig({});
    console.error("[sessionSources] Failed to load session-sources.json:", err.message);
    return normalizeConfig({});
  }
}

function publicAttach(kind, attach, tokens) {
  const rest = persistableAttach(attach);
  return {
    ...rest,
    hasToken: Boolean(tokens[attach.id] || tokens[kind]),
    conventionalStateDir: conventionalStateDir(kind),
  };
}

export function getPublicSessionSources() {
  const config = loadSessionSources();
  const tokens = loadSessionSourceTokens();
  const pub = { ...config };
  for (const kind of sessionSourceIds()) {
    pub[kind] = attachList(config[kind]).map((attach) => publicAttach(kind, attach, tokens));
  }
  return pub;
}

function allAttachIds(config) {
  return sessionSourceIds()
    .flatMap((kind) => attachList(config[kind]))
    .map((attach) => attach.id)
    .filter(Boolean);
}

function patchKindList(kind, currentList, src) {
  if (Array.isArray(src)) {
    const used = new Set();
    return src.map((item) => {
      const prev = item?.id ? currentList.find((a) => a.id === item.id) : null;
      const attachPatch = { ...(prev || {}), ...item };
      for (const key of PUBLIC_ONLY) delete attachPatch[key];
      const attach = normalizeAttach(attachPatch, kind, used);
      used.add(attach.id);
      validateAttach(attach);
      return attach;
    });
  }
  const attachPatch = { ...src };
  for (const key of PUBLIC_ONLY) delete attachPatch[key];
  const idx = src.id ? currentList.findIndex((a) => a.id === src.id) : 0;
  const base = idx >= 0 ? currentList[idx] : currentList[0] || { id: kind };
  const used = new Set(currentList.map((a) => a.id).filter((id) => id !== base.id));
  const updated = normalizeAttach({ ...base, ...attachPatch }, kind, used);
  validateAttach(updated);
  if (idx >= 0 && currentList.length > 0) {
    const next = [...currentList];
    next[idx] = updated;
    return next;
  }
  return [updated];
}

function tokenPatchFromBody(patch, previous, next) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const kind of sessionSourceIds()) {
    const src = patch[kind];
    if (src === undefined) continue;
    const items = Array.isArray(src) ? src : [src];
    const prevList = attachList(previous[kind]);
    const nextList = attachList(next[kind]);
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const id = item.id || nextList[0]?.id || kind;
      if (Object.prototype.hasOwnProperty.call(item, "token") && item.token != null) {
        out[id] = String(item.token);
        continue;
      }
      const prev = item.id ? prevList.find((a) => a.id === item.id) : prevList[0];
      const curr = nextList.find((a) => a.id === id) || nextList[0];
      if (!prev || !curr) continue;
      if (originKey(prev.url) === originKey(curr.url)) continue;
      out[id] = "";
    }
  }
  const keep = new Set(allAttachIds(next));
  const stored = loadSessionSourceTokens();
  for (const id of Object.keys(stored)) {
    if (!keep.has(id)) out[id] = "";
  }
  return out;
}

export function updateSessionSources(patch) {
  const body = patch && typeof patch === "object" ? patch : {};
  const current = loadSessionSources();
  const next = { ...current };
  for (const kind of sessionSourceIds()) {
    const src = body[kind];
    if (src === undefined) continue;
    if (src !== null && typeof src !== "object") continue;
    next[kind] = patchKindList(kind, attachList(current[kind]), src);
  }
  const tokens = tokenPatchFromBody(body, current, next);
  const previousTokens = tokenSnapshot(current);
  let tokensPatched = false;
  try {
    if (Object.keys(tokens).length > 0) {
      patchSessionSourceTokens(tokens);
      tokensPatched = true;
    }
    saveSessionSources(next);
    dropSessionSourceDevices(allAttachIds(next));
  } catch (err) {
    if (tokensPatched) patchSessionSourceTokens(previousTokens);
    throw err;
  }
  return getPublicSessionSources();
}

function tokenSnapshot(config) {
  const current = loadSessionSourceTokens();
  /** @type {Record<string, string>} */
  const out = {};
  for (const id of allAttachIds(config)) out[id] = current[id] ?? "";
  return out;
}
