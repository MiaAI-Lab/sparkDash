import fs from "fs";
import { atomicWrite, atomicWriteAsync, quarantineCorrupt } from "../util/atomicWrite.js";
import {
  BUCKET_TIERS,
  HISTORY_RANGES,
  addToStats,
  coarsen,
  finite,
  isKnownKey,
  parseLlmKey,
  statOf,
  statOut,
  BucketRing,
} from "./historyTiers.js";

const DEFAULT_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const DEFAULT_MIN_GAP_MS = 1500;
// The long GPU series (Temps page): one reading a minute for a week.
const LONG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const LONG_MIN_GAP_MS = 60_000;
// Rewriting the whole file is the cost, so save every few minutes (and on shutdown), not every minute.
const SAVE_INTERVAL_MS = 5 * 60_000;
const DEVICE_KEYS = ["u", "c", "p"];
// A host never has more cards than this; it also bounds the memory a bad payload could use.
const MAX_DEVICES = 16;
const TIERS_FILE_VERSION = 1;

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
      usage: d.metricAvailability?.usage === false ? null : d.usage,
      temperature: d.metricAvailability?.temperature === false ? null : d.temperature,
      powerPct: d.metricAvailability?.powerDraw === false || d.metricAvailability?.powerLimit === false ||
        !Number.isFinite(draw) || !Number.isFinite(limit) || limit <= 0
        ? null : Math.min(100, (draw / limit) * 100),
    });
  }
  return out;
}

const round1 = (v) => Math.round(v * 10) / 10;
const nextTick = () => new Promise((resolve) => setImmediate(resolve));

/** `{"k":v,...}` from [key, json] parts — keys are written, never assigned, so `__proto__` is just a key. */
function objectText(parts) {
  return `{${parts.map(([k, json]) => `${JSON.stringify(k)}:${json}`).join(",")}}`;
}

function newUnit() {
  return {
    tiers: BUCKET_TIERS.map((tier) => ({
      ring: new BucketRing(tier.stepMs, tier.retentionMs),
      /** The bucket still filling: { t, stats: Map } or null. */
      open: null,
    })),
    /** LLM ports the unit has configured; series for other ports are dropped on save. */
    ports: null,
  };
}

/**
 * One GPU raw series: utilization %, temperature and power % of the board limit as parallel
 * arrays per unit, one reading per `minGapMs`, kept for `maxAgeMs` and persisted to `file`
 * (`{"version":1,"sparks":{...}}`, the format GpuHistory always wrote). UnitHistory keeps two:
 * the dense one for the GPU chart and the minute-resolution week for the Temps page.
 */
class GpuSeries {
  constructor({ file, maxAgeMs, minGapMs, now, readFileSync }) {
    this.file = file;
    this.maxAgeMs = maxAgeMs;
    this.minGapMs = minGapMs;
    this._now = now;
    this._readFileSync = readFileSync;
    /** @type {Map<string, { t: number[], u: number[], c: number[], p: Array<number|null>, g: Record<string, { n: string|null, u: Array<number|null>, c: Array<number|null>, p: Array<number|null> }> }>} */
    this._map = new Map();
    // A file is dirty while `rev` is ahead of the last revision written.
    this.rev = 0;
    this.savedRev = 0;
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(this._readFileSync(this.file, "utf8"));
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
        if (out.t.length) this._map.set(id, out);
      }
    } catch (err) {
      if (err instanceof SyntaxError) quarantineCorrupt(this.file, "UnitHistory", err);
    }
  }


  /**
   * Append one reading; ignored when it is too close to the previous one or goes back in time.
   * `devices` (see deviceReadings) adds the per-card readings of a multi-GPU host.
   */
  record(sparkId, at, usage, temperature, powerPct, devices = []) {
    if (!Number.isFinite(at)) return false;
    if (![usage, temperature, powerPct].some(Number.isFinite) && (!Array.isArray(devices) || !devices.some((d) =>
      [d?.usage, d?.temperature, d?.powerPct].some(Number.isFinite)))) return false;
    let s = this._map.get(sparkId);
    if (!s) {
      s = { t: [], u: [], c: [], p: [], g: {} };
      this._map.set(sparkId, s);
    }
    const last = s.t.length ? s.t[s.t.length - 1] : -Infinity;
    if (at - last < this.minGapMs) return false;
    s.t.push(Math.round(at));
    s.u.push(Number.isFinite(usage) ? Math.round(usage * 10) / 10 : null);
    s.c.push(Number.isFinite(temperature) ? Math.round(temperature * 10) / 10 : null);
    s.p.push(Number.isFinite(powerPct) ? round1(powerPct) : null);
    this._recordDevices(s, devices);
    this._trim(s, at);
    this.rev++;
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
      g.u.push(d && Number.isFinite(d.usage) ? round1(d.usage) : null);
      g.c.push(d && Number.isFinite(d.temperature) ? round1(d.temperature) : null);
      g.p.push(d && Number.isFinite(d.powerPct) ? round1(d.powerPct) : null);
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
  prune(now) {
    const cutoff = now - this.maxAgeMs;
    for (const [id, s] of this._map) {
      let k = 0;
      while (k < s.t.length && s.t[k] < cutoff) k++;
      if (k > 0) this._cut(s, k);
      if (!s.t.length) {
        this._map.delete(id);
        this.rev++;
      }
    }
  }

  /**
   * Readings newer than `sinceMs` (ms epoch). Arrays are parallel; `p` may hold nulls.
   * `gpus` lists the cards of a multi-GPU host (by index), each with arrays parallel to `t`
   * (null where the card had no reading); it is empty for a single-GPU host.
   */
  get(sparkId, sinceMs = 0) {
    const s = this._map.get(sparkId);
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
    if (this._map.delete(sparkId)) this.rev++;
  }

  *parts() {
    for (const id of [...this._map.keys()]) {
      const s = this._map.get(id);
      if (s) yield [id, JSON.stringify(s)];
    }
  }

  text(parts) {
    return `{"version":1,"sparks":${objectText(parts)}}`;
  }
}

