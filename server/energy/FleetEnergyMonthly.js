import fs from "node:fs";
import path from "node:path";
import { writeStateAtomically } from "./atomicWrite.js";

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
 */

const FILE_VERSION = 1;
const MINUTE_MS = 60_000;
/** A minute can still receive a late interval for this long after it ends (the tracker's MAX_GAP_MS). */
const LATE_WRITE_GRACE_MS = 10_000;
/** Sanity cap: never fold, or hold a watermark, beyond the clock plus this. */
const MAX_AHEAD_MS = 24 * 60 * 60_000;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
const round3 = (v) => Math.round(v * 1000) / 1000;

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
  }
  for (const key of ["fleetWh", "fleetCoverageMs", "outputTokens", "coveredOutputTokens", "tokenFleetWh"]) {
    month[key] = num(raw?.[key]);
  }
  return month;
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
    this._dirty = false;
    this._load();
  }

  get foldedThroughMs() {
    return this._foldedThroughMs;
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
      nodes.push([id, energy, coverageMs]);
    }
    const fleetWh = num(bucket.fleetWattMs) / 3_600_000;
    // A discarded bucket adds nothing anywhere (fleet, coverage, tokens or nodes).
    if (!(nodes.length > 0 || fleetWh > 0 || bucket.outputTokens > 0)) return false;
    const key = monthKey(start);
    const month = this._months.get(key) ?? emptyMonth();
    for (const [id, energy, coverageMs] of nodes) {
      const node = (month.nodes[id] ??= { wh: 0, coverageMs: 0 });
      node.wh += energy;
      node.coverageMs += coverageMs;
    }
    month.fleetWh += fleetWh;
    month.fleetCoverageMs += Math.min(num(bucket.fleetCoverageMs), MINUTE_MS);
    month.outputTokens += Math.trunc(num(bucket.outputTokens));
    month.coveredOutputTokens += Math.trunc(num(bucket.coveredOutputTokens));
    if (trackedSinceMs !== null && start >= trackedSinceMs) month.tokenFleetWh += fleetWh;
    this._months.set(key, month);
    return true;
  }

  /** Months oldest first, with derived totals. */
  snapshot(nowMs = this._now()) {
    const months = [...this._months.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, m]) => {
        const [startMs, endMs] = monthRange(key);
        const nodes = Object.fromEntries(
          Object.entries(m.nodes).map(([id, n]) => [id, { wh: round3(n.wh), coverageMs: Math.round(n.coverageMs) }])
        );
        const totalWh = Object.values(m.nodes).reduce((s, n) => s + n.wh, 0);
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
