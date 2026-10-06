/**
 * Alert rule engine — Prometheus-style `for:` timing with hysteresis.
 *
 *   inactive ──condition true──▶ pending ──true for `for`──▶ firing
 *       ▲                          │                           │
 *       └──────condition false─────┘    false for `for` ──▶ resolved
 *
 * A pending alert that goes false is dropped silently (it never fired). A
 * firing alert resolves only after its condition has stayed false for the same
 * `for` duration, so a value hovering on a threshold does not page on every
 * crossing. Severity changes (warning ⇄ critical) also have to hold for `for`;
 * an escalation to a severity not yet notified sends a fresh "firing" message.
 *
 * `evaluate()` is synchronous and never throws into the caller: rule errors
 * are caught per rule, and notifications are dispatched without awaiting.
 */
import { RULES, effectiveRuleConfig, severityRank } from "./rules.js";

export const HISTORY_LIMIT = 200;
/** Rewrite the firing set this often while non-empty, so its age is provable. */
const STATE_HEARTBEAT_MS = 5 * 60_000;
/** A persisted firing set older than this is too stale to resume from. */
export const STATE_MAX_AGE_MS = 15 * 60_000;

function keyOf(ruleId, unitId, sub) {
  return sub ? `${ruleId}:${unitId}:${sub}` : `${ruleId}:${unitId}`;
}

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
    /** `${unitId}:${port}` endpoints seen available since start (llm_unavailable). */
    this._seenEndpoints = new Set();
    this._lastPersistAt = 0;
    this._dirty = false;
    this._ruleErrorsLogged = new Set();
  }

  // ─── State restore / persist ────────────────────────────

  /**
   * Resume the firing set saved before a restart. Entries are kept only when
   * the save is recent enough to trust; they continue firing (no new
   * notification) and resolve through the normal hysteresis if the condition
   * is gone.
   */
  restore(state) {
    if (!state || !Array.isArray(state.firing)) return 0;
    const now = this._now();
    if (!Number.isFinite(state.savedAt) || now - state.savedAt > STATE_MAX_AGE_MS) return 0;
    let n = 0;
    for (const a of state.firing) {
      if (!a || typeof a.key !== "string" || !Number.isFinite(a.startsAt)) continue;
      if (!RULES.some((r) => r.id === a.ruleId)) continue;
      this._alerts.set(a.key, {
        key: a.key,
        ruleId: a.ruleId,
        ruleName: a.ruleName,
        unitId: a.unitId,
        unitName: a.unitName,
        sub: a.sub || "",
        severity: a.severity === "critical" ? "critical" : "warning",
        peakSeverity: a.peakSeverity === "critical" ? "critical" : a.severity === "critical" ? "critical" : "warning",
        notifiedSeverity: a.notifiedSeverity || a.severity,
        summary: String(a.summary || ""),
        value: a.value ?? null,
        state: "firing",
        startsAt: a.startsAt,
        firingAt: Number.isFinite(a.firingAt) ? a.firingAt : a.startsAt,
        falseSince: null,
        changeSince: null,
        lastNotifiedAt: Number.isFinite(a.lastNotifiedAt) ? a.lastNotifiedAt : now,
      });
      if (a.ruleId === "llm_unavailable" && a.sub) this._seenEndpoints.add(`${a.unitId}:${a.sub}`);
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
          key: a.key,
          ruleId: a.ruleId,
          ruleName: a.ruleName,
          unitId: a.unitId,
          unitName: a.unitName,
          sub: a.sub,
          severity: a.severity,
          peakSeverity: a.peakSeverity,
          notifiedSeverity: a.notifiedSeverity,
          summary: a.summary,
          value: a.value,
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
   * Run every enabled rule over the fleet. Returns the notification group
   * (`{ firing, resolved, reminder }`) it dispatched, for tests.
   * @param {object[]} units SparkMonitor snapshots in tab order
   */
  evaluate(units) {
    const now = this._now();
    const config = this._getConfig();
    const fired = [];
    const resolved = [];
    const list = Array.isArray(units) ? units : [];
    const unitIds = new Set(list.map((u) => u?.id));
    const ctx = {
      markSeen: (unitId, sub) => this._seenEndpoints.add(`${unitId}:${sub}`),
      wasSeen: (unitId, sub) => this._seenEndpoints.has(`${unitId}:${sub}`),
    };

    for (const rule of RULES) {
      const cfg = effectiveRuleConfig(rule, config.rules?.[rule.id]);
      const forMs = Math.max(0, (Number(cfg.forSec) || 0) * 1000);
      if (!cfg.enabled) {
        // Turning a rule off ends its alerts now.
        for (const a of [...this._alerts.values()]) {
          if (a.ruleId === rule.id) this._end(a, now, resolved, "rule disabled");
        }
        continue;
      }
      for (const unit of list) {
        if (!unit?.id) continue;
        let conditions;
        try {
          conditions = rule.evaluate(unit, cfg, ctx);
        } catch (err) {
          const tag = `${rule.id}:${err?.message}`;
          if (!this._ruleErrorsLogged.has(tag)) {
            this._ruleErrorsLogged.add(tag);
            this._log.error?.(`[alerts] rule ${rule.id} failed on ${unit.id}: ${err?.message}`);
          }
          conditions = null;
        }
        // null = cannot judge right now: hold every alert of this rule + unit.
        if (conditions == null) continue;
        const trueKeys = new Set();
        for (const c of conditions) {
          const key = keyOf(rule.id, unit.id, c.sub);
          trueKeys.add(key);
          this._conditionTrue(key, rule, unit, c, forMs, now, fired);
        }
        for (const a of [...this._alerts.values()]) {
          if (a.ruleId !== rule.id || a.unitId !== unit.id || trueKeys.has(a.key)) continue;
          this._conditionFalse(a, forMs, now, resolved);
        }
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

  _conditionTrue(key, rule, unit, c, forMs, now, fired) {
    const severity = c.severity === "critical" ? "critical" : "warning";
    let a = this._alerts.get(key);
    if (!a) {
      a = {
        key,
        ruleId: rule.id,
        ruleName: rule.name,
        unitId: unit.id,
        unitName: unit.name || unit.id,
        sub: c.sub || "",
        severity,
        peakSeverity: severity,
        notifiedSeverity: null,
        summary: c.summary,
        value: c.value ?? null,
        state: "pending",
        startsAt: now,
        firingAt: null,
        falseSince: null,
        changeSince: null,
        lastNotifiedAt: 0,
      };
      this._alerts.set(key, a);
    }
    a.unitName = unit.name || unit.id;
    a.summary = c.summary;
    a.value = c.value ?? null;
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
    if (now - a.falseSince >= forMs) this._end(a, now, resolved, null);
  }

  /** Remove an alert; a firing one is recorded and notified as resolved. */
  _end(a, now, resolved, reason) {
    this._alerts.delete(a.key);
    if (a.state !== "firing") return;
    const endsAt = a.falseSince ?? now;
    const pub = { ...this._public(a), status: "resolved", endsAt, ...(reason ? { reason } : {}) };
    if (reason) pub.summary = `${a.summary} (${reason})`;
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
      summary: reason ? `${a.summary} (${reason})` : a.summary,
      value: a.value,
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
      summary: a.summary,
      value: a.value,
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