/**
 * Per-unit history kept on the server, so a freshly opened page can draw the last hours at
 * once instead of starting empty. One store, one sampler (UnitHistoryRuntime), three depths:
 *
 * GPU raw series (always on — what GpuHistory was): utilization %, temperature, power as % of
 * the board limit, as parallel arrays. On a multi-GPU host each card also gets its own series
 * (`g`, by device index) aligned with the aggregate timestamps, null where the card was absent,
 * so a card that appears or disappears never disturbs the aggregate. Two of them, fed by the
 * same reading:
 *   - dense: one reading per ~2 s for 8 h, persisted to `file` (gpu-history.json, format
 *     unchanged) — the GPU chart. ~0.5–1 MB of heap per unit, ~300 KB on disk.
 *   - long (when `longFile` is given): one reading per minute for 7 days, persisted to
 *     `longFile` (gpu-history-long.json, the format of 2.40.1) — the Temps page's day and week.
 *     ~10k readings per unit, a few hundred KB of heap and ~400 KB on disk; more per card on
 *     a multi-GPU host.
 * window() picks the dense series for windows up to 8 h and the long one beyond.
 *
 * Bucketed tiers (opt-in, Settings → `metricsHistory`; see historyTiers.js): 1-minute buckets
 * for 48 h and 15-minute buckets for 30 days of GPU util/temp/power (W), memory used and
 * headroom, CPU util/temp, host RAM, network rx/tx, and per LLM endpoint decode/prefill tok/s
 * and KV fill. Persisted to `tiersFile` (metrics-history.json), which is only read once the
 * setting has been on and only written while it holds data and the setting is on, so an
 * install that never enables it never gets the file, and turning it off stops the writes. There is deliberately no raw tier for these series: 8 h of 2 s
 * samples for ~13 series would add ~2–3 MB of heap and a multi-MB file per unit for detail the
 * 1-minute avg/max already summarises; the GPU chart keeps its 8 h of raw readings.
 * Worst case with every bucket full: ~0.65 MB of heap and ~1 MB on disk per unit, plus ~0.17 MB
 * of heap and ~0.3 MB on disk per LLM endpoint.
 *
 * Persistence is asynchronous (fs.promises, temp + rename, one unit serialized per event-loop
 * turn) every few minutes, coalesced (one save in flight at a time; a revision counter decides
 * whether anything changed), and synchronous only on shutdown (stop()). A sync flush
 * supersedes an in-flight async save, which then discards its temp file instead of renaming
 * older data over the newer file. Unit ids are only ever Map keys, and files are written as
 * text, so an id like `__proto__` keeps its history.
 */
