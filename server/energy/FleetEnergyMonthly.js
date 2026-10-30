import fs from "node:fs";
import path from "node:path";
import { writeStateAtomically } from "./atomicWrite.js";
import { wallMinute } from "./wallMinute.js";

/**
 * Permanent monthly roll-up of fleet energy.
 *
 * The tracker keeps per-minute buckets for 31 days. This archive folds each
 * finished minute into its UTC month once, so totals outlive that window,
 * restarts, resets and fleet membership changes.
 *
 * Idempotency: one watermark (`foldedThroughMs`) is stored in the same file as
 * the totals and written atomically with them. A minute is folded only when its
 * start is at or after the watermark, and the watermark then moves past it, so
 * a minute can never be counted twice (re-feeding the same buckets, reloading
 * the 31-day file after a crash, or backfilling on every start are all safe).
 *
 * A month is "closed" once its end is past the late-write grace at the time of
 * reading. There is no separate close step; the current UTC month is open.
 *
 * Optional series ride along as pure additions, present only once recorded:
 *  - GPU and CPU parts of the estimate fold with the estimate, under the same watermark.
 *  - Wall power from an external meter folds under its own watermark
 *    (`wallFoldedThroughMs`), and only once the meter has settled a minute, because the
 *    meter's own record may still replace live readings. Meter history older than the
 *    tracker's window is imported per hour (`importWallHours`); `wallImportedFromMs`
 *    per node makes that import idempotent.
 */

const FILE_VERSION = 1;
const MINUTE_MS = 60_000;
/** A minute can still receive a late interval for this long after it ends (the tracker's MAX_GAP_MS). */
const LATE_WRITE_GRACE_MS = 10_000;
/** Sanity cap: never fold, or hold a watermark, beyond the clock plus this. */
const MAX_AHEAD_MS = 24 * 60 * 60_000;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

const HOUR_MS = 60 * MINUTE_MS;

const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
const round3 = (v) => Math.round(v * 1000) / 1000;
const NODE_PART_KEYS = ["gpuWh", "cpuWh", "partsCoverageMs"];
const NODE_WALL_KEYS = ["wallWh", "wallCoverageMs", "wallMeteredMs", "wallFilledWh", "wallFilledMs"];
const MONTH_WALL_KEYS = ["fleetWallWh", "fleetWallFilledWh", "fleetWallCoverageMs", "wallCoveredOutputTokens", "wallTokenFleetWh"];

/** "2026-10" for a UTC instant. */
export function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** [startMs, endMs) of a "YYYY-MM" key, or null when it is not one. */
export function monthRange(key) {
  const m = MONTH_RE.exec(key ?? "");
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  return [Date.UTC(year, month, 1), Date.UTC(year, month + 1, 1)];
}

function emptyMonth() {
  return {
    nodes: {},
    fleetWh: 0,
    fleetCoverageMs: 0,
    outputTokens: 0,
    coveredOutputTokens: 0,
    tokenFleetWh: 0,
  };
}

function cleanMonth(raw) {
  const month = emptyMonth();
  for (const [id, node] of Object.entries(raw?.nodes ?? {})) {
    month.nodes[id] = { wh: num(node?.wh), coverageMs: num(node?.coverageMs) };
    for (const key of [...NODE_PART_KEYS, ...NODE_WALL_KEYS]) {
      if (node?.[key] !== undefined) month.nodes[id][key] = num(node[key]);
    }
  }
  for (const key of ["fleetWh", "fleetCoverageMs", "outputTokens", "coveredOutputTokens", "tokenFleetWh"]) {
    month[key] = num(raw?.[key]);
  }
  for (const key of MONTH_WALL_KEYS) {
    if (raw?.[key] !== undefined) month[key] = num(raw[key]);
  }
  return month;
}

function addTo(target, key, value) {
  target[key] = (target[key] ?? 0) + value;
}

export class MonthlyEnergyArchive {
  constructor({
    filePath = null,
    now = () => Date.now(),
    fileSystem = fs,
    writeState = writeStateAtomically,
  } = {}) {
    this.filePath = filePath;
    this._now = now;
    this._fs = fileSystem;
    this._writeState = writeState;
    this._months = new Map();
    this._foldedThroughMs = 0;
    this._wallFoldedThroughMs = 0;
    this._wallFoldedFromMs = null;
    this._wallImportedFromMs = {};
    this._dirty = false;
    this._load();
  }

