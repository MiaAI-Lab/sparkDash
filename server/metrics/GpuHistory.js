import fs from "fs";
import { atomicWrite, quarantineCorrupt } from "../util/atomicWrite.js";

const DEFAULT_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const DEFAULT_MIN_GAP_MS = 1500;
// Rewriting the whole file is the cost, so save every few minutes (and on shutdown), not every minute.
const SAVE_INTERVAL_MS = 5 * 60_000;
const DEVICE_KEYS = ["u", "c", "p"];
// A host never has more cards than this; it also bounds the memory a bad payload could use.
const MAX_DEVICES = 16;

/**
 * Per-card readings from a snapshot's `gpu.gpus[]` (vendor-neutral: index, name, usage,
 * temperature, power {draw, limit}). Only hosts with more than one card yield readings;
 * a single card is already the aggregate.
 */
export function deviceReadings(gpus) {
  if (!Array.isArray(gpus) || gpus.length < 2) return [];
  const out = [];
  for (const d of gpus.slice(0, MAX_DEVICES)) {
    if (!d || !Number.isInteger(d.index) || d.index < 0) continue;
    const { draw, limit } = d.power ?? {};
    out.push({
      index: d.index,
      name: typeof d.name === "string" ? d.name : null,
      usage: d.usage,
      temperature: d.temperature,
      powerPct: Number.isFinite(draw) && Number.isFinite(limit) && limit > 0 ? Math.min(100, (draw / limit) * 100) : null,
    });
  }
  return out;
}

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * Per-Spark GPU history (utilization %, temperature, power as % of the board limit), kept
 * on the server so a freshly opened page can draw the last hours at once instead of
 * starting empty. Parallel arrays keep it small; it is persisted every few minutes and loaded
 * back on start, so a server restart does not wipe it either. On a multi-GPU host each card also gets
 * its own series (`g`, by device index) aligned with the aggregate timestamps, null where the card
 * was absent, so a card that appears or disappears never disturbs the aggregate.
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
    /** @type {Map<string, { t: number[], u: number[], c: number[], p: Array<number|null>, g: Record<string, { n: string|null, u: Array<number|null>, c: Array<number|null>, p: Array<number|null> }> }>} */
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
        const out = { t: [], u: [], c: [], p: [], g: {} };
        const devs = Object.entries(s.g && typeof s.g === "object" ? s.g : {})
          .filter(([k, d]) => /^\d+$/.test(k) && d && DEVICE_KEYS.every((key) => Array.isArray(d[key])))
          .slice(0, MAX_DEVICES);
        for (const [k, d] of devs) out.g[k] = { n: typeof d.n === "string" ? d.n : null, u: [], c: [], p: [] };
        const num = (v) => (Number.isFinite(v) ? v : null);
        for (let i = 0; i < n; i++) {
          if (!Number.isFinite(s.t[i]) || s.t[i] < cutoff) continue;
          if (out.t.length && s.t[i] <= out.t[out.t.length - 1]) continue;
          out.t.push(s.t[i]);
          out.u.push(s.u[i]);
          out.c.push(s.c[i]);
          out.p.push(num(s.p[i]));
          for (const [k, d] of devs) for (const key of DEVICE_KEYS) out.g[k][key].push(num(d[key][i]));
        }
        if (out.t.length) this._series.set(id, out);
      }
    } catch (err) {
      if (err instanceof SyntaxError) quarantineCorrupt(this.file, "GpuHistory", err);
    }
  }

  /**
   * Append one reading; ignored when it is too close to the previous one or goes back in time.
   * `devices` (see deviceReadings) adds the per-card readings of a multi-GPU host.
   */
  record(sparkId, at, usage, temperature, powerPct, devices = []) {
    if (!Number.isFinite(at) || !Number.isFinite(usage) || !Number.isFinite(temperature)) return false;
    let s = this._series.get(sparkId);
    if (!s) {
      s = { t: [], u: [], c: [], p: [], g: {} };
      this._series.set(sparkId, s);
    }
    const last = s.t.length ? s.t[s.t.length - 1] : -Infinity;
    if (at - last < this.minGapMs) return false;
    s.t.push(Math.round(at));
    s.u.push(Math.round(usage * 10) / 10);
    s.c.push(Math.round(temperature * 10) / 10);
    s.p.push(Number.isFinite(powerPct) ? round1(powerPct) : null);
    this._recordDevices(s, devices);
    this._trim(s, at);
    this._dirty = true;
    return true;
  }

  /** Push one value per known card (null when it is missing now); a new card is padded with nulls first. */
  _recordDevices(s, devices) {
    const seen = new Map();
    for (const d of Array.isArray(devices) ? devices : []) {
      if (Number.isInteger(d?.index) && d.index >= 0) seen.set(String(d.index), d);
    }
    const len = s.t.length - 1; // samples before this one
    for (const k of seen.keys()) {
      if (s.g[k] || Object.keys(s.g).length >= MAX_DEVICES) continue;
      s.g[k] = { n: null, u: Array(len).fill(null), c: Array(len).fill(null), p: Array(len).fill(null) };
    }
    for (const [k, g] of Object.entries(s.g)) {
      const d = seen.get(k);
      if (d && typeof d.name === "string") g.n = d.name;
      const ok = d && Number.isFinite(d.usage) && Number.isFinite(d.temperature);
      g.u.push(ok ? round1(d.usage) : null);
      g.c.push(ok ? round1(d.temperature) : null);
      g.p.push(ok && Number.isFinite(d.powerPct) ? round1(d.powerPct) : null);
    }
  }

  /** Drop the first `k` samples of every parallel array, and cards left with no readings. */
  _cut(s, k) {
    for (const key of ["t", "u", "c", "p"]) s[key].splice(0, k);
    for (const [idx, g] of Object.entries(s.g)) {
      for (const key of DEVICE_KEYS) g[key].splice(0, k);
      if (g.u.every((v) => v == null)) delete s.g[idx];
    }
  }

  _trim(s, now) {
    const cutoff = now - this.maxAgeMs;
    // Trim in chunks so a long-lived series does not shift on every sample.
    if (s.t.length > 64 && s.t[0] < cutoff - 60_000) {
      let k = 0;
      while (k < s.t.length && s.t[k] < cutoff) k++;
      if (k > 0) this._cut(s, k);
    }
  }

  /** Trim every series to the retention window and drop series left without samples. */
  _prune(now) {
    const cutoff = now - this.maxAgeMs;
    for (const [id, s] of this._series) {
      let k = 0;
      while (k < s.t.length && s.t[k] < cutoff) k++;
      if (k > 0) this._cut(s, k);
      if (!s.t.length) {
        this._series.delete(id);
        this._dirty = true;
      }
    }
  }

  /**
   * Readings newer than `sinceMs` (ms epoch). Arrays are parallel; `p` may hold nulls.
   * `gpus` lists the cards of a multi-GPU host (by index), each with arrays parallel to `t`
   * (null where the card had no reading); it is empty for a single-GPU host.
   */
  get(sparkId, sinceMs = 0) {
    const s = this._series.get(sparkId);
    if (!s) return { t: [], u: [], c: [], p: [], gpus: [] };
    let i = 0;
    while (i < s.t.length && s.t[i] < sinceMs) i++;
    const gpus = Object.entries(s.g)
      .map(([k, g]) => ({ index: Number(k), name: g.n, u: g.u.slice(i), c: g.c.slice(i), p: g.p.slice(i) }))
      .filter((g) => g.u.some((v) => v != null))
      .sort((a, b) => a.index - b.index);
    return { t: s.t.slice(i), u: s.u.slice(i), c: s.c.slice(i), p: s.p.slice(i), gpus };
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
    if (!this.file) return;
    this._prune(this._now());
    if (!this._dirty) return;
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
