/**
 * Bounded, restart-safe LLM telemetry for incident and capacity analysis.
 *
 * One latest sample is retained per 10-second bucket for seven days. Unlike
 * LlmDaily, unavailable samples are retained so outages remain visible after
 * the inference process or dashboard restarts.
 *
 * Series are scoped to one served model. A router can serve different models
 * on one port over the retention window, and a median that crossed that
 * boundary would describe neither model.
 */
import fs from "fs";
import path from "path";
import { LLM_TELEMETRY_JSON_PATH } from "../config.js";
import { atomicWrite, quarantineCorrupt } from "../util/atomicWrite.js";

const BUCKET_MS = 10_000;
const MAX_HOURS = 168;
const RETENTION_MS = MAX_HOURS * 60 * 60 * 1000;
const MAX_POINTS = RETENTION_MS / BUCKET_MS;
/**
 * A bound on the whole store, not just one series. Every distinct model id an
 * engine reports adds a series for seven days, so a router that renames models
 * would otherwise grow the file without limit: eight full series are about
 * 480,000 points, and the caps below hold the store near that regardless.
 */
const MAX_SERIES = 32;
const MAX_TOTAL_POINTS = 750_000;
/** One read answers at most twelve hours of buckets; a longer range says it was cut. */
const MAX_READ_POINTS = 4_320;
const MAX_MODEL_ID_CHARS = 120;
const FLUSH_MS = 30_000;
const COMPACT_MS = 60 * 60 * 1000;
/** How much of the store one compaction slice writes before yielding the loop. */
const COMPACT_SLICE_POINTS = 1_000;
const FILE_VERSION = 3;
const LLM_STATUSES = new Set([
  "active",
  "idle",
  "unknown",
  "stale",
  "unavailable",
  "ambiguous_model",
]);

/** A JSON tuple keeps a colon in a spark id or model id from colliding. */
function seriesKey(sparkId, port, modelId) {
  return JSON.stringify([sparkId, port, modelId ?? null]);
}

/**
 * The id is part of the storage key, so a value that varies per request (a path
 * with a timestamp, trailing whitespace, a banner) must not mint a new series.
 */
function normalizeModelId(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  return text ? text.slice(0, MAX_MODEL_ID_CHARS) : null;
}

function readSeriesKey(key) {
  try {
    const parsed = JSON.parse(key);
    if (Array.isArray(parsed) && parsed.length === 3 && typeof parsed[0] === "string" && Number.isInteger(parsed[1])) {
      return parsed;
    }
  } catch {
    // A version 2 key is not JSON; the caller migrates it.
  }
  return null;
}

