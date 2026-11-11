/**
 * CacheHistory — the shared-pool / prompt-state-store history for TensorFold engines.
 *
 * Kept apart from UnitHistory on purpose: these series come from cumulative counters that must be
 * differenced exactly once per observation, and from four disjoint pool categories whose sum is a
 * capacity, not a fill level. Mixing them into the gauge store would either double-count deltas
 * (two pollers) or average categories into nonsense. It has its own bounded sidecar file, so a
 * rollback that drops the live panels leaves nothing to unwind.
 *
 * Shape: two tiers of closed buckets (the same 1 m / 15 m grid UnitHistory uses), sparse — a bucket
 * exists only if an observation landed in it, and a gap stays a gap. Buckets carry
 *   g  gauge sums/counts (mean on read), with max for pool categories and last for step values,
 *   c  counter-delta sums,
 *   reuse  prompt / cached / completion tokens for the bucket's weighted reuse share,
 *   h  cumulative-histogram deltas (fine tier only), so a window p95 comes from bucket counts.
 *
 * Exactly-once: an observation is identified by (port, engine epoch, observed_unix_ns). A repeat or
 * older stamp is skipped, a new epoch or a backwards stamp rebaselines and records an event.
 *
 * Disk: bounded by slots, not request volume. A saturated one-port fixture (2,880 buckets per tier,
 * every gauge, coverage duration, 13 deltas above 2^32, 20 histogram bounds, 200 numeric events)
 * serialized to 8,548,723 bytes (~8.2 MiB). Its post-GC V8 heap delta was ~12.5 MiB, a process-level
 * estimate rather than allocation-event profiling. The bound is unconditional, not fixture-dependent:
 * histograms above 64 buckets per series are refused (recorded as `telemetry_invalid`) and epochs are
 * clamped to 128 characters at ingest. Several ports scale with their fixed tiers;
 * MAX_EVENTS (200) is shared per unit. The file does not grow with uptime: retention
 * prunes on write, and it is replaced atomically (temp file + rename), so a crash mid-write leaves the
 * previous file intact rather than a truncated one.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { HISTORY_RANGES } from "./historyTiers.js";

export const CACHE_SCHEMA = 1;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Same grid as the dashboard's other history: 1 m for 48 h, 15 m for 30 d. */
const TIERS = [
  { stepMs: MINUTE_MS, retentionMs: 48 * 60 * MINUTE_MS, slots: 2880, histograms: true },
  { stepMs: 15 * MINUTE_MS, retentionMs: 30 * DAY_MS, slots: 2880, histograms: false },
];

/** A real TensorFold histogram has ~19 buckets; beyond this the exposition is broken or hostile,
 * not finer — the series is treated as absent rather than stored (and the disk bound holds unconditionally). */
const MAX_HISTOGRAM_BUCKETS = 64;
/** Engine epochs are numeric strings (~19 chars); clamped so a pathological engine cannot bloat
 * the sidecar or the event ring through `engine_epoch`. */
const MAX_EPOCH_CHARS = 128;
const SLOT_COUNT = Math.max(...TIERS.map((t) => t.slots));
/** Bounded event log per unit; oldest dropped. */
const MAX_EVENTS = 200;
/** A repeated event of one kind inside this window is coalesced. */
const EVENT_COALESCE_MS = 60_000;
/** An engine clock this far from the dashboard's is reported once. */
const CLOCK_SKEW_MS = 30_000;
/** Beyond this, the observation window is unknown: never backfill its counter deltas. */
const MAX_GAP_MS = 90_000;

/** Gauges: `max` keeps the peak, `step` marks a configuration value (never averaged). */
const GAUGES = {
  capacity: { step: true },
  active: { max: true },
  prefix: { max: true },
  growth: { max: true },
  unclaimed: { max: true },
  validStates: {},
  held: {},
  spare: {},
  budget: { step: true },
  entries: {},
  running: { max: true },
  waiting: { max: true },
};

