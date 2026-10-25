/**
 * Bounded, restart-safe LLM telemetry for incident and capacity analysis.
 *
 * One latest sample is retained per 10-second bucket for seven days. Unlike
 * LlmDaily, unavailable samples are retained so outages remain visible after
 * the inference process or dashboard restarts.
 */
import fs from "fs";
import path from "path";
import { LLM_TELEMETRY_JSON_PATH } from "../config.js";
import { atomicWrite } from "../util/atomicWrite.js";

const BUCKET_MS = 10_000;
const MAX_HOURS = 168;
const RETENTION_MS = MAX_HOURS * 60 * 60 * 1000;
const MAX_POINTS = RETENTION_MS / BUCKET_MS;
const FLUSH_MS = 30_000;
const COMPACT_MS = 60 * 60 * 1000;
const LLM_STATUSES = new Set([
  "active",
  "idle",
  "unknown",
  "stale",
  "unavailable",
  "ambiguous_model",
]);

function seriesKey(sparkId, port) {
  return `${sparkId}:${port}`;
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
    this._lastCompactionAt = Date.now();
    this._load();
  }

  _load() {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
        const series = raw?.series;
        if (series && typeof series === "object" && !Array.isArray(series)) {
          for (const [key, points] of Object.entries(series)) {
            if (!Array.isArray(points)) continue;
            this._series[key] = points.map(migratePoint).filter(Boolean).slice(-MAX_POINTS);
          }
        }
        this._lastCompactionAt = fs.statSync(this.filePath).mtimeMs;
      } catch {
        this._series = {};
      }
    }
    try {
      this._replayJournal();
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
        this._upsert(entry.key, point);
      } catch {
        // A torn final append must not hide the last valid snapshot or entries.
      }
    }
  }

  _upsert(key, point) {
    const cutoff = point.t - RETENTION_MS + BUCKET_MS;
    const points = (this._series[key] || []).filter((candidate) => candidate.t >= cutoff);
    const existing = points.findIndex((candidate) => candidate.t === point.t);
    if (existing >= 0) points[existing] = point;
    else points.push(point);
    points.sort((left, right) => left.t - right.t);
    this._series[key] = points.slice(-MAX_POINTS);
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
      if (Date.now() - this._lastCompactionAt >= COMPACT_MS) this.compact();
    } catch (err) {
      this._journalNeedsReplay = true;
      console.error("[LlmTelemetry] write failed:", err.message);
    }
  }

  compact(now = Date.now()) {
    // Retire inactive/deleted ports too, not just series receiving new samples.
    const cutoff = now - RETENTION_MS + BUCKET_MS;
    for (const [key, points] of Object.entries(this._series)) {
      const retained = points.filter((point) => point.t >= cutoff);
      if (retained.length) this._series[key] = retained;
      else delete this._series[key];
    }
    atomicWrite(
      this.filePath,
      JSON.stringify({ version: 2, bucketMs: BUCKET_MS, retentionHours: MAX_HOURS, series: this._series }),
      0o600
    );
    atomicWrite(this.journalPath, "", 0o600);
    this._pending.clear();
    this._dirty = false;
    this._journalNeedsRepair = false;
    this._journalNeedsReplay = false;
    this._lastCompactionAt = Date.now();
  }

  /** Record or replace the current ten-second bucket. */
  record(sparkId, port, metrics, now = new Date()) {
    if (!sparkId || !Number.isInteger(port) || !metrics) return;
    const time = now instanceof Date ? now.getTime() : Number(now);
    if (!Number.isFinite(time)) return;
    const key = seriesKey(sparkId, port);
    const point = pointFrom(metrics, time);
    this._upsert(key, point);
    this._pending.set(`${key}:${point.t}`, { key, point });
    // A denied/full journal must not turn the retry buffer into unbounded history.
    const cutoff = point.t - RETENTION_MS + BUCKET_MS;
    for (const [id, entry] of this._pending) {
      if (entry.point.t < cutoff || entry.point.t > point.t) this._pending.delete(id);
    }
    this._dirty = true;
    this._scheduleFlush();
  }

  getSeries(sparkId, port, opts = {}) {
    const hours = Math.min(MAX_HOURS, Math.max(1, Number(opts.hours) || 24));
    const now = opts.now instanceof Date ? opts.now.getTime() : Date.now();
    const cutoff = now - hours * 60 * 60 * 1000;
    const points = (this._series[seriesKey(sparkId, port)] || []).filter((p) => p.t >= cutoff);
    return { sparkId, port, bucketSeconds: BUCKET_MS / 1000, retentionHours: MAX_HOURS, points };
  }
}
