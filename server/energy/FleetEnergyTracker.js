import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

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
const UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set(["EINVAL", "ENOTSUP", "EISDIR", "EBADF"]);

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

function emptyBucket(minuteStartMs, nodeIds) {
  return {
    minuteStartMs,
    nodeWh: nodeValues(nodeIds),
    nodeCoverageMs: nodeValues(nodeIds),
    fleetWattMs: 0,
    fleetCoverageMs: 0,
    outputTokens: 0,
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
  return {
    previous: {
      atMs: highWaterMs,
      watts: previous.watts + (current.watts - previous.watts) * fraction,
    },
    current,
  };
}

function hasExactNodeKeys(value, nodeIds, nodeIdSet) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === nodeIds.length &&
    keys.every((key) => nodeIdSet.has(key))
  );
}

function tokenObservation(snapshots, atMs, nodeIdSet) {
  const heads = snapshots.filter(
    (snapshot) => nodeIdSet.has(snapshot?.id) && snapshot?.role === "head"
  );
  if (heads.length !== 1) return null;

  const head = heads[0];
  const entries = head?.metrics?.llm;
  const ports = head?.llmPorts;
  if (!Array.isArray(entries) || !Array.isArray(ports) || entries.length !== ports.length) {
    return null;
  }
  const availableIndexes = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index]?.available === true) availableIndexes.push(index);
  }
  if (availableIndexes.length !== 1) return null;
  const index = availableIndexes[0];
  const entry = entries[index];
  const port = ports[index];
  if (
    !validNonnegativeSafeInteger(port) ||
    !validNonnegativeSafeInteger(entry.totalOutputTokens)
  ) {
    return null;
  }
  return {
    headId: head.id,
    port,
    totalOutputTokens: entry.totalOutputTokens,
    observedAtMs: atMs,
  };
}

function sameTokenSource(left, right) {
  return (
    left?.headId === right?.headId &&
    left?.port === right?.port
  );
}

function writeStateAtomically(filePath, contents, fileSystem) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let temporaryFd = null;
  let directoryFd = null;
  let renamed = false;

  fileSystem.mkdirSync(directory, { recursive: true });
  try {
    temporaryFd = fileSystem.openSync(temporaryPath, "wx", 0o600);
    fileSystem.writeFileSync(temporaryFd, contents, { encoding: "utf8" });
    fileSystem.fchmodSync(temporaryFd, 0o600);
    fileSystem.fsyncSync(temporaryFd);
    fileSystem.closeSync(temporaryFd);
    temporaryFd = null;

    fileSystem.renameSync(temporaryPath, filePath);
    renamed = true;
    fileSystem.chmodSync(filePath, 0o600);
    const finalMode = fileSystem.statSync(filePath).mode & 0o777;
    if (finalMode !== 0o600) {
      throw new Error(`Failed to secure ${filePath}: expected mode 0600, got 0${finalMode.toString(8)}`);
    }

    try {
      directoryFd = fileSystem.openSync(directory, "r");
      fileSystem.fsyncSync(directoryFd);
    } catch (error) {
      if (!UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(error?.code)) throw error;
    } finally {
      if (directoryFd !== null) fileSystem.closeSync(directoryFd);
    }
  } catch (error) {
    if (temporaryFd !== null) {
      try {
        fileSystem.closeSync(temporaryFd);
      } catch {
        // Preserve the original persistence error.
      }
    }
    if (!renamed) {
      try {
        fileSystem.unlinkSync(temporaryPath);
      } catch {
        // The temp may not have been created; never remove the prior target.
      }
    }
    throw error;
  }
}

/**
 * Estimate a node's whole-system draw from raw GPU and CPU telemetry.
 *
 * Callers must explicitly mark combined GPU/CPU telemetry fresh. Liveness alone
 * is insufficient because SparkMonitor can retain stale domain values.
 */
