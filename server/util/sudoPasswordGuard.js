/**
 * Brute-force brake for sudo passwords typed in the dashboard. Wrong guesses are counted per
 * account on the machine (not per registry entry) and across all units, so a second entry for
 * the same machine does not reset the budget. After too many, further attempts are refused for a while.
 */
const PASSWORD_ATTEMPTS = 3;
const PASSWORD_LOCK_MS = 5 * 60_000;
/** Across all units. */
const PASSWORD_ATTEMPTS_GLOBAL = 9;

export class SudoPasswordGuard {
  /** @param {{ now?: () => number }} [opts] */
  constructor({ now = Date.now } = {}) {
    this._now = now;
    /** @type {Map<string, { n: number, until: number }>} */
    this._fails = new Map();
  }

  /** What a password is a guess against: the account on the machine, not the registry entry. */
  key(spark) {
    if (spark.isLocal) return "local";
    const ssh = spark.ssh || {};
    return `${ssh.user || ""}@${ssh.host || spark.lanIp || spark.id}:${ssh.port || 22}`.toLowerCase();
  }

  /** @returns {number} seconds left on the lock, 0 when attempts are allowed */
  lockedForSeconds(spark) {
    const now = this._now();
    const f = [this._fails.get(this.key(spark)), this._fails.get("*")]
      .filter((x) => x && x.until > now)
      .sort((x, y) => y.until - x.until)[0];
    return f ? Math.ceil((f.until - now) / 1000) : 0;
  }

  _bump(key, limit) {
    const f = this._fails.get(key) ?? { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= limit) {
      f.until = this._now() + PASSWORD_LOCK_MS;
      f.n = 0;
    }
    this._fails.set(key, f);
  }

  /** Record the outcome of an attempt: a right password clears the account's count, a wrong one adds to it. */
  note(spark, wrong) {
    const key = this.key(spark);
    if (!wrong) return void this._fails.delete(key);
    this._bump(key, PASSWORD_ATTEMPTS);
    this._bump("*", PASSWORD_ATTEMPTS_GLOBAL);
  }
}
