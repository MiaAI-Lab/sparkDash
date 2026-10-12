/**
 * The downsampled tiers of UnitHistory: fixed-size rings of 1-minute and
 * 15-minute buckets, the way Netdata (and RRDtool before it) trades resolution
 * for reach. Both tiers are fed straight from the samples (not rolled up from
 * one another), so every bucket's avg / max / min is exact.
 *
 *   1m    1-minute buckets    last 48 h
 *   15m   15-minute buckets   last 30 days
 *
 * A bucket keeps avg, max and the sample count per series; `memFreeMB` also
 * keeps its min, because for headroom the low point is the one that hurts. A
 * value the unit did not report is never stored, so the charts show a gap.
 *
 * Slot = bucket index modulo the ring length, so memory is fixed per series
 * once it exists: 2 tiers × 2,880 slots × (4 + 4 + 2 bytes) ≈ 58 KB, plus 23 KB
 * of min for headroom and 46 KB of bucket times per unit.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The bucket tiers, finest first. `name` is the key in the persisted file. */
export const BUCKET_TIERS = Object.freeze([
  Object.freeze({ name: "1m", stepMs: MINUTE_MS, retentionMs: 48 * HOUR_MS }),
  Object.freeze({ name: "15m", stepMs: 15 * MINUTE_MS, retentionMs: 30 * DAY_MS }),
]);

/**
 * Query ranges: which tier answers, and the step of the points returned. The
 * step coarsens a tier's buckets (weighted merge, same math as the buckets) so
 * a response stays at or under ~500 points per series. Steps are fixed per
 * range, so the grid does not shift between polls. There is no raw tier for
 * these series (see UnitHistory), so 1h is sixty 1-minute buckets.
 */
export const HISTORY_RANGES = Object.freeze({
  "1h": Object.freeze({ spanMs: HOUR_MS, tier: 0, stepMs: MINUTE_MS }),
  "6h": Object.freeze({ spanMs: 6 * HOUR_MS, tier: 0, stepMs: MINUTE_MS }),
  "24h": Object.freeze({ spanMs: DAY_MS, tier: 0, stepMs: 3 * MINUTE_MS }),
  "7d": Object.freeze({ spanMs: 7 * DAY_MS, tier: 1, stepMs: 30 * MINUTE_MS }),
  "30d": Object.freeze({ spanMs: 30 * DAY_MS, tier: 1, stepMs: 90 * MINUTE_MS }),
});

/** Unit-level series. Memory is in MB, network in bytes/s, GPU power in W. */
export const UNIT_SERIES = Object.freeze([
  "gpuUtil",
  "gpuTemp",
  "gpuPower",
  "memUsedMB",
  "memFreeMB",
  "cpuUtil",
  "cpuTemp",
  "ramUsedMB",
  "netRx",
  "netTx",
]);

/** Per LLM endpoint. kvUsage is the 0–1 share of the engine's KV pool. */
export const LLM_SERIES = Object.freeze(["genTps", "prefillTps", "kvUsage"]);

/** Series whose buckets also keep the minimum. */
const MIN_SERIES = new Set(["memFreeMB"]);

const UNIT_SERIES_SET = new Set(UNIT_SERIES);
const LLM_SERIES_SET = new Set(LLM_SERIES);
const LLM_KEY_RE = /^llm:(\d{1,5}):([A-Za-z]+)$/;
const MAX_COUNT = 65_535;

/** Internal key for one endpoint's series: `llm:<port>:<name>`. */
export function llmKey(port, name) {
  return `llm:${port}:${name}`;
}

/** `{ port, name }` for an LLM key, or null for a unit-level key. */
export function parseLlmKey(key) {
  const m = LLM_KEY_RE.exec(key);
  if (!m || !LLM_SERIES_SET.has(m[2])) return null;
  return { port: Number(m[1]), name: m[2] };
}

export function isKnownKey(key) {
  return UNIT_SERIES_SET.has(key) || parseLlmKey(key) !== null;
}

export function keepsMin(key) {
  return MIN_SERIES.has(parseLlmKey(key)?.name ?? key);
}

export const finite = (v) => typeof v === "number" && Number.isFinite(v);

/** A running aggregate of one value: sum (not avg) so merges stay exact. */
export function statOf(value) {
  return { sum: value, max: value, min: value, n: 1 };
}

/** Fold `add` into `into` (weighted by sample count). */
export function mergeStat(into, add) {
  if (!into) return { ...add };
  into.sum += add.sum;
  into.max = Math.max(into.max, add.max);
  into.min = Math.min(into.min, add.min);
  into.n += add.n;
  return into;
}

export function addToStats(stats, key, stat) {
  stats.set(key, mergeStat(stats.get(key), stat));
}

/** Round for transport and storage: whole numbers from 100, else 2 decimals (4 below 1). */
export function round(v) {
  const a = Math.abs(v);
  if (a >= 100) return Math.round(v);
  if (a >= 1) return Math.round(v * 100) / 100;
  return Math.round(v * 10_000) / 10_000;
}

/**
 * Fixed-size ring of closed buckets for one tier. A slot whose stored time is
 * not the bucket being written is reclaimed. Columns are allocated per series
 * on first use.
 */