export function estimateNodeWatts(snapshot) {
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
  return clamp(gpuDraw + cpuWatts + 23, 0, 240);
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
  } = {}) {
    this.nodeIds = Object.freeze(normalizeNodeIds(nodeIds));
    this._nodeIdSet = new Set(this.nodeIds);
    this._minimumFleetWatts = MIN_NODE_WATTS * this.nodeIds.length;
    this._maximumFleetWatts = 240 * this.nodeIds.length;
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
    this._tokenCounter = null;
    this._tokenNeedsRebase = false;
    this._recentFullFleetSamples = [];
    this._latestFreshNodeCount = 0;
    this._latestRecordAt = null;
    this._dirty = false;
    this._flushTimer = null;

    if (load) this._load();

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

  _bucket(minuteStartMs) {
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

  _recordTokens(snapshots, atMs) {
    const observation = tokenObservation(snapshots, atMs, this._nodeIdSet);
    if (!observation) return;

    const previous = this._tokenCounter;
    const gapMs = previous ? atMs - previous.observedAtMs : null;
    const rebase =
      !previous ||
      this._tokenNeedsRebase ||
      !sameTokenSource(previous, observation) ||
      observation.totalOutputTokens < previous.totalOutputTokens ||
      gapMs < 0 ||
      gapMs > MAX_GAP_MS;

    if (!rebase && observation.totalOutputTokens > previous.totalOutputTokens) {
      const delta = observation.totalOutputTokens - previous.totalOutputTokens;
      const minuteStartMs = Math.floor(atMs / MINUTE_MS) * MINUTE_MS;
      const bucket = this._bucket(minuteStartMs);
      const nextTotal = bucket.outputTokens + delta;
      if (Number.isSafeInteger(nextTotal)) bucket.outputTokens = nextTotal;
    }
    this._tokenCounter = observation;
    this._tokenNeedsRebase = false;
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
    if (changed) this._dirty = true;
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
      this._tokenNeedsRebase = true;
      this._nodeBaselines.clear();
      this._fleetBaseline = null;
      this._recentFullFleetSamples = [];
      this._latestFreshNodeCount = 0;
    }

    const byId = new Map();
    for (const snapshot of snapshots) {
      if (this._nodeIdSet.has(snapshot?.id)) byId.set(snapshot.id, snapshot);
    }

    const validNodes = new Map();
    const integrationHighWaterAtStart = this._integrationHighWaterMs;
    let integratedAtTimestamp = false;
    for (const id of this.nodeIds) {
      const watts = estimateNodeWatts(byId.get(id));
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
              { atMs: timestamp, watts },
              integrationHighWaterAtStart
            )
          : null;
      if (interval) {
        this._integrateNode(id, interval.previous, interval.current);
        integratedAtTimestamp = true;
      }
      this._nodeBaselines.set(id, { atMs: timestamp, watts });
    }

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

    this._recordTokens(snapshots, timestamp);
    this._latestFreshNodeCount = validNodes.size;
    this._latestRecordAt = timestamp;
    this._dirty = true;
    this._prune(timestamp);
    return true;
  }

  _window(atMs, windowMs) {
    const cutoff = alignedWindowCutoff(atMs, windowMs);
    const nodeWh = nodeValues(this.nodeIds);
    const nodeCoverageMs = nodeValues(this.nodeIds);
    let fleetCoverageMs = 0;
    let outputTokens = 0;

    for (const bucket of this._buckets.values()) {
      if (bucket.minuteStartMs < cutoff || bucket.minuteStartMs > atMs) continue;
      for (const id of this.nodeIds) {
        nodeWh[id] += bucket.nodeWh[id];
        nodeCoverageMs[id] += bucket.nodeCoverageMs[id];
      }
      fleetCoverageMs += bucket.fleetCoverageMs;
      outputTokens += bucket.outputTokens;
    }

    const energyWh = Object.values(nodeWh).reduce((sum, value) => sum + value, 0);
    const hasObservedEnergy = Object.values(nodeCoverageMs).some((coverageMs) => coverageMs > 0);
    return {
      energyWh,
      hasObservedEnergy,
      nodeCoverageMs,
      fleetCoverageMs,
      outputTokens,
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
      freshNodeCount,
      currentWatts30s,
      energy24hKwh: last24h.hasObservedEnergy ? last24h.energyWh / 1000 : null,
      energy31dKwh: last31d.hasObservedEnergy ? last31d.energyWh / 1000 : null,
      whPerOutputToken24h:
        last24h.hasObservedEnergy && last24h.outputTokens > 0
          ? last24h.energyWh / last24h.outputTokens
          : null,
      outputTokens24h: last24h.outputTokens,
      coverage24hMs: last24h.fleetCoverageMs,
      coverage31dMs: last31d.fleetCoverageMs,
      nodeCoverage24hMs: last24h.nodeCoverageMs,
      nodeCoverage31dMs: last31d.nodeCoverageMs,
      hourlyWatts24h: this._hourly(safeTimestamp),
    };
  }

  _load() {
    if (!this.filePath) return;
    try {
      const raw = JSON.parse(this._fs.readFileSync(this.filePath, "utf8"));
      const legacyNodeIds = !Object.prototype.hasOwnProperty.call(raw || {}, "nodeIds");
      if (
        raw?.version !== FILE_VERSION ||
        !Array.isArray(raw.buckets) ||
        (!legacyNodeIds &&
          (!Array.isArray(raw.nodeIds) ||
            raw.nodeIds.length !== this.nodeIds.length ||
            raw.nodeIds.some((id) => !this._nodeIdSet.has(id))))
      ) {
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
        if (
          !hasExactNodeKeys(candidate.nodeWh, this.nodeIds, this._nodeIdSet) ||
          !hasExactNodeKeys(candidate.nodeCoverageMs, this.nodeIds, this._nodeIdSet)
        ) {
          rejectedBucket = true;
          continue;
        }
        const bucket = emptyBucket(minuteStartMs, this.nodeIds);
        let valid = true;
        for (const id of this.nodeIds) {
          const nodeWh = candidate?.nodeWh?.[id];
          const nodeCoverageMs = candidate?.nodeCoverageMs?.[id];
          if (
            !validNonnegative(nodeWh) ||
            nodeWh > MAX_NODE_WH_PER_MINUTE ||
            !validNonnegative(nodeCoverageMs) ||
            nodeCoverageMs > MINUTE_MS ||
            exceedsWithFloatingTolerance(
              nodeWh,
              (240 * nodeCoverageMs) / 3_600_000
            ) ||
            fallsBelowWithFloatingTolerance(
              nodeWh,
              (MIN_NODE_WATTS * nodeCoverageMs) / 3_600_000
            )
          ) {
            valid = false;
            break;
          }
          bucket.nodeWh[id] = nodeWh;
          bucket.nodeCoverageMs[id] = nodeCoverageMs;
        }
        if (
          !valid ||
          !validNonnegative(candidate.fleetWattMs) ||
          candidate.fleetWattMs > this._maximumFleetWatts * MINUTE_MS ||
          !validNonnegative(candidate.fleetCoverageMs) ||
          candidate.fleetCoverageMs > MINUTE_MS ||
          exceedsWithFloatingTolerance(
            candidate.fleetWattMs,
            this._maximumFleetWatts * candidate.fleetCoverageMs
          ) ||
          fallsBelowWithFloatingTolerance(
            candidate.fleetWattMs,
            this._minimumFleetWatts * candidate.fleetCoverageMs
          ) ||
          exceedsWithFloatingTolerance(
            candidate.fleetWattMs,
            Object.values(bucket.nodeWh).reduce((sum, nodeWh) => sum + nodeWh, 0) *
              3_600_000
          ) ||
          this.nodeIds.some((id) =>
            exceedsWithFloatingTolerance(
              candidate.fleetCoverageMs,
              bucket.nodeCoverageMs[id]
            )
          ) ||
          !validNonnegativeSafeInteger(candidate.outputTokens)
        ) {
          rejectedBucket = true;
          continue;
        }
        bucket.fleetWattMs = candidate.fleetWattMs;
        bucket.fleetCoverageMs = candidate.fleetCoverageMs;
        bucket.outputTokens = candidate.outputTokens;
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

      const tokenCounter = raw.tokenCounter;
      if (
        this._nodeIdSet.has(tokenCounter?.headId) &&
        validNonnegativeSafeInteger(tokenCounter?.port) &&
        validNonnegativeSafeInteger(tokenCounter?.totalOutputTokens) &&
        Number.isFinite(tokenCounter?.observedAtMs)
      ) {
        this._tokenCounter = {
          headId: tokenCounter.headId,
          port: tokenCounter.port,
          totalOutputTokens: tokenCounter.totalOutputTokens,
          observedAtMs: tokenCounter.observedAtMs,
        };
        this._tokenNeedsRebase = true;
      }
      this._dirty = legacyNodeIds || rejectedBucket || repairedHighWater;
      const now = this._now();
      if (Number.isFinite(now)) this._prune(now);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      console.warn(`[FleetEnergyTracker] unable to load ${this.filePath}: ${error.message}`);
    }
  }

  flush() {
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
      tokenCounter: this._tokenCounter,
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