  get foldedThroughMs() {
    return this._foldedThroughMs;
  }

  /** Earliest minute whose wall power was folded, or null before the first wall fold. */
  get wallFoldedFromMs() {
    return this._wallFoldedFromMs;
  }

  /** Start (ms) of the first minute that is no longer open to late writes at `nowMs`. */
  static closedBefore(nowMs) {
    return Math.floor((nowMs - LATE_WRITE_GRACE_MS) / MINUTE_MS) * MINUTE_MS;
  }

  /**
   * Fold finished minutes from `buckets` (any iterable of tracker minute buckets).
   * Buckets before the watermark were folded already and are skipped.
   * `trackedSinceMs` is the minute from which output tokens were counted; only
   * fleet energy from then on is paired with tokens.
   * @returns {number} how many minutes were added
   */
  foldBuckets(buckets, { nowMs = this._now(), trackedSinceMs = null } = {}) {
    if (!Number.isFinite(nowMs)) return 0;
    // Clock-jump guard: a clock that ran far ahead must not park the watermark in the future,
    // or real minutes after the clock returns would be skipped. Never fold past now + 1 day;
    // a stored watermark beyond that is clamped back (totals are kept).
    const cap = MonthlyEnergyArchive.closedBefore(this._now() + MAX_AHEAD_MS);
    const boundary = Math.min(MonthlyEnergyArchive.closedBefore(nowMs), cap);
    if (this._foldedThroughMs > cap) {
      this._foldedThroughMs = boundary;
      this._dirty = true;
    }
    if (boundary <= this._foldedThroughMs) return 0;

    let folded = 0;
    for (const bucket of buckets ?? []) {
      const start = bucket?.minuteStartMs;
      if (!Number.isSafeInteger(start) || start % MINUTE_MS !== 0) continue;
      if (start < this._foldedThroughMs || start >= boundary) continue;
      if (this._add(start, bucket, trackedSinceMs)) folded += 1;
    }
    // The watermark only moves when something was added, so an empty scan
    // (a fresh start, a quiet fleet) can never hide minutes recorded later.
    if (folded > 0) {
      this._foldedThroughMs = boundary;
      this._dirty = true;
    }
    return folded;
  }

  _add(start, bucket, trackedSinceMs) {
    const nodes = [];
    for (const [id, wh] of Object.entries(bucket.nodeWh ?? {})) {
      const coverageMs = Math.min(num(bucket.nodeCoverageMs?.[id]), MINUTE_MS);
      const energy = num(wh);
      if (energy === 0 && coverageMs === 0) continue;
      nodes.push([id, energy, coverageMs, bucket.parts?.[id]]);
    }
    const fleetWh = num(bucket.fleetWattMs) / 3_600_000;
    // A discarded bucket adds nothing anywhere (fleet, coverage, tokens or nodes).
    if (!(nodes.length > 0 || fleetWh > 0 || bucket.outputTokens > 0)) return false;
    const key = monthKey(start);
    const month = this._months.get(key) ?? emptyMonth();
    for (const [id, energy, coverageMs, parts] of nodes) {
      const node = (month.nodes[id] ??= { wh: 0, coverageMs: 0 });
      node.wh += energy;
      node.coverageMs += coverageMs;
      if (Array.isArray(parts)) {
        addTo(node, "gpuWh", num(parts[0]));
        addTo(node, "cpuWh", num(parts[1]));
        addTo(node, "partsCoverageMs", Math.min(num(parts[2]), MINUTE_MS));
      }
    }
    month.fleetWh += fleetWh;
    month.fleetCoverageMs += Math.min(num(bucket.fleetCoverageMs), MINUTE_MS);
    month.outputTokens += Math.trunc(num(bucket.outputTokens));
    month.coveredOutputTokens += Math.trunc(num(bucket.coveredOutputTokens));
    if (trackedSinceMs !== null && start >= trackedSinceMs) month.tokenFleetWh += fleetWh;
    this._months.set(key, month);
    return true;
  }

