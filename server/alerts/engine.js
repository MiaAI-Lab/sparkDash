/**
 * Alert notifications — the timing layer on top of what sparkDash already
 * detects.
 *
 * How this coexists with HealthEvaluator and the Activity log (2.0):
 *   - Detection stays where it is. The conditions are HealthEvaluator's
 *     findings (snapshot.health) and the Overview strip's exceptions
 *     (src/shared/fleetExceptions.js); see conditions.js. Nothing here has a
 *     threshold of its own, so the Health chips, the strip and a notification
 *     always agree on what is wrong.
 *   - The Activity log keeps recording what happened (SparkMonitor writes
 *     health.*, spark.offline/online, gpu.throttle.* events as before). This
 *     layer adds only what it does itself: one `alert.notify.sent` or
 *     `alert.notify.failed` event per channel per notification, with no URL and
 *     no response body.
 *   - What this adds is delivery: a condition must hold for its `for` before it
 *     fires, and stay clear for the same `for` (at least MIN_CLEAR_MS) before it
 *     resolves; everything that changes in one evaluation goes out as one
 *     message; optional reminders while firing; and the firing set survives a
 *     restart, so a notification is not repeated and a duration does not reset.
 *
 *   inactive ──condition true──▶ pending ──true for `for`──▶ firing
 *       ▲                          │                           │
 *       └──────condition false─────┘    false for `for` ──▶ resolved
 *
 * A pending alert that goes false is dropped silently (it never fired). Severity
 * changes (warning ⇄ critical) also have to hold for `for`; an escalation to a
 * severity not yet notified sends a fresh "firing" message.
 *
 * `evaluate()` is synchronous and never throws into the caller; notifications
 * are dispatched without awaiting.
 */
import { collectConditions, effectiveRuleConfig, ruleName, severityRank } from "./conditions.js";
import { MAX_NAME_CHARS, capText } from "./text.js";

export const HISTORY_LIMIT = 200;
/** A firing alert resolves only after this much clear time, even with `for` 0. */
export const MIN_CLEAR_MS = 30_000;
/** Rewrite the firing set this often while non-empty, so its age is provable. */
const STATE_HEARTBEAT_MS = 5 * 60_000;
/** A persisted firing set older than this is too stale to resume from. */
export const STATE_MAX_AGE_MS = 15 * 60_000;

const keyOf = (unitId, ruleId) => `${unitId}:${ruleId}`;

export class AlertEngine {
  /**
   * @param {{
   *   now?: () => number,
   *   getConfig: () => { repeatIntervalMin: number, rules: object, channels: object[] },
   *   notifier?: { dispatch: (channels: object[], group: object) => Promise<unknown> } | null,
   *   persistState?: ((state: object) => void) | null,
   *   log?: Pick<Console, "error" | "warn">,
   * }} opts
   */
  constructor(opts) {
    this._now = opts.now || Date.now;
    this._getConfig = opts.getConfig;
    this._notifier = opts.notifier || null;
    this._persistState = opts.persistState || null;
    this._log = opts.log || console;
    /** @type {Map<string, object>} key → alert (pending or firing) */
    this._alerts = new Map();
    /** Newest first. */
    this._history = [];
    this._historySeq = 0;
    this._lastPersistAt = 0;
    this._dirty = false;
  }

  // ─── State restore / persist ────────────────────────────

  /**
   * Resume the firing set saved before a restart, when the save is recent
   * enough to trust. Restored alerts keep firing without a new notification and
   * resolve through the normal hysteresis if the condition is gone.
   */
  restore(state) {
    if (!state || !Array.isArray(state.firing)) return 0;
    const now = this._now();
    if (!Number.isFinite(state.savedAt) || now - state.savedAt > STATE_MAX_AGE_MS) return 0;
    let n = 0;
    for (const a of state.firing) {
      if (!a || typeof a.unitId !== "string" || typeof a.ruleId !== "string" || !Number.isFinite(a.startsAt)) continue;
      if (!/^[a-z0-9-]{1,40}$/.test(a.ruleId)) continue;
      const severity = a.severity === "critical" ? "critical" : "warning";
      const key = keyOf(a.unitId, a.ruleId);
      this._alerts.set(key, {
        key,
        ruleId: a.ruleId,
        ruleName: ruleName(a.ruleId, a.ruleName),
        unitId: a.unitId,
        unitName: capText(a.unitName || a.unitId, MAX_NAME_CHARS),
        severity,
        peakSeverity: a.peakSeverity === "critical" ? "critical" : severity,
        notifiedSeverity: a.notifiedSeverity === "critical" ? "critical" : severity,
        label: capText(a.label),
        summary: capText(a.summary),
        state: "firing",
        startsAt: a.startsAt,
        firingAt: Number.isFinite(a.firingAt) ? a.firingAt : a.startsAt,
        falseSince: null,
        changeSince: null,
        lastNotifiedAt: Number.isFinite(a.lastNotifiedAt) ? a.lastNotifiedAt : now,
      });
      n += 1;
    }
    return n;
  }

