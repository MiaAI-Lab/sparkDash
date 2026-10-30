import fs from "node:fs";
import path from "node:path";
import { writeStateAtomically } from "./atomicWrite.js";
import { MonthlyEnergyArchive } from "./FleetEnergyMonthly.js";
import { learnWallRatios, wallMinute } from "./wallMinute.js";

const FILE_VERSION = 1;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const RETENTION_MS = 31 * DAY_MS;
const MAX_COMPLETED_BUCKETS = 44_640;
const MAX_GAP_MS = 10_000;
const CURRENT_WINDOW_MS = 30_000;
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const MAX_RECENT_SAMPLES = 10_000;
const MAX_NODE_WH_PER_MINUTE = 4;
const MIN_NODE_WATTS = 28.2;
const PERSISTENCE_RELATIVE_TOLERANCE = 1e-9;
// Optional per-node series beside the estimate (pure additions to a bucket):
//   parts  { [nodeId]: [gpuWh, cpuWh, coverageMs] }   GPU draw as measured, CPU as modelled,
//                                                      from the same samples as the estimate
//   wall   { [nodeId]: [wh, coverageMs, meteredMs] }   wall power from an external meter;
//                                                      meteredMs is the part the meter's own
//                                                      record confirmed (live readings fill the rest)
const MAX_PART_WATTS = 5_000;
const MAX_WALL_WATTS = 20_000;
const WALL_PERIODS_MS = new Set([5 * MINUTE_MS, HOUR_MS]);

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

// Minute buckets intentionally include the bucket crossing a rolling window's
// exact leading edge, limiting approximation error to less than one minute.
function alignedWindowCutoff(atMs, windowMs) {
  return Math.floor((atMs - windowMs) / MINUTE_MS) * MINUTE_MS;
}

function normalizeNodeIds(nodeIds) {
  if (!Array.isArray(nodeIds)) return [];
  return [...new Set(nodeIds.filter((id) => typeof id === "string" && id.trim() !== ""))];
}

function nodeValues(nodeIds, value, fallback = 0) {
  return Object.fromEntries(nodeIds.map((id) => [id, value?.[id] ?? fallback]));
}

/** Running wall sums for the last 24 h and 31 days, and the 24 hourly slots. */
function emptyWallSums(nodeIds) {
  return {
    windows: [0, 1].map(() => ({
      energyWh: 0,
      filledWh: 0,
      nodeCoverageMs: nodeValues(nodeIds),
      fleetCoverageMs: 0,
      coveredTokens: 0,
      tokenFleetWh: 0,
    })),
    hours: Array.from({ length: 24 }, () => ({ wh: 0, coverageMs: 0 })),
  };
}

function emptyBucket(minuteStartMs, nodeIds) {
  return {
    minuteStartMs,
    nodeWh: nodeValues(nodeIds),
    nodeCoverageMs: nodeValues(nodeIds),
    fleetWattMs: 0,
    fleetCoverageMs: 0,
    outputTokens: 0,
    coveredOutputTokens: 0,
  };
}

function validNonnegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function validNonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validAccountingHighWater(value) {
  return validNonnegative(value) && value <= Number.MAX_SAFE_INTEGER;
}

function exceedsWithFloatingTolerance(value, maximum) {
  const tolerance = PERSISTENCE_RELATIVE_TOLERANCE * Math.max(1, Math.abs(maximum));
  return value > maximum + tolerance;
}

function fallsBelowWithFloatingTolerance(value, minimum) {
  const tolerance = PERSISTENCE_RELATIVE_TOLERANCE * Math.max(1, Math.abs(minimum));
  return value < minimum - tolerance;
}

function unaccountedInterval(previous, current, highWaterMs) {
  if (highWaterMs === null) return { previous, current };
  if (current.atMs <= highWaterMs) return null;
  if (previous.atMs >= highWaterMs) return { previous, current };

  const fraction = (highWaterMs - previous.atMs) / (current.atMs - previous.atMs);
  const trimmed = { atMs: highWaterMs };
  for (const key of ["watts", "gpuWatts", "cpuWatts"]) {
    if (Number.isFinite(previous[key]) && Number.isFinite(current[key])) {
      trimmed[key] = previous[key] + (current[key] - previous[key]) * fraction;
    }
  }
  return { previous: trimmed, current };
}

function hasExactNodeKeys(value, nodeIds, nodeIdSet) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === nodeIds.length &&
    keys.every((key) => nodeIdSet.has(key))
  );
}

/**
 * Plausibility gate for a bucket read back from disk, shared by the live load and the
 * roll-up of an out-of-scope file: per-node Wh within 4 Wh/min, 28.2-240 W bounds,
 * coverage within a minute, token counts as safe integers. Returns a clean bucket for
 * `nodeIds`, or null when anything is implausible.
 */
function restoreBucket(candidate, minuteStartMs, nodeIds) {
  const nodeIdSet = new Set(nodeIds);
  if (
    !hasExactNodeKeys(candidate?.nodeWh, nodeIds, nodeIdSet) ||
    !hasExactNodeKeys(candidate?.nodeCoverageMs, nodeIds, nodeIdSet)
  ) {
    return null;
  }
  const maximumFleetWatts = 240 * nodeIds.length;
  const minimumFleetWatts = MIN_NODE_WATTS * nodeIds.length;
  const bucket = emptyBucket(minuteStartMs, nodeIds);
  for (const id of nodeIds) {
    const nodeWh = candidate.nodeWh[id];
    const nodeCoverageMs = candidate.nodeCoverageMs[id];
    if (
      !validNonnegative(nodeWh) ||
      nodeWh > MAX_NODE_WH_PER_MINUTE ||
      !validNonnegative(nodeCoverageMs) ||
      nodeCoverageMs > MINUTE_MS ||
      exceedsWithFloatingTolerance(nodeWh, (240 * nodeCoverageMs) / 3_600_000) ||
      fallsBelowWithFloatingTolerance(nodeWh, (MIN_NODE_WATTS * nodeCoverageMs) / 3_600_000)
    ) {
      return null;
    }
    bucket.nodeWh[id] = nodeWh;
    bucket.nodeCoverageMs[id] = nodeCoverageMs;
  }
  if (
    !validNonnegative(candidate.fleetWattMs) ||
    candidate.fleetWattMs > maximumFleetWatts * MINUTE_MS ||
    !validNonnegative(candidate.fleetCoverageMs) ||
    candidate.fleetCoverageMs > MINUTE_MS ||
    exceedsWithFloatingTolerance(candidate.fleetWattMs, maximumFleetWatts * candidate.fleetCoverageMs) ||
    fallsBelowWithFloatingTolerance(candidate.fleetWattMs, minimumFleetWatts * candidate.fleetCoverageMs) ||
    exceedsWithFloatingTolerance(
      candidate.fleetWattMs,
      Object.values(bucket.nodeWh).reduce((sum, nodeWh) => sum + nodeWh, 0) * 3_600_000
    ) ||
    nodeIds.some((id) => exceedsWithFloatingTolerance(candidate.fleetCoverageMs, bucket.nodeCoverageMs[id])) ||
    !validNonnegativeSafeInteger(candidate.outputTokens) ||
    (candidate.coveredOutputTokens != null && !validNonnegativeSafeInteger(candidate.coveredOutputTokens))
  ) {
    return null;
  }
  bucket.fleetWattMs = candidate.fleetWattMs;
  bucket.fleetCoverageMs = candidate.fleetCoverageMs;
  bucket.outputTokens = candidate.outputTokens;
  bucket.coveredOutputTokens = candidate.coveredOutputTokens ?? 0;
  // Optional series never decide whether a bucket is kept: a bad entry is dropped on its own.
  const parts = restoreSeries(candidate.parts, nodeIds, ([gpuWh, cpuWh, coverageMs]) =>
    validCoverage(coverageMs) && withinWatts(gpuWh, coverageMs, MAX_PART_WATTS) && withinWatts(cpuWh, coverageMs, MAX_PART_WATTS)
  );
  if (parts) bucket.parts = parts;
  const wall = restoreSeries(candidate.wall, nodeIds, ([wh, coverageMs, meteredMs]) =>
    validCoverage(coverageMs) && withinWatts(wh, coverageMs, MAX_WALL_WATTS) && validNonnegative(meteredMs) && meteredMs <= coverageMs
  );
  if (wall) bucket.wall = wall;
  return bucket;
}