/** Cumulative counters whose per-observation delta is summed into a bucket. */
const COUNTERS = [
  "promptTokens",
  "cachedTokens",
  "completions",
  "hits",
  "misses",
  "evictions",
  "refusals",
  "failures",
  "failuresKeep",
  "failuresRestore",
  "failuresPeerForget",
  "invalidations",
  "placementBlocks",
];

const round = (v) => {
  const a = Math.abs(v);
  if (a >= 1000) return Math.round(v);
  if (a >= 1) return Math.round(v * 100) / 100;
  return Math.round(v * 10_000) / 10_000;
};

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Percentile from bucket counts. `edges[i]` is the bucket's upper bound (the last is Infinity).
 * Returns `{ value, upperBound, exact }`: the interpolated position, or the bucket's upper bound
 * when interpolation inside it is not possible; `exact: false` says the figure is an approximation.
 */
export function quantileFromCounts(counts, edges, q = 0.95) {
  let total = 0;
  for (const c of counts) total += c;
  if (!(total > 0)) return null;
  const target = q * total;
  let seen = 0;
  for (let i = 0; i < counts.length; i += 1) {
    const next = seen + counts[i];
    if (target <= next) {
      const upper = edges[i];
      const lower = i === 0 ? 0 : edges[i - 1];
      const within = counts[i] > 0 ? (target - seen) / counts[i] : 0;
      if (Number.isFinite(upper) && upper > lower) {
        return { value: round(lower + (upper - lower) * within), upperBound: round(upper), exact: false };
      }
      // The +Inf bucket: the true value is above its lower bound and unbounded, so it is reported
      // as open rather than clamped to a number the engine never measured.
      return { value: null, lowerBound: round(lower), open: true, exact: false };
    }
    seen = next;
  }
  return null;
}

/** A bucket is created lazily so an hour without traffic costs nothing. */
function newBucket(t) {
  return { t, n: 0, g: {}, c: {}, reuse: [0, 0, 0], h: null };
}

export class CacheHistory {
  /**
   * @param {{ file?: string | null, now?: () => number, logError?: (...a: unknown[]) => void }} [opts]
   */
  constructor({ file = null, now = Date.now, logError = console.error } = {}) {
    this.file = file;
    this._now = now;
    this._log = logError;
    /** @type {Map<string, { ports: Map<number, object>, events: object[] }>} */
    this._units = new Map();
    this._loaded = false;
    this._timer = null;
    this._dirty = false;
  }

  // ─── ingest ──────────────────────────────────────────────────────────────
  /**
   * Consume one unit snapshot. Called once per sampling tick with the same snapshot the gauge tier
   * sees; endpoints that are down, unreadable or report no cache group are gaps.
   * @param {{ id?: string, llmPorts?: number[], metrics?: { llm?: any[] } }} snapshot
   * @param {number} atMs dashboard-clock time of the sample
   */
  record(snapshot, atMs) {
    const id = snapshot?.id;
    if (typeof id !== "string" || !id) return;
    const entries = Array.isArray(snapshot?.metrics?.llm) ? snapshot.metrics.llm : [];
    const ports = Array.isArray(snapshot?.llmPorts) ? snapshot.llmPorts : [];
    entries.forEach((entry, i) => {
      const port = Number.isInteger(entry?.port) ? entry.port : ports[i];
      if (!Number.isInteger(port) || (ports.length > 0 && !ports.includes(port))) return;
      if (entry?.available !== true || entry?.measurementValid === false) {
        this._rebaseline(this._units.get(id)?.ports.get(port));
        this._event(id, port, atMs, "telemetry_lost", { reason: entry?.measurementValid === false ? "measurement_invalid" : "endpoint_unavailable" });
        return;
      }
      const cache = entry?.cache;
      if (!cache || typeof cache !== "object") {
        const state = this._units.get(id)?.ports.get(port);
        if (state) {
          this._rebaseline(state);
          this._event(id, port, atMs, "telemetry_lost", { reason: "cache_group_missing" });
        }
        return;
      }
      if (cache.status !== "full" && cache.status !== "partial") {
        this._rebaseline(this._units.get(id)?.ports.get(port));
        this._event(id, port, atMs, cache.status === "unavailable" ? "telemetry_lost" : "telemetry_invalid", {
          status: ["unavailable", "inconsistent", "invalid", "unsupported"].includes(cache.status) ? cache.status : "unknown",
          reason: "cache_telemetry_unavailable_or_invalid",
        });
        return;
      }
      try {
        this._ingest(id, port, entry, cache, atMs);
      } catch (error) {
        this._log("[CacheHistory] ingest error", error);
      }
    });
  }

