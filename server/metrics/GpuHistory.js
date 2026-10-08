import fs from "fs";
import { atomicWrite } from "../util/atomicWrite.js";

const DEFAULT_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const DEFAULT_MIN_GAP_MS = 1500;
// Rewriting the whole file is the cost, so save every few minutes (and on shutdown), not every minute.
const SAVE_INTERVAL_MS = 5 * 60_000;

/**
 * Per-Spark GPU history (utilization %, temperature, power as % of the board limit), kept
 * on the server so a freshly opened page can draw the last hours at once instead of
 * starting empty. Parallel arrays keep it small; it is persisted every few minutes and loaded
 * back on start, so a server restart does not wipe it either.
 */
export class GpuHistory {
  /**
   * @param {{ file?: string|null, maxAgeMs?: number, minGapMs?: number, now?: () => number }} [opts]
   */
  constructor({ file = null, maxAgeMs = DEFAULT_MAX_AGE_MS, minGapMs = DEFAULT_MIN_GAP_MS, now = Date.now } = {}) {
    this.file = file;
    this.maxAgeMs = maxAgeMs;
    this.minGapMs = minGapMs;
    this._now = now;
    /** @type {Map<string, { t: number[], u: number[], c: number[], p: Array<number|null> }>} */
    this._series = new Map();
    this._dirty = false;
    this._timer = null;
    this._load();
  }

  _load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const cutoff = this._now() - this.maxAgeMs;
      for (const [id, s] of Object.entries(raw?.sparks ?? {})) {
        if (!s || !Array.isArray(s.t) || !Array.isArray(s.u) || !Array.isArray(s.c) || !Array.isArray(s.p)) continue;
        const n = Math.min(s.t.length, s.u.length, s.c.length, s.p.length);
        const out = { t: [], u: [], c: [], p: [] };
        for (let i = 0; i < n; i++) {
          if (!Number.isFinite(s.t[i]) || s.t[i] < cutoff) continue;
          if (out.t.length && s.t[i] <= out.t[out.t.length - 1]) continue;
          out.t.push(s.t[i]);
          out.u.push(s.u[i]);
          out.c.push(s.c[i]);
          out.p.push(Number.isFinite(s.p[i]) ? s.p[i] : null);
        }
        if (out.t.length) this._series.set(id, out);
      }
    } catch {
      /* no file yet, or unreadable: start empty */
    }
  }

  /** Append one reading; ignored when it is too close to the previous one or goes back in time. */
  record(sparkId, at, usage, temperature, powerPct) {
    if (!Number.isFinite(at) || !Number.isFinite(usage) || !Number.isFinite(temperature)) return false;
    let s = this._series.get(sparkId);
    if (!s) {
      s = { t: [], u: [], c: [], p: [] };
      this._series.set(sparkId, s);
    }
    const last = s.t.length ? s.t[s.t.length - 1] : -Infinity;
    if (at - last < this.minGapMs) return false;
    s.t.push(Math.round(at));
    s.u.push(Math.round(usage * 10) / 10);
    s.c.push(Math.round(temperature * 10) / 10);
    s.p.push(Number.isFinite(powerPct) ? Math.round(powerPct * 10) / 10 : null);
    this._trim(s, at);
    this._dirty = true;
    return true;
  }

  _trim(s, now) {
    const cutoff = now - this.maxAgeMs;
    // Trim in chunks so a long-lived series does not shift on every sample.
    if (s.t.length > 64 && s.t[0] < cutoff - 60_000) {
      let k = 0;
      while (k < s.t.length && s.t[k] < cutoff) k++;
      if (k > 0) for (const key of ["t", "u", "c", "p"]) s[key].splice(0, k);
    }
  }

  /** Readings newer than `sinceMs` (ms epoch). Arrays are parallel; `p` may hold nulls. */
  get(sparkId, sinceMs = 0) {
    const s = this._series.get(sparkId);
    if (!s) return { t: [], u: [], c: [], p: [] };
    let i = 0;
    while (i < s.t.length && s.t[i] < sinceMs) i++;
    return { t: s.t.slice(i), u: s.u.slice(i), c: s.c.slice(i), p: s.p.slice(i) };
  }

  remove(sparkId) {
    if (this._series.delete(sparkId)) this._dirty = true;
  }

  /** Start the periodic save (no-op without a file). */
  start() {
    if (!this.file || this._timer) return;
    this._timer = setInterval(() => this.flush(), SAVE_INTERVAL_MS);
    this._timer.unref?.();
  }

  flush() {
    if (!this.file || !this._dirty) return;
    try {
      const sparks = {};
      for (const [id, s] of this._series) sparks[id] = s;
      atomicWrite(this.file, JSON.stringify({ version: 1, sparks }));
      this._dirty = false;
    } catch {
      /* best effort: history is a convenience */
    }
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.flush();
  }
}