function validCoverage(coverageMs) {
  return Number.isFinite(coverageMs) && coverageMs > 0 && coverageMs <= MINUTE_MS;
}

function withinWatts(wh, coverageMs, maxWatts) {
  return validNonnegative(wh) && !exceedsWithFloatingTolerance(wh, (maxWatts * coverageMs) / 3_600_000);
}

function restoreSeries(raw, nodeIds, valid) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const id of nodeIds) {
    const entry = raw[id];
    if (Array.isArray(entry) && entry.length === 3 && entry.every(Number.isFinite) && valid(entry)) out[id] = [...entry];
  }
  return Object.keys(out).length ? out : null;
}

/**
 * One observation per available LLM endpoint on a tracked head or standalone
 * node, keyed `nodeId:port`. A fleet can run several clusters and standalone
 * engines at once, so every endpoint is its own counter. Workers are skipped:
 * a worker fronts its head's engine, and counting it would double the pair.
 */
function tokenObservations(snapshots, atMs, nodeIdSet) {
  const observations = new Map();
  for (const snapshot of snapshots) {
    if (!nodeIdSet.has(snapshot?.id)) continue;
    if (snapshot.role !== "head" && snapshot.role !== "standalone") continue;
    const entries = snapshot.metrics?.llm;
    const ports = snapshot.llmPorts;
    if (!Array.isArray(entries) || !Array.isArray(ports) || entries.length !== ports.length) {
      continue;
    }
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const port = ports[index];
      if (
        entry?.available !== true ||
        !validNonnegativeSafeInteger(port) ||
        !validNonnegativeSafeInteger(entry.totalOutputTokens)
      ) {
        continue;
      }
      observations.set(`${snapshot.id}:${port}`, {
        totalOutputTokens: entry.totalOutputTokens,
        observedAtMs: atMs,
      });
    }
  }
  return observations;
}

/**
 * Estimate a node's whole-system draw from raw GPU and CPU telemetry.
 *
 * Callers must explicitly mark combined GPU/CPU telemetry fresh. Liveness alone
 * is insufficient because SparkMonitor can retain stale domain values.
 */
export function estimateNodeWatts(snapshot) {
  return estimateNodeParts(snapshot)?.watts ?? null;
}

/**
 * The estimate and the two readings it is made of: the GPU board draw as measured, and
 * the CPU draw modelled from utilization (5.2–65 W). `watts` adds 23 W of memory,
 * network and base load and is clamped to the DGX Spark envelope; the parts are not.
 */
export function estimateNodeParts(snapshot) {
  const gpuDraw = snapshot?.metrics?.gpu?.power?.draw;
  const cpuUsage = snapshot?.metrics?.cpu?.usage;
  if (
    snapshot?.telemetryFresh !== true ||
    !validNonnegative(gpuDraw) ||
    !Number.isFinite(cpuUsage)
  ) {
    return null;
  }

  const boundedCpuUsage = clamp(cpuUsage, 0, 100);
  const cpuWatts = 5.2 + ((65 - 5.2) * boundedCpuUsage) / 100;
  return { watts: clamp(gpuDraw + cpuWatts + 23, 0, 240), gpuWatts: gpuDraw, cpuWatts };
}

export class FleetEnergyTracker {
  constructor({
    nodeIds = [],
    filePath = null,
    now = () => Date.now(),
    load = true,
    flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    fileSystem = fs,
    writeState = writeStateAtomically,
    monthlyFilePath = null,
    monthly = null,
  } = {}) {
    this.nodeIds = Object.freeze(normalizeNodeIds(nodeIds));
    this._nodeIdSet = new Set(this.nodeIds);
    this.filePath = filePath;
    this._now = typeof now === "function" ? now : () => Date.now();
    this._setInterval = setIntervalFn;
    this._clearInterval = clearIntervalFn;
    this._fs = fileSystem;
    this._writeState = writeState;
    this._buckets = new Map();
    this._bucketsOrdered = true;
    this._latestBucketStart = null;
    this._nodeBaselines = new Map();
    this._fleetBaseline = null;
    this._integrationHighWaterMs = null;
    // nodeId:port → last output-token counter. Never persisted: after a
    // restart every counter rebases, so a stored one could never be used.
    this._tokenCounters = new Map();
    // Minute in which any token source was first seen. Efficiency divides only
    // energy from here on: earlier energy has no token counts to divide by.
    this._tokensTrackedSinceMs = null;
    this._recentFullFleetSamples = [];
    this._latestFreshNodeCount = 0;
    this._latestFreshNodeIds = [];
    this._latestRecordAt = null;
    this._membershipChanged = false;
    this._currentNodeIds = [...this.nodeIds];
    this._dirty = false;
    this._lastFoldBoundary = null;
    this._flushTimer = null;
    // Wall power (optional, see configureWall). Baselines and samples are in memory only.
    this._wallNodeIds = [];
    this._wallNodeIdSet = new Set();
    this._wallSettledBefore = () => -Infinity;
    this._wallBaselines = new Map();
    this._wallHighWaterMs = null;
    this._recentWallSamples = [];
    this._latestWallFreshIds = [];
    this._latestWallFilledIds = [];
    this._ratioCache = null;
    // Opaque bookkeeping of the meter integration (watermarks, backfill keys), persisted here.
    this._wallState = {};

    // Permanent monthly roll-up; in memory only unless monthlyFilePath is set.
    this.monthly =
      monthly ?? new MonthlyEnergyArchive({ filePath: monthlyFilePath, now: this._now, fileSystem });

    if (load) {
      this._load();
      this._foldClosedMinutes(this._now());
    }

    const requestedFlushMs = Number.isFinite(flushIntervalMs) && flushIntervalMs > 0
      ? flushIntervalMs
      : DEFAULT_FLUSH_INTERVAL_MS;
    this.flushIntervalMs = Math.min(requestedFlushMs, DEFAULT_FLUSH_INTERVAL_MS);
    if (this.filePath && typeof this._setInterval === "function") {
      this._flushTimer = this._setInterval(() => {
        try {
          this.flush();
        } catch (error) {
          console.error(`[FleetEnergyTracker] persist error: ${error.message}`);
        }
      }, this.flushIntervalMs);
      this._flushTimer?.unref?.();
    }
  }

  _time(atMs) {
    return atMs === undefined ? this._now() : atMs;
  }

  /** Invalidate aggregates when the visible registry no longer matches this tracker's scope. */
  invalidateMembership(currentNodeIds) {
    const normalized = normalizeNodeIds(currentNodeIds);
    const unchanged =
      normalized.length === this.nodeIds.length &&
      normalized.every((id) => this._nodeIdSet.has(id));
    this._currentNodeIds = normalized;
    this._membershipChanged = !unchanged;
    if (this._membershipChanged) {
      this._recentFullFleetSamples = [];
      this._latestFreshNodeCount = 0;
      this._latestFreshNodeIds = [];
    }
    return this._membershipChanged;
  }

