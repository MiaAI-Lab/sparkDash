import fs from "node:fs";
import { atomicWrite } from "../util/atomicWrite.js";

/**
 * MetricsHistory — per-unit time series kept on the server, so the unit page
 * can chart the last hour to the last month across reloads. Opt-in: nothing is
 * recorded, loaded or written unless the `metricsHistory` setting is on (the
 * runtime checks it every tick).
 *
 * Storage is tiered the way Netdata (and RRDtool before it) does it — each tier
 * trades resolution for reach:
 *
 *   tier 0   raw samples, one per sampler tick (2 s)   last 60 min   memory only
 *   tier 1   1-minute buckets                          last 48 h     persisted
 *   tier 2   15-minute buckets                         last 30 days  persisted
 *
 * Both bucket tiers are fed straight from the raw samples (not rolled up from
 * the tier below), so every bucket's avg / max / min is exact. A bucket keeps
 * avg, max and the sample count per series; `memFreeMB` also keeps its min,
 * because for headroom the low point is the one that hurts. A value the unit
 * did not report (offline, a failed collection, no sensor, an endpoint down)
 * is skipped rather than recorded as zero, so the charts show a gap.
 *
 * Buckets live in fixed-size typed-array rings (slot = bucket index modulo the
 * ring length), so memory is bounded no matter how long the server runs:
 * 2 tiers × 2,880 slots × 10 bytes ≈ 60 KB per series, about 0.8 MB for a
 * unit with one LLM endpoint, plus up to an hour of raw samples.
 *
 * On disk (`config/metrics-history.json`, METRICS_HISTORY_JSON_PATH): columnar
 * JSON of tiers 1–2 only, rewritten atomically every 60 s and on shutdown.
 * Worst case — every bucket of both tiers filled (48 h and 30 days of uptime),
 * full-precision values — is ~0.9 MB per unit plus ~0.25 MB per LLM endpoint:
 * 3.2 MB for 3 units (two GB10s, one serving, plus a host with an endpoint),
 * 22 MB for 20 units with one endpoint each (~160 ms to serialize on an M-series
 * Mac). It cannot grow past that: retention is applied on every flush, and a
 * removed unit (or LLM port) is dropped on the next one.
 */

const FILE_VERSION = 1;
const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Tier 0: raw samples, memory only. */
export const RAW_RETENTION_MS = HOUR_MS;

/** Tiers 1 and 2, in order. `name` is the key in the persisted file. */
export const BUCKET_TIERS = Object.freeze([
  Object.freeze({ name: "1m", stepMs: MINUTE_MS, retentionMs: 48 * HOUR_MS }),
  Object.freeze({ name: "15m", stepMs: 15 * MINUTE_MS, retentionMs: 30 * DAY_MS }),
]);

/**
 * Query ranges: which tier answers, and the step of the points returned. The
 * step coarsens a tier's buckets (weighted merge, same math as the buckets
 * themselves) so a response stays under ~500 points per series: 1h is raw
 * samples in 10 s steps, 24h is 1-minute buckets merged in threes, 30d is
 * 15-minute buckets merged in sixes. Steps are fixed per range, so the grid
 * does not shift between polls.
 */
export const HISTORY_RANGES = Object.freeze({
  "1h": Object.freeze({ spanMs: HOUR_MS, tier: 0, stepMs: 10 * SECOND_MS }),
  "6h": Object.freeze({ spanMs: 6 * HOUR_MS, tier: 1, stepMs: MINUTE_MS }),
  "24h": Object.freeze({ spanMs: DAY_MS, tier: 1, stepMs: 3 * MINUTE_MS }),
  "7d": Object.freeze({ spanMs: 7 * DAY_MS, tier: 2, stepMs: 30 * MINUTE_MS }),
  "30d": Object.freeze({ spanMs: 30 * DAY_MS, tier: 2, stepMs: 90 * MINUTE_MS }),
});

/** Unit-level series. Memory is in MB, network in bytes/s. */
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

function isKnownKey(key) {
  return UNIT_SERIES_SET.has(key) || parseLlmKey(key) !== null;
}

function baseName(key) {
  return parseLlmKey(key)?.name ?? key;
}

function keepsMin(key) {
  return MIN_SERIES.has(baseName(key));
}

const finite = (v) => typeof v === "number" && Number.isFinite(v);

// ─── Sample extraction ────────────────────────────────────

