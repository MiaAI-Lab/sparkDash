/**
 * The latest disk analysis per unit, kept in a file so it survives a restart and a reload of the page:
 * an analysis stays until the person runs another. Entries are re-checked against the delete policy
 * when loaded, so a hand-edited file cannot unlock a protected path.
 */
import fs from "node:fs";
import { atomicWrite } from "../util/atomicWrite.js";
import { hasUnsafeName, protectedReason } from "./policy.js";

const VERSION = 1;
const TYPES = new Set(["dir", "file", "link", "other"]);

/**
 * @param {string | null} file
 * @returns {{ sessions: Map<string, object>, revision: number }}
 */
export function loadSessions(file) {
  const sessions = new Map();
  let revision = 0;
  if (!file || !fs.existsSync(file)) return { sessions, revision };
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data?.version !== VERSION || typeof data.sessions !== "object" || data.sessions === null) return { sessions, revision };
    for (const [sparkId, raw] of Object.entries(data.sessions)) {
      if (!raw || typeof raw.root !== "string" || !Array.isArray(raw.entries)) continue;
      const entries = new Map();
      for (const e of raw.entries) {
        if (!e || typeof e.path !== "string" || !e.path.startsWith("/") || !Number.isFinite(e.bytes) || e.bytes < 0 || !TYPES.has(e.type)) continue;
        const unsafe = hasUnsafeName(e.path);
        const entry = { path: e.path, bytes: e.bytes, type: e.type, expanded: e.expanded === true && e.type === "dir" && !unsafe, locked: protectedReason(e.path) };
        if (unsafe) entry.unsafe = true;
        if (Number.isFinite(e.sharedBytes) && e.sharedBytes > 0) entry.sharedBytes = Math.min(e.sharedBytes, e.bytes);
        // Saved before dates were recorded, or not known: left out, never guessed.
        if (Number.isSafeInteger(e.modifiedAt) && e.modifiedAt >= 0) entry.modifiedAt = e.modifiedAt;
        entries.set(e.path, entry);
      }
      if (entries.size === 0 || !entries.has(raw.root)) continue;
      revision = Math.max(revision, Number.isInteger(raw.revision) ? raw.revision : 0);
      sessions.set(sparkId, {
        revision: Number.isInteger(raw.revision) ? raw.revision : 1,
        root: raw.root,
        scannedAt: Number.isFinite(raw.scannedAt) ? raw.scannedAt : 0,
        analysedAt: Number.isFinite(raw.analysedAt) ? raw.analysedAt : Number.isFinite(raw.scannedAt) ? raw.scannedAt : 0,
        elevated: raw.elevated === true,
        unreadable: Number.isInteger(raw.unreadable) ? raw.unreadable : 0,
        timedOut: raw.timedOut === true,
        hardlinks: raw.hardlinks === "exact" ? "exact" : "approx",
        dated: raw.dated === true,
        entries,
      });
    }
    revision = Math.max(revision, Number.isInteger(data.revision) ? data.revision : 0);
  } catch (err) {
    console.error(`[storage] Could not read ${file}: ${err.message}. Starting without earlier analyses.`);
    return { sessions: new Map(), revision: 0 };
  }
  return { sessions, revision };
}

/**
 * @param {string | null} file
 * @param {Map<string, any>} sessions
 * @param {number} revision
 */
export function saveSessions(file, sessions, revision) {
  if (!file) return;
  const out = {};
  for (const [sparkId, s] of sessions) {
    out[sparkId] = {
      revision: s.revision,
      root: s.root,
      scannedAt: s.scannedAt,
      analysedAt: s.analysedAt,
      elevated: s.elevated,
      unreadable: s.unreadable,
      timedOut: s.timedOut,
      hardlinks: s.hardlinks,
      dated: s.dated === true,
      entries: [...s.entries.values()].map((e) => ({
        path: e.path,
        bytes: e.bytes,
        type: e.type,
        expanded: e.expanded,
        ...(e.sharedBytes ? { sharedBytes: e.sharedBytes } : {}),
        ...(e.modifiedAt != null ? { modifiedAt: e.modifiedAt } : {}),
      })),
    };
  }
  atomicWrite(file, JSON.stringify({ version: VERSION, revision, sessions: out }), 0o600);
}