  _bucket(minuteStartMs) {
    if (minuteStartMs < (this._ratioCache?.settled?.beforeMs ?? -Infinity)) this._ratioCache.settled = null;
    let bucket = this._buckets.get(minuteStartMs);
    if (!bucket) {
      bucket = emptyBucket(minuteStartMs, this.nodeIds);
      this._buckets.set(minuteStartMs, bucket);
      if (this._latestBucketStart !== null && minuteStartMs < this._latestBucketStart) {
        this._bucketsOrdered = false;
      }
      this._latestBucketStart = Math.max(this._latestBucketStart ?? minuteStartMs, minuteStartMs);
    }
    return bucket;
  }

  _splitInterval(startMs, endMs, startWatts, endWatts, addSegment) {
    const totalMs = endMs - startMs;
    let segmentStart = startMs;
    while (segmentStart < endMs) {
      const minuteStartMs = Math.floor(segmentStart / MINUTE_MS) * MINUTE_MS;
      const segmentEnd = Math.min(endMs, minuteStartMs + MINUTE_MS);
      const startFraction = (segmentStart - startMs) / totalMs;
      const endFraction = (segmentEnd - startMs) / totalMs;
      const segmentStartWatts = startWatts + (endWatts - startWatts) * startFraction;
      const segmentEndWatts = startWatts + (endWatts - startWatts) * endFraction;
      addSegment(
        this._bucket(minuteStartMs),
        segmentEnd - segmentStart,
        (segmentStartWatts + segmentEndWatts) / 2
      );
      segmentStart = segmentEnd;
    }
  }

  _integrateNode(id, previous, current) {
    this._splitInterval(
      previous.atMs,
      current.atMs,
      previous.watts,
      current.watts,
      (bucket, durationMs, averageWatts) => {
        bucket.nodeWh[id] += (averageWatts * durationMs) / 3_600_000;
        bucket.nodeCoverageMs[id] += durationMs;
      }
    );
    if (![previous.gpuWatts, previous.cpuWatts, current.gpuWatts, current.cpuWatts].every(Number.isFinite)) return;
    for (const [index, key] of [[0, "gpuWatts"], [1, "cpuWatts"]]) {
      this._splitInterval(previous.atMs, current.atMs, previous[key], current[key], (bucket, durationMs, averageWatts) => {
        const entry = ((bucket.parts ??= {})[id] ??= [0, 0, 0]);
        entry[index] += (averageWatts * durationMs) / 3_600_000;
        if (index === 0) entry[2] = Math.min(MINUTE_MS, entry[2] + durationMs);
      });
    }
  }

  _integrateWall(id, previous, current) {
    this._splitInterval(previous.atMs, current.atMs, previous.watts, current.watts, (bucket, durationMs, averageWatts) => {
      const entry = ((bucket.wall ??= {})[id] ??= [0, 0, 0]);
      // The meter's own record for this minute wins over live readings.
      if (entry[2] > 0) return;
      const ms = Math.min(durationMs, MINUTE_MS - entry[1]);
      if (ms <= 0) return;
      entry[0] += (averageWatts * ms) / 3_600_000;
      entry[1] += ms;
    });
  }

  _recordWall(byId, timestamp, estimates) {
    if (this._wallNodeIds.length === 0) return;
    const fresh = [];
    let integrated = false;
    for (const id of this._wallNodeIds) {
      const watts = byId.get(id)?.wallWatts;
      if (!validNonnegative(watts) || watts > MAX_WALL_WATTS) {
        this._wallBaselines.delete(id);
        continue;
      }
      fresh.push(id);
      const previous = this._wallBaselines.get(id);
      const gapMs = previous ? timestamp - previous.atMs : null;
      const fromMs = Math.max(previous?.atMs ?? Infinity, this._wallHighWaterMs ?? -Infinity);
      if (previous && gapMs > 0 && gapMs <= MAX_GAP_MS && fromMs < timestamp) {
        const fraction = (fromMs - previous.atMs) / gapMs;
        const startWatts = previous.watts + (watts - previous.watts) * fraction;
        this._integrateWall(id, { atMs: fromMs, watts: startWatts }, { atMs: timestamp, watts });
        integrated = true;
      }
      this._wallBaselines.set(id, { atMs: timestamp, watts });
    }
    if (integrated) this._wallHighWaterMs = Math.max(this._wallHighWaterMs ?? timestamp, timestamp);
    this._latestWallFreshIds = fresh;
    // Current fleet draw: measured where a meter is fresh, estimate × ratio elsewhere.
    const ratios = this._ratios(timestamp).byNode;
    const filled = [];
    let watts = 0;
    let complete = true;
    for (const id of this.nodeIds) {
      if (fresh.includes(id)) watts += byId.get(id).wallWatts;
      else if (estimates.has(id) && ratios.has(id)) {
        watts += estimates.get(id) * ratios.get(id);
        filled.push(id);
      } else complete = false;
    }
    this._latestWallFilledIds = filled;
    if (complete) this._recentWallSamples.push({ atMs: timestamp, watts, filled: filled.length > 0 });
    const cutoff = timestamp - CURRENT_WINDOW_MS;
    this._recentWallSamples = this._recentWallSamples.filter((x) => x.atMs >= cutoff && x.atMs <= timestamp);
  }

  // ─── Wall power from external meters (optional) ─────────────────────────

  /**
   * Turn on wall-power accounting for `nodeIds`. `settledBefore()` returns the instant
   * before which the meter will not revise wall readings any more; only that part is
   * folded into the monthly archive, so a reconciled minute is counted once, correctly.
   */
  configureWall({ nodeIds = [], settledBefore = () => Infinity } = {}) {
    this._wallNodeIds = normalizeNodeIds(nodeIds).filter((id) => this._nodeIdSet.has(id));
    this._wallNodeIdSet = new Set(this._wallNodeIds);
    this._wallSettledBefore = typeof settledBefore === "function" ? settledBefore : () => Infinity;
    this._ratioCache = null;
    return this._wallNodeIds;
  }

  get wallNodeIds() {
    return [...this._wallNodeIds];
  }

  /**
   * Learned wall/estimate ratios, recomputed once a minute or when the meter's record
   * changes. Ratios only use complete minutes, so live samples never change them. The
   * cache also holds the wall sums of settled minutes, which depend on the ratios.
   */
  _ratios(atMs) {
    const minute = Math.floor(atMs / MINUTE_MS);
    if (this._ratioCache?.minute !== minute) {
      this._ratioCache = {
        minute,
        value: learnWallRatios(this._buckets.values(), this.nodeIds, this._wallNodeIdSet, atMs),
        settled: null,
      };
    }
    return this._ratioCache.value;
  }

  _wallMinute(bucket, ratios) {
    return wallMinute(bucket, this.nodeIds, this._wallNodeIdSet, ratios);
  }

  /** Bookkeeping the meter integration stores with this tracker (survives restarts, not a new scope). */
  wallState(nodeId) {
    return this._wallState[nodeId] ?? null;
  }

  setWallState(nodeId, value) {
    if (!this._nodeIdSet.has(nodeId)) return;
    this._wallState[nodeId] = value;
    this._dirty = true;
  }

  /** Forget a node's wall minutes (its meter now reads a different outlet). Months are kept. */
  clearWall(nodeId) {
    let removed = 0;
    for (const bucket of this._buckets.values()) {
      if (bucket.wall?.[nodeId]) {
        delete bucket.wall[nodeId];
        if (Object.keys(bucket.wall).length === 0) delete bucket.wall;
        removed += 1;
      }
    }
    this._wallBaselines.delete(nodeId);
    this._ratioCache = null;
    if (removed > 0) this._dirty = true;
    return removed;
  }