/** The all-zero result a failed GPU collection returns (see SystemCollector). */
function isDefaultGpu(gpu) {
  return (
    gpu?.temperature === 0 &&
    gpu?.usage === 0 &&
    gpu?.power?.draw === 0 &&
    gpu?.vram?.total === 0
  );
}

function isDefaultCpu(cpu) {
  return cpu?.usage === 0 && cpu?.temperature === 0 && cpu?.draw === 0 && cpu?.tdp === 0;
}

/**
 * Used and free memory in MB, with the semantics of src/shared/vramBreakdown.ts:
 * a GB10 (`kind` spark) judges its unified pool — used is GPU + CPU side, free
 * is MemAvailable — falling back to the GPU's view when the pool is unknown; a
 * discrete card (`kind` host) judges its VRAM, free = total − used (the host
 * collector puts system RAM in `vram.available` while no GPU process runs).
 */
export function memoryReading(snapshot, isFresh = () => true) {
  const m = snapshot?.metrics || {};
  const unified = snapshot?.kind !== "host";
  const um = m.unifiedMemory;
  if (unified && isFresh("memory") && finite(um?.total) && um.total > 0) {
    const used = Math.max(0, finite(um.gpuUsed) ? um.gpuUsed : 0) +
      Math.max(0, finite(um.cpuUsed) ? um.cpuUsed : 0);
    const free = finite(um.available) ? Math.max(0, um.available) : Math.max(0, um.total - used);
    return { usedMB: used, freeMB: free };
  }
  const vram = m.gpu?.vram;
  if (!isFresh("gpu") || isDefaultGpu(m.gpu) || !finite(vram?.total) || vram.total <= 0) {
    return null;
  }
  const used = Math.max(0, finite(vram.used) ? vram.used : 0);
  const free =
    unified && finite(vram.available)
      ? Math.max(0, vram.available)
      : Math.max(0, vram.total - used);
  return { usedMB: used, freeMB: free };
}

/** Primary interface's rates, or the sum over shown interfaces when it is unknown. */
export function networkRates(network) {
  const shown = Array.isArray(network?.interfaces)
    ? network.interfaces.filter((i) => i && !i.disabled && i.name !== "lo")
    : [];
  if (shown.length === 0) return null;
  const primary = network.primaryInterface
    ? shown.find((i) => i.name === network.primaryInterface)
    : null;
  const picked = primary ? [primary] : shown;
  let rx = 0;
  let tx = 0;
  let any = false;
  for (const i of picked) {
    if (finite(i.rxSpeed)) {
      rx += i.rxSpeed;
      any = true;
    }
    if (finite(i.txSpeed)) {
      tx += i.txSpeed;
      any = true;
    }
  }
  return any ? { rx, tx } : null;
}

/**
 * One sample's values from a SparkMonitor snapshot, keyed by series. Returns
 * null for an offline unit. `isFresh(domain)` lets the runtime drop domains
 * whose last collection is stale or failed (SparkMonitor keeps the previous
 * value around, and a failed GPU read yields zeros) — a dropped value becomes
 * a gap, never a fake zero.
 */
export function extractSample(snapshot, isFresh = () => true) {
  if (!snapshot || snapshot.online !== true) return null;
  const m = snapshot.metrics || {};
  const out = {};
  const set = (key, value) => {
    if (finite(value)) out[key] = value;
  };

  const gpu = m.gpu;
  if (gpu && isFresh("gpu") && !isDefaultGpu(gpu)) {
    set("gpuUtil", gpu.usage);
    if (gpu.temperature > 0) set("gpuTemp", gpu.temperature);
    set("gpuPower", gpu.power?.draw);
  }

  const mem = memoryReading(snapshot, isFresh);
  if (mem) {
    set("memUsedMB", mem.usedMB);
    set("memFreeMB", mem.freeMB);
  }

  const cpu = m.cpu;
  if (cpu && isFresh("cpu") && !isDefaultCpu(cpu)) {
    set("cpuUtil", cpu.usage);
    // 0 °C is "no sensor", not a reading.
    if (cpu.temperature > 0) set("cpuTemp", cpu.temperature);
  }

  if (snapshot.kind === "host" && isFresh("ram") && finite(m.ram?.total) && m.ram.total > 0) {
    set("ramUsedMB", m.ram.used);
  }

  const net = isFresh("network") ? networkRates(m.network) : null;
  if (net) {
    set("netRx", net.rx);
    set("netTx", net.tx);
  }

  if (Array.isArray(m.llm) && isFresh("llm")) {
    // metrics.llm is index-aligned with llmPorts (same zip as the browser's metricsStore).
    const ports = Array.isArray(snapshot.llmPorts) ? snapshot.llmPorts : [];
    m.llm.forEach((entry, i) => {
      const port = ports[i];
      if (!Number.isInteger(port) || entry?.available !== true) return;
      set(llmKey(port, "genTps"), entry.generationTps);
      set(llmKey(port, "prefillTps"), entry.prefillTps);
      if (finite(entry.kvCacheUsage)) {
        set(llmKey(port, "kvUsage"), Math.min(1, Math.max(0, entry.kvCacheUsage)));
      }
    });
  }
  return out;
}

