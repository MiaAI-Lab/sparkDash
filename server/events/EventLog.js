import fs from "fs";
import { atomicWrite, quarantineCorrupt } from "../util/atomicWrite.js";

const SEVERITIES = new Set(["info", "warn", "error", "success"]);
const DEDUPE_MS = 5000;
const WRITE_DEBOUNCE_MS = 1500;

/**
 * Fleet event log: a capped, persisted ring of human-readable events
 * (offline/online, throttling, updates, bench runs, power, add/remove).
 * Recording never throws: callers sit inside poll loops.
 */
export class EventLog {
  /**
   * @param {{ file?: string|null, max?: number, now?: () => number }} [opts]
   */
  constructor({ file = null, max = 200, now = Date.now } = {}) {
    this.file = file;
    this.max = Math.max(1, Math.floor(max) || 200);
    this._now = now;
    /** @type {object[]} oldest first */
    this._events = [];
    this._nextId = 1;
    this._subs = new Set();
    this._timer = null;
    this._dirty = false;
    /** @type {Map<string, number>} dedupe key -> last ts */
    this._recent = new Map();
    /** @type {Map<string, string>} sparkId -> dedupe key of its latest accepted event */
    this._lastKeyBySpark = new Map();
    this._load();
  }

  _load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const list = Array.isArray(raw?.events) ? raw.events : [];
      const valid = list.filter(
        (e) => e && Number.isInteger(e.id) && Number.isFinite(e.ts) && typeof e.message === "string"
      );
      this._events = valid.slice(-this.max);
      const maxId = valid.reduce((m, e) => Math.max(m, e.id), 0);
      this._nextId = Math.max(Number.isInteger(raw?.nextId) ? raw.nextId : 1, maxId + 1);
    } catch (err) {
      if (err instanceof SyntaxError) quarantineCorrupt(this.file, "EventLog", err);
      this._events = [];
      this._nextId = 1;
    }
  }

  /**
   * @param {{ type: string, severity?: string, sparkId?: string|null, sparkName?: string|null, message: string, data?: unknown }} input
   * @returns {object|null} the stored event, or null when dropped (invalid / deduped)
   */
  record(input) {
    try {
      if (!input || typeof input.type !== "string" || typeof input.message !== "string") return null;
      const ts = this._now();
      const sparkId = input.sparkId ?? null;
      const key = `${input.type}\u0000${sparkId ?? ""}\u0000${input.message}`;
      const last = this._recent.get(key);
      // Only a repeat counts as a duplicate: if another event for this spark
      // landed in between (offline -> online -> offline), it is a real change.
      const interleaved = this._lastKeyBySpark.get(sparkId ?? "") !== key;
      if (!interleaved && last != null && ts - last < DEDUPE_MS && ts >= last) return null;
      this._recent.set(key, ts);
      this._lastKeyBySpark.set(sparkId ?? "", key);
      if (this._recent.size > 500) {
        for (const [k, t] of this._recent) if (ts - t >= DEDUPE_MS) this._recent.delete(k);
      }
      const event = {
        id: this._nextId++,
        ts,
        type: input.type,
        severity: SEVERITIES.has(input.severity) ? input.severity : "info",
        sparkId,
        sparkName: input.sparkName ?? null,
        message: input.message,
      };
      if (input.data !== undefined) event.data = input.data;
      this._events.push(event);
      if (this._events.length > this.max) this._events.splice(0, this._events.length - this.max);
      this._schedulePersist();
      for (const fn of [...this._subs]) {
        try {
          fn(event);
        } catch {
          /* subscriber errors never propagate */
        }
      }
      return event;
    } catch (err) {
      console.error("[EventLog] record failed:", err?.message);
      return null;
    }
  }

  /** Newest first. */
  list({ limit = 50, sparkId, sinceId, beforeId } = {}) {
    let out = this._events;
    if (sparkId) out = out.filter((e) => e.sparkId === sparkId);
    if (Number.isFinite(sinceId)) out = out.filter((e) => e.id > sinceId);
    // Older page: events strictly before `beforeId` (newest first, like the default listing).
    if (Number.isFinite(beforeId)) out = out.filter((e) => e.id < beforeId);
    const n = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 50, this.max));
    return out.slice(-n).reverse();
  }

  /** Id of the oldest retained event, or null when empty. */
  oldestId() {
    return this._events.length ? this._events[0].id : null;
  }

  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  _schedulePersist() {
    if (!this.file) return;
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, WRITE_DEBOUNCE_MS);
    this._timer.unref?.();
  }

  /** Write pending changes now (graceful shutdown). */
  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (!this.file || !this._dirty) return;
    try {
      atomicWrite(
        this.file,
        JSON.stringify({ nextId: this._nextId, events: this._events }),
        0o644
      );
      this._dirty = false;
    } catch (err) {
      console.error("[EventLog] persist failed:", err?.message);
    }
  }
}

export default EventLog;