  /** Oldest minute the tracker keeps; meter history before it belongs to the monthly archive. */
  windowStartMs(atMs = this._now()) {
    return alignedWindowCutoff(atMs, RETENTION_MS);
  }

  /**
   * Overwrite wall minutes with the meter's own record. 5-minute periods replace whatever
   * the minutes held; hourly periods only fill minutes the meter has not confirmed at finer
   * resolution. Periods that are unfinished, unaligned, outside the window or before
   * `sinceMs` are ignored. Returns how many periods were applied.
   */
  applyWallPeriods(nodeId, periods, { sinceMs = null } = {}) {
    if (!this._wallNodeIds.includes(nodeId) || !Array.isArray(periods)) return 0;
    const now = this._now();
    const cutoff = this.windowStartMs(now);
    let applied = 0;
    for (const period of periods) {
      const { startMs, endMs, meanW } = period ?? {};
      const durationMs = endMs - startMs;
      if (!WALL_PERIODS_MS.has(durationMs) || startMs % durationMs !== 0 || endMs > now || startMs < cutoff) continue;
      if (sinceMs !== null && startMs < sinceMs) continue;
      if (!validNonnegative(meanW) || meanW > MAX_WALL_WATTS) continue;
      const whPerMinute = (meanW * MINUTE_MS) / 3_600_000;
      for (let minute = startMs; minute < endMs; minute += MINUTE_MS) {
        const bucket = this._bucket(minute);
        const wall = (bucket.wall ??= {});
        if (durationMs === HOUR_MS && wall[nodeId]?.[2] > 0) continue;
        wall[nodeId] = [whPerMinute, MINUTE_MS, MINUTE_MS];
      }
      applied += 1;
    }
    if (applied > 0) {
      this._dirty = true;
      this._ratioCache = null;
    }
    return applied;
  }

  /**
   * Meter history older than the minute window goes straight into the monthly archive.
   * `periodsByNode` maps node id → hourly periods.
   */
  importWallHistory(periodsByNode) {
    const nodeIds = [...periodsByNode.keys()].filter((id) => this._wallNodeIds.includes(id));
    if (nodeIds.length === 0) return 0;
    const imported = this.monthly.importWallHours(periodsByNode, {
      nodeIds,
      fleetNodeIds: this._wallNodeIds,
      beforeMs: this.monthly.wallFoldedFromMs ?? this.windowStartMs(),
    });
    if (imported > 0) this._dirty = true;
    return imported;
  }

  _integrateFleet(previous, current) {
    this._splitInterval(
      previous.atMs,
      current.atMs,
      previous.watts,
      current.watts,
      (bucket, durationMs, averageWatts) => {
        bucket.fleetWattMs += averageWatts * durationMs;
        bucket.fleetCoverageMs += durationMs;
      }
    );
  }

  _recordTokens(snapshots, atMs, hasFullFleetInterval) {
    const observations = tokenObservations(snapshots, atMs, this._nodeIdSet);

    // A counter that went backwards (engine restart) or was last seen over
    // MAX_GAP_MS ago rebases: the new value is a baseline, never a delta.
    let delta = 0;
    for (const [key, observation] of observations) {
      const previous = this._tokenCounters.get(key);
      const gapMs = previous ? atMs - previous.observedAtMs : null;
      if (
        previous &&
        gapMs >= 0 &&
        gapMs <= MAX_GAP_MS &&
        observation.totalOutputTokens > previous.totalOutputTokens
      ) {
        delta += observation.totalOutputTokens - previous.totalOutputTokens;
      }
      this._tokenCounters.set(key, observation);
    }
    for (const [key, counter] of this._tokenCounters) {
      if (atMs - counter.observedAtMs > MAX_GAP_MS) this._tokenCounters.delete(key);
    }
    if (observations.size === 0) return;
    if (this._tokensTrackedSinceMs === null) {
      this._tokensTrackedSinceMs = Math.floor(atMs / MINUTE_MS) * MINUTE_MS;
    }

    if (delta > 0) {
      const minuteStartMs = Math.floor(atMs / MINUTE_MS) * MINUTE_MS;
      const bucket = this._bucket(minuteStartMs);
      const nextTotal = bucket.outputTokens + delta;
      if (Number.isSafeInteger(nextTotal)) bucket.outputTokens = nextTotal;
      if (hasFullFleetInterval) {
        const nextCovered = bucket.coveredOutputTokens + delta;
        if (Number.isSafeInteger(nextCovered)) bucket.coveredOutputTokens = nextCovered;
      }
    }
    this._dirty = true;
  }

  _pruneRecentSamples(atMs) {
    const cutoff = atMs - CURRENT_WINDOW_MS;
    this._recentFullFleetSamples = this._recentFullFleetSamples.filter(
      (sample) => sample.atMs >= cutoff && sample.atMs <= atMs
    );
    if (this._recentFullFleetSamples.length > MAX_RECENT_SAMPLES) {
      this._recentFullFleetSamples = this._recentFullFleetSamples.slice(-MAX_RECENT_SAMPLES);
    }
  }

  _pruneBuckets(atMs) {
    if (!this._bucketsOrdered) {
      this._buckets = new Map(
        [...this._buckets.entries()].sort(([left], [right]) => left - right)
      );
      this._bucketsOrdered = true;
      this._latestBucketStart = [...this._buckets.keys()].at(-1) ?? null;
    }
    const cutoff = alignedWindowCutoff(atMs, RETENTION_MS);
    let changed = false;
    for (const minuteStartMs of this._buckets.keys()) {
      if (minuteStartMs >= cutoff) break;
      this._buckets.delete(minuteStartMs);
      changed = true;
    }

    const maximum = MAX_COMPLETED_BUCKETS + 1;
    while (this._buckets.size > maximum) {
      const oldest = this._buckets.keys().next().value;
      this._buckets.delete(oldest);
      changed = true;
    }
    if (this._buckets.size === 0) this._latestBucketStart = null;
    if (changed) {
      this._dirty = true;
      this._ratioCache = null;
    }
  }

  _prune(atMs) {
    this._pruneRecentSamples(atMs);
    this._pruneBuckets(atMs);
  }

  record(snapshots, atMs = undefined) {
    const timestamp = this._time(atMs);
    if (!Array.isArray(snapshots) || !Number.isFinite(timestamp)) return false;
    if (this._latestRecordAt !== null && timestamp === this._latestRecordAt) return false;
    if (this._latestRecordAt !== null && timestamp < this._latestRecordAt) {
      this._tokenCounters.clear();
      this._nodeBaselines.clear();
      this._fleetBaseline = null;
      this._recentFullFleetSamples = [];
      this._latestFreshNodeCount = 0;
      this._latestFreshNodeIds = [];
      this._wallBaselines.clear();
      this._wallHighWaterMs = null;
      this._recentWallSamples = [];
    }

    const byId = new Map();
    for (const snapshot of snapshots) {
      if (this._nodeIdSet.has(snapshot?.id)) byId.set(snapshot.id, snapshot);
    }

    const validNodes = new Map();
    const integrationHighWaterAtStart = this._integrationHighWaterMs;
    let integratedAtTimestamp = false;
    for (const id of this.nodeIds) {
      const parts = estimateNodeParts(byId.get(id));
      const watts = parts?.watts ?? null;
      if (watts === null) {
        this._nodeBaselines.delete(id);
        continue;
      }

      validNodes.set(id, watts);
      const previous = this._nodeBaselines.get(id);
      const gapMs = previous ? timestamp - previous.atMs : null;
      const interval =
        previous && gapMs > 0 && gapMs <= MAX_GAP_MS
          ? unaccountedInterval(
              previous,
              { atMs: timestamp, watts, gpuWatts: parts.gpuWatts, cpuWatts: parts.cpuWatts },
              integrationHighWaterAtStart
            )
          : null;
      if (interval) {
        this._integrateNode(id, interval.previous, interval.current);
        integratedAtTimestamp = true;
      }
      this._nodeBaselines.set(id, { atMs: timestamp, watts, gpuWatts: parts.gpuWatts, cpuWatts: parts.cpuWatts });
    }