// ─── Bucket math ──────────────────────────────────────────

/** A running aggregate: sum (not avg) so merges stay exact. */
function statOf(value) {
  return { sum: value, max: value, min: value, n: 1 };
}

/** Fold `add` into `into` (weighted by sample count). Exported for tests. */
export function mergeStat(into, add) {
  if (!into) return { ...add };
  into.sum += add.sum;
  into.max = Math.max(into.max, add.max);
  into.min = Math.min(into.min, add.min);
  into.n += add.n;
  return into;
}

function addToStats(stats, key, stat) {
  stats.set(key, mergeStat(stats.get(key), stat));
}

/**
 * Fixed-size ring of closed buckets for one tier. Slot = bucket index modulo
 * the ring length; a slot whose stored time is not the bucket being written is
 * reclaimed. Columns are allocated per series on first use.
 */
class BucketRing {
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
   * typed arrays directly — no per-bucket objects — because a 20-unit fleet
   * serializes ~110k buckets every flush.
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
    const series = {};
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

function newUnit() {
  return {
    /** Tier 0: [{ t, v: { key: value } }], oldest first. */
    raw: [],
    tiers: BUCKET_TIERS.map((tier) => ({
      ring: new BucketRing(tier.stepMs, tier.retentionMs),
      /** The bucket still filling: { t, stats: Map } or null. */
      open: null,
    })),
    /** LLM ports the unit has configured; series for other ports are dropped on flush. */
    ports: null,
  };
}

/** Round for transport and storage: whole numbers from 100, else 2 decimals (4 below 1). */
function round(v) {
  const a = Math.abs(v);
  if (a >= 100) return Math.round(v);
  if (a >= 1) return Math.round(v * 100) / 100;
  return Math.round(v * 10_000) / 10_000;
}

function statOut(key, s) {
  const out = { avg: round(s.sum / s.n), max: round(s.max) };
  if (keepsMin(key)) out.min = round(s.min);
  return out;
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

// ─── Store ────────────────────────────────────────────────

export class MetricsHistory {
  constructor({
    filePath = null,
    now = () => Date.now(),
    fileSystem = fs,
    writeFile = atomicWrite,
    logWarn = console.warn,
  } = {}) {
    this.filePath = filePath;
    this._now = typeof now === "function" ? now : () => Date.now();
    this._fs = fileSystem;
    this._writeFile = writeFile;
    this._warn = logWarn;
    /** unit id → unit (see newUnit) */
    this._units = new Map();
    /** Unit ids seen on the last record() — the live fleet. */
    this._live = null;
    this._loaded = false;
    this._dirty = false;
  }

  /** Unit ids with any history in memory (tests / diagnostics). */
  get unitIds() {
    this._ensureLoaded();
    return [...this._units.keys()];
  }

  get dirty() {
    return this._dirty;
  }

  _unit(id, create = false) {
    let unit = this._units.get(id);
    if (!unit && create) {
      unit = newUnit();
      this._units.set(id, unit);
    }
    return unit ?? null;
  }

  /** Close open buckets whose period has ended by `atMs`. */
  _closeEnded(unit, atMs) {
    unit.tiers.forEach((tier, idx) => {
      const { stepMs } = BUCKET_TIERS[idx];
      if (tier.open && tier.open.t + stepMs <= atMs) {
        tier.ring.put(tier.open.t, tier.open.stats);
        tier.open = null;
      }
    });
  }

  /**
   * Record one sampler tick. `units` is the whole fleet in order:
   * [{ id, llmPorts?, values: { key: number } | null }] — null or empty values
   * is a gap for that unit. Units missing from the list are dropped on the next
   * flush.
   */
  record(units, atMs = this._now()) {
    if (!Array.isArray(units) || !finite(atMs)) return;
    this._ensureLoaded();
    const live = new Set();
    for (const input of units) {
      const id = input?.id;
      if (typeof id !== "string" || id === "") continue;
      live.add(id);
      const values = input.values && typeof input.values === "object" ? input.values : null;
      const keys = values ? Object.keys(values).filter((k) => isKnownKey(k) && finite(values[k])) : [];
      let unit = this._unit(id, keys.length > 0);
      if (!unit) continue;
      if (Array.isArray(input.llmPorts)) unit.ports = new Set(input.llmPorts.filter(Number.isInteger));
      this._closeEnded(unit, atMs);
      if (keys.length > 0) {
        const v = {};
        for (const k of keys) v[k] = values[k];
        unit.raw.push({ t: atMs, v });
        unit.tiers.forEach((tier, idx) => {
          const bucketT = Math.floor(atMs / BUCKET_TIERS[idx].stepMs) * BUCKET_TIERS[idx].stepMs;
          if (tier.open && tier.open.t !== bucketT) {
            // Clock stepped backwards into an older bucket: store what we have.
            tier.ring.put(tier.open.t, tier.open.stats);
            tier.open = null;
          }
          if (!tier.open) tier.open = { t: bucketT, stats: new Map() };
          for (const k of keys) addToStats(tier.open.stats, k, statOf(v[k]));
        });
        this._dirty = true;
      }
      const cutoff = atMs - RAW_RETENTION_MS;
      let drop = 0;
      while (drop < unit.raw.length && unit.raw[drop].t < cutoff) drop += 1;
      if (drop > 0) unit.raw.splice(0, drop);
    }
    this._live = live;
    for (const id of this._units.keys()) {
      if (!live.has(id)) this._dirty = true;
    }
  }

  /** A tier's buckets with t ≥ fromMs, the open one merged in. */
  _tierEntries(unit, idx, fromMs) {
    const tier = unit.tiers[idx];
    const entries = tier.ring.entries(fromMs);
    const open = tier.open;
    if (open && open.t >= fromMs && open.stats.size > 0) {
      const last = entries[entries.length - 1];
      if (last && last.t === open.t) {
        for (const [key, s] of open.stats) addToStats(last.stats, key, { ...s });
      } else {
        const stats = new Map();
        for (const [key, s] of open.stats) stats.set(key, { ...s });
        entries.push({ t: open.t, stats });
        entries.sort((a, b) => a.t - b.t);
      }
    }
    return entries;
  }

  /**
   * History for one unit:
   * { range, stepMs, from, to, points: [{ t, <series>: { avg, max, min? } }],
   *   llm: [{ port, points: [{ t, genTps?, prefillTps?, kvUsage? }] }] }.
   * Throws on an unknown range (the route validates first).
   */
  query(unitId, range, atMs = this._now()) {
    const spec = HISTORY_RANGES[range];
    if (!spec) throw new Error(`unknown range: ${range}`);
    this._ensureLoaded();
    const to = atMs;
    const from = atMs - spec.spanMs;
    const gridFrom = Math.floor(from / spec.stepMs) * spec.stepMs;
    const unit = this._unit(unitId);
    let entries = [];
    if (unit) {
      if (spec.tier === 0) {
        entries = unit.raw
          .filter((s) => s.t >= gridFrom && s.t <= to)
          .map((s) => {
            const stats = new Map();
            for (const [key, value] of Object.entries(s.v)) stats.set(key, statOf(value));
            return { t: s.t, stats };
          });
      } else {
        entries = this._tierEntries(unit, spec.tier - 1, gridFrom);
      }
    }
    const merged = coarsen(entries, spec.stepMs);

    const points = [];
    const llm = new Map();
    for (const { t, stats } of merged) {
      let point = null;
      for (const [key, s] of stats) {
        const parsed = parseLlmKey(key);
        if (parsed) {
          if (unit?.ports && !unit.ports.has(parsed.port)) continue;
          let byT = llm.get(parsed.port);
          if (!byT) {
            byT = new Map();
            llm.set(parsed.port, byT);
          }
          let lp = byT.get(t);
          if (!lp) {
            lp = { t };
            byT.set(t, lp);
          }
          lp[parsed.name] = statOut(key, s);
        } else {
          if (!point) point = { t };
          point[key] = statOut(key, s);
        }
      }
      if (point) points.push(point);
    }
    return {
      range,
      stepMs: spec.stepMs,
      from,
      to,
      points,
      llm: [...llm.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([port, byT]) => ({ port, points: [...byT.values()] })),
    };
  }

  /** Forget removed units and LLM ports a unit no longer has. */
  _dropStale() {
    if (this._live) {
      for (const id of [...this._units.keys()]) {
        if (!this._live.has(id)) this._units.delete(id);
      }
    }
    for (const unit of this._units.values()) {
      if (!unit.ports) continue;
      const stale = (key) => {
        const parsed = parseLlmKey(key);
        return parsed !== null && !unit.ports.has(parsed.port);
      };
      for (const tier of unit.tiers) {
        tier.ring.dropKeys(stale);
        if (tier.open) for (const key of [...tier.open.stats.keys()]) if (stale(key)) tier.open.stats.delete(key);
      }
      for (const sample of unit.raw) {
        for (const key of Object.keys(sample.v)) if (stale(key)) delete sample.v[key];
      }
    }
  }

  /** The persisted shape (tiers 1–2, open buckets included, retention applied). */
  serialize(atMs = this._now()) {
    const units = {};
    for (const [id, unit] of this._units) {
      const tiers = {};
      BUCKET_TIERS.forEach((spec, idx) => {
        const tier = unit.tiers[idx];
        const cols = tier.ring.columns(atMs - spec.retentionMs, tier.open);
        if (Object.keys(cols.series).length > 0) tiers[spec.name] = cols;
      });
      if (Object.keys(tiers).length > 0) units[id] = tiers;
    }
    return { version: FILE_VERSION, savedAt: atMs, units };
  }

  /**
   * Write tiers 1–2 if anything changed since the last write. Dirty is only
   * ever set by record(), which the runtime calls only while the setting is on
   * — so an install that never enables it never gets a file.
   */
  flush() {
    if (!this.filePath || !this._dirty) return false;
    const atMs = this._now();
    this._dropStale();
    this._writeFile(this.filePath, `${JSON.stringify(this.serialize(atMs))}\n`, 0o600);
    this._dirty = false;
    return true;
  }

  close() {
    return this.flush();
  }

  _ensureLoaded() {
    if (this._loaded) return;
    this._loaded = true;
    if (this.filePath) this._load();
  }

  _load() {
    let raw;
    try {
      raw = this._fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this._warn(`[MetricsHistory] unable to read ${this.filePath}: ${error.message}`);
      }
      return;
    }
    let state;
    try {
      state = JSON.parse(raw);
      if (state?.version !== FILE_VERSION || typeof state.units !== "object" || state.units === null) {
        throw new Error(`unsupported format (version ${state?.version})`);
      }
    } catch (error) {
      // Keep the unreadable file beside the live one instead of overwriting it.
      const aside = `${this.filePath}.unreadable-${this._now()}`;
      this._warn(`[MetricsHistory] ignoring ${this.filePath}: ${error.message}; moved to ${aside}`);
      try {
        this._fs.renameSync(this.filePath, aside);
      } catch {
        /* the next flush overwrites it */
      }
      return;
    }
    const atMs = this._now();
    for (const [id, tiers] of Object.entries(state.units)) {
      if (typeof id !== "string" || !tiers || typeof tiers !== "object") continue;
      const unit = newUnit();
      let any = false;
      BUCKET_TIERS.forEach((spec, idx) => {
        const tier = tiers[spec.name];
        if (!tier || !Array.isArray(tier.t) || typeof tier.series !== "object") return;
        const cutoff = atMs - spec.retentionMs;
        tier.t.forEach((t, i) => {
          if (!finite(t) || t < cutoff || t % spec.stepMs !== 0) return;
          const stats = new Map();
          for (const [key, col] of Object.entries(tier.series)) {
            if (!isKnownKey(key) || !col) continue;
            const n = col.n?.[i];
            const avg = col.avg?.[i];
            const max = col.max?.[i];
            if (!(Number.isInteger(n) && n > 0) || !finite(avg) || !finite(max)) continue;
            const min = finite(col.min?.[i]) ? col.min[i] : avg;
            stats.set(key, { sum: avg * n, max, min, n });
          }
          if (stats.size > 0) {
            unit.tiers[idx].ring.put(t, stats);
            any = true;
          }
        });
      });
      if (any) this._units.set(id, unit);
    }
  }
}

export default MetricsHistory;