  _portState(unitId, port) {
    let unit = this._units.get(unitId);
    if (!unit) {
      unit = { ports: new Map(), events: [] };
      this._units.set(unitId, unit);
    }
    let state = unit.ports.get(port);
    if (!state) {
      state = {
        epoch: null,
        observedAt: null,
        lastAt: null,
        counters: {},
        histograms: null,
        edges: null,
        tiers: TIERS.map(() => new Map()),
        events: unit.events,
      };
      unit.ports.set(port, state);
    }
    return state;
  }

  _ingest(unitId, port, entry, cache, atMs) {
    const state = this._portState(unitId, port);
    state.firstAvailableAt ??= atMs;
    const epoch = typeof cache.engineEpoch === "string" ? cache.engineEpoch.slice(0, MAX_EPOCH_CHARS) : null;
    const observedAt = finite(cache.observedAt) ? cache.observedAt : null;
    if (observedAt != null && state.observedAt != null) {
      if (observedAt === state.observedAt && epoch === state.epoch) return; // same observation already consumed
      if (epoch !== state.epoch) {
        this._event(unitId, port, atMs, "engine_restart", { from: state.epoch, to: epoch });
        this._rebaseline(state);
      } else if (observedAt < state.observedAt) {
        this._event(unitId, port, atMs, "observation_backwards", {
          previous: state.observedAt,
          observedAt,
        });
        this._rebaseline(state);
      }
    }
    if (observedAt != null) {
      if (state.lastAt != null && Math.abs(atMs - observedAt) > CLOCK_SKEW_MS && state.skewReported !== true) {
        state.skewReported = true;
        this._event(unitId, port, atMs, "clock_skew", { lagMs: atMs - observedAt });
      }
      state.observedAt = observedAt;
    }
    if (state.lastAt != null && atMs - state.lastAt > MAX_GAP_MS) {
      this._event(unitId, port, atMs, "collection_gap", { durationMs: atMs - state.lastAt });
      this._rebaseline(state);
    }
    let coveredMs = state.lastAt == null ? 0 : Math.max(0, atMs - state.lastAt);
    state.epoch = epoch;
    state.lastAt = atMs;

    const pool = cache.pool;
    const store = cache.promptState;
    const gauges = {
      capacity: pool?.capacityPositions,
      active: pool?.activeReservedPositions,
      prefix: pool?.retainedPrefixPositions,
      growth: pool?.retainedGrowthPositions,
      unclaimed: pool?.unclaimedPositions,
      validStates: pool?.validStates,
      held: store?.enabled ? store.heldBytes : null,
      spare: store?.enabled ? store.spareBytes : null,
      budget: store?.enabled ? store.budgetBytes : null,
      entries: store?.enabled ? store.entries : null,
      running: entry.requestsRunning,
      waiting: entry.requestsWaiting,
    };

    const counters = {
      hits: store?.hitsTotal,
      misses: store?.missesTotal,
      evictions: store?.evictionsTotal,
      refusals: store?.refusalsTotal,
      failures: store?.failuresTotal,
      failuresKeep: store?.failuresKeepTotal,
      failuresRestore: store?.failuresRestoreTotal,
      failuresPeerForget: store?.failuresPeerForgetTotal,
      invalidations: pool?.invalidationsTotal,
      placementBlocks: pool?.placementBlocksTotal,
    };

    // Histograms are cumulative bucket counts; the total is the completion count.
    const hist = entry.cacheHistograms;
    const histOk =
      hist && Array.isArray(hist.ttft?.counts) && Array.isArray(hist.latency?.counts) &&
      Array.isArray(hist.ttft?.edges) && Array.isArray(hist.latency?.edges) &&
      hist.ttft.counts.length === hist.ttft.edges.length &&
      hist.latency.counts.length === hist.latency.edges.length &&
      hist.ttft.counts.length <= MAX_HISTOGRAM_BUCKETS &&
      hist.latency.counts.length <= MAX_HISTOGRAM_BUCKETS;
    if (hist && !histOk && (Array.isArray(hist.ttft?.counts) || Array.isArray(hist.latency?.counts))) {
      this._event(unitId, port, atMs, "telemetry_invalid", {
        reason: "histogram_arity",
        buckets: Math.max(hist.ttft?.counts?.length ?? 0, hist.latency?.counts?.length ?? 0),
      });
    }
    if (histOk) counters.completions = hist.latency.counts[hist.latency.counts.length - 1] ?? null;
    if (finite(entry.totalPromptTokens)) counters.promptTokens = entry.totalPromptTokens;
    if (finite(entry.totalCachedTokens)) counters.cachedTokens = entry.totalCachedTokens;

    // Counter deltas: only meaningful against the same engine epoch and a monotone counter.
    const deltas = {};
    let resetSeen = false;
    for (const key of COUNTERS) {
      const value = counters[key];
      const previous = state.counters[key];
      state.counters[key] = finite(value) ? value : null;
      if (!finite(value)) continue;
      if (previous == null) continue; // baseline only
      if (value < previous) {
        resetSeen = true;
        continue; // This whole observation becomes a baseline, not invented first-window traffic.
      }
      deltas[key] = value - previous;
    }
    const invalidReuse = finite(deltas.promptTokens) && finite(deltas.cachedTokens) && deltas.cachedTokens > deltas.promptTokens;
    if (resetSeen || invalidReuse) {
      this._event(unitId, port, atMs, resetSeen ? "counter_reset" : "telemetry_invalid", invalidReuse ? { reason: "cached_delta_exceeds_prompt_delta" } : null);
      for (const key of Object.keys(deltas)) delete deltas[key];
      state.histograms = null;
      coveredMs = 0;
    }
    const pressure = Object.fromEntries(["evictions", "invalidations", "refusals", "failures", "failuresKeep", "failuresRestore", "failuresPeerForget", "placementBlocks"]
      .filter((key) => deltas[key] > 0).map((key) => [key, deltas[key]]));
    if (entry.requestsWaiting > 0) pressure.waiting = entry.requestsWaiting;
    if (Object.keys(pressure).length) this._event(unitId, port, atMs, "cache_pressure", pressure);

    let histDeltas = null;
    if (histOk) {
      const edges = { ttft: hist.ttft.edges, latency: hist.latency.edges };
      const sameEdges =
        state.edges != null &&
        state.edges.ttft.length === edges.ttft.length &&
        state.edges.latency.length === edges.latency.length &&
        // JSON encodes the persisted +Inf boundary as null; it is not a new edge.
        state.edges.ttft.every((e, i) => (e ?? Infinity) === edges.ttft[i]) &&
        state.edges.latency.every((e, i) => (e ?? Infinity) === edges.latency[i]);
      if (!sameEdges) {
        if (state.edges != null) this._event(unitId, port, atMs, "histogram_edges_changed", null);
        state.histograms = null;
        state.edges = edges;
      }
      const previous = state.histograms;
      if (previous) {
        histDeltas = { ttft: [], latency: [] };
        for (const kind of ["ttft", "latency"]) {
          const prev = previous[kind];
          const cur = hist[kind].counts;
          if (prev.length !== cur.length || cur.some((c, i) => !finite(c) || c < prev[i])) {
            histDeltas = null;
            this._event(unitId, port, atMs, "counter_reset", { histogram: kind });
            break;
          }
          histDeltas[kind] = cur.map((c, i) => c - prev[i]);
        }
      }
      state.histograms = { ttft: hist.ttft.counts.slice(), latency: hist.latency.counts.slice() };
    }

    this._writeBucket(state, atMs, gauges, deltas, histDeltas, hist ? { ttft: hist.ttft.edges, latency: hist.latency.edges } : null, coveredMs);
    void entry;
  }