    let hasFullFleetInterval = false;
    if (this.nodeIds.length > 0 && validNodes.size === this.nodeIds.length) {
      const fleetWatts = [...validNodes.values()].reduce((sum, watts) => sum + watts, 0);
      const previous = this._fleetBaseline;
      const gapMs = previous ? timestamp - previous.atMs : null;
      const interval =
        previous && gapMs > 0 && gapMs <= MAX_GAP_MS
          ? unaccountedInterval(
              previous,
              { atMs: timestamp, watts: fleetWatts },
              integrationHighWaterAtStart
            )
          : null;
      if (interval) {
        this._integrateFleet(interval.previous, interval.current);
        hasFullFleetInterval = true;
        integratedAtTimestamp = true;
      }
      this._fleetBaseline = { atMs: timestamp, watts: fleetWatts };
      this._recentFullFleetSamples.push({ atMs: timestamp, watts: fleetWatts });
    } else {
      this._fleetBaseline = null;
    }

    if (integratedAtTimestamp && validAccountingHighWater(timestamp)) {
      this._integrationHighWaterMs = Math.max(
        this._integrationHighWaterMs ?? timestamp,
        timestamp
      );
    }

    this._recordWall(byId, timestamp, validNodes);
    this._recordTokens(snapshots, timestamp, hasFullFleetInterval);
    this._latestFreshNodeCount = validNodes.size;
    this._latestFreshNodeIds = [...validNodes.keys()];
    this._latestRecordAt = timestamp;
    this._dirty = true;
    this._prune(timestamp);
    this._foldClosedMinutes(timestamp);
    return true;
  }

  /** Move finished minutes into the monthly archive (cheap unless a minute just closed). */
  _foldClosedMinutes(atMs) {
    const boundary = MonthlyEnergyArchive.closedBefore(atMs);
    if (boundary === this._lastFoldBoundary) return;
    this._lastFoldBoundary = boundary;
    this.monthly.foldBuckets(this._buckets.values(), {
      nowMs: atMs,
      trackedSinceMs: this._tokensTrackedSinceMs,
    });
    if (this._wallNodeIds.length > 0) {
      let settledBeforeMs = -Infinity;
      try {
        settledBeforeMs = this._wallSettledBefore();
      } catch {
        // An unanswerable meter folds nothing this time.
      }
      this.monthly.foldWall(this._buckets.values(), {
        nowMs: atMs,
        settledBeforeMs,
        nodeIds: this.nodeIds,
        wallNodeIds: this._wallNodeIds,
        ratios: this._ratios(atMs).byNode,
        trackedSinceMs: this._tokensTrackedSinceMs,
      });
    }
  }

  /** Permanent per-month totals. A fold here only dirties the archive; the next tracker flush persists it. */
  monthlySnapshot(atMs = undefined) {
    const timestamp = this._time(atMs);
    if (Number.isFinite(timestamp)) this._foldClosedMinutes(timestamp);
    return this.monthly.snapshot(Number.isFinite(timestamp) ? timestamp : 0);
  }

  /** Explicit, separate from clear(): delete archived months (`month` or `all`). */
  clearMonthly(options) {
    return this.monthly.clear(options);
  }

  _window(atMs, windowMs, fromMs = null) {
    const cutoff = Math.max(alignedWindowCutoff(atMs, windowMs), fromMs ?? -Infinity);
    const nodeWh = nodeValues(this.nodeIds);
    const nodeCoverageMs = nodeValues(this.nodeIds);
    let fleetCoverageMs = 0;
    let fleetWattMs = 0;
    let outputTokens = 0;
    let coveredOutputTokens = 0;

    for (const bucket of this._buckets.values()) {
      if (bucket.minuteStartMs < cutoff || bucket.minuteStartMs > atMs) continue;
      for (const id of this.nodeIds) {
        nodeWh[id] += bucket.nodeWh[id];
        nodeCoverageMs[id] += bucket.nodeCoverageMs[id];
      }
      fleetCoverageMs += bucket.fleetCoverageMs;
      fleetWattMs += bucket.fleetWattMs;
      outputTokens += bucket.outputTokens;
      coveredOutputTokens += bucket.coveredOutputTokens;
    }

    const energyWh = Object.values(nodeWh).reduce((sum, value) => sum + value, 0);
    const hasObservedEnergy = Object.values(nodeCoverageMs).some((coverageMs) => coverageMs > 0);
    return {
      energyWh,
      hasObservedEnergy,
      nodeCoverageMs,
      fleetCoverageMs,
      fleetEnergyWh: fleetWattMs / 3_600_000,
      outputTokens,
      coveredOutputTokens,
    };
  }

  _hourly(atMs) {
    const graphEnd = Math.floor(atMs / MINUTE_MS) * MINUTE_MS;
    const graphStart = graphEnd - DAY_MS;
    const aggregates = Array.from({ length: 24 }, () => ({
      fleetWattMs: 0,
      fleetCoverageMs: 0,
    }));
    for (const bucket of this._buckets.values()) {
      if (bucket.minuteStartMs < graphStart || bucket.minuteStartMs >= graphEnd) continue;
      const index = Math.floor((bucket.minuteStartMs - graphStart) / HOUR_MS);
      aggregates[index].fleetWattMs += bucket.fleetWattMs;
      aggregates[index].fleetCoverageMs += bucket.fleetCoverageMs;
    }

    return aggregates.map(({ fleetWattMs, fleetCoverageMs }) =>
      fleetCoverageMs > 0 ? fleetWattMs / fleetCoverageMs : null
    );
  }

  /**
   * Wall power over the last 24 h and 31 days, and the 24 hourly averages. Minutes that
   * live samples can no longer reach are summed once and kept with the ratios they used,
   * until the minute turns, the ratios change or one of those minutes is written again;
   * only the newest minutes are added up on every call.
   */
  _wallWindows(atMs, ratios) {
    const minute = Math.floor(atMs / MINUTE_MS) * MINUTE_MS;
    const frame = {
      cutoffs: [alignedWindowCutoff(atMs, DAY_MS), alignedWindowCutoff(atMs, RETENTION_MS)],
      graphStart: minute - DAY_MS,
      graphEnd: minute,
      tokensSince: this._tokensTrackedSinceMs,
    };
    // A sample integrates back MAX_GAP_MS at most, so earlier minutes are final; _bucket()
    // drops the cached sums should anything write to one of them all the same.
    const latest = Math.max(this._latestRecordAt ?? atMs, atMs);
    const settledBefore = Math.min(minute, Math.floor((latest - MAX_GAP_MS) / MINUTE_MS) * MINUTE_MS);
    const cache = this._ratioCache?.value.byNode === ratios ? this._ratioCache : null;
    let settled = cache?.settled;
    if (!settled || settled.minute !== minute || settled.beforeMs !== settledBefore || settled.tokensSince !== frame.tokensSince) {
      const sums = emptyWallSums(this.nodeIds);
      for (const bucket of this._buckets.values()) {
        if (bucket.minuteStartMs < settledBefore) this._addWallMinute(sums, bucket, ratios, frame, atMs);
      }
      settled = { minute, beforeMs: settledBefore, tokensSince: frame.tokensSince, sums };
      if (cache) cache.settled = settled;
    }
    const sums = structuredClone(settled.sums);
    for (let start = Math.max(settledBefore, frame.cutoffs[1]); start <= atMs; start += MINUTE_MS) {
      const bucket = this._buckets.get(start);
      if (bucket) this._addWallMinute(sums, bucket, ratios, frame, atMs);
    }
    const [last24h, last31d] = sums.windows.map((w) => ({ ...w, observed: Object.values(w.nodeCoverageMs).some((ms) => ms > 0) }));
    const hourly = sums.hours.map(({ wh, coverageMs }) => (coverageMs > 0 ? (wh * 3_600_000) / coverageMs : null));
    return { last24h, last31d, hourly };
  }