  /**
   * Fold settled wall-power minutes (start before `settledBeforeMs`, and closed): measured
   * for `wallNodeIds`, plus time the estimate covered without a meter, valued at estimate ×
   * `ratios` (see wallMinute.js). Same idempotency as foldBuckets, under the wall watermark.
   * @returns {number} minutes added
   */
  foldWall(
    buckets,
    { nowMs = this._now(), settledBeforeMs = -Infinity, nodeIds = [], wallNodeIds = nodeIds, ratios = null, trackedSinceMs = null } = {}
  ) {
    if (!Number.isFinite(nowMs) || nodeIds.length === 0 || wallNodeIds.length === 0) return 0;
    const cap = MonthlyEnergyArchive.closedBefore(this._now() + MAX_AHEAD_MS);
    const settled = Number.isFinite(settledBeforeMs)
      ? Math.floor(settledBeforeMs / MINUTE_MS) * MINUTE_MS
      : settledBeforeMs === Infinity ? Infinity : -Infinity;
    const boundary = Math.min(MonthlyEnergyArchive.closedBefore(nowMs), settled, cap);
    if (this._wallFoldedThroughMs > cap) {
      this._wallFoldedThroughMs = Math.max(0, Math.min(boundary, MonthlyEnergyArchive.closedBefore(nowMs)));
      this._dirty = true;
    }
    if (!(boundary > this._wallFoldedThroughMs)) return 0;
    const metered = new Set(wallNodeIds);
    let folded = 0;
    let earliest = null;
    for (const bucket of buckets ?? []) {
      const start = bucket?.minuteStartMs;
      if (!Number.isSafeInteger(start) || start % MINUTE_MS !== 0) continue;
      if (start < this._wallFoldedThroughMs || start >= boundary) continue;
      const minute = wallMinute(bucket, nodeIds, metered, ratios);
      if (!minute) continue;
      const key = monthKey(start);
      const month = this._months.get(key) ?? emptyMonth();
      for (const id of nodeIds) {
        const n = minute.nodes[id];
        if (n.coverageMs <= 0 && n.filledMs <= 0) continue;
        const node = (month.nodes[id] ??= { wh: 0, coverageMs: 0 });
        addTo(node, "wallWh", num(n.wh));
        addTo(node, "wallCoverageMs", Math.min(num(n.coverageMs), MINUTE_MS));
        addTo(node, "wallMeteredMs", Math.min(num(n.meteredMs), MINUTE_MS));
        addTo(node, "wallFilledWh", num(n.filledWh));
        addTo(node, "wallFilledMs", Math.min(num(n.filledMs), MINUTE_MS));
      }
      if (minute.fleet) {
        addTo(month, "fleetWallWh", minute.fleet.wh);
        addTo(month, "fleetWallFilledWh", minute.fleet.filledWh);
        addTo(month, "fleetWallCoverageMs", minute.fleet.coverageMs);
        if (minute.fleet.full && trackedSinceMs !== null && start >= trackedSinceMs) {
          addTo(month, "wallCoveredOutputTokens", Math.trunc(num(bucket.outputTokens)));
          addTo(month, "wallTokenFleetWh", minute.fleet.wh);
        }
      }
      this._months.set(key, month);
      folded += 1;
      if (earliest === null || start < earliest) earliest = start;
    }
    if (folded > 0) {
      this._wallFoldedThroughMs = boundary === Infinity ? MonthlyEnergyArchive.closedBefore(nowMs) : boundary;
      if (this._wallFoldedFromMs === null || earliest < this._wallFoldedFromMs) this._wallFoldedFromMs = earliest;
      this._dirty = true;
    }
    return folded;
  }