export class BucketRing {
  constructor(stepMs, retentionMs) {
    this.stepMs = stepMs;
    this.retentionMs = retentionMs;
    this.slots = Math.ceil(retentionMs / stepMs);
    this.times = new Float64Array(this.slots).fill(NaN);
    /** key → { avg, max, min|null, n } typed arrays */
    this.cols = new Map();
  }

  _slot(t) {
    const k = Math.floor(t / this.stepMs) % this.slots;
    return k < 0 ? k + this.slots : k;
  }

  _col(key) {
    let col = this.cols.get(key);
    if (!col) {
      col = {
        avg: new Float32Array(this.slots),
        max: new Float32Array(this.slots),
        min: keepsMin(key) ? new Float32Array(this.slots) : null,
        n: new Uint16Array(this.slots),
      };
      this.cols.set(key, col);
    }
    return col;
  }

  /** Store (or merge into) the bucket starting at `t`. */
  put(t, stats) {
    const i = this._slot(t);
    if (this.times[i] !== t) {
      this.times[i] = t;
      for (const col of this.cols.values()) col.n[i] = 0;
    }
    for (const [key, s] of stats) {
      if (!(s.n > 0)) continue;
      const col = this._col(key);
      const prev = col.n[i] > 0 ? this._stat(col, i) : null;
      const next = prev ? mergeStat(prev, s) : s;
      col.avg[i] = next.sum / next.n;
      col.max[i] = next.max;
      if (col.min) col.min[i] = next.min;
      col.n[i] = Math.min(MAX_COUNT, next.n);
    }
  }

  _stat(col, i) {
    const n = col.n[i];
    const avg = col.avg[i];
    return { sum: avg * n, max: col.max[i], min: col.min ? col.min[i] : avg, n };
  }

  /** Closed buckets with t ≥ fromMs, oldest first: [{ t, stats: Map }]. */
  entries(fromMs) {
    const out = [];
    for (let i = 0; i < this.slots; i++) {
      const t = this.times[i];
      if (!(t >= fromMs)) continue;
      const stats = new Map();
      for (const [key, col] of this.cols) {
        if (col.n[i] > 0) stats.set(key, this._stat(col, i));
      }
      if (stats.size > 0) out.push({ t, stats });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  /**
   * Columnar form of the buckets with t ≥ fromMs, `open` (the bucket still
   * filling) merged in: { t: [...], series: { key: { avg, max, min?, n } } },
   * arrays aligned with t, null / 0 where a series has no samples. Reads the
   * typed arrays directly — no per-bucket objects — because a large fleet
   * serializes a few hundred thousand buckets per save.
   */
  columns(fromMs, open) {
    const rows = [];
    for (let i = 0; i < this.slots; i++) {
      if (this.times[i] >= fromMs) rows.push({ t: this.times[i], slot: i });
    }
    const openT = open && open.t >= fromMs && open.stats.size > 0 ? open.t : null;
    if (openT !== null && !rows.some((r) => r.t === openT)) rows.push({ t: openT, slot: -1 });
    rows.sort((a, b) => a.t - b.t);
    const keys = new Set(this.cols.keys());
    if (openT !== null) for (const key of open.stats.keys()) keys.add(key);
    const series = Object.create(null);
    for (const key of [...keys].sort()) {
      const col = this.cols.get(key);
      const extra = openT !== null ? open.stats.get(key) : undefined;
      const out = { avg: [], max: [], n: [] };
      if (keepsMin(key)) out.min = [];
      let any = false;
      for (const { t, slot } of rows) {
        let s = slot >= 0 && col && col.n[slot] > 0 ? this._stat(col, slot) : null;
        if (extra && t === openT) s = mergeStat(s ?? undefined, extra);
        out.avg.push(s ? round(s.sum / s.n) : null);
        out.max.push(s ? round(s.max) : null);
        if (out.min) out.min.push(s ? round(s.min) : null);
        out.n.push(s ? Math.min(MAX_COUNT, s.n) : 0);
        if (s) any = true;
      }
      if (any) series[key] = out;
    }
    return { t: rows.map((r) => r.t), series };
  }

  dropKeys(predicate) {
    for (const key of [...this.cols.keys()]) if (predicate(key)) this.cols.delete(key);
  }
}

/** Merge entries onto a coarser grid of `stepMs` (bucket starts aligned to the epoch). */
export function coarsen(entries, stepMs) {
  const grid = new Map();
  for (const { t, stats } of entries) {
    const g = Math.floor(t / stepMs) * stepMs;
    let into = grid.get(g);
    if (!into) {
      into = new Map();
      grid.set(g, into);
    }
    for (const [key, s] of stats) addToStats(into, key, { ...s });
  }
  return [...grid.entries()].sort((a, b) => a[0] - b[0]).map(([t, stats]) => ({ t, stats }));
}

/** `{ avg, max, min? }` of one merged stat, rounded for transport. */
export function statOut(key, s) {
  const out = { avg: round(s.sum / s.n), max: round(s.max) };
  if (keepsMin(key)) out.min = round(s.min);
  return out;
}