  /** The firing set in its persisted shape. */
  stateForSave() {
    return {
      savedAt: this._now(),
      firing: [...this._alerts.values()]
        .filter((a) => a.state === "firing")
        .map((a) => ({
          ruleId: a.ruleId,
          ruleName: a.ruleName,
          unitId: a.unitId,
          unitName: a.unitName,
          severity: a.severity,
          peakSeverity: a.peakSeverity,
          notifiedSeverity: a.notifiedSeverity,
          label: a.label,
          summary: a.summary,
          startsAt: a.startsAt,
          firingAt: a.firingAt,
          lastNotifiedAt: a.lastNotifiedAt,
        })),
    };
  }

  _maybePersist() {
    if (!this._persistState) return;
    const now = this._now();
    const firing = [...this._alerts.values()].some((a) => a.state === "firing");
    const heartbeat = firing && now - this._lastPersistAt >= STATE_HEARTBEAT_MS;
    if (!this._dirty && !heartbeat) return;
    try {
      this._persistState(this.stateForSave());
      this._dirty = false;
      this._lastPersistAt = now;
    } catch (err) {
      this._log.error?.(`[alerts] failed to save alert state: ${err.message}`);
    }
  }

  // ─── Evaluation ─────────────────────────────────────────

  /**
   * Run over the fleet once. Returns the group it dispatched
   * (`{ firing, resolved, reminders }`), for tests.
   * @param {object[]} units SparkMonitor snapshots in tab order
   */
  evaluate(units) {
    const now = this._now();
    const config = this._getConfig();
    const fired = [];
    const resolved = [];
    const list = Array.isArray(units) ? units : [];
    const unitIds = new Set();
    const cfgCache = new Map();
    const cfgFor = (ruleId) => {
      if (!cfgCache.has(ruleId)) cfgCache.set(ruleId, effectiveRuleConfig(ruleId, config.rules?.[ruleId]));
      return cfgCache.get(ruleId);
    };

    for (const unit of list) {
      if (!unit?.id) continue;
      unitIds.add(unit.id);
      let result;
      try {
        result = collectConditions(unit);
      } catch (err) {
        this._log.error?.(`[alerts] could not read ${unit.id}: ${err?.message}`);
        continue;
      }
      const trueKeys = new Set();
      for (const c of result.conditions) {
        const cfg = cfgFor(c.ruleId);
        if (!cfg.enabled) continue;
        const key = keyOf(unit.id, c.ruleId);
        trueKeys.add(key);
        this._conditionTrue(key, unit, c, cfg.forSec * 1000, now, fired);
      }
      for (const a of [...this._alerts.values()]) {
        if (a.unitId !== unit.id || trueKeys.has(a.key)) continue;
        const cfg = cfgFor(a.ruleId);
        // Turning a rule off ends its alerts now.
        if (!cfg.enabled) this._end(a, now, resolved, "rule turned off");
        else if (result.judged(a.ruleId)) this._conditionFalse(a, cfg.forSec * 1000, now, resolved);
      }
    }

    // Units removed from the fleet: their alerts end now.
    for (const a of [...this._alerts.values()]) {
      if (!unitIds.has(a.unitId)) this._end(a, now, resolved, "unit removed");
    }

    // Repeat reminders for alerts still firing.
    const reminders = [];
    const repeatMs = (Number(config.repeatIntervalMin) || 0) * 60_000;
    if (repeatMs > 0) {
      for (const a of this._alerts.values()) {
        if (a.state !== "firing" || fired.includes(a)) continue;
        if (now - a.lastNotifiedAt >= repeatMs) {
          a.lastNotifiedAt = now;
          reminders.push(a);
          this._dirty = true;
        }
      }
    }

    const group = { firing: fired.map((a) => this._public(a)), resolved, reminder: false };
    if (this._notifier && (group.firing.length || group.resolved.length)) {
      this._dispatch(config.channels, group);
    }
    if (this._notifier && reminders.length) {
      this._dispatch(config.channels, { firing: reminders.map((a) => this._public(a)), resolved: [], reminder: true });
    }
    this._maybePersist();
    return { ...group, reminders: reminders.map((a) => this._public(a)) };
  }

  _dispatch(channels, group) {
    try {
      Promise.resolve(this._notifier.dispatch(channels, group)).catch((err) => {
        this._log.error?.(`[alerts] notification dispatch failed: ${err?.message}`);
      });
    } catch (err) {
      this._log.error?.(`[alerts] notification dispatch failed: ${err?.message}`);
    }
  }