  _rebaseline(state) {
    if (!state) return;
    state.lastAt = null;
    state.counters = {};
    state.histograms = null;
    state.edges = null;
  }

  _writeBucket(state, atMs, gauges, deltas, histDeltas, edges, coveredMs) {
    for (let ti = 0; ti < TIERS.length; ti += 1) {
      const tier = TIERS[ti];
      const slot = Math.floor(atMs / tier.stepMs) % tier.slots;
      const ring = state.tiers[ti];
      const t = Math.floor(atMs / tier.stepMs) * tier.stepMs;
      let bucket = ring.get(slot);
      if (!bucket || bucket.t !== t) {
        bucket = newBucket(t);
        ring.set(slot, bucket);
        this._prune(ring, tier, atMs);
      }
      if (bucket.n > 0 && !finite(bucket.coveredMs)) bucket.coveragePartial = true;
      bucket.coveredMs = (bucket.coveredMs ?? 0) + coveredMs;
      bucket.n += 1;
      for (const [key, spec] of Object.entries(GAUGES)) {
        const value = gauges[key];
        if (!finite(value)) continue;
        let g = bucket.g[key];
        if (!g) g = bucket.g[key] = { s: 0, n: 0, max: -Infinity, last: 0, first: value };
        g.s += value;
        g.n += 1;
        g.max = Math.max(g.max, value);
        g.last = value;
        // A configuration value is a step: keep its last value and mark that it moved, because the
        // mean of a capacity is not a capacity.
        if (spec.step && g.last !== g.first) g.changed = true;
      }
      for (const [key, value] of Object.entries(deltas)) {
        bucket.c[key] = (bucket.c[key] ?? 0) + value;
      }
      if (finite(deltas.promptTokens) && finite(deltas.cachedTokens)) {
        bucket.reuse[0] += deltas.promptTokens;
        bucket.reuse[1] += deltas.cachedTokens;
      }
      if (finite(deltas.completions)) bucket.reuse[2] += deltas.completions;
      if (tier.histograms && histDeltas) {
        if (!bucket.h) bucket.h = { ttft: [], latency: [], edges: { ttft: null, latency: null } };
        for (const kind of ["ttft", "latency"]) {
          if (!bucket.h[kind].length) bucket.h[kind] = histDeltas[kind].map(() => 0);
          histDeltas[kind].forEach((c, i) => {
            bucket.h[kind][i] += c;
          });
        }
        if (edges) bucket.h.edges = { ttft: edges.ttft.slice(), latency: edges.latency.slice() };
      }
    }
    this._dirty = true;
  }

