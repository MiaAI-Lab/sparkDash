/**
 * Dashboard-level OpenClaw / Hermes Agent conversation-source attach config.
 * Tokens live in secretsStore, never in this JSON file.
 */
import fs from "fs";
import { SESSION_SOURCES_JSON_PATH } from "./config.js";
import { atomicWrite } from "./util/atomicWrite.js";
import { isAllowedTargetHost } from "./validate.js";
import { loadSessionSourceTokens, patchSessionSourceTokens } from "./secretsStore.js";

const SOURCE_IDS = Object.freeze(["openclaw", "hermes"]);
const MODES = new Set(["local", "url", "state-dir"]);
const PUBLIC_ONLY = new Set(["token", "hasToken", "conventionalStateDir"]);

const DEFAULT_ATTACH = Object.freeze({
  enabled: false,
  mode: "local",
  url: "",
  stateDir: "",
});

export function conventionalStateDir(id) {
  if (id === "openclaw") {
    const env = process.env.OPENCLAW_STATE_DIR;
    return env && env.trim() ? env.trim() : "~/.openclaw";
  }
  if (id === "hermes") {
    const env = process.env.HERMES_HOME;
    return env && env.trim() ? env.trim() : "~/.hermes";
  }
  return "";
}

function normalizeAttach(raw) {
  const extras = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  for (const key of PUBLIC_ONLY) delete extras[key];
  const mode = MODES.has(extras.mode) ? extras.mode : DEFAULT_ATTACH.mode;
  return {
    ...extras,
    enabled: Boolean(extras.enabled),
    mode,
    url: typeof extras.url === "string" ? extras.url.trim() : "",
    stateDir: typeof extras.stateDir === "string" ? extras.stateDir.trim() : "",
  };
}

function normalizeConfig(raw) {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  return {
    ...base,
    openclaw: normalizeAttach(base.openclaw),
    hermes: normalizeAttach(base.hermes),
  };
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
  const payload = {
    ...config,
    openclaw: persistableAttach(config.openclaw),
    hermes: persistableAttach(config.hermes),
  };
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

function publicAttach(id, attach, tokens) {
  const rest = persistableAttach(attach);
  return {
    ...rest,
    hasToken: Boolean(tokens[id]),
    conventionalStateDir: conventionalStateDir(id),
  };
}

export function getPublicSessionSources() {
  const config = loadSessionSources();
  const tokens = loadSessionSourceTokens();
  return {
    ...config,
    openclaw: publicAttach("openclaw", config.openclaw, tokens),
    hermes: publicAttach("hermes", config.hermes, tokens),
  };
}

function tokenPatchFromBody(patch) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const id of SOURCE_IDS) {
    const src = patch[id];
    if (!src || typeof src !== "object") continue;
    if (!Object.prototype.hasOwnProperty.call(src, "token")) continue;
    if (src.token == null) continue;
    out[id] = String(src.token);
  }
  return out;
}

export function updateSessionSources(patch) {
  const body = patch && typeof patch === "object" ? patch : {};
  const current = loadSessionSources();
  const next = { ...current };
  for (const id of SOURCE_IDS) {
    const src = body[id];
    if (!src || typeof src !== "object") continue;
    const attachPatch = { ...src };
    for (const key of PUBLIC_ONLY) delete attachPatch[key];
    next[id] = normalizeAttach({ ...current[id], ...attachPatch });
    validateAttach(next[id]);
  }
  const tokens = tokenPatchFromBody(body);
  for (const id of SOURCE_IDS) {
    const src = body[id];
    if (!src || typeof src !== "object") continue;
    if (Object.prototype.hasOwnProperty.call(src, "token")) continue;
    if (originKey(current[id].url) === originKey(next[id].url)) continue;
    tokens[id] = "";
  }
  const previousTokens = tokenSnapshot();
  let tokensPatched = false;
  try {
    if (Object.keys(tokens).length > 0) {
      patchSessionSourceTokens(tokens);
      tokensPatched = true;
    }
    saveSessionSources(next);
  } catch (err) {
    if (tokensPatched) patchSessionSourceTokens(previousTokens);
    throw err;
  }
  return getPublicSessionSources();
}

function tokenSnapshot() {
  const current = loadSessionSourceTokens();
  /** @type {Record<string, string>} */
  const out = {};
  for (const id of SOURCE_IDS) out[id] = current[id] ?? "";
  return out;
}
