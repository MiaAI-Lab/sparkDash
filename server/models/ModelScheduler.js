/**
 * ModelScheduler — one model at a time, driven by per-model time windows.
 *
 * Design constraints that shaped this file:
 *
 *  - Injected clock. `tick(nowMs)` takes the instant; the timer only supplies
 *    it. All the interesting logic (wrap-around windows, weekday/weekend, DST)
 *    is therefore unit-testable without waiting for 02:00.
 *  - Explicit time zone (MODEL_SCHEDULER_TZ). Host tz would silently move the
 *    night shift by an hour at DST change, which is exactly the failure mode
 *    this panel must not have.
 *  - Manual override. When a human clicks Start/Stop, that choice wins *until
 *    the next boundary of the winning model's schedule*, then the schedule
 *    re-asserts. `override.windowKey` is the identity of the window that was
 *    active at click time; comparing it is how "until the next boundary" is
 *    decided without a countdown timer that can drift.
 *  - Deliberately NOT paused when the last browser tab closes (unlike the
 *    Spark monitors' updateClientState()). The night shift has to happen
 *    whether or not someone is looking.
 *  - `enabled: false` in the global config makes the whole thing inert: no
 *    tick work at all, so an operator can turn the automation off without
 *    deleting any schedule data.
 *
 * Decision per tick:
 *   resolve dayType + active window
 *     ├─ override still in force (same windowKey)   → stand down
 *     ├─ target model, already running              → idle (self-heal if down)
 *     ├─ target model, down                         → start it (self-heal)
 *     ├─ different model running                    → stop incumbent, then start
 *     └─ no window (gap)                            → stop whatever is running
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWrite } from "../util/atomicWrite.js";
import { SCHEDULER_JSON_PATH, MODEL_SCHEDULER_TICK_MS, MODEL_SCHEDULER_TZ } from "../config.js";
import {
  zonedParts,
  scheduleWindows,
  resolveActiveWindow,
  normalizeSchedulerConfig,
} from "../../src/shared/modelSchedules.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");
const STATE_PATH =
  process.env.MODEL_SCHEDULER_STATE_PATH ||
  path.join(ROOT, "config", "model-scheduler-state.json");

export class ModelScheduler {
  /**
   * @param {object} deps
   * @param {import("./ModelRegistry.js").ModelRegistry} deps.registry
   * @param {import("./ModelJobManager.js").ModelJobManager} deps.jobs
   * @param {() => Record<string, object>} deps.status latest probe status map
   * @param {(msg: string) => void} [deps.log]
   * @param {string} [deps.statePath]
   * @param {string} [deps.tz]
   * @param {() => {enabled:boolean, tz:string}} [deps.getConfig] scheduler config
   *   source (the server owns it; tests inject a plain object)
   */
  constructor(deps) {
    this.registry = deps.registry;
    this.jobs = deps.jobs;
    this.status = deps.status || (() => ({}));
    this.log = deps.log || ((m) => console.log(`[ModelScheduler] ${m}`));
    this.statePath = deps.statePath || STATE_PATH;
    this.getConfig =
      deps.getConfig ||
      (() => normalizeSchedulerConfig(readJson(deps.schedulerPath || SCHEDULER_JSON_PATH)));
    this.tz = deps.tz || MODEL_SCHEDULER_TZ;
    /** @type {ReturnType<typeof setInterval>|null} */
    this._timer = null;
    /** @type {Promise<void>|null} in-flight tick, so ticks never overlap */
    this._running = null;
    /** @type {{ override: {modelId:string, windowKey:string, at:number}|null, lastDecision: object|null }} */
    this._state = { override: null, lastDecision: null };
    this._loadState();
  }

  // ─── Lifecycle ──────────────────────────────────────────
  start(tickMs = MODEL_SCHEDULER_TICK_MS) {
    if (this._timer) return;
    this._timer = setInterval(() => {
      void this.runTick();
    }, tickMs);
    // Never hold the process open for the scheduler alone.
    if (typeof this._timer.unref === "function") this._timer.unref();
    this.log(`scheduler armed (tick ${Math.round(tickMs / 1000)}s, tz ${this.tz})`);
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

  // ─── Override (manual clicks) ───────────────────────────
  /**
   * Called by the API after a manual start/stop. The click wins until the next
   * boundary of the window that was active at click time.
   * @param {string|null} modelId null = manual stop of everything
   */
  noteManual(modelId, nowMs = Date.now()) {
    const cfg = this.getConfig();
    const key = this._windowKey(nowMs, cfg);
    this._state.override = modelId ? { modelId, windowKey: key } : { modelId: null, windowKey: key };
    this._saveState();
  }

  /** Clear the override so the schedule re-asserts immediately (UI "re-enable"). */
  clearOverride() {
    this._state.override = null;
    this._saveState();
  }

  /** Public status block for the WS snapshot — no Date.now() values. */
  statusBlock(nowMs = Date.now()) {
    const cfg = this.getConfig();
    if (!cfg.enabled) {
      return { enabled: false, activeModelId: null, window: null, override: null, nextBoundary: null, lastDecision: this._state.lastDecision };
    }
    const parts = zonedParts(nowMs, cfg.tz || this.tz);
    const active = this._activeWindowFor(nowMs, cfg);
    const override = this._overrideInForce(parts, active);
    const nextChange = this._nextScheduleChange(nowMs, cfg, active);
    return {
      enabled: true,
      tz: cfg.tz || this.tz,
      dayType: parts.dayType,
      window: active ? { start: active.start, end: active.end, label: active.label, owner: active.owner } : null,
      activeModelId: this._targetFromWindow(active),
      // The model the schedule will switch to at the upcoming boundary (and the
      // window it owns it). Null when nothing is scheduled to take over — e.g.
      // a day window ending into an unowned gap, in which case the next model
      // is simply 'nothing'. Stable between boundaries (diff-cache safe).
      nextModelId: nextChange?.window?.owner ?? null,
      nextWindow: nextChange?.window
        ? { start: nextChange.window.start, end: nextChange.window.end, label: nextChange.window.label, owner: nextChange.window.owner }
        : null,
      // A manual click is only worth surfacing while it still holds.
      override: override ? { modelId: this._state.override.modelId } : null,
      // Absolute epoch ms of the next window boundary — stable between
      // boundaries, so the WS payload stays byte-identical between ticks and
      // the diff cache holds. The UI renders the countdown from its own clock.
      nextBoundary: nextChange
        ? { epochMs: nextChange.epochMs, clock: nextChange.clock }
        : null,
      lastDecision: this._state.lastDecision,
    };
  }

  // ─── The tick ───────────────────────────────────────────
  async _tick(nowMs) {
    const cfg = this.getConfig();
    if (!cfg.enabled) {
      this._state.lastDecision = { action: "disabled", reason: "Scheduler is disabled" };
      return this._state.lastDecision;
    }
    const tz = cfg.tz || this.tz;
    const parts = zonedParts(nowMs, tz);
    const active = this._activeWindowFor(nowMs, cfg);

    // Manual override holds until the window identity changes (i.e. the next
    // boundary), which is exactly the promised semantics.
    if (this._overrideInForce(parts, active)) {
      const d = {
        action: "override",
        reason: `Manual choice held for window ${active ? active.label : "(no window)"}`,
        modelId: this._state.override?.modelId ?? null,
      };
      this._state.lastDecision = d;
      return d;
    }
    if (this._state.override) {
      this._state.override = null;
      this._saveState();
    }

    const targetId = active ? active.owner : null;
    const models = this.registry.models;
    const statusMap = this.status() || {};
    // Only models with an *enabled* schedule are the scheduler's business.
    // A manual-only model (schedule disabled) is never started or stopped here.
    // Without this, flipping Auto on before anyone defines windows would put
    // every running model in a "gap" and stop whatever the operator is using.
    const isManaged = (m) => Boolean(m.schedule?.enabled);
    const managedRunning = models.filter((m) => isManaged(m) && statusMap[m.id]?.running);
    const unmanagedRunning = models.filter((m) => !isManaged(m) && statusMap[m.id]?.running);

    // Gap: nothing scheduled → the *managed* models all stop. Manual ones stay.
    if (!targetId) {
      if (!managedRunning.length) {
        this._state.lastDecision = { action: "idle", reason: "No window active and no managed model running" };
        return this._state.lastDecision;
      }
      const incumbent = managedRunning[0];
      const d = { action: "stop", modelId: incumbent.id, reason: `Window ended (${parts.dayType} ${fmt(parts.minute)})` };
      this._state.lastDecision = d;
      await this._enqueueStop(incumbent.id, "scheduler");
      return d;
    }

    const target = this.registry.getModel(targetId);
    if (!target) {
      const d = { action: "error", modelId: targetId, reason: "Scheduled model is no longer registered" };
      this._state.lastDecision = d;
      return d;
    }

    // A manually started model holds the GPU. Refuse to double-book it and
    // refuse to kill it either — tell the operator instead.
    if (unmanagedRunning.length) {
      const names = unmanagedRunning.map((m) => m.name || m.id);
      const d = {
        action: "blocked",
        modelId: targetId,
        blockedBy: unmanagedRunning.map((m) => m.id),
        reason: `${names.join(", ")} running without a schedule — stop it or give it a window`,
      };
      this._state.lastDecision = d;
      this.log(`cannot start ${target.name}: ${d.reason}`);
      return d;
    }

    const incumbents = managedRunning.filter((m) => m.id !== targetId);
    if (!incumbents.length) {
      if (statusMap[targetId]?.running) {
        const d = { action: "idle", modelId: targetId, reason: `${target.name} already running` };
        this._state.lastDecision = d;
        return d;
      }
      // Same model is the target but it is down → self-heal.
      const d = { action: "start", modelId: targetId, reason: `Window ${active.label} — ${target.name} not up` };
      this._state.lastDecision = d;
      await this._enqueueStart(targetId, "scheduler");
      return d;
    }

    // One-model-at-a-time: stop the incumbent(s), then start the target.
    const d = {
      action: "swap",
      modelId: targetId,
      stopping: incumbents.map((m) => m.id),
      reason: `Window ${active.label} (${parts.dayType})`,
    };
    this._state.lastDecision = d;
    for (const inc of incumbents) await this._enqueueStop(inc.id, "scheduler");
    await this._enqueueStart(targetId, "scheduler");
    return d;
  }

  // ─── Helpers ────────────────────────────────────────────
  /**
   * Start/stop through the job manager, waiting for the mutating slot to be
   * free. The job manager serializes mutating jobs globally, so "wait" here is
   * just: retry on 409 until the incumbent's job settles.
   */
  async _enqueueStop(modelId, source) {
    try {
      const r = this.jobs.start(modelId, "stop", { source });
      await this._awaitJob(r.jobId);
    } catch (err) {
      this.log(`stop ${modelId} failed: ${err?.message || err}`);
    }
  }

  async _enqueueStart(modelId, source) {
    try {
      const r = this.jobs.start(modelId, "start", { source });
      // Do NOT await: a start script tails the container logs forever, so
      // awaiting it would block the swap chain indefinitely. Readiness comes
      // from the probe; the next tick sees the model up and goes idle.
      void this._awaitJob(r.jobId);
    } catch (err) {
      this.log(`start ${modelId} failed: ${err?.message || err}`);
    }
  }

  async _awaitJob(jobId) {
    const job = this.jobs.jobs.get(jobId);
    if (!job?.done) return;
    // Bounded so a wedged script can never wedge the scheduler too.
    await Promise.race([
      job.done,
      new Promise((r) => {
        const t = setTimeout(r, 15 * 60_000);
        if (typeof t.unref === "function") t.unref();
      }),
    ]);
  }

  _windowKey(nowMs, cfg) {
    const w = this._activeWindowFor(nowMs, cfg);
    if (!w) return `gap:${zonedParts(nowMs, cfg.tz || this.tz).dayType}`;
    return `${zonedParts(nowMs, cfg.tz || this.tz).dayType}:${w.key}:${w.owner}`;
  }

  /** Windows for the instant's day type, each stamped with its owning model. */
  _windowsFor(nowMs, cfg) {
    const parts = zonedParts(nowMs, cfg.tz || this.tz);
    const out = [];
    for (const m of this.registry.models) {
      if (!m.schedule?.enabled) continue;
      for (const w of scheduleWindows(m.schedule, parts.dayType)) {
        out.push({ ...w, owner: m.id, ownerName: m.name });
      }
    }
    return out;
  }

  _activeWindowFor(nowMs, cfg) {
    const parts = zonedParts(nowMs, cfg.tz || this.tz);
    return resolveActiveWindow(this._windowsFor(nowMs, cfg), parts.minute);
  }

  _targetFromWindow(active) {
    return active?.owner ?? null;
  }

  /** Find the first future minute whose scheduled owner differs from now. */
  _nextScheduleChange(nowMs, cfg, active) {
    if (!active) return null;
    const tz = cfg.tz || this.tz;
    const parts = zonedParts(nowMs, tz);
    const [year, month, day] = parts.dateKey.split("-").map(Number);
    const currentMinuteEpoch =
      Date.UTC(year, month - 1, day) + parts.minute * 60_000 - parts.offsetMin * 60_000;

    // Weekday/weekend schedules repeat within seven days. Scan one extra day
    // so an all-week reservation cleanly reports that no change is coming.
    for (let offset = 1; offset <= 8 * 1440; offset += 1) {
      const probeMs = currentMinuteEpoch + offset * 60_000;
      const probeParts = zonedParts(probeMs, tz);
      const window = resolveActiveWindow(this._windowsFor(probeMs, cfg), probeParts.minute);
      if ((window?.owner ?? null) !== active.owner) {
        return { epochMs: probeMs, clock: fmt(probeParts.minute), window };
      }
    }
    return null;
  }

  /** Does the manual override still apply at this instant? */
  _overrideInForce(parts, active) {
    const ov = this._state.override;
    if (!ov) return false;
    const keyNow = active
      ? `${parts.dayType}:${active.key}:${active.owner}`
      : `gap:${parts.dayType}`;
    return ov.windowKey === keyNow;
  }

  // ─── Persistence (override + last decision survive a restart) ───
  _loadState() {
    try {
      const data = readJson(this.statePath);
      if (data && typeof data === "object") {
        this._state.override = data.override && typeof data.override === "object" ? data.override : null;
        this._state.lastDecision = data.lastDecision && typeof data.lastDecision === "object" ? data.lastDecision : null;
      }
    } catch {
      /* fresh state */
    }
  }

  _saveState() {
    try {
      atomicWrite(this.statePath, JSON.stringify(this._state, null, 2) + "\n", 0o644);
    } catch (err) {
      this.log(`failed to save scheduler state: ${err?.message || err}`);
    }
  }
}

function fmt(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function readJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