export class UnitHistory {
  /**
   * @param {{
   *   file?: string|null, tiersFile?: string|null, maxAgeMs?: number, minGapMs?: number,
   *   longFile?: string|null, longMaxAgeMs?: number, longMinGapMs?: number, tiersEnabled?: () => boolean,
   *   now?: () => number, writeSync?: typeof atomicWrite, writeAsync?: typeof atomicWriteAsync,
   *   readFileSync?: typeof fs.readFileSync, yieldFn?: () => Promise<void>, logError?: (...args: any[]) => void,
   * }} [opts]
   */
  constructor({
    file = null,
    tiersFile = null,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    minGapMs = DEFAULT_MIN_GAP_MS,
    longFile = undefined,
    longMaxAgeMs = LONG_MAX_AGE_MS,
    longMinGapMs = LONG_MIN_GAP_MS,
    tiersEnabled = () => true,
    now = Date.now,
    writeSync = atomicWrite,
    writeAsync = atomicWriteAsync,
    readFileSync = fs.readFileSync,
    yieldFn = nextTick,
    logError = console.error,
  } = {}) {
    this.file = file;
    this.tiersFile = tiersFile;
    this._tiersEnabled = tiersEnabled;
    this._now = now;
    this._writeSync = writeSync;
    this._writeAsync = writeAsync;
    this._readFileSync = readFileSync;
    this._yield = yieldFn;
    this._logError = logError;
    this._gpu = new GpuSeries({ file, maxAgeMs, minGapMs, now, readFileSync });
    // `longFile: null` keeps the long series in memory only (tests); left out, there is none.
    this._gpuLong = longFile === undefined
      ? null
      : new GpuSeries({ file: longFile, maxAgeMs: longMaxAgeMs, minGapMs: longMinGapMs, now, readFileSync });
    /** unit id → bucketed tiers (see newUnit) */
    this._units = new Map();
    /** Unit ids seen on the last recordSample() — the live fleet. */
    this._live = null;
    this._tiersLoaded = false;
    // Change counters: a file is dirty while its revision is ahead of the last one written.
    this._tiersRev = 0;
    this._tiersSavedRev = 0;
    /** Bumped by every sync flush: an async save started under an older value must not commit. */
    this._writeGen = 0;
    /** @type {Promise<void> | null} */
    this._saving = null;
    this._timer = null;
  }

  /** The GPU raw series that exist (dense first). */
  _gpuSeries() {
    return this._gpuLong ? [this._gpu, this._gpuLong] : [this._gpu];
  }

  // ─── GPU raw series ─────────────────────────────────────

  /**
   * Append one reading to the dense series and, when configured, the long one; each ignores a
   * reading too close to its previous one or going back in time. `devices` (see deviceReadings)
   * adds the per-card readings of a multi-GPU host. True when either series took it.
   */
  record(sparkId, at, usage, temperature, powerPct, devices = []) {
    const dense = this._gpu.record(sparkId, at, usage, temperature, powerPct, devices);
    const long = this._gpuLong ? this._gpuLong.record(sparkId, at, usage, temperature, powerPct, devices) : false;
    return dense || long;
  }

  /**
   * Dense readings newer than `sinceMs` (ms epoch). Arrays are parallel; `p` may hold nulls.
   * `gpus` lists the cards of a multi-GPU host (by index), each with arrays parallel to `t`
   * (null where the card had no reading); it is empty for a single-GPU host.
   */
  get(sparkId, sinceMs = 0) {
    return this._gpu.get(sparkId, sinceMs);
  }

  /** The longest GPU window this store can answer: the long series' reach, else the dense one's. */
  get maxWindowMs() {
    return this._gpuLong ? this._gpuLong.maxAgeMs : this._gpu.maxAgeMs;
  }

  /**
   * The last `windowMs` of GPU readings, same shape as get(): from the dense series when it
   * reaches that far, else from the long one (Temps day/week).
   */
  window(sparkId, windowMs, atMs = this._now()) {
    const series = this._gpuLong && windowMs > this._gpu.maxAgeMs ? this._gpuLong : this._gpu;
    return series.get(sparkId, atMs - windowMs);
  }

  /** Trim every GPU series to its retention window (saves do this too). */
  _prune(now) {
    for (const series of this._gpuSeries()) series.prune(now);
  }

  /** Forget a removed unit everywhere. */
  remove(sparkId) {
    for (const series of this._gpuSeries()) series.remove(sparkId);
    if (this._units.delete(sparkId)) this._tiersRev++;
  }

  // ─── Bucketed tiers (opt-in) ────────────────────────────

  _ensureTiersLoaded() {
    if (this._tiersLoaded) return;
    this._tiersLoaded = true;
    if (this.tiersFile) this._loadTiers();
  }

