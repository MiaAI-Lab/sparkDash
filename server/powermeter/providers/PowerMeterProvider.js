/** History granularities a provider may offer, finest first. */
export const HISTORY_PERIODS = Object.freeze(["5minute", "hour"]);

/**
 * @typedef {object} PowerReading
 * @property {number | null} watts   null when the channel could not be read; never a fabricated 0
 * @property {number | null} atMs    when the meter itself last reported (the time of the read if it cannot say)
 * @property {string} [error]        why `watts` is null, or a warning
 *
 * @typedef {object} PowerPeriod
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} meanW          time-weighted mean over the period
 * @property {number | null} [maxW]
 *
 * @typedef {object} ReadOptions
 * @property {AbortSignal} [signal]
 *
 * @typedef {object} HistoryOptions
 * @property {number} fromMs
 * @property {number} toMs
 * @property {"5minute" | "hour"} period
 * @property {AbortSignal} [signal]
 */

/**
 * A power meter: something that reports the power drawn at an outlet — a smart plug or
 * strip, a PDU, a home-automation hub that already polls one. Subclass it once per kind of
 * meter and register the class in `providers/index.js`.
 *
 * A unit is attached to one *channel* of a meter: a provider-specific string naming one
 * outlet's power reading (a Home Assistant entity id, a Shelly switch id, a PDU outlet).
 *
 * Required: `static type`, `static label`, `readPower`. Meters that keep their own record also list
 * `static historyPeriods` and implement `readHistory`; `assertProviderClass` enforces that.
 *
 * @abstract
 */
export class PowerMeterProvider {
  /** Provider name used as `type` in power-meters.json. */
  static type = "";

  /** Name shown to people: on the Energy page, in the Activity log. */
  static label = "";

  /** Periods `readHistory` can return; empty for a live-only meter. @type {ReadonlyArray<"5minute" | "hour">} */
  static historyPeriods = Object.freeze([]);

  /**
   * Problems with a meter's entry in power-meters.json.
   * @param {Record<string, unknown>} _spec
   * @returns {string[]}
   */
  static validate(_spec) {
    return [];
  }

  /**
   * The problem with one unit's channel string, or null when it is usable.
   * @param {string} _channel
   * @returns {string | null}
   */
  static validateChannel(_channel) {
    return null;
  }

  /**
   * @param {Record<string, unknown>} spec   the validated meter entry
   * @param {object} [_deps]                 injected dependencies (env, fetch, logger…)
   * @throws when the meter cannot be used (a missing credential, say)
   */
  constructor(spec, _deps = {}) {
    if (new.target === PowerMeterProvider) throw new TypeError("PowerMeterProvider is abstract; subclass it");
    this.spec = spec;
  }

  get type() {
    return /** @type {typeof PowerMeterProvider} */ (this.constructor).type;
  }

  get label() {
    return /** @type {typeof PowerMeterProvider} */ (this.constructor).label;
  }

  get historyPeriods() {
    return /** @type {typeof PowerMeterProvider} */ (this.constructor).historyPeriods;
  }

  get supportsHistory() {
    return this.historyPeriods.length > 0;
  }

  /**
   * What to show in the UI. Never a credential.
   * @returns {{ type: string, target: string | null }}
   */
  describe() {
    return { type: this.type, target: null };
  }

  /**
   * Current reading for each channel. A channel that fails gets `watts: null` and an error;
   * the promise rejects only when the meter as a whole cannot be asked.
   * @abstract
   * @param {string[]} _channels
   * @param {ReadOptions} [_options]
   * @returns {Promise<Map<string, PowerReading>>}
   */
  async readPower(_channels, _options) {
    throw new Error(`${this.constructor.name} does not implement readPower`);
  }

  /**
   * The meter's own record for each channel over [fromMs, toMs): one entry per finished
   * period it has data for; periods without data are simply absent.
   * @param {string[]} _channels
   * @param {HistoryOptions} _options
   * @returns {Promise<Map<string, PowerPeriod[]>>}
   */
  async readHistory(_channels, _options) {
    throw new Error(`${this.constructor.name} keeps no history`);
  }

  /** Release sockets or timers on shutdown. */
  close() {}
}

/**
 * Check that a class satisfies the provider interface. Run at registration, so a broken
 * provider fails at startup rather than on its first poll.
 * @template {typeof PowerMeterProvider} T
 * @param {T} Provider
 * @returns {T}
 */
export function assertProviderClass(Provider) {
  const name = Provider?.name || String(Provider);
  if (typeof Provider !== "function" || !(Provider.prototype instanceof PowerMeterProvider)) {
    throw new TypeError(`${name} must extend PowerMeterProvider`);
  }
  if (typeof Provider.type !== "string" || !/^[a-z][a-z0-9-]*$/.test(Provider.type)) {
    throw new TypeError(`${name}.type must be a lowercase provider name`);
  }
  if (typeof Provider.label !== "string" || Provider.label.trim() === "") {
    throw new TypeError(`${name}.label must name the meter for people`);
  }
  if (Provider.prototype.readPower === PowerMeterProvider.prototype.readPower) {
    throw new TypeError(`${name} must implement readPower`);
  }
  const periods = Provider.historyPeriods;
  if (!Array.isArray(periods) || periods.some((p) => !HISTORY_PERIODS.includes(p))) {
    throw new TypeError(`${name}.historyPeriods may only contain ${HISTORY_PERIODS.join(", ")}`);
  }
  const implementsHistory = Provider.prototype.readHistory !== PowerMeterProvider.prototype.readHistory;
  if (periods.length > 0 && !implementsHistory) {
    throw new TypeError(`${name} lists historyPeriods but does not implement readHistory`);
  }
  if (periods.length === 0 && implementsHistory) {
    throw new TypeError(`${name} implements readHistory but lists no historyPeriods`);
  }
  return Provider;
}