  _prune(ring, tier, atMs) {
    const oldest = atMs - tier.retentionMs;
    for (const [slot, bucket] of ring) {
      if (bucket.t < oldest) ring.delete(slot);
    }
  }

  _event(unitId, port, atMs, kind, detail) {
    const unit = this._units.get(unitId) ?? { ports: new Map(), events: [] };
    if (!this._units.has(unitId)) this._units.set(unitId, unit);
    const events = unit.events;
    const last = events[events.length - 1];
    if (last && last.port === port && last.kind === kind && atMs - last.t < EVENT_COALESCE_MS) {
      if (kind === "cache_pressure") {
        last.until = atMs;
        for (const [key, value] of Object.entries(detail ?? {})) {
          last.detail[key] = key === "waiting" ? Math.max(last.detail[key] ?? 0, value) : (last.detail[key] ?? 0) + value;
        }
        this._dirty = true;
      }
      return;
    }
    this._dirty = true;
    events.push({ t: atMs, port, kind, ...(detail ? { detail } : {}) });
    while (events.length > MAX_EVENTS) {
      const pressure = events.findIndex((e) => e.kind === "cache_pressure");
      events.splice(pressure < 0 ? 0 : pressure, 1); // Keep epoch/gap boundaries ahead of noisy churn.
    }
    for (const state of unit.ports.values()) state.events = events;
  }