  _addWallMinute(sums, bucket, ratios, { cutoffs, graphStart, graphEnd, tokensSince }, atMs) {
    const start = bucket.minuteStartMs;
    if (start < cutoffs[1] || start > atMs) return;
    const minute = this._wallMinute(bucket, ratios);
    if (!minute) return;
    sums.windows.forEach((w, i) => {
      if (start < cutoffs[i]) return;
      for (const id of this.nodeIds) {
        const n = minute.nodes[id];
        w.energyWh += n.wh + n.filledWh;
        w.filledWh += n.filledWh;
        w.nodeCoverageMs[id] += n.coverageMs + n.filledMs;
      }
      if (!minute.fleet) return;
      w.fleetCoverageMs += minute.fleet.coverageMs;
      if (minute.fleet.full && tokensSince !== null && start >= tokensSince) {
        w.coveredTokens += bucket.outputTokens;
        w.tokenFleetWh += minute.fleet.wh;
      }
    });
    if (minute.fleet && start >= graphStart && start < graphEnd) {
      const slot = sums.hours[Math.floor((start - graphStart) / HOUR_MS)];
      slot.wh += minute.fleet.wh;
      slot.coverageMs += minute.fleet.coverageMs;
    }
  }

  /**
   * Wall power in the shape of the estimate's own fields; only present while meters are
   * configured. Energy and coverage include filled time (estimate × learned ratio);
   * `filledEnergy24hKwh` says how much of the 24 h figure that is.
   */
  _wallSnapshot(atMs) {
    const learned = this._ratios(atMs);
    const { last24h, last31d, hourly } = this._wallWindows(atMs, learned.byNode);
    const recent = this._latestRecordAt !== null && atMs - this._latestRecordAt <= MAX_GAP_MS;
    const fresh = recent ? this._latestWallFreshIds : [];
    const filled = recent ? this._latestWallFilledIds : [];
    const samples = recent ? this._recentWallSamples : [];
    const round4 = (v) => Math.round(v * 10_000) / 10_000;
    return {
      nodeIds: [...this._wallNodeIds],
      freshNodeIds: [...fresh],
      filledNodeIds: [...filled],
      staleNodeIds: this.nodeIds.filter((id) => !fresh.includes(id) && !filled.includes(id)),
      ratios: Object.fromEntries(this.nodeIds.map((id) => [id, learned.byNode.get(id) ?? null])),
      ownRatios: learned.own,
      fleetRatio: learned.fleet,
      currentWatts30s: samples.length ? samples.reduce((sum, x) => sum + x.watts, 0) / samples.length : null,
      currentFilled: samples.some((x) => x.filled),
      energy24hKwh: last24h.observed ? last24h.energyWh / 1000 : null,
      filledEnergy24hKwh: last24h.observed ? round4(last24h.filledWh / 1000) : null,
      energy31dKwh: last31d.observed ? last31d.energyWh / 1000 : null,
      whPerOutputToken24h: last24h.tokenFleetWh > 0 && last24h.coveredTokens > 0 ? last24h.tokenFleetWh / last24h.coveredTokens : null,
      coverage24hMs: last24h.fleetCoverageMs,
      coverage24hWindowMs: DAY_MS,
      coverage31dMs: last31d.fleetCoverageMs,
      coverage31dWindowMs: RETENTION_MS,
      nodeCoverage24hMs: last24h.nodeCoverageMs,
      nodeCoverage31dMs: last31d.nodeCoverageMs,
      hourlyWatts24h: hourly,
    };
  }

  snapshot(atMs = undefined) {
    const timestamp = this._time(atMs);
    const safeTimestamp = Number.isFinite(timestamp)
      ? timestamp
      : Number.isFinite(this._latestRecordAt)
        ? this._latestRecordAt
        : 0;
    this._prune(safeTimestamp);
    const last24h = this._window(safeTimestamp, DAY_MS);
    const last31d = this._window(safeTimestamp, RETENTION_MS);
    const tracked24h = this._tokensTrackedSinceMs === null
      ? null
      : this._window(safeTimestamp, DAY_MS, this._tokensTrackedSinceMs);
    const sampleCount = this._recentFullFleetSamples.length;
    const currentWatts30s = sampleCount > 0
      ? this._recentFullFleetSamples.reduce((sum, sample) => sum + sample.watts, 0) / sampleCount
      : null;
    const latestRecordAgeMs =
      this._latestRecordAt === null ? null : safeTimestamp - this._latestRecordAt;
    const freshNodeCount =
      latestRecordAgeMs !== null && latestRecordAgeMs >= 0 && latestRecordAgeMs <= MAX_GAP_MS
        ? this._latestFreshNodeCount
        : 0;

    return {
      estimated: true,
      membershipChanged: this._membershipChanged,
      restartRequired: this._membershipChanged,
      trackedNodeIds: [...this.nodeIds],
      currentNodeIds: [...this._currentNodeIds],
      freshNodeCount: this._membershipChanged ? 0 : freshNodeCount,
      // Tracked nodes that have no fresh power reading right now (offline or telemetry stale).
      staleNodeIds: this._membershipChanged
        ? []
        : this.nodeIds.filter((id) => !(freshNodeCount > 0 && this._latestFreshNodeIds.includes(id))),
      currentWatts30s: this._membershipChanged ? null : currentWatts30s,
      energy24hKwh:
        !this._membershipChanged && last24h.hasObservedEnergy ? last24h.energyWh / 1000 : null,
      energy31dKwh:
        !this._membershipChanged && last31d.hasObservedEnergy ? last31d.energyWh / 1000 : null,
      whPerOutputToken24h:
        !this._membershipChanged && tracked24h?.fleetEnergyWh > 0 && tracked24h.coveredOutputTokens > 0
          ? tracked24h.fleetEnergyWh / tracked24h.coveredOutputTokens
          : null,
      outputTokens24h: last24h.outputTokens,
      coverage24hMs: last24h.fleetCoverageMs,
      /** Window these coverage figures are measured over — clients must not
       *  assume the window length. Fleet coverage is wall-clock time during
       *  which every node was fresh, so it is capped by this window, not by
       *  window × nodeCount (per-node totals live in nodeCoverage*Ms). */
      coverage24hWindowMs: DAY_MS,
      coverage31dMs: last31d.fleetCoverageMs,
      coverage31dWindowMs: RETENTION_MS,
      nodeCoverage24hMs: last24h.nodeCoverageMs,
      nodeCoverage31dMs: last31d.nodeCoverageMs,
      hourlyWatts24h: this._membershipChanged
        ? Array(24).fill(null)
        : this._hourly(safeTimestamp),
      // Present only while external meters are configured: the estimate's fields stay as they are.
      ...(this._wallNodeIds.length > 0 && !this._membershipChanged ? { wall: this._wallSnapshot(safeTimestamp) } : {}),
    };
  }

