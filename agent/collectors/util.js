/**
 * util.js — shared helpers for node-agent collectors.
 *
 * Style: Node.js ESM, plain JS (JSDoc types), no dependencies. Mirrors the
 * exec/file-access style of sparkDash server/collectors/SystemCollector.js
 * (local execution, 5s default timeout, trimmed stdout).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";

/**
 * Run a shell command locally; resolve trimmed stdout, reject on non-zero
 * exit or timeout.
 * @param {string} cmd
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export function runShell(cmd, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("sh", ["-c", cmd], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(
          `${String(cmd).split(/\s+/)[0]} failed: ${err.message} ${String(stderr).trim()}`
        );
        e.exitCode = err.code;
        reject(e);
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

/**
 * Read a text file; throw on failure.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export function readTextFile(filePath) {
  return fs.promises.readFile(filePath, "utf-8");
}

/**
 * Parse an nvidia-smi CSV numeric field; "[N/A]" / empty / non-numeric → null.
 * (Same semantics as SystemCollector._parseSmiNumber.)
 * @param {unknown} value
 * @returns {number | null}
 */
export function parseSmiNumber(value) {
  if (value == null) return null;
  const t = String(value).trim();
  if (!t || /^\[?n\/a\]?$/i.test(t)) return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a human-readable size ("8.00GiB", "512MiB", "1024kB", "4096B") to MB.
 * @param {unknown} raw
 * @returns {number | null}
 */
export function parseSizeToMB(raw) {
  if (raw == null) return null;
  const m = String(raw).trim().match(/^([\d.]+)\s*([a-zA-Z]*)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  let perMB = null;
  if (unit === "" || unit === "b") perMB = 1 / 1048576;
  else if (unit === "kb" || unit === "kib") perMB = 1 / 1024;
  else if (unit === "mb" || unit === "mib") perMB = 1;
  else if (unit === "gb" || unit === "gib") perMB = 1024;
  else if (unit === "tb" || unit === "tib") perMB = 1024 * 1024;
  if (perMB == null) return null;
  return Math.round(n * perMB * 100) / 100;
}

/**
 * Parse a /proc-style uptime line ("500.000000 250.000000") to whole seconds.
 * @param {unknown} raw
 * @returns {number | null}
 */
export function parseUptimeSeconds(raw) {
  const m = String(raw || "").match(/^\s*([\d.]+)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? Math.round(n) : null;
}
