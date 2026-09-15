/**
 * AutoPowerManager — idle shutdown + scheduled wake for the spark fleet.
 *
 * Mirrors ModelScheduler's design constraints:
 *  - Injected clock: `runTick(nowMs)` takes the instant; all the interesting
 *    logic (wrap-around watch windows, weekday/weekend, DST, wake dedup) is
 *    unit-testable without waiting for 22:00.
 *  - Explicit time zone (AUTOPOWER_TZ) — a DST shift must never move the
 *    night shift by an hour.
 *  - Never paused by browser-tab state; the night shift runs headless.
 *  - `enabled: false` makes the whole thing inert: no probes, no actions.
 *
 * Decision per tick:
 *   resolve dayType + clock
 *     ├─ disabled                                   → stand down
 *     ├─ wake time reached (grace, once per day)    → WoL the offline sparks
 *     ├─ probe busy (streams/requests/slots/tickets/plans > 0,
 *     │  or a source unreachable)                   → reset the idle timer
 *     └─ idle
 *         ├─ outside the watch span                 → just count
 *         ├─ inside, idle < timeout                 → watching
 *         └─ inside, idle ≥ timeout, spark online   → shut the sparks down
 *
 * Unknown == busy: an unreachable proxy or engine never counts as idle.
 * Note the AI proxy lives ON spark1 — once that spark is off the proxy
 * source goes unreachable, which keeps the manager busy until the wake.
 */
import fs from "fs";
import { atomicWrite } from "../util/atomicWrite.js";
import { AUTOPOWER_STATE_PATH, AUTOPOWER_TZ, AUTOPOWER_TICK_MS } from "../config.js";
import { zonedParts, zonedMinuteToEpoch, parseClock } from "../../src/shared/modelSchedules.js";
import { resolveWatchWindow } from "../../src/shared/autopowerSchedules.js";
import { busyReasons } from "./probe.js";

/** A scheduled wake fires within this window after its exact minute. */
const WAKE_FIRE_GRACE_MS = 15 * 60_000;
/** Default state file (config volume); tests inject their own. */
const STATE_PATH = AUTOPOWER_STATE_PATH;
/** Worker before head: the proxy runs on the head, so it goes last. */
function shutdownOrder(sparks) {
  return [...sparks].sort((a, b) => (a.role === "head" ? 1 : 0) - (b.role === "head" ? 1 : 0));
}

/** Head before worker for the same reason, reversed for wake. */
function wakeOrder(sparks) {
  return [...sparks].sort((a, b) => (b.role === "head" ? 1 : 0) - (a.role === "head" ? 1 : 0));
}

export class AutoPowerManager {
  /**
   * @param {object} deps
   * @param {() => Promise<object>} deps.probe autoPowerProbe() — source snapshot
   * @param {() => object[]} deps.getSparks target sparks (kind=spark, remote)
   * @param {(id: string) => boolean} deps.isOnline liveness from the monitors
   * @param {(spark: object) => Promise<string>} deps.shutdownSpark
   * @param {(spark: object) => Promise<object>} deps.wakeSpark
   * @param {(id: string, kind: "wake"|"shutdown") => void} [deps.onAction]
   * @param {() => object} deps.getConfig
   * @param {(msg: string) => void} [deps.log]
   * @param {string} [deps.statePath]
   * @param {string} [deps.tz]
   */
  constructor(deps) {
    this.probe = deps.probe;
    this.getSparks = deps.getSparks || (() => []);
    this.isOnline = deps.isOnline || (() => false);
    this.shutdownSpark = deps.shutdownSpark;
    this.wakeSpark = deps.wakeSpark;
    this.onAction = deps.onAction || (() => {});
    this.getConfig = deps.getConfig;
    this.log = deps.log || ((m) => console.log(`[AutoPower] ${m}`));
    this.statePath = deps.statePath || STATE_PATH;
    this.tz = deps.tz || AUTOPOWER_TZ;
    /** @type {ReturnType<typeof setInterval>|null} */
    this._timer = null;
    /** @type {Promise<void>|null} in-flight tick, so ticks never overlap */
    this._running = null;
    /** @type {object|null} latest probe snapshot (memory only) */
    this._sources = null;
    this._state = {
      idleSince: null,
      lastBusyAt: null,
      lastBusyReason: null,
      lastShutdownAt: null,
      lastWakeFiredFor: null,
      lastAction: null,
      lastDecision: null,
    };
    this._loadState();
  }