  /**
   * Hourly rows for the detailed energy page, oldest first (UTC hour starts, all retained
   * minute buckets). The client regroups them into days / its local day boundaries.
   * Per row: per-node Wh and coverage, fleet average watts over the covered time,
   * fleet Wh, and the output tokens seen (for efficiency). Hours with no coverage are omitted.
   */
  history(atMs = undefined) {
    const timestamp = this._time(atMs);
    const now = Number.isFinite(timestamp) ? timestamp : (this._latestRecordAt ?? 0);
    this._prune(now);
    const byHour = new Map();
    const learned = this._wallNodeIds.length > 0 ? this._ratios(now) : null;
    const ratios = learned?.byNode ?? null;
    for (const bucket of this._buckets.values()) {
      const hourStart = Math.floor(bucket.minuteStartMs / HOUR_MS) * HOUR_MS;
      let row = byHour.get(hourStart);
      if (!row) {
        row = {
          nodeWh: nodeValues(this.nodeIds),
          nodeCoverageMs: nodeValues(this.nodeIds),
          fleetWattMs: 0,
          fleetCoverageMs: 0,
          outputTokens: 0,
          coveredOutputTokens: 0,
          parts: null,
          wall: null,
        };
        byHour.set(hourStart, row);
      }
      for (const id of this.nodeIds) {
        row.nodeWh[id] += bucket.nodeWh[id];
        row.nodeCoverageMs[id] += bucket.nodeCoverageMs[id];
      }
      if (bucket.parts) {
        row.parts ??= { gpuWh: nodeValues(this.nodeIds), cpuWh: nodeValues(this.nodeIds), coverageMs: nodeValues(this.nodeIds) };
        for (const [id, [gpuWh, cpuWh, coverageMs]] of Object.entries(bucket.parts)) {
          if (!this._nodeIdSet.has(id)) continue;
          row.parts.gpuWh[id] += gpuWh;
          row.parts.cpuWh[id] += cpuWh;
          row.parts.coverageMs[id] += coverageMs;
        }
      }
      const minute = this._wallNodeIds.length > 0 ? this._wallMinute(bucket, ratios) : null;
      if (minute) {
        row.wall ??= {
          wh: nodeValues(this.nodeIds),
          coverageMs: nodeValues(this.nodeIds),
          meteredMs: nodeValues(this.nodeIds),
          filledWh: nodeValues(this.nodeIds),
          filledMs: nodeValues(this.nodeIds),
          fleetWh: 0,
          fleetFilledWh: 0,
          fleetCoverageMs: 0,
          coveredTokens: 0,
        };
        for (const id of this.nodeIds) {
          const n = minute.nodes[id];
          row.wall.wh[id] += n.wh;
          row.wall.coverageMs[id] += n.coverageMs;
          row.wall.meteredMs[id] += n.meteredMs;
          row.wall.filledWh[id] += n.filledWh;
          row.wall.filledMs[id] += n.filledMs;
        }
        if (minute.fleet) {
          row.wall.fleetWh += minute.fleet.wh;
          row.wall.fleetFilledWh += minute.fleet.filledWh;
          row.wall.fleetCoverageMs += minute.fleet.coverageMs;
          if (minute.fleet.full) row.wall.coveredTokens += bucket.outputTokens;
        }
      }
      row.fleetWattMs += bucket.fleetWattMs;
      row.fleetCoverageMs += bucket.fleetCoverageMs;
      row.outputTokens += bucket.outputTokens;
      row.coveredOutputTokens += bucket.coveredOutputTokens;
    }
    const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
    const roundAll = (map) => Object.fromEntries(Object.entries(map).map(([id, v]) => [id, round(v)]));
    const hourly = this._membershipChanged
      ? []
      : [...byHour.entries()]
          .sort(([a], [b]) => a - b)
          .filter(([, row]) =>
            Object.values(row.nodeCoverageMs).some((ms) => ms > 0) ||
            Object.values(row.wall?.coverageMs ?? {}).some((ms) => ms > 0) ||
            Object.values(row.wall?.filledMs ?? {}).some((ms) => ms > 0)
          )
          .map(([t, row]) => ({
            t,
            nodeWh: Object.fromEntries(Object.entries(row.nodeWh).map(([id, wh]) => [id, round(wh)])),
            nodeCoverageMs: row.nodeCoverageMs,
            avgWatts: row.fleetCoverageMs > 0 ? round(row.fleetWattMs / row.fleetCoverageMs, 1) : null,
            fleetEnergyWh: round(row.fleetWattMs / 3_600_000),
            fleetCoverageMs: row.fleetCoverageMs,
            outputTokens: row.outputTokens,
            coveredOutputTokens: row.coveredOutputTokens,
            // Pure additions: present only in hours that have them.
            ...(row.parts
              ? {
                  nodeGpuWh: roundAll(row.parts.gpuWh),
                  nodeCpuWh: roundAll(row.parts.cpuWh),
                  nodePartsCoverageMs: row.parts.coverageMs,
                }
              : {}),
            ...(row.wall
              ? {
                  nodeWallWh: roundAll(row.wall.wh),
                  nodeWallCoverageMs: row.wall.coverageMs,
                  nodeWallMeteredMs: row.wall.meteredMs,
                  nodeWallFilledWh: roundAll(row.wall.filledWh),
                  nodeWallFilledMs: row.wall.filledMs,
                  avgWallWatts: row.wall.fleetCoverageMs > 0 ? round((row.wall.fleetWh * 3_600_000) / row.wall.fleetCoverageMs, 1) : null,
                  fleetWallWh: round(row.wall.fleetWh),
                  fleetWallFilledWh: round(row.wall.fleetFilledWh),
                  fleetWallCoverageMs: row.wall.fleetCoverageMs,
                  wallCoveredOutputTokens: row.wall.coveredTokens,
                }
              : {}),
          }));
    return {
      estimated: true,
      membershipChanged: this._membershipChanged,
      generatedAt: now,
      retentionMs: RETENTION_MS,
      nodeIds: [...this.nodeIds],
      ...(learned
        ? {
            wallNodeIds: [...this._wallNodeIds],
            wallRatios: Object.fromEntries(this.nodeIds.map((id) => [id, learned.byNode.get(id) ?? null])),
          }
        : {}),
      hourly,
    };
  }

  /**
   * A state file from another fleet scope is not loaded (its aggregates would not be truthful for this fleet),
   * but it is kept: renamed beside the live file so the next flush cannot overwrite that history.
   */
  _archiveOutOfScopeState(raw) {
    const stamp = validNonnegativeSafeInteger(raw?.savedAt) ? raw.savedAt : Math.floor(this._now());
    const parsed = path.parse(this.filePath);
    const archivePath = path.join(parsed.dir, `${parsed.name}.scope-${stamp}${parsed.ext}`);
    try {
      // Same plausibility checks as _load, against the old file's own node set.
      const oldNodeIds = normalizeNodeIds(raw?.nodeIds);
      const seen = new Set();
      const plausible = [];
      for (const candidate of Array.isArray(raw?.buckets) ? raw.buckets : []) {
        const minuteStartMs = candidate?.minuteStartMs;
        if (!validNonnegativeSafeInteger(minuteStartMs) || minuteStartMs % MINUTE_MS !== 0 || seen.has(minuteStartMs)) {
          continue;
        }
        seen.add(minuteStartMs);
        const bucket = oldNodeIds.length > 0 ? restoreBucket(candidate, minuteStartMs, oldNodeIds) : null;
        if (bucket) plausible.push(bucket);
      }
      this.monthly.foldBuckets(plausible, {
        nowMs: this._now(),
        trackedSinceMs: validNonnegativeSafeInteger(raw?.tokensTrackedSinceMs) ? raw.tokensTrackedSinceMs : null,
      });
      // The old scope's metered nodes: its wall minutes are final now, so all of them fold.
      const oldWallIds = Object.keys(raw?.wallMeter ?? {}).filter((id) => oldNodeIds.includes(id));
      if (oldWallIds.length > 0) {
        this.monthly.foldWall(plausible, {
          nowMs: this._now(),
          settledBeforeMs: Infinity,
          nodeIds: oldNodeIds,
          wallNodeIds: oldWallIds,
          trackedSinceMs: validNonnegativeSafeInteger(raw?.tokensTrackedSinceMs) ? raw.tokensTrackedSinceMs : null,
        });
      }
      this.monthly.flush();
    } catch (error) {
      console.warn(`[FleetEnergyTracker] unable to roll up ${this.filePath}: ${error.message}`);
    }
    try {
      if (this._fs.existsSync(archivePath)) return;
      this._fs.renameSync(this.filePath, archivePath);
      console.warn(
        `[FleetEnergyTracker] fleet membership changed; previous energy history kept at ${archivePath}`
      );
    } catch (error) {
      console.warn(`[FleetEnergyTracker] unable to archive ${this.filePath}: ${error.message}`);
    }
  }