  // ─── read ────────────────────────────────────────────────────────────────
  /**
   * Bucketed cache history for one unit over a dashboard range. Points carry only what was
   * observed: a gap is an absent point, and a partial report leaves its fields out.
   * @param {string} unitId
   * @param {string} range
   * @param {number} atMs
   */
  query(unitId, range, atMs = this._now()) {
    const spec = Object.hasOwn(HISTORY_RANGES, range) ? HISTORY_RANGES[range] : null;
    if (!spec) throw new Error(`unknown range: ${range}`);
    const from = atMs - spec.spanMs;
    const gridFrom = Math.floor(from / spec.stepMs) * spec.stepMs;
    const unit = this._units.get(unitId) ?? null;
    const endpoints = [];
    if (unit) {
      for (const [port, state] of [...unit.ports.entries()].sort((a, b) => a[0] - b[0])) {
        const merged = this._merge(state.tiers[spec.tier], spec, gridFrom, atMs);
        endpoints.push({
          port,
          engineEpoch: state.epoch,
          ...(finite(state.firstAvailableAt) ? { firstAvailableAt: state.firstAvailableAt } : {}),
          points: merged.map((m) => this._pointOut(m, spec.stepMs)),
        });
      }
    }
    return {
      range,
      stepMs: spec.stepMs,
      from,
      to: atMs,
      endpoints,
      events: (unit?.events ?? []).filter((e) => e.t >= gridFrom && e.t <= atMs),
    };
  }

  /** Merge closed buckets into the range's step grid (weighted means, summed deltas). */
  _merge(ring, spec, gridFrom, atMs) {
    const merged = new Map();
    for (const bucket of [...ring.values()].sort((a, b) => a.t - b.t)) {
      if (bucket.t < gridFrom || bucket.t > atMs) continue;
      const t = Math.floor(bucket.t / spec.stepMs) * spec.stepMs;
      let m = merged.get(t);
      if (!m) {
        m = { t, n: 0, g: {}, c: {}, reuse: [0, 0, 0], h: null };
        merged.set(t, m);
      }
      if (finite(bucket.coveredMs)) m.coveredMs = (m.coveredMs ?? 0) + bucket.coveredMs;
      if (!finite(bucket.coveredMs) || bucket.coveragePartial) m.coveragePartial = true;
      m.n += bucket.n;
      for (const [key, g] of Object.entries(bucket.g)) {
        const agg = (m.g[key] ??= { s: 0, n: 0, max: -Infinity, last: 0, changed: false, anyLast: false, first: null });
        agg.s += g.s;
        agg.n += g.n;
        agg.max = Math.max(agg.max, g.max);
        if (agg.first == null) agg.first = g.last;
        agg.last = g.last;
        agg.anyLast = true;
        agg.changed = agg.changed || g.changed === true || (agg.anyLast && agg.first !== g.last);
      }
      for (const [key, value] of Object.entries(bucket.c)) m.c[key] = (m.c[key] ?? 0) + value;
      m.reuse[0] += bucket.reuse[0];
      m.reuse[1] += bucket.reuse[1];
      m.reuse[2] += bucket.reuse[2];
      if (bucket.h) {
        if (!m.h) m.h = { ttft: [], latency: [], edges: null };
        for (const kind of ["ttft", "latency"]) {
          if (!m.h[kind].length) m.h[kind] = bucket.h[kind].map(() => 0);
          bucket.h[kind].forEach((c, i) => {
            m.h[kind][i] += c;
          });
        }
        m.h.edges = bucket.h.edges ?? m.h.edges;
      }
    }
    return [...merged.values()].sort((a, b) => a.t - b.t);
  }

