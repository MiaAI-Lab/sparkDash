/**
 * Shared I/O helpers for OpenClaw / Hermes conversation readers.
 * Collectors keep their own mapping and mid-turn rules.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOST_PATHS, LLM_PROBE_TIMEOUT_MS } from "../config.js";
import { isAllowedTargetHost } from "../validate.js";

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

export function expandTilde(raw, home) {
  const value = String(raw || "");
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

export function pathReadable(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function remapHostRoot(expanded, deps = {}) {
  const hostRoot = deps.hostRoot === undefined ? HOST_PATHS.ROOT : deps.hostRoot;
  if (!hostRoot) return expanded;
  const isReadable = deps.isReadable ?? pathReadable;
  if (isReadable(expanded)) return expanded;
  if (!expanded.startsWith("/") || !isReadable(hostRoot)) return expanded;
  const mapped = path.join(hostRoot, expanded.slice(1));
  return isReadable(mapped) ? mapped : expanded;
}

export function resolveStateDir(attach, deps, conventional) {
  const home = deps.homedir ?? os.homedir();
  if (attach.mode === "state-dir") {
    if (!attach.stateDir) return "";
    return remapHostRoot(expandTilde(attach.stateDir, home), deps);
  }
  return remapHostRoot(expandTilde(String(conventional || ""), home), deps);
}

export function defaultReadFile(filePath) {
  return fs.promises.readFile(filePath, "utf8");
}

export function defaultReadDir(dirPath) {
  return fs.promises.readdir(dirPath);
}

export function assertAllowedFetchUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid URL protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("URL userinfo is not allowed");
  }
  if (!isAllowedTargetHost(parsed.hostname)) {
    throw new Error(`Invalid or disallowed host: ${parsed.hostname}`);
  }
  return parsed;
}

export async function defaultFetchResponse(url, { token, cookie, method, body, extraHeaders } = {}) {
  assertAllowedFetchUrl(url);
  const headers = { Accept: "application/json", ...(extraHeaders ?? {}) };
  if (cookie) headers.Cookie = cookie;
  else if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method: method ?? "GET",
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(LLM_PROBE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

export async function defaultFetchJson(url, opts = {}) {
  const res = await defaultFetchResponse(url, opts);
  return res.json();
}

export function normalizeSessionList(sessions) {
  if (Array.isArray(sessions)) return sessions;
  if (sessions && Array.isArray(sessions.sessions)) return sessions.sessions;
  return null;
}

const LAST_USED_FIELDS = [
  "updatedAt",
  "updated_at",
  "lastActivityAt",
  "last_activity",
  "last_activity_at",
  "lastMessageAt",
  "last_message_at",
  "mtime",
  "modifiedAt",
  "timestamp",
  "createdAt",
  "created_at",
];

/** Epoch ms from a session timestamp field. Null when absent or unparseable. */
export function parseSessionTime(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return parseSessionTime(numeric);
  }
  return null;
}

/** Prefer updated/activity timestamps; createdAt is last-resort. Never Date.now(). */
export function sessionLastUsedAt(session) {
  if (!session || typeof session !== "object") return null;
  for (const field of LAST_USED_FIELDS) {
    const ms = parseSessionTime(session[field]);
    if (ms != null) return ms;
  }
  return null;
}

/** Short probe error for Settings. No paths, tokens, or payloads. */
export function sanitizeProbeError(err) {
  const code = err?.code;
  if (code === "ENOENT") return "State files not found";
  if (code === "EACCES" || code === "EPERM") return "Permission denied";
  if (code === "ENOTFOUND") return "Host not found";
  if (code === "ECONNREFUSED") return "Connection refused";
  if (code === "ECONNRESET") return "Connection reset";
  if (code === "ETIMEDOUT" || err?.name === "TimeoutError" || err?.name === "AbortError") {
    return "Timed out";
  }
  const status = Number(err?.status);
  if (status === 401 || status === 403) return `HTTP ${status} (auth failed)`;
  if (Number.isInteger(status) && status >= 400) return `HTTP ${status}`;
  const raw = err?.message ? String(err.message) : "Request failed";
  if (/Unexpected token|^JSON|not valid JSON/i.test(raw)) return "Not a JSON session list";
  if (/^HTTP 401\b/.test(raw) || /^HTTP 403\b/.test(raw)) return `${raw.split(/\s+/).slice(0, 2).join(" ")} (auth failed)`;
  const http = raw.match(/^HTTP \d+/);
  if (http) return http[0];
  return "Request failed";
}
