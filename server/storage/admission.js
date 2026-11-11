/**
 * Admission control for Storage Manager work: one place that decides what may start.
 *
 * - Per Spark, one piece of storage work at a time: a heavy job (a scan, later surveys and hashing) or a
 *   change (delete, Docker removal). Changes are exclusive; nothing heavy runs beside them either.
 * - Across the fleet (every Spark this dashboard process manages), at most `fleetHeavy` heavy jobs at once.
 * - The unit-side lock (unit-state.sh) is the second half: it keeps a second dashboard from overlapping.
 *
 * A slot is held until its holder releases it. A scan keeps its slot until its processes are confirmed gone
 * on the unit, not merely until the dashboard stopped waiting for it.
 */

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

/** @typedef {"heavy" | "mutation"} WorkKind */
/**
 * @typedef {{ kind: WorkKind, label: string, since: number,
 *   refusal?: () => { status?: number, code: string, message: string } | null }} Holder
 *   `refusal`: what to answer someone who wants the Spark while this holder has it (defaults by kind).
 */

export class AdmissionController {
  /** @param {{ fleetHeavy?: number, now?: () => number }} [opts] */
  constructor({ fleetHeavy = 2, now = Date.now } = {}) {
    this._fleetHeavy = fleetHeavy;
    this._now = now;
    /** @type {Map<string, Holder>} */
    this._held = new Map();
  }

  /** The current holder of a Spark, or null. */
  holder(sparkId) {
    return this._held.get(sparkId) ?? null;
  }

  /** Heavy jobs running across the fleet. */
  heavyCount() {
    let n = 0;
    for (const h of this._held.values()) if (h.kind === "heavy") n += 1;
    return n;
  }

  /**
   * Take the Spark's slot or throw the reason it is not free. The returned release is idempotent.
   * @param {string} sparkId
   * @param {{ kind: WorkKind, label?: string, refusal?: Holder["refusal"] }} work
   * @returns {{ release: () => void }}
   */
  admit(sparkId, { kind, label = kind, refusal }) {
    if (kind !== "heavy" && kind !== "mutation") throw new Error(`unknown work kind: ${kind}`);
    const held = this._held.get(sparkId);
    if (held) throw this._refuse(held);
    if (kind === "heavy" && this.heavyCount() >= this._fleetHeavy) {
      throw httpError(
        429,
        `${this._fleetHeavy} scans are already running on other Sparks. Try again when one of them finishes.`,
        "fleet-busy"
      );
    }
    const holder = { kind, label, since: this._now(), refusal };
    this._held.set(sparkId, holder);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (this._held.get(sparkId) === holder) this._held.delete(sparkId);
      },
    };
  }

  _refuse(held) {
    const custom = held.refusal?.();
    if (custom) return httpError(custom.status ?? 409, custom.message, custom.code);
    return held.kind === "heavy"
      ? httpError(409, "A scan is still running on this Spark. Wait for it to finish or stop it first.", "scan-running")
      : httpError(409, "Another change is still running on this Spark", "busy");
  }
}