  /**
   * Import a meter's hourly history older than anything folded or imported before for each
   * node: hours ending at or before `beforeMs` and before the node's earlier imports. Hours
   * every node in `fleetNodeIds` reported in this call also count toward the fleet figures.
   * @param {Map<string, Array<{ startMs: number, endMs: number, meanW: number }>>} periodsByNode
   * @returns {number} node-hours added
   */
  importWallHours(periodsByNode, { nodeIds = [...periodsByNode.keys()], fleetNodeIds = nodeIds, beforeMs } = {}) {
    if (!Number.isFinite(beforeMs)) return 0;
    const byHour = new Map();
    let imported = 0;
    for (const id of nodeIds) {
      const limit = Math.min(beforeMs, this._wallImportedFromMs[id] ?? beforeMs);
      let earliest = null;
      for (const p of periodsByNode.get(id) ?? []) {
        if (p?.endMs - p?.startMs !== HOUR_MS || p.startMs % HOUR_MS !== 0 || p.endMs > limit) continue;
        if (!Number.isFinite(p.meanW) || p.meanW < 0) continue;
        const wh = p.meanW;
        const month = this._months.get(monthKey(p.startMs)) ?? emptyMonth();
        const node = (month.nodes[id] ??= { wh: 0, coverageMs: 0 });
        addTo(node, "wallWh", wh);
        addTo(node, "wallCoverageMs", HOUR_MS);
        addTo(node, "wallMeteredMs", HOUR_MS);
        this._months.set(monthKey(p.startMs), month);
        const hour = byHour.get(p.startMs) ?? new Map();
        hour.set(id, wh);
        byHour.set(p.startMs, hour);
        imported += 1;
        if (earliest === null || p.startMs < earliest) earliest = p.startMs;
      }
      this._wallImportedFromMs[id] = earliest === null ? limit : Math.min(limit, earliest);
    }
    if (fleetNodeIds.length > 0 && fleetNodeIds.every((id) => nodeIds.includes(id))) {
      for (const [start, hour] of byHour) {
        if (hour.size !== fleetNodeIds.length) continue;
        const month = this._months.get(monthKey(start));
        addTo(month, "fleetWallWh", [...hour.values()].reduce((sum, wh) => sum + wh, 0));
        addTo(month, "fleetWallCoverageMs", HOUR_MS);
      }
    }
    this._dirty = true;
    return imported;
  }