/** Version 2 stored `${sparkId}:${port}` and kept the model on each point. */
function canonicalKey(key, point) {
  if (readSeriesKey(key)) return key;
  const at = key.lastIndexOf(":");
  if (at <= 0) return null;
  const port = Number(key.slice(at + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return seriesKey(key.slice(0, at), port, point?.modelId ?? null);
}

function finiteOrNull(value) {
  const n = Number(value);
  return value != null && Number.isFinite(n) ? n : null;
}

function pointFrom(metrics, time) {
  const status = LLM_STATUSES.has(metrics?.status)
    ? metrics.status
    : metrics?.available === true
      ? "active"
      : "unavailable";
  return {
    t: Math.floor(time / BUCKET_MS) * BUCKET_MS,
    available: metrics?.available === true && metrics?.measurementValid !== false,
    measurementValid: metrics?.measurementValid !== false,
    measurementError:
      typeof metrics?.measurementError === "string" ? metrics.measurementError : null,
    status,
    lastObservedAt: finiteOrNull(metrics?.lastObservedAt),
    statusReason: typeof metrics?.statusReason === "string" ? metrics.statusReason : null,
    modelId: typeof metrics?.modelId === "string" ? metrics.modelId : null,
    telemetrySource:
      metrics?.telemetrySource === "direct" || metrics?.telemetrySource === "relay"
        ? metrics.telemetrySource
        : null,
    backend: typeof (metrics?.backend ?? metrics?.backendType) === "string" ? (metrics.backend ?? metrics.backendType) : null,
    generationTps: finiteOrNull(metrics?.generationTps),
    prefillTps: finiteOrNull(metrics?.prefillTps),
    totalPromptTokens: finiteOrNull(metrics?.totalPromptTokens),
    totalOutputTokens: finiteOrNull(metrics?.totalOutputTokens),
    completedRequestsTotal: finiteOrNull(metrics?.completedRequestsTotal),
    requestsRunning: finiteOrNull(metrics?.requestsRunning),
    requestsWaiting: finiteOrNull(metrics?.requestsWaiting),
    kvCacheUsage: finiteOrNull(metrics?.kvCacheUsage),
    ttftP95Seconds: finiteOrNull(metrics?.ttftP95Seconds),
    e2eP95Seconds: finiteOrNull(metrics?.e2eP95Seconds),
    itlP95Seconds: finiteOrNull(metrics?.itlP95Seconds),
    preemptionsTotal: finiteOrNull(metrics?.preemptionsTotal),
    prefixCacheHitRate: finiteOrNull(metrics?.prefixCacheHitRate),
    mtpAcceptanceRate: finiteOrNull(metrics?.mtpAcceptanceRate),
    kvCacheCapacityTokens: finiteOrNull(metrics?.kvCacheCapacityTokens),
    kvCacheMaxConcurrency: finiteOrNull(metrics?.kvCacheMaxConcurrency),
  };
}

function validPoint(point) {
  return point && Number.isFinite(point.t) && typeof point.available === "boolean";
}

/** Read old v1 points while giving every point the current status vocabulary. */
function migratePoint(point) {
  if (!validPoint(point)) return null;
  const status = LLM_STATUSES.has(point.status)
    ? point.status
    : point.available
      ? "unknown"
      : "unavailable";
  return {
    ...point,
    status,
    lastObservedAt: finiteOrNull(point.lastObservedAt),
    statusReason: typeof point.statusReason === "string" ? point.statusReason : null,
    modelId: typeof point.modelId === "string" ? point.modelId : null,
    telemetrySource:
      point.telemetrySource === "direct" || point.telemetrySource === "relay"
        ? point.telemetrySource
        : null,
    totalPromptTokens: finiteOrNull(point.totalPromptTokens),
    totalOutputTokens: finiteOrNull(point.totalOutputTokens),
    completedRequestsTotal: finiteOrNull(point.completedRequestsTotal),
  };
}

export class LlmTelemetryStore {
  /** @param {string} [filePath] */
  constructor(filePath = process.env.LLM_TELEMETRY_JSON_PATH || LLM_TELEMETRY_JSON_PATH) {
    this.filePath = filePath;
    this.journalPath = `${filePath}.journal`;
    /** @type {Record<string, Array<Record<string, unknown>>>} */
    this._series = {};
    this._dirty = false;
    this._journalNeedsRepair = false;
    this._journalNeedsReplay = false;
    this._pending = new Map();
    this._flushTimer = null;
    this._compacting = false;
    this._lastCompactionAt = Date.now();
    this._load();
    // Retire expired ports even when nothing new arrives.
    this._compactTimer = setInterval(() => {
      void this.compactChunked();
    }, COMPACT_MS);
    this._compactTimer.unref?.();
  }

  _load() {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
        const series = raw?.series;
        if (series && typeof series === "object" && !Array.isArray(series)) {
          for (const [key, points] of Object.entries(series)) {
            if (!Array.isArray(points)) continue;
            for (const rawPoint of points) {
              const point = migratePoint(rawPoint);
              if (!point) continue;
              // A version 2 series is split by each point's model.
              const target = canonicalKey(key, point);
              if (target) this._upsert(target, point);
            }
          }
        }
        this._lastCompactionAt = fs.statSync(this.filePath).mtimeMs;
      } catch (err) {
        quarantineCorrupt(this.filePath, "LlmTelemetry", err);
        this._series = {};
      }
    }
    try {
      this._replayJournal();
      // A store written before the caps existed is bounded on the way in, not only
      // after the next sample or the next hourly compaction.
      this._enforceBounds();
      if (this._journalNeedsRepair || (!fs.existsSync(this.filePath) && fs.existsSync(this.journalPath))) this.compact();
    } catch {
      this._journalNeedsReplay = true;
      // Retry recovery before a later append; never extend a tail we could not read.
    }
  }

  _replayJournal() {
    if (!fs.existsSync(this.journalPath)) return;
    const journal = fs.readFileSync(this.journalPath, "utf8");
    this._journalNeedsRepair = journal.length > 0 && !journal.endsWith("\n");
    for (const line of journal.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (typeof entry?.key !== "string") continue;
        const point = migratePoint(entry.point);
        if (!point) continue;
        const target = canonicalKey(entry.key, point);
        if (target) this._upsert(target, point);
      } catch {
        // A torn final append must not hide the last valid snapshot or entries.
      }
    }
  }

  _upsert(key, point, nowMs = Date.now()) {
    // Retention is relative to now, not to the incoming sample: one point with
    // a forward-stepped clock must not collapse the whole series.
    const cutoff = nowMs - RETENTION_MS + BUCKET_MS;
    let points = this._series[key] || [];
    const last = points[points.length - 1];
    if (!last || point.t > last.t) {
      points.push(point);
      let drop = 0;
      while (drop < points.length && points[drop].t < cutoff) drop += 1;
      if (drop) points = points.slice(drop);
    } else if (point.t === last.t) {
      points[points.length - 1] = point;
    } else {
      const existing = points.findIndex((candidate) => candidate.t === point.t);
      if (existing >= 0) points[existing] = point;
      else {
        const at = points.findIndex((candidate) => candidate.t > point.t);
        points.splice(at < 0 ? points.length : at, 0, point);
      }
      if (points.some((candidate) => candidate.t < cutoff)) {
        points = points.filter((candidate) => candidate.t >= cutoff);
      }
    }
    if (points.length > MAX_POINTS) points = points.slice(-MAX_POINTS);
    this._series[key] = points;
  }

  /** Drop expired points and any series left with nothing, without writing the file. */
  _prune(now) {
    const cutoff = now - RETENTION_MS + BUCKET_MS;
    for (const [key, points] of Object.entries(this._series)) {
      const retained = points.filter((point) => point.t >= cutoff);
      if (retained.length) this._series[key] = retained;
      else delete this._series[key];
    }
  }

  /**
   * Hold the store under MAX_SERIES and MAX_TOTAL_POINTS by retiring whole series,
   * oldest last sample first. The series just written is always the newest, so a
   * live unit is never the one evicted while an abandoned model keeps its week.
   */
  _enforceBounds() {
    const keys = Object.keys(this._series);
    let total = 0;
    for (const key of keys) total += this._series[key].length;
    if (keys.length <= MAX_SERIES && total <= MAX_TOTAL_POINTS) return;
    const byAge = keys
      .map((key) => {
        const points = this._series[key];
        return { key, last: points[points.length - 1]?.t ?? -Infinity, size: points.length };
      })
      .sort((a, b) => a.last - b.last);
    let evicted = 0;
    while (byAge.length && (byAge.length > MAX_SERIES || total > MAX_TOTAL_POINTS)) {
      const oldest = byAge.shift();
      delete this._series[oldest.key];
      total -= oldest.size;
      evicted += 1;
    }
    if (evicted) {
      console.warn(`[LlmTelemetry] retired ${evicted} series to stay within ${MAX_SERIES} series and ${MAX_TOTAL_POINTS} points`);
    }
  }

  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush();
    }, FLUSH_MS);
    this._flushTimer.unref?.();
  }

  flush() {
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = null;
    if (!this._dirty) return;
    try {
      if (this._journalNeedsReplay) {
        this._replayJournal();
        // Newer in-memory records take precedence over recovered journal rows.
        for (const { key, point } of this._pending.values()) this._upsert(key, point);
        this._journalNeedsReplay = false;
      }
      if (this._journalNeedsRepair) {
        this.compact();
        return;
      }
      fs.mkdirSync(path.dirname(this.journalPath), { recursive: true });
      const journal = `${Array.from(this._pending.values(), (entry) => JSON.stringify(entry)).join("\n")}\n`;
      fs.appendFileSync(this.journalPath, journal, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(this.journalPath, 0o600);
      this._pending.clear();
      this._dirty = false;
      if (Date.now() - this._lastCompactionAt >= COMPACT_MS) void this.compactChunked();
    } catch (err) {
      this._journalNeedsReplay = true;
      console.error("[LlmTelemetry] write failed:", err.message);
    }
  }

  compact(now = Date.now()) {
    // Retire inactive/deleted ports too, not just series receiving new samples.
    this._prune(now);
    this._enforceBounds();
    atomicWrite(
      this.filePath,
      JSON.stringify({
        version: FILE_VERSION,
        bucketMs: BUCKET_MS,
        retentionHours: MAX_HOURS,
        series: this._series,
      }),
      0o600
    );
    atomicWrite(this.journalPath, "", 0o600);
    this._pending.clear();
    this._dirty = false;
    this._journalNeedsRepair = false;
    this._journalNeedsReplay = false;
    this._lastCompactionAt = Date.now();
  }

  /**
   * The same snapshot as compact(), written in slices with the event loop between
   * them: stringifying a week of ten-second buckets in one call blocks every
   * request and the polling loop for as long as it takes. The file is replaced
   * atomically, so an interrupted slice leaves the previous snapshot in place.
   */
  async compactChunked(now = Date.now()) {
    if (this._compacting) return;
    this._compacting = true;
    const tmp = `${this.filePath}.tmp`;
    try {
      if (!fs.existsSync(path.dirname(this.filePath))) return;
      this._prune(now);
      this._enforceBounds();
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const fd = fs.openSync(tmp, "w", 0o600);
      try {
        fs.writeSync(fd, `{"version":${FILE_VERSION},"bucketMs":${BUCKET_MS},"retentionHours":${MAX_HOURS},"series":{`);
        let firstSeries = true;
        for (const [key, points] of Object.entries(this._series)) {
          fs.writeSync(fd, `${firstSeries ? "" : ","}${JSON.stringify(key)}:[`);
          for (let at = 0; at < points.length; at += COMPACT_SLICE_POINTS) {
            const slice = points.slice(at, at + COMPACT_SLICE_POINTS);
            fs.writeSync(fd, `${at === 0 ? "" : ","}${slice.map((point) => JSON.stringify(point)).join(",")}`);
            await new Promise((resolve) => setImmediate(resolve));
          }
          fs.writeSync(fd, "]");
          firstSeries = false;
        }
        fs.writeSync(fd, "}}\n");
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
      atomicWrite(this.journalPath, "", 0o600);
      this._pending.clear();
      this._dirty = false;
      this._journalNeedsRepair = false;
      this._journalNeedsReplay = false;
      this._lastCompactionAt = Date.now();
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // The temporary file is rewritten next time; a failed cleanup is not a second failure.
      }
      // The directory going away mid-write (an unmounted volume, a removed test
      // store) is not a corrupt snapshot: nothing was replaced, and the next
      // flush recreates the path.
      if (!(err.code === "ENOENT" && !fs.existsSync(path.dirname(this.filePath)))) {
        console.error("[LlmTelemetry] chunked compaction failed:", err.message);
      }
    } finally {
      this._compacting = false;
    }
  }

  /** Record or replace the current ten-second bucket for one served model. */
  record(sparkId, port, metrics, now = new Date()) {
    if (!sparkId || !Number.isInteger(port) || !metrics) return;
    const time = now instanceof Date ? now.getTime() : Number(now);
    if (!Number.isFinite(time)) return;
    const modelId = normalizeModelId(metrics.modelId);
    const key = seriesKey(sparkId, port, modelId);
    const point = pointFrom(metrics, time);
    this._upsert(key, point);
    this._pending.set(`${key}:${point.t}`, { key, point });
    // A denied/full journal must not turn the retry buffer into unbounded history.
    const cutoff = point.t - RETENTION_MS + BUCKET_MS;
    for (const [id, entry] of this._pending) {
      if (entry.point.t < cutoff || entry.point.t > point.t) this._pending.delete(id);
    }
    this._enforceBounds();
    this._dirty = true;
    this._scheduleFlush();
  }

  /**
   * Read one model's series. Without a model, the newest series on the port is
   * returned so a caller never receives two models merged into one median.
   *
   * @param {{ hours?: number, since?: number|null, model?: string|null, now?: Date }} [opts]
   */
  getSeries(sparkId, port, opts = {}) {
    const hours = Math.min(MAX_HOURS, Math.max(1, Number(opts.hours) || 24));
    const now = opts.now instanceof Date ? opts.now.getTime() : Date.now();
    const cutoff = now - hours * 60 * 60 * 1000;
    const since = opts.since != null && Number.isFinite(Number(opts.since)) ? Number(opts.since) : null;
    const lower = since != null ? Math.max(cutoff, since + 1) : cutoff;
    const requestedModel = normalizeModelId(opts.model);
    let key = null;
    let modelId = requestedModel;
    if (requestedModel != null) {
      key = seriesKey(sparkId, port, requestedModel);
    } else {
      // Pick the series whose last point is newest, not the last key inserted.
      let latest = -Infinity;
      for (const candidate of Object.keys(this._series)) {
        const parsed = readSeriesKey(candidate);
        if (!parsed || parsed[0] !== sparkId || parsed[1] !== port) continue;
        const points = this._series[candidate];
        const last = points[points.length - 1];
        if (last && last.t > latest) {
          latest = last.t;
          key = candidate;
          modelId = parsed[2];
        }
      }
    }
    const inRange = (key && this._series[key] ? this._series[key] : []).filter((point) => point.t >= lower);
    // A week at ten seconds is 60,480 points; one response carries at most twelve
    // hours of them and says so, instead of serialising the whole week per read.
    const truncated = inRange.length > MAX_READ_POINTS;
    const points = truncated ? inRange.slice(-MAX_READ_POINTS) : inRange;
    return {
      sparkId,
      port,
      modelId: modelId ?? null,
      bucketSeconds: BUCKET_MS / 1000,
      retentionHours: MAX_HOURS,
      since,
      nextSince: points.length ? points[points.length - 1].t : since,
      truncated,
      points,
    };
  }
}