  // ─── Lifecycle ──────────────────────────────────────────
  start(tickMs = AUTOPOWER_TICK_MS) {
    if (this._timer) return;
    this._timer = setInterval(() => {
      void this.runTick();
    }, tickMs);
    if (typeof this._timer.unref === "function") this._timer.unref();
    this.log(`armed (tick ${Math.round(tickMs / 1000)}s, tz ${this.tz})`);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** Run one tick, serialized. Returns the decision (or null when inert). */
  async runTick(nowMs = Date.now()) {
    if (this._running) return this._running.then(() => this._state.lastDecision);
    this._running = this._tick(nowMs).finally(() => {
      this._running = null;
    });
    return this._running;
  }

  // ─── The tick ───────────────────────────────────────────
  async _tick(nowMs) {
    const cfg = this.getConfig();
    if (!cfg?.enabled) {
      return this._decide("disabled", "AutoPower is disabled");
    }
    const tz = cfg.tz || this.tz;
    const parts = zonedParts(nowMs, tz);

    // 1) Auto-wake: fires in a short grace after its exact minute, once per day.
    const wakeEpoch = this._wakeDue(cfg, parts, nowMs);
    if (wakeEpoch != null) return this._fireWake(cfg, wakeEpoch, nowMs);

    // 2) Idle tracking.
    const sources = await this.probe();
    this._sources = sources;
    const reasons = busyReasons(sources);

    if (reasons.length) {
      if (this._state.idleSince != null) {
        this._state.idleSince = null;
        this._saveState();
      }
      this._state.lastBusyAt = nowMs;
      this._state.lastBusyReason = reasons.join("; ");
      return this._decide("busy", this._state.lastBusyReason);
    }

    if (this._state.idleSince == null) {
      this._state.idleSince = nowMs;
      this._saveState();
    }
    const idleMs = nowMs - this._state.idleSince;
    const timeoutMs = (cfg.idleTimeoutMin || 30) * 60_000;
    const active = resolveWatchWindow(cfg, parts.dayType, parts.minute);

    if (!active) {
      return this._decide(
        "idle",
        `Idle ${fmtMin(idleMs)}, outside the ${parts.dayType} watch window`
      );
    }
    if (idleMs < timeoutMs) {
      return this._decide(
        "watching",
        `Idle ${fmtMin(idleMs)} / ${cfg.idleTimeoutMin} min within ${active.label}`
      );
    }
    const online = shutdownOrder(this.getSparks()).filter((s) => this.isOnline(s.id));
    if (!online.length) {
      return this._decide(
        "watching",
        `Idle ≥ ${cfg.idleTimeoutMin} min within ${active.label} — all Sparks already off`
      );
    }
    return this._fireShutdown(cfg, active, online, nowMs);
  }

  // ─── Actions ────────────────────────────────────────────
  async _fireShutdown(cfg, window, targets, nowMs) {
    const reason = `Idle ≥ ${cfg.idleTimeoutMin} min within ${window.label}`;
    const results = [];
    for (const spark of targets) {
      try {
        const message = await this.shutdownSpark(spark);
        results.push({ id: spark.id, ok: true, message: typeof message === "string" ? message : "ok" });
        this.onAction(spark.id, "shutdown");
      } catch (err) {
        const msg = err?.message || String(err);
        this.log(`shutdown ${spark.id} failed: ${msg}`);
        results.push({ id: spark.id, ok: false, error: msg });
      }
    }
    this._state.lastAction = { at: nowMs, kind: "shutdown", results, reason };
    // Restart the idle timer: a partially failed sweep retries after another
    // full idle span instead of hammering the failing host every tick.
    this._state.idleSince = null;
    this._state.lastShutdownAt = nowMs;
    this._saveState();
    const ok = results.filter((r) => r.ok).length;
    this.log(`${reason} → shutdown issued to ${ok}/${results.length} Spark(s)`);
    return this._decide("shutdown", reason, true);
  }

  async _fireWake(cfg, wakeEpoch, nowMs) {
    const reason = `Scheduled wake ${formatClockOf(wakeEpoch, cfg.tz || this.tz)}`;
    const offline = wakeOrder(this.getSparks()).filter((s) => !this.isOnline(s.id));
    this._state.lastWakeFiredFor = wakeEpoch;
    if (!offline.length) {
      this._state.lastAction = { at: nowMs, kind: "wake", results: [], reason: `${reason} — all already online` };
      this._saveState();
      return this._decide("wake-skip", `${reason} — all Sparks already online`, true);
    }
    const results = [];
    for (const spark of offline) {
      try {
        const sent = await this.wakeSpark(spark);
        results.push({ id: spark.id, ok: true, mac: sent?.mac ?? null });
        this.onAction(spark.id, "wake");
      } catch (err) {
        const msg = err?.message || String(err);
        this.log(`wake ${spark.id} failed: ${msg}`);
        results.push({ id: spark.id, ok: false, error: msg });
      }
    }
    this._state.lastAction = { at: nowMs, kind: "wake", results, reason };
    // A woken fleet must not look idle-shutdownable while it boots: re-time the
    // idle counter from the wake.
    this._state.idleSince = null;
    this._saveState();
    const ok = results.filter((r) => r.ok).length;
    this.log(`${reason} → WoL issued to ${ok}/${results.length} Spark(s)`);
    return this._decide("wake", reason, true);
  }

  /**
   * Epoch of a wake due at this instant, or null. Fires only within
   * WAKE_FIRE_GRACE_MS of the scheduled minute (a server that missed it fires
   * late — one much later than that should NOT suddenly blast WoL), and only
   * once per scheduled slot (persisted, so a restart cannot double-fire).
   */
  _wakeDue(cfg, parts, nowMs) {
    const clock = parseClock(cfg.wake?.[parts.dayType]);
    if (clock == null) return null;
    const [y, mo, d] = parts.dateKey.split("-").map(Number);
    const epoch = Date.UTC(y, mo - 1, d) + clock * 60_000 - parts.offsetMin * 60_000;
    if (nowMs < epoch || nowMs - epoch > WAKE_FIRE_GRACE_MS) return null;
    if (this._state.lastWakeFiredFor === epoch) return null;
    return epoch;
  }

  // ─── Status (polled route — live values allowed here) ───
  statusBlock(nowMs = Date.now()) {
    const cfg = this.getConfig();
    const tz = cfg?.tz || this.tz;
    const parts = zonedParts(nowMs, tz);
    const window = resolveWatchWindow(cfg, parts.dayType, parts.minute);
    const idleMs = this._state.idleSince != null ? nowMs - this._state.idleSince : null;
    const timeoutMs = (cfg?.idleTimeoutMin || 30) * 60_000;
    const wakeClock = parseClock(cfg?.wake?.[parts.dayType]);
    return {
      config: cfg,
      dayType: parts.dayType,
      clock: fmtClock(parts.minute),
      watching: Boolean(window),
      window: window ? { start: window.start, end: window.end, label: window.label } : null,
      targets: this.getSparks().map((s) => ({
        id: s.id,
        name: s.name,
        online: Boolean(this.isOnline(s.id)),
      })),
      sources: this._sources,
      idleSince: this._state.idleSince,
      idleMin: idleMs == null ? null : Math.floor(idleMs / 60_000),
      shutdownInMs:
        idleMs == null ? null : Math.max(0, timeoutMs - idleMs),
      lastBusyAt: this._state.lastBusyAt,
      lastBusyReason: this._state.lastBusyReason,
      lastShutdownAt: this._state.lastShutdownAt,
      // Absolute epoch ms of the next auto-wake (stable between firings).
      nextWakeAt: wakeClock == null ? null : zonedMinuteToEpoch(nowMs, tz, wakeClock),
      lastAction: this._state.lastAction,
      lastDecision: this._state.lastDecision,
    };
  }

  // ─── Persistence ────────────────────────────────────────
  _decide(action, reason, forceSave = false) {
    const prev = this._state.lastDecision?.action;
    this._state.lastDecision = { action, reason };
    if (forceSave || action !== prev) this._saveState();
    return this._state.lastDecision;
  }

  _loadState() {
    try {
      const data = JSON.parse(fs.readFileSync(this.statePath, "utf-8"));
      if (data && typeof data === "object") {
        for (const key of Object.keys(this._state)) {
          if (data[key] !== undefined) this._state[key] = data[key];
        }
      }
    } catch {
      /* fresh state */
    }
  }

  _saveState() {
    try {
      atomicWrite(this.statePath, JSON.stringify(this._state, null, 2) + "\n", 0o644);
    } catch (err) {
      this.log(`failed to save state: ${err?.message || err}`);
    }
  }
}

function fmtMin(ms) {
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function fmtClock(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function formatClockOf(epochMs, tz) {
  return fmtClock(zonedParts(epochMs, tz).minute);
}