  /** Months oldest first, with derived totals. */
  snapshot(nowMs = this._now()) {
    const months = [...this._months.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, m]) => {
        const [startMs, endMs] = monthRange(key);
        const nodes = Object.fromEntries(
          Object.entries(m.nodes).map(([id, n]) => {
            const node = { wh: round3(n.wh), coverageMs: Math.round(n.coverageMs) };
            for (const key of [...NODE_PART_KEYS, ...NODE_WALL_KEYS]) {
              if (n[key] !== undefined) node[key] = key.endsWith("Ms") ? Math.round(n[key]) : round3(n[key]);
            }
            return [id, node];
          })
        );
        const totalWh = Object.values(m.nodes).reduce((s, n) => s + n.wh, 0);
        const hasWall = Object.values(m.nodes).some((n) => n.wallCoverageMs > 0 || n.wallFilledMs > 0);
        return {
          month: key,
          startMs,
          endMs,
          closed: endMs <= MonthlyEnergyArchive.closedBefore(nowMs),
          nodeIds: Object.keys(nodes).sort(),
          nodes,
          totalWh: round3(totalWh),
          fleetWh: round3(m.fleetWh),
          fleetCoverageMs: Math.round(m.fleetCoverageMs),
          outputTokens: m.outputTokens,
          coveredOutputTokens: m.coveredOutputTokens,
          whPerOutputToken:
            m.tokenFleetWh > 0 && m.coveredOutputTokens > 0 ? m.tokenFleetWh / m.coveredOutputTokens : null,
          ...(hasWall
            ? {
                // Measured plus filled; totalWallFilledWh says how much was filled from the estimate.
                totalWallWh: round3(Object.values(m.nodes).reduce((s, n) => s + (n.wallWh ?? 0) + (n.wallFilledWh ?? 0), 0)),
                totalWallFilledWh: round3(Object.values(m.nodes).reduce((s, n) => s + (n.wallFilledWh ?? 0), 0)),
                fleetWallWh: round3(m.fleetWallWh ?? 0),
                fleetWallFilledWh: round3(m.fleetWallFilledWh ?? 0),
                fleetWallCoverageMs: Math.round(m.fleetWallCoverageMs ?? 0),
                wallCoveredOutputTokens: m.wallCoveredOutputTokens ?? 0,
                wallWhPerOutputToken:
                  m.wallTokenFleetWh > 0 && m.wallCoveredOutputTokens > 0 ? m.wallTokenFleetWh / m.wallCoveredOutputTokens : null,
              }
            : {}),
        };
      });
    return { estimated: true, generatedAt: nowMs, foldedThroughMs: this._foldedThroughMs, months };
  }

  /**
   * Delete archived months: one (`month: "YYYY-MM"`) or all (`all: true`).
   * The watermark is kept, so cleared minutes are not backfilled again.
   * @returns {number} months removed
   */
  clear({ month, all } = {}) {
    let removed = 0;
    if (all === true) {
      removed = this._months.size;
      this._months.clear();
    } else if (monthRange(month) && this._months.delete(month)) {
      removed = 1;
    }
    this._dirty = true;
    this.flush();
    return removed;
  }

  flush() {
    if (!this.filePath || !this._dirty || this._persistDisabled) return false;
    const months = Object.fromEntries([...this._months.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
    const state = { version: FILE_VERSION, savedAt: this._now(), foldedThroughMs: this._foldedThroughMs, months };
    if (this._wallFoldedThroughMs > 0 || Object.keys(this._wallImportedFromMs).length > 0) {
      state.wallFoldedThroughMs = this._wallFoldedThroughMs;
      state.wallFoldedFromMs = this._wallFoldedFromMs;
      state.wallImportedFromMs = this._wallImportedFromMs;
    }
    this._writeState(this.filePath, `${JSON.stringify(state)}\n`, this._fs);
    this._dirty = false;
    return true;
  }

  _load() {
    if (!this.filePath) return;
    let text;
    try {
      text = this._fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      // Not being able to READ a file (permissions, I/O) says nothing about its content:
      // never move it aside, and never overwrite it from an empty archive.
      this._persistDisabled = true;
      console.warn(`[MonthlyEnergyArchive] cannot read ${this.filePath} (${error.code ?? error.message}); not persisting this run`);
      return;
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      this._setAside(error);
      return;
    }
    if (raw?.version !== FILE_VERSION || !raw.months || typeof raw.months !== "object") {
      this._setAside(new Error("unrecognised format"));
      return;
    }
    for (const [key, value] of Object.entries(raw.months)) {
      if (monthRange(key)) this._months.set(key, cleanMonth(value));
    }
    if (Number.isSafeInteger(raw.wallFoldedThroughMs) && raw.wallFoldedThroughMs >= 0) {
      const cap = MonthlyEnergyArchive.closedBefore(this._now() + MAX_AHEAD_MS);
      this._wallFoldedThroughMs = Math.min(raw.wallFoldedThroughMs, cap);
    }
    if (Number.isSafeInteger(raw.wallFoldedFromMs) && raw.wallFoldedFromMs >= 0) this._wallFoldedFromMs = raw.wallFoldedFromMs;
    if (raw.wallImportedFromMs && typeof raw.wallImportedFromMs === "object") {
      for (const [id, ms] of Object.entries(raw.wallImportedFromMs)) {
        if (Number.isSafeInteger(ms) && ms >= 0) this._wallImportedFromMs[id] = ms;
      }
    }
    if (Number.isSafeInteger(raw.foldedThroughMs) && raw.foldedThroughMs >= 0) {
      this._foldedThroughMs = raw.foldedThroughMs;
      // Same clock-jump guard as foldBuckets: a watermark beyond now + 1 day is clamped back now.
      const cap = MonthlyEnergyArchive.closedBefore(this._now() + MAX_AHEAD_MS);
      if (this._foldedThroughMs > cap) {
        this._foldedThroughMs = MonthlyEnergyArchive.closedBefore(this._now());
        this._dirty = true;
      }
    }
  }

  /** An unreadable archive is kept beside the live file, never overwritten. */
  _setAside(error) {
    const parsed = path.parse(this.filePath);
    const aside = path.join(parsed.dir, `${parsed.name}.unreadable-${Math.floor(this._now())}${parsed.ext}`);
    try {
      this._fs.renameSync(this.filePath, aside);
      console.warn(`[MonthlyEnergyArchive] ${error.message}; kept the old file at ${aside}`);
    } catch (renameError) {
      console.warn(`[MonthlyEnergyArchive] unable to read ${this.filePath}: ${renameError.message}`);
    }
  }
}

export default MonthlyEnergyArchive;
