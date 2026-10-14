/**
 * Fleet clock-cap reconcile.
 *
 * The last fleet-wide apply is persisted in config (settings.clockCapTarget —
 * `fixed <MHz>`, `unlocked` or `auto`). A periodic loop reads each Spark's cap status
 * and re-applies the target when the node has drifted:
 *   - a stale marker from an earlier boot (the Spark rebooted, cap gone),
 *   - someone ran `nvidia-smi -rgc` out-of-band (marker gone → stock),
 *   - the live marker MHz no longer matches the target.
 * Every successful re-application records a `gpu.clockcap.reapplied` event.
 * With no target recorded, or while fleet Auto owns the caps (`auto`), the
 * loop touches nothing.
 */

/** How often the reconcile loop reads the fleet (ms). */
export const RECONCILE_POLL_MS = 5000;

/** How long a node failure is throttled before the next failure event (ms). */
export const RECONCILE_FAILURE_EVENT_MS = 5 * 60_000;

/**
 * Whether a node's cap status has drifted from the fleet target.
 * @param {{ mhz: number | null, stale?: boolean }} status result of readClockCapStatus
 * @param {{ mode: "fixed" | "unlocked" | "auto", mhz: number | null } | null} target
 * @returns {boolean}
 */
export function capDrifts(status, target) {
  // Fleet Auto owns the caps while enabled: never fight it.
  if (!target || target.mode === "auto") return false;
  if (target.mode === "unlocked") {
    // Drift when a cap is present, or a stale marker from a previous boot
    // still sits on disk (the reapply removes it).
    return status.mhz != null || status.stale === true;
  }
  // fixed: a stale marker resolves to null (cap lost on reboot), as does an
  // out-of-band -rgc — both count as drift, as does any other MHz.
  return status.mhz !== target.mhz;
}

/**
 * Periodic fleet clock-cap reconcile. All I/O is injected; `run`-style fakes
 * keep the tests hardware-free.
 */
export class FleetClockCapReconciler {
  /**
   * @param {object} deps
   * @param {() => Array<{ id: string, name: string }>} deps.sparks Fleet snapshot, read fresh each tick.
   * @param {() => { mode: "fixed" | "unlocked", mhz: number | null } | null} deps.target
   *   The persisted fleet target (settings.clockCapTarget), read fresh each tick.
   * @param {(spark: { id: string }) => Promise<{ mhz: number | null, stale?: boolean }>} deps.readStatus
   * @param {(spark: { id: string }, mhz: number) => Promise<unknown>} deps.apply Same signature as clockCap.applyClockCap.
   * @param {(spark: { id: string }) => Promise<unknown>} deps.revert Same signature as clockCap.revertClockCap.
   * @param {(event: object) => unknown} deps.recordEvent
   */
  constructor({ sparks, target, readStatus, apply, revert, recordEvent }) {
    this._sparks = sparks;
    this._target = target;
    this._readStatus = readStatus;
    this._apply = apply;
    this._revert = revert;
    this._recordEvent = recordEvent;
    this._timer = null;
    this._ticking = false;
    /** Per-node busy flags: a slow SSH read must not overlap itself. */
    this._busy = new Set();
    /** Last failure event per node, for throttling. */
    this._lastFailureEventAt = new Map();
  }

  /** Start the loop (no-op when already running). */
  start(pollMs = RECONCILE_POLL_MS) {
    if (this._timer) return;
    this._timer = setInterval(() => void this.tick(), Math.max(1000, pollMs));
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * One reconcile pass over the fleet. Overlapping passes are skipped, and a
   * node whose previous read is still in flight is left for the next tick.
   */
  async tick() {
    if (this._ticking) return;
    this._ticking = true;
    try {
      const target = this._target();
      if (!target) return;
      await Promise.allSettled(
        this._sparks().map((spark) => this._reconcileSpark(spark, target))
      );
    } finally {
      this._ticking = false;
    }
  }

  async _reconcileSpark(spark, target) {
    if (this._busy.has(spark.id)) return;
    this._busy.add(spark.id);
    try {
      const status = await this._readStatus(spark);
      if (!capDrifts(status, target)) return;
      const name = spark.name || spark.id;
      if (target.mode === "unlocked") {
        await this._revert(spark);
      } else {
        await this._apply(spark, target.mhz);
      }
      this._lastFailureEventAt.delete(spark.id);
      this._recordEvent({
        type: "gpu.clockcap.reapplied",
        severity: "info",
        sparkId: spark.id,
        sparkName: spark.name,
        message:
          target.mode === "unlocked"
            ? `Clock cap reconcile: Unlocked restored on ${name} (drifted cap re-removed)`
            : `Clock cap reconcile: ${target.mhz} MHz re-applied on ${name} (drifted from the fleet target)`,
      });
    } catch (err) {
      const msg = String(err?.message || err).split("\n")[0].slice(0, 160);
      const now = Date.now();
      // Throttle: an offline node would otherwise spam one event per tick.
      if (now - (this._lastFailureEventAt.get(spark.id) ?? 0) >= RECONCILE_FAILURE_EVENT_MS) {
        this._lastFailureEventAt.set(spark.id, now);
        this._recordEvent({
          type: "gpu.clockcap.reconcile.failed",
          severity: "error",
          sparkId: spark.id,
          sparkName: spark.name,
          message: `Clock cap reconcile failed on ${spark.name || spark.id}: ${msg}`,
        });
      }
    } finally {
      this._busy.delete(spark.id);
    }
  }
}
