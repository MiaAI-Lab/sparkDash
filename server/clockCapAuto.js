/**
 * Fleet-wide GPU clock-cap auto mode.
 *
 * One controller for every Spark: while enabled it holds a cap (within
 * 1800–2200 MHz) on any node whose GPU reaches AUTO_HOLD_TEMP_C and releases
 * it again at AUTO_RELEASE_TEMP_C. Temperatures come from the monitors'
 * snapshots; caps go through the same applyClockCap / revertClockCap as the
 * manual presets (sudoers-scoped nvidia-smi -lgc / -rgc plus the marker).
 * All I/O is injected, so the tests run without hardware or SSH.
 */
import { CLOCK_CAP_PRESETS, parseClockCap } from "./clockCap.js";

/** Auto never leaves this band. Caps are validated by parseFleetAutoCap. */
export const AUTO_RANGE = Object.freeze({ min: 1800, max: 2200 });

/** Presets the auto cap may be set to (the clock-cap presets inside the range). */
export const AUTO_CAP_PRESETS = Object.freeze(
  CLOCK_CAP_PRESETS.filter((mhz) => mhz >= AUTO_RANGE.min && mhz <= AUTO_RANGE.max)
);

/** Hold the cap at or above this GPU temperature (°C). */
export const AUTO_HOLD_TEMP_C = 72;

/** Release the cap at or below this GPU temperature (°C). */
export const AUTO_RELEASE_TEMP_C = 67;

/** Default cap applied while holding. */
export const DEFAULT_AUTO_CAP_MHZ = 1800;

/** How often the controller samples temperatures. */
export const AUTO_POLL_MS = 5000;

/** Validate an auto cap: an exact preset that also sits inside the auto range. */
export function parseFleetAutoCap(raw) {
  const mhz = parseClockCap(raw);
  if (mhz < AUTO_RANGE.min || mhz > AUTO_RANGE.max) {
    throw new Error(
      `Auto cap must be between ${AUTO_RANGE.min} and ${AUTO_RANGE.max} MHz`
    );
  }
  return mhz;
}

export class FleetClockAuto {
  /**
   * @param {object} deps
   * @param {() => Array<{ id: string, name: string }>} deps.sparks Fleet snapshot, read fresh each tick.
   * @param {(spark: { id: string }) => number | null} deps.readTemp
   *   GPU temperature in °C, or null when the node is offline / has no fresh reading.
   * @param {(spark: { id: string }) => Promise<{ mhz: number | null }>} deps.readStatus
   *   Current cap status, used to adopt existing caps when auto is enabled.
   * @param {(spark: { id: string }, mhz: number) => Promise<unknown>} deps.apply Same signature as clockCap.applyClockCap.
   * @param {(spark: { id: string }) => Promise<unknown>} deps.revert Same signature as clockCap.revertClockCap.
   * @param {(event: object) => unknown} deps.recordEvent
   */
  constructor({ sparks, readTemp, readStatus, apply, revert, recordEvent }) {
    this._sparks = sparks;
    this._readTemp = readTemp;
    this._readStatus = readStatus;
    this._apply = apply;
    this._revert = revert;
    this._recordEvent = recordEvent;
    this._timer = null;
    this._ticking = false;
    this._enabled = false;
    this._capMhz = DEFAULT_AUTO_CAP_MHZ;
    /** Per-spark auto ownership: true while auto is holding a cap on that node. */
    this._holding = new Map();
    /** Last per-spark tick error, surfaced in status until the next success. */
    this._lastError = new Map();
  }

  /** Current controller state for the API/UI. */
  status() {
    return {
      enabled: this._enabled,
      capMhz: this._capMhz,
      holdTempC: AUTO_HOLD_TEMP_C,
      releaseTempC: AUTO_RELEASE_TEMP_C,
      range: { ...AUTO_RANGE },
      presets: [...AUTO_CAP_PRESETS],
      sparks: this._sparks().map((spark) => ({
        id: spark.id,
        name: spark.name,
        holding: this._holding.get(spark.id) === true,
        lastError: this._lastError.get(spark.id) ?? null,
      })),
    };
  }

  /**
   * Enable/disable fleet auto mode. When enabling with a capMhz, the value is
   * validated first so an invalid cap never flips the mode on. Existing caps
   * are adopted (best effort) so auto releases exactly what it holds.
   */
  async setEnabled(enabled, capMhz) {
    if (capMhz !== undefined) this._capMhz = parseFleetAutoCap(capMhz);
    this._enabled = Boolean(enabled);
    if (this._enabled) {
      await this._adoptExistingCaps();
      this._ensureTimer();
    } else {
      this._stopTimer();
      this._holding.clear();
      this._lastError.clear();
    }
    return this.status();
  }

  /** Start the tick loop if enabled (no-op otherwise). Safe to call twice. */
  start() {
    if (this._enabled) this._ensureTimer();
  }

  stop() {
    this._stopTimer();
  }

  _ensureTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => void this.tick(), AUTO_POLL_MS);
    this._timer.unref?.();
  }

  _stopTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** Seed per-node holding state from the current marker on each node. */
  async _adoptExistingCaps() {
    const results = await Promise.allSettled(
      this._sparks().map(async (spark) => {
        try {
          const status = await this._readStatus(spark);
          this._holding.set(spark.id, status.mhz != null);
          this._lastError.delete(spark.id);
        } catch {
          // Unreachable node at enable time: start unowned; the tick will
          // apply a cap if the node comes back hot.
          this._holding.set(spark.id, false);
        }
      })
    );
    return results;
  }

  /** One sampling pass. Overlapping ticks (slow SSH) are skipped, not queued. */
  async tick() {
    if (!this._enabled || this._ticking) return;
    this._ticking = true;
    try {
      await Promise.allSettled(
        this._sparks().map((spark) => this._tickSpark(spark))
      );
    } finally {
      this._ticking = false;
    }
  }

  async _tickSpark(spark) {
    const temp = this._readTemp(spark);
    if (!Number.isFinite(temp)) return; // offline or no fresh reading — hold state
    const name = spark.name || spark.id;
    try {
      if (temp >= AUTO_HOLD_TEMP_C && this._holding.get(spark.id) !== true) {
        await this._apply(spark, this._capMhz);
        this._holding.set(spark.id, true);
        this._lastError.delete(spark.id);
        this._recordEvent({
          type: "gpu.clockcap.auto.applied",
          severity: "info",
          sparkId: spark.id,
          sparkName: spark.name,
          message: `Auto: capped ${name} at ${this._capMhz} MHz (GPU ${Math.round(temp)}°C ≥ ${AUTO_HOLD_TEMP_C}°C)`,
        });
      } else if (temp <= AUTO_RELEASE_TEMP_C && this._holding.get(spark.id) === true) {
        await this._revert(spark);
        this._holding.set(spark.id, false);
        this._lastError.delete(spark.id);
        this._recordEvent({
          type: "gpu.clockcap.auto.released",
          severity: "info",
          sparkId: spark.id,
          sparkName: spark.name,
          message: `Auto: released clock cap on ${name} (GPU ${Math.round(temp)}°C ≤ ${AUTO_RELEASE_TEMP_C}°C)`,
        });
      }
    } catch (err) {
      const msg = (err?.message || String(err)).split("\n")[0].slice(0, 160);
      this._lastError.set(spark.id, msg);
      this._recordEvent({
        type: "gpu.clockcap.auto.failed",
        severity: "error",
        sparkId: spark.id,
        sparkName: spark.name,
        message: `Auto clock cap failed on ${name}: ${msg}`,
      });
    }
  }
}