  _pointOut(m, stepMs) {
    const point = { t: m.t, n: m.n };
    if (finite(m.coveredMs)) point.coveredMs = m.coveredMs;
    if (m.coveragePartial) point.coveragePartial = true;
    const mean = (g) => (g && g.n > 0 ? round(g.s / g.n) : null);
    const max = (g) => (g && g.n > 0 && Number.isFinite(g.max) ? round(g.max) : null);
    const step = (g) => (g && g.n > 0 ? round(g.last) : null);

    const capacity = step(m.g.capacity);
    const categories = {
      active: mean(m.g.active),
      prefix: mean(m.g.prefix),
      growth: mean(m.g.growth),
      unclaimed: mean(m.g.unclaimed),
    };
    if (Object.values(categories).some((v) => v != null) && capacity != null) {
      point.pool = { capacity, ...categories };
      point.poolMax = { active: max(m.g.active), prefix: max(m.g.prefix), growth: max(m.g.growth) };
      if (m.g.capacity?.changed) point.capacityChanged = true;
      if (m.g.budget?.changed) point.budgetChanged = true;
    }
    const store = {
      held: mean(m.g.held),
      spare: mean(m.g.spare),
      entries: mean(m.g.entries),
    };
    if (store.held != null) point.store = { ...store, budget: step(m.g.budget) };
    const running = mean(m.g.running);
    if (running != null) point.running = running;
    const waiting = mean(m.g.waiting);
    if (waiting != null) point.waiting = waiting;
    if (m.g.validStates) point.validStates = mean(m.g.validStates);

    // Weighted reuse over the window: tokens, not a mean of per-sample percentages.
    if (finite(m.c.promptTokens) && finite(m.c.cachedTokens)) {
      point.promptTokens = Math.round(m.reuse[0]);
      point.cachedTokens = Math.round(m.reuse[1]);
      if (m.reuse[0] > 0 && m.reuse[1] <= m.reuse[0]) point.reusePct = round((m.reuse[1] / m.reuse[0]) * 100);
    }
    if (finite(m.c.completions)) point.completions = Math.round(m.reuse[2]);
    if (Object.keys(m.c).length) {
      point.churn = {...m.c};
      delete point.churn.promptTokens;
      delete point.churn.cachedTokens;
      if (Object.keys(point.churn).length === 0) delete point.churn;
    }
    if (m.h && m.h.ttft.length) {
      // Prometheus deltas remain cumulative across bounds; interpolation needs exclusive bins.
      point.histogramSamples = { ttft: m.h.ttft.at(-1) ?? 0, latency: m.h.latency.at(-1) ?? 0 };
      const ttft = quantileFromCounts(m.h.ttft.map((c, i, a) => c - (a[i - 1] ?? 0)), m.h.edges?.ttft ?? []);
      const latency = quantileFromCounts(m.h.latency.map((c, i, a) => c - (a[i - 1] ?? 0)), m.h.edges?.latency ?? []);
      if (ttft) point.ttftP95 = ttft;
      if (latency) point.latencyP95 = latency;
    }
    void stepMs;
    return point;
  }

  // ─── persistence ─────────────────────────────────────────────────────────
  _serialize() {
    const units = {};
    for (const [id, unit] of this._units) {
      const ports = {};
      for (const [port, state] of unit.ports) {
        ports[port] = {
          epoch: state.epoch,
          firstAvailableAt: state.firstAvailableAt,
          observedAt: state.observedAt,
          lastAt: state.lastAt,
          counters: state.counters,
          histograms: state.histograms,
          edges: state.edges,
          tiers: state.tiers.map((ring) => [...ring.values()]),
        };
      }
      units[id] = { ports, events: unit.events };
    }
    return { schema: CACHE_SCHEMA, savedAt: this._now(), tiers: TIERS.map((t) => ({ stepMs: t.stepMs, retentionMs: t.retentionMs })), units };
  }

