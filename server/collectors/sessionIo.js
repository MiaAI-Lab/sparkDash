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

export async function defaultFetchJson(url, { token } = {}) {
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
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(LLM_PROBE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export function normalizeSessionList(sessions) {
  if (Array.isArray(sessions)) return sessions;
  if (sessions && Array.isArray(sessions.sessions)) return sessions.sessions;
  return null;
}