  _loadTiers() {
    let raw;
    try {
      raw = this._readFileSync(this.tiersFile, "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT") this._logError(`[UnitHistory] unable to read ${this.tiersFile}: ${err.message}`);
      return;
    }
    let state;
    try {
      state = JSON.parse(raw);
      if (state?.version !== TIERS_FILE_VERSION || typeof state.units !== "object" || state.units === null) {
        throw new SyntaxError(`unsupported format (version ${state?.version})`);
      }
    } catch (err) {
      // Keep the unreadable file beside the live one instead of overwriting it.
      quarantineCorrupt(this.tiersFile, "UnitHistory", err);
      return;
    }
    const atMs = this._now();
    for (const [id, tiers] of Object.entries(state.units)) {
      if (!tiers || typeof tiers !== "object") continue;
      const unit = newUnit();
      let any = false;
      BUCKET_TIERS.forEach((spec, idx) => {
        const tier = tiers[spec.name];
        if (!tier || !Array.isArray(tier.t) || !tier.series || typeof tier.series !== "object") return;
        const cutoff = atMs - spec.retentionMs;
        const cols = Object.entries(tier.series).filter(([key, col]) => isKnownKey(key) && col);
        tier.t.forEach((t, i) => {
          if (!finite(t) || t < cutoff || t % spec.stepMs !== 0) return;
          const stats = new Map();
          for (const [key, col] of cols) {
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

  /** Close open buckets whose period has ended by `atMs`. */
  _closeEnded(unit, atMs) {
    unit.tiers.forEach((tier, idx) => {
      if (tier.open && tier.open.t + BUCKET_TIERS[idx].stepMs <= atMs) {
        tier.ring.put(tier.open.t, tier.open.stats);
        tier.open = null;
      }
    });
  }

  /**
   * Record one sampler tick into the bucketed tiers. `units` is the whole fleet in order:
   * [{ id, llmPorts?, values: { key: number } | null }] — null or empty values is a gap for
   * that unit. Units missing from the list are dropped on the next save.
   */
  recordSample(units, atMs = this._now()) {
    if (!Array.isArray(units) || !finite(atMs)) return;
    this._ensureTiersLoaded();
    const live = new Set();
    for (const input of units) {
      const id = input?.id;
      if (typeof id !== "string" || id === "") continue;
      live.add(id);
      const values = input.values && typeof input.values === "object" ? input.values : null;
      const keys = values ? Object.keys(values).filter((k) => isKnownKey(k) && finite(values[k])) : [];
      let unit = this._units.get(id);
      if (!unit && keys.length > 0) {
        unit = newUnit();
        this._units.set(id, unit);
      }
      if (!unit) continue;
      if (Array.isArray(input.llmPorts)) unit.ports = new Set(input.llmPorts.filter(Number.isInteger));
      this._closeEnded(unit, atMs);
      if (keys.length === 0) continue;
      unit.tiers.forEach((tier, idx) => {
        const { stepMs } = BUCKET_TIERS[idx];
        const bucketT = Math.floor(atMs / stepMs) * stepMs;
        if (tier.open && tier.open.t !== bucketT) {
          // Clock stepped backwards into an older bucket: store what we have.
          tier.ring.put(tier.open.t, tier.open.stats);
          tier.open = null;
        }
        if (!tier.open) tier.open = { t: bucketT, stats: new Map() };
        for (const k of keys) addToStats(tier.open.stats, k, statOf(values[k]));
      });
      this._tiersRev++;
    }
    this._live = live;
    for (const id of this._units.keys()) {
      if (!live.has(id)) {
        this._tiersRev++;
        break;
      }
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
   * Bucketed history for one unit:
   * { range, stepMs, from, to, points: [{ t, <series>: { avg, max, min? } }],
   *   llm: [{ port, points: [{ t, genTps?, prefillTps?, kvUsage? }] }] }.
   * Throws on an unknown range (the route validates first).
   */
  query(unitId, range, atMs = this._now()) {
    const spec = Object.hasOwn(HISTORY_RANGES, range) ? HISTORY_RANGES[range] : null;
    if (!spec) throw new Error(`unknown range: ${range}`);
    this._ensureTiersLoaded();
    const to = atMs;
    const from = atMs - spec.spanMs;
    const gridFrom = Math.floor(from / spec.stepMs) * spec.stepMs;
    const unit = this._units.get(unitId) ?? null;
    const merged = unit ? coarsen(this._tierEntries(unit, spec.tier, gridFrom), spec.stepMs) : [];

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
    }
  }

  /** One unit's persisted tiers (open buckets included, retention applied), or null when empty. */
  _unitTiers(unit, atMs) {
    const tiers = {};
    let any = false;
    BUCKET_TIERS.forEach((spec, idx) => {
      const tier = unit.tiers[idx];
      const cols = tier.ring.columns(atMs - spec.retentionMs, tier.open);
      if (Object.keys(cols.series).length > 0) {
        tiers[spec.name] = cols;
        any = true;
      }
    });
    return any ? tiers : null;
  }

  /** The persisted shape of the tiers file (tests and diagnostics; saves stream it per unit). */
  serializeTiers(atMs = this._now()) {
    return JSON.parse(this._tiersText([...this._tiersParts(atMs)], atMs));
  }

  *_tiersParts(atMs) {
    for (const id of [...this._units.keys()]) {
      const unit = this._units.get(id);
      const tiers = unit ? this._unitTiers(unit, atMs) : null;
      if (tiers) yield [id, JSON.stringify(tiers)];
    }
  }

  _tiersText(parts, atMs) {
    return `{"version":${TIERS_FILE_VERSION},"savedAt":${atMs},"units":${objectText(parts)}}`;
  }

  // ─── Persistence ────────────────────────────────────────

  /** Start the periodic (async) save; no-op without a file. */
  start() {
    if ((!this._gpuSeries().some((series) => series.file) && !this.tiersFile) || this._timer) return;
    this._timer = setInterval(() => void this.save(), SAVE_INTERVAL_MS);
    this._timer.unref?.();
  }

  /**
   * Write whatever changed, synchronously (shutdown, tests). Supersedes an async save in
   * flight. Returns true when a file was written.
   */
  flush() {
    this._writeGen++;
    let wrote = false;
    for (const series of this._gpuSeries()) {
      if (!series.file) continue;
      series.prune(this._now());
      if (series.rev === series.savedRev) continue;
      const rev = series.rev;
      try {
        this._writeSync(series.file, series.text([...series.parts()]));
        series.savedRev = rev;
        wrote = true;
      } catch {
        /* best effort: history is a convenience */
      }
    }
    if (this._tiersDirty()) {
      const rev = this._tiersRev;
      const atMs = this._now();
      this._dropStale();
      try {
        this._writeSync(this.tiersFile, this._tiersText([...this._tiersParts(atMs)], atMs), 0o600);
        this._tiersSavedRev = rev;
        wrote = true;
      } catch (err) {
        this._logError(`[UnitHistory] failed to write ${this.tiersFile}: ${err.message}`);
      }
    }
    return wrote;
  }

  /**
   * Write whatever changed without blocking the event loop: one unit is serialized per turn and
   * the file goes through fs.promises. Coalesced — while a save is in flight, callers share it.
   */
  save() {
    if (this._saving) return this._saving;
    const gen = this._writeGen;
    this._saving = (async () => {
      for (const series of this._gpuSeries()) {
        try {
          await this._saveGpu(series, gen);
        } catch (err) {
          this._logError(`[UnitHistory] failed to save ${series.file}: ${err.message}`);
        }
      }
      try {
        await this._saveTiers(gen);
      } catch (err) {
        this._logError(`[UnitHistory] failed to save ${this.tiersFile}: ${err.message}`);
      }
    })().finally(() => {
      this._saving = null;
    });
    return this._saving;
  }

  async _saveGpu(series, gen) {
    if (!series.file) return;
    series.prune(this._now());
    if (series.rev === series.savedRev) return;
    const rev = series.rev;
    const parts = [];
    for (const part of series.parts()) {
      parts.push(part);
      await this._yield();
    }
    const committed = await this._writeAsync(series.file, series.text(parts), 0o600, {
      shouldCommit: () => gen === this._writeGen,
    });
    if (committed !== false && gen === this._writeGen) series.savedRev = Math.max(series.savedRev, rev);
  }

  /**
   * The tiers file has unsaved changes and may be written: never while the setting is off, so
   * buckets still pending when it is turned off are not written after it (they are written if
   * it is turned on again before a restart).
   */
  _tiersDirty() {
    return Boolean(this.tiersFile) && this._tiersLoaded && this._tiersRev !== this._tiersSavedRev && this._tiersEnabled();
  }

  async _saveTiers(gen) {
    if (!this._tiersDirty()) return;
    const rev = this._tiersRev;
    const atMs = this._now();
    this._dropStale();
    const parts = [];
    // Each unit is one slice: its rings are read in a single turn, so its columns stay consistent.
    for (const part of this._tiersParts(atMs)) {
      parts.push(part);
      await this._yield();
    }
    const committed = await this._writeAsync(this.tiersFile, this._tiersText(parts, atMs), 0o600, {
      shouldCommit: () => gen === this._writeGen,
    });
    if (committed !== false && gen === this._writeGen) this._tiersSavedRev = Math.max(this._tiersSavedRev, rev);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.flush();
  }
}

export default UnitHistory;