  _load() {
    if (!this.filePath) return;
    try {
      const raw = JSON.parse(this._fs.readFileSync(this.filePath, "utf8"));
      const legacyNodeIds = !Object.prototype.hasOwnProperty.call(raw || {}, "nodeIds");
      if (raw?.version !== FILE_VERSION || !Array.isArray(raw.buckets)) {
        return;
      }
      if (
        !legacyNodeIds &&
        (!Array.isArray(raw.nodeIds) ||
          raw.nodeIds.length !== this.nodeIds.length ||
          raw.nodeIds.some((id) => !this._nodeIdSet.has(id)))
      ) {
        this._archiveOutOfScopeState(raw);
        return;
      }

      const candidates = [...raw.buckets].sort(
        (left, right) => (left?.minuteStartMs ?? Infinity) - (right?.minuteStartMs ?? Infinity)
      );
      const seenMinuteStarts = new Set();
      let rejectedBucket = false;
      for (const candidate of candidates) {
        const minuteStartMs = candidate?.minuteStartMs;
        if (
          !validNonnegativeSafeInteger(minuteStartMs) ||
          minuteStartMs % MINUTE_MS !== 0 ||
          seenMinuteStarts.has(minuteStartMs)
        ) {
          rejectedBucket = true;
          continue;
        }
        seenMinuteStarts.add(minuteStartMs);
        const bucket = restoreBucket(candidate, minuteStartMs, this.nodeIds);
        if (!bucket) {
          rejectedBucket = true;
          continue;
        }
        this._buckets.set(minuteStartMs, bucket);
      }
      this._bucketsOrdered = true;
      this._latestBucketStart = [...this._buckets.keys()].at(-1) ?? null;

      let latestCoveredBucket = null;
      for (const bucket of this._buckets.values()) {
        const hasCoverage =
          bucket.fleetCoverageMs > 0 ||
          this.nodeIds.some((id) => bucket.nodeCoverageMs[id] > 0);
        if (hasCoverage) latestCoveredBucket = bucket;
      }
      const latestCoveredMinuteStart = latestCoveredBucket?.minuteStartMs ?? null;
      const creditedCoverageMs = latestCoveredBucket
        ? Math.max(
            latestCoveredBucket.fleetCoverageMs,
            ...Object.values(latestCoveredBucket.nodeCoverageMs)
          )
        : null;
      const hasPersistedHighWater = Object.prototype.hasOwnProperty.call(
        raw,
        "integrationHighWaterMs"
      );
      const persistedHighWater = raw.integrationHighWaterMs;
      const validPersistedHighWater =
        latestCoveredMinuteStart !== null &&
        validNonnegativeSafeInteger(persistedHighWater) &&
        persistedHighWater >= latestCoveredMinuteStart + creditedCoverageMs &&
        persistedHighWater <= latestCoveredMinuteStart + MINUTE_MS;
      let repairedHighWater = false;
      if (validPersistedHighWater) {
        this._integrationHighWaterMs = persistedHighWater;
      } else if (latestCoveredMinuteStart !== null) {
        this._integrationHighWaterMs = Math.min(
          latestCoveredMinuteStart + MINUTE_MS,
          Number.MAX_SAFE_INTEGER
        );
        repairedHighWater = true;
      } else {
        this._integrationHighWaterMs = null;
        repairedHighWater = hasPersistedHighWater && persistedHighWater !== null;
      }

      const trackedSince = raw.tokensTrackedSinceMs;
      const now = this._now();
      if (
        validNonnegativeSafeInteger(trackedSince) &&
        trackedSince % MINUTE_MS === 0 &&
        !(trackedSince > now)
      ) {
        this._tokensTrackedSinceMs = trackedSince;
      }
      if (raw.wallMeter && typeof raw.wallMeter === "object" && !Array.isArray(raw.wallMeter)) {
        for (const [id, value] of Object.entries(raw.wallMeter)) {
          if (this._nodeIdSet.has(id) && value && typeof value === "object") this._wallState[id] = value;
        }
      }
      this._dirty = legacyNodeIds || rejectedBucket || repairedHighWater;
      if (Number.isFinite(now)) this._prune(now);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      console.warn(`[FleetEnergyTracker] unable to load ${this.filePath}: ${error.message}`);
    }
  }

  /**
   * Delete recorded history: everything, or only minutes older than `olderThanMs`.
   * Power baselines are kept, so integration carries on from the next sample.
   * @returns {number} how many minute buckets were removed
   */
  clear({ olderThanMs } = {}) {
    // Archive finished minutes first: a reset only empties the 31-day window.
    this._foldClosedMinutes(this._now());
    this._ratioCache = null;
    const all = !(Number.isFinite(olderThanMs) && olderThanMs > 0);
    const cutoff = all ? Infinity : this._now() - olderThanMs;
    let removed = 0;
    for (const minuteStartMs of [...this._buckets.keys()]) {
      if (minuteStartMs < cutoff) {
        this._buckets.delete(minuteStartMs);
        removed++;
      }
    }
    this._latestBucketStart = this._buckets.size
      ? Math.max(...this._buckets.keys())
      : null;
    if (all) this._tokensTrackedSinceMs = null;
    else if (this._tokensTrackedSinceMs !== null && this._tokensTrackedSinceMs < cutoff) {
      this._tokensTrackedSinceMs = this._buckets.size ? Math.min(...this._buckets.keys()) : null;
    }
    if (removed > 0) {
      this._dirty = true;
      try {
        this.flush();
      } catch (error) {
        console.error(`[FleetEnergyTracker] persist error: ${error.message}`);
      }
    }
    return removed;
  }

  flush() {
    try {
      this._foldClosedMinutes(this._now());
      this.monthly.flush();
    } catch (error) {
      console.error(`[FleetEnergyTracker] monthly persist error: ${error.message}`);
    }
    if (!this.filePath || !this._dirty) return false;
    const now = this._now();
    if (Number.isFinite(now)) this._prune(now);
    const buckets = [...this._buckets.values()].sort(
      (left, right) => left.minuteStartMs - right.minuteStartMs
    );
    const state = {
      version: FILE_VERSION,
      nodeIds: this.nodeIds,
      savedAt: now,
      integrationHighWaterMs:
        this._integrationHighWaterMs === null
          ? null
          : Math.ceil(this._integrationHighWaterMs),
      tokensTrackedSinceMs: this._tokensTrackedSinceMs,
      ...(Object.keys(this._wallState).length > 0 ? { wallMeter: this._wallState } : {}),
      buckets,
    };
    this._writeState(this.filePath, `${JSON.stringify(state)}\n`, this._fs);
    this._dirty = false;
    return true;
  }

  close() {
    if (this._flushTimer !== null) {
      this._clearInterval?.(this._flushTimer);
      this._flushTimer = null;
    }
    return this.flush();
  }
}

export default FleetEnergyTracker;
