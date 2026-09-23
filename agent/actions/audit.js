/**
 * audit.js — append-only JSONL audit log for node-agent actions.
 *
 * Every executed action is recorded as one JSON line (AuditEntry,
 * shared/types.ts):
 *
 *   {"ts":1758620000000,"action":"start","serviceName":"llm-tp1","port":8080,
 *    "modelId":null,"engine":null,"status":"success",
 *    "message":"docker start qwen38-sglang → exit 0","durationMs":42}
 *
 * Invariants:
 *  - Append-only: existing lines are never rewritten or deleted.
 *  - Append, not overwrite: appending the same entry twice writes two lines.
 *  - Graceful degradation: an unwritable log path logs to the console and
 *    resolves — the audit layer never takes down the action that produced
 *    the entry.
 *
 * Default path: <agent>/config/audit.log (sibling of recipes.json).
 * The path is configurable per call via opts.path.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AGENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Default audit log path: agent/config/audit.log. */
export const DEFAULT_AUDIT_PATH = path.join(AGENT_DIR, "config", "audit.log");
/** Number of lines readAudit returns when limit is omitted/invalid. */
export const DEFAULT_READ_LIMIT = 50;

/**
 * One audit log entry (shared/types.ts → AuditEntry).
 * @typedef {object} AuditEntry
 * @property {number} ts ms epoch
 * @property {"start"|"stop"|"restart"|"switch"} action
 * @property {string} serviceName
 * @property {number|null} port
 * @property {string|null} modelId
 * @property {string|null} engine
 * @property {"success"|"failure"|"running"} status
 * @property {string} message
 * @property {number|null} durationMs
 */

/**
 * Append one audit entry as a single JSON line.
 *
 * Never throws: an unwritable path or a malformed entry logs to the console
 * (console.log) and resolves. The file is opened in append mode, one
 * "json-line + \n" is written, and the handle is closed — existing content
 * is never touched.
 *
 * @param {object} entry
 * @param {{path?: string}} [opts] opts.path overrides DEFAULT_AUDIT_PATH
 * @returns {Promise<void>}
 */
export async function appendAudit(entry, opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const p = typeof o.path === "string" && o.path !== "" ? o.path : DEFAULT_AUDIT_PATH;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    console.log(
      `[audit] appendAudit: entry must be an object, got ${JSON.stringify(entry)} — line not appended`
    );
    return;
  }
  const record = { ...entry, ts: Number.isFinite(entry.ts) ? entry.ts : Date.now() };
  /** @type {import("node:fs/promises").FileHandle | undefined} */
  let fh;
  try {
    fh = await fs.promises.open(p, "a");
    await fh.write(JSON.stringify(record) + "\n");
  } catch (err) {
    console.log(`[audit] append failed (${p}): ${err && err.message ? err.message : String(err)}`);
    return;
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch {
        /* close is best-effort; the write already landed */
      }
    }
  }
}

/**
 * Read the last N audit entries.
 *
 * - File missing or unreadable → [] (graceful, no throw).
 * - Malformed lines are skipped, never thrown on.
 * - limit: omitted or negative/non-integer → DEFAULT_READ_LIMIT (50);
 *   0 → [].
 * - The returned array preserves file order (oldest of the window first).
 *
 * @param {number} [limit]
 * @param {{path?: string}} [opts] opts.path overrides DEFAULT_AUDIT_PATH
 * @returns {Promise<AuditEntry[]>}
 */
export async function readAudit(limit = DEFAULT_READ_LIMIT, opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const p = typeof o.path === "string" && o.path !== "" ? o.path : DEFAULT_AUDIT_PATH;

  let raw;
  try {
    raw = await fs.promises.readFile(p, "utf-8");
  } catch {
    return [];
  }

  let n = limit;
  if (!Number.isInteger(n) || n < 0) n = DEFAULT_READ_LIMIT;
  if (n === 0) return [];

  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop(); // trailing newline
  const window = lines.slice(-n);

  /** @type {AuditEntry[]} */
  const out = [];
  for (const line of window) {
    const t = line.trim();
    if (t === "") continue;
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.push(/** @type {AuditEntry} */ (parsed));
      }
    } catch {
      /* skip malformed line — content is preserved, no throw */
    }
  }
  return out;
}