  _conditionTrue(key, unit, c, forMs, now, fired) {
    const severity = c.severity === "critical" ? "critical" : "warning";
    let a = this._alerts.get(key);
    if (!a) {
      a = {
        key,
        ruleId: c.ruleId,
        ruleName: c.ruleName,
        unitId: unit.id,
        unitName: capText(unit.name || unit.id, MAX_NAME_CHARS),
        severity,
        peakSeverity: severity,
        notifiedSeverity: null,
        label: c.label,
        summary: c.summary,
        state: "pending",
        startsAt: now,
        firingAt: null,
        falseSince: null,
        changeSince: null,
        lastNotifiedAt: 0,
      };
      this._alerts.set(key, a);
    }
    a.unitName = capText(unit.name || unit.id, MAX_NAME_CHARS);
    a.label = c.label;
    a.summary = c.summary;
    a.falseSince = null;

    if (a.state === "pending") {
      a.severity = severity;
      if (now - a.startsAt >= forMs) {
        a.state = "firing";
        a.firingAt = now;
        a.peakSeverity = severity;
        a.notifiedSeverity = severity;
        a.lastNotifiedAt = now;
        this._record("firing", a, now);
        fired.push(a);
        this._dirty = true;
      }
      return;
    }

    // Firing: a severity change must hold for `for` too.
    if (severity === a.severity) {
      a.changeSince = null;
      return;
    }
    if (a.changeSince == null) a.changeSince = now;
    if (now - a.changeSince < forMs) return;
    a.severity = severity;
    a.changeSince = null;
    this._dirty = true;
    if (severityRank(severity) > severityRank(a.peakSeverity)) a.peakSeverity = severity;
    if (severityRank(severity) > severityRank(a.notifiedSeverity)) {
      a.notifiedSeverity = severity;
      a.lastNotifiedAt = now;
      this._record("firing", a, now);
      fired.push(a);
    }
  }

  _conditionFalse(a, forMs, now, resolved) {
    if (a.state === "pending") {
      this._alerts.delete(a.key);
      return;
    }
    a.changeSince = null;
    if (a.falseSince == null) a.falseSince = now;
    if (now - a.falseSince >= Math.max(forMs, MIN_CLEAR_MS)) this._end(a, now, resolved, null);
  }

  /** Remove an alert; a firing one is recorded and notified as resolved. */
  _end(a, now, resolved, reason) {
    this._alerts.delete(a.key);
    if (a.state !== "firing") return;
    const endsAt = a.falseSince ?? now;
    const pub = { ...this._public(a), status: "resolved", endsAt, ...(reason ? { reason } : {}) };
    if (reason) pub.summary = capText(`${a.summary} (${reason})`);
    this._record("resolved", a, now, endsAt, reason);
    resolved.push(pub);
    this._dirty = true;
  }

  _record(status, a, now, endsAt = null, reason = null) {
    this._history.unshift({
      id: ++this._historySeq,
      at: now,
      status,
      key: a.key,
      ruleId: a.ruleId,
      ruleName: a.ruleName,
      unitId: a.unitId,
      unitName: a.unitName,
      severity: a.severity,
      label: a.label,
      summary: reason ? capText(`${a.summary} (${reason})`) : a.summary,
      startsAt: a.startsAt,
      endsAt,
    });
    if (this._history.length > HISTORY_LIMIT) this._history.length = HISTORY_LIMIT;
  }

  _public(a) {
    return {
      key: a.key,
      ruleId: a.ruleId,
      ruleName: a.ruleName,
      unitId: a.unitId,
      unitName: a.unitName,
      severity: a.severity,
      peakSeverity: a.peakSeverity,
      state: a.state,
      label: a.label,
      summary: a.summary,
      startsAt: a.startsAt,
      firingAt: a.firingAt,
      endsAt: null,
      status: "firing",
    };
  }

  // ─── Read side ──────────────────────────────────────────

  /** Firing alerts, critical first then oldest first. */
  active() {
    return [...this._alerts.values()]
      .filter((a) => a.state === "firing")
      .sort((x, y) => severityRank(y.severity) - severityRank(x.severity) || x.startsAt - y.startsAt)
      .map((a) => this._public(a));
  }

  pending() {
    return [...this._alerts.values()].filter((a) => a.state === "pending").map((a) => this._public(a));
  }

  recent(limit = HISTORY_LIMIT) {
    return this._history.slice(0, limit);
  }

  /**
   * Forget the live alerts (alerts switched off). Writes nothing now; the next
   * evaluation — which only runs once alerts are on again — saves the empty set
   * so a later restart does not resume what was firing before the switch-off.
   */
  reset() {
    this._alerts.clear();
    this._dirty = true;
  }
}