  _deserialize(raw) {
    if (!raw || typeof raw !== "object" || raw.schema !== CACHE_SCHEMA || typeof raw.units !== "object") {
      throw new Error("unsupported cache-history file");
    }
    for (const [id, unit] of Object.entries(raw.units)) {
      if (!unit || typeof unit !== "object" || typeof unit.ports !== "object") continue;
      const ports = new Map();
      for (const [port, state] of Object.entries(unit.ports)) {
        const n = Number(port);
        if (!Number.isInteger(n) || !state || typeof state !== "object") continue;
        const tiers = TIERS.map((tier, ti) => {
          const ring = new Map();
          const buckets = Array.isArray(state.tiers?.[ti]) ? state.tiers[ti] : [];
          for (const bucket of buckets) {
            if (!bucket || !finite(bucket.t)) continue;
            const slot = Math.floor(bucket.t / tier.stepMs) % tier.slots;
            ring.set(slot, {
              t: bucket.t,
              n: finite(bucket.n) ? bucket.n : 0,
              ...(finite(bucket.coveredMs) ? { coveredMs: bucket.coveredMs } : {}),
              ...(bucket.coveragePartial ? { coveragePartial: true } : {}),
              g: bucket.g && typeof bucket.g === "object" ? bucket.g : {},
              c: bucket.c && typeof bucket.c === "object" ? bucket.c : {},
              reuse: Array.isArray(bucket.reuse) ? bucket.reuse.map((v) => (finite(v) ? v : 0)) : [0, 0, 0],
              h: bucket.h ?? null,
            });
          }
          return ring;
        });
        const firstBucket = Math.min(...[...(tiers[0].size ? tiers[0] : tiers[1]).values()].map((b) => b.t));
        ports.set(n, {
          epoch: state.epoch ?? null,
          firstAvailableAt: finite(state.firstAvailableAt) ? state.firstAvailableAt : finite(firstBucket) ? firstBucket : null,
          observedAt: finite(state.observedAt) ? state.observedAt : null,
          lastAt: finite(state.lastAt) ? state.lastAt : null,
          counters: state.counters && typeof state.counters === "object" ? state.counters : {},
          histograms: state.histograms ?? null,
          edges: state.edges ?? null,
          tiers,
          events: [],
        });
      }
      const events = Array.isArray(unit.events) ? unit.events.filter((e) => e && finite(e.t)) : [];
      for (const state of ports.values()) state.events = events;
      this._units.set(id, { ports, events });
    }
    this._loaded = true;
  }

  _ensureLoaded() {
    if (this._loaded) return;
    this._loaded = true;
    if (!this.file) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      this._deserialize(raw);
    } catch (error) {
      if (error?.code !== "ENOENT") this._log("[CacheHistory] starting empty:", error?.message ?? error);
    }
  }

  /** Write the sidecar now (atomic: temp file + rename). Best effort; never throws. */
  save() {
    if (!this.file) return false;
    try {
      const dir = dirname(this.file);
      mkdirSync(dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this._serialize()));
      renameSync(tmp, this.file);
      this._dirty = false;
      return true;
    } catch (error) {
      this._log("[CacheHistory] save failed", error);
      return false;
    }
  }

  start({ intervalMs = 60_000 } = {}) {
    this._ensureLoaded();
    if (!this.file || this._timer) return;
    this._timer = setInterval(() => {
      if (this._dirty) this.save();
    }, intervalMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this._dirty) this.save();
  }

  /** Forget units that no longer exist (called from the runtime's tick). */
  prune(ids) {
    if (!(ids instanceof Set)) return;
    for (const id of [...this._units.keys()]) {
      if (!ids.has(id)) this._units.delete(id);
    }
  }

  /** Test/ops view: how many buckets and events are held. */
  stats() {
    let buckets = 0;
    let events = 0;
    for (const unit of this._units.values()) {
      events += unit.events.length;
      for (const state of unit.ports.values()) {
        for (const ring of state.tiers) buckets += ring.size;
      }
    }
    return { units: this._units.size, buckets, events, maxSlots: SLOT_COUNT };
  }
}
