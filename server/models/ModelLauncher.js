/**
 * ModelLauncher — the isolated module behind the Overview "Model Launcher" panel.
 *
 * Everything the feature needs (registry, host job runner, liveness probe,
 * time-window scheduler) is wired here, so index.js only has to
 *
 *   1. `registerModelRoutes(app, launcher)`       — one import, one call
 *   2. `launcher.snapshotPayload()` inside buildSnapshotPayload()
 *   3. `launcher.startTimers()` / `stopTimers()` / `interruptAll()`
 *
 * That is the merge surface: four touch points, all additive, no existing
 * code paths modified. Nothing here imports SparkMonitor / LlmProbe / the WS
 * layer, so upstream changes to those files cannot break the launcher, and
 * the launcher can be deleted by removing the four touch points.
 *
 * Probe timing: the probe runs on its own interval and keeps the last good
 * result, so the WS snapshot never waits on a host round-trip. Deliberately
 * NOT tied to updateClientState() — the scheduler must keep enforcing windows
 * with zero browser tabs open, and a model that comes up at 02:00 needs to be
 * reported as up at 02:00.
 */
import { ModelRegistry, normalizeRepoUrl } from "./ModelRegistry.js";
import { ModelJobManager } from "./ModelJobManager.js";
import { ModelScheduler } from "./ModelScheduler.js";
import { execOnTarget, resolveRunTarget, shQuote } from "./hostExec.js";
import { probeModels, buildModelStatus, containersKnown } from "./ModelProbe.js";
import { getSchedulerConfig, updateSchedulerConfig } from "./schedulerStore.js";
import { MODEL_PROBE_INTERVAL_MS } from "../config.js";

export class ModelLauncher {
  /**
   * @param {{ onStatusChange?: () => void, getSpark?: (id: string) => object|null }} [hooks]
   *   server callbacks — `onStatusChange` forces a WS broadcast; `getSpark`
   *   is the SparkRegistry lookup INCLUDING ssh.password that decides WHERE
   *   every model's scripts run (the model's assigned Spark, over SSH).
   */
  constructor(hooks = {}) {
    this.onStatusChange = hooks.onStatusChange || (() => {});
    this.getSpark = hooks.getSpark || (() => null);
    /** A model's run target is its assigned Spark — never the dashboard's box. */
    this._targetFor = (model) => resolveRunTarget(model, this.getSpark);
    this.registry = new ModelRegistry();
    this.jobs = new ModelJobManager({
      getModel: (id) => this.registry.getModel(id),
      getSpark: (id) => this.getSpark(id),
      onChange: () => this._notify(),
      afterSettle: async () => {
        // A stop/start changes liveness immediately — don't wait for the tick.
        await this.refresh();
      },
    });
    this.scheduler = new ModelScheduler({
      registry: this.registry,
      jobs: this.jobs,
      status: () => this._status,
      getConfig: () => getSchedulerConfig(),
      log: (m) => console.log(`[ModelLauncher] ${m}`),
    });
    /** @type {Record<string, object>} */
    this._status = {};
    /** @type {ReturnType<typeof setInterval>|null} */
    this._probeTimer = null;
    this._probing = false;
    /** @type {Promise<unknown>} the in-flight (or last) refresh pass */
    this._pass = Promise.resolve();
    this._lastProbeOkAt = null;
    // Registry edits change both the card list and the scheduler's windows.
    this.registry.onChange(() => {
      this._notify();
    });
  }

  // ─── Timers ─────────────────────────────────────────────
  startTimers() {
    if (!this._probeTimer) {
      this._probeTimer = setInterval(() => void this.refresh(), MODEL_PROBE_INTERVAL_MS);
      if (typeof this._probeTimer.unref === "function") this._probeTimer.unref();
      void this.refresh();
    }
    this.scheduler.start();
    void this.detectRepoUrls();
  }

  /**
   * Fill in `repoUrl` for kits that do not have one yet: the repos base is not
   * bind-mounted into this container (and lives on the model's Spark anyway),
   * so the origin URL is read with one short `git` call per model *on that
   * Spark*, once at startup. Existing values are never overwritten (they may
   * have been set deliberately through the API).
   */
  async detectRepoUrls() {
    const missing = this.registry.models.filter((m) => !m.repoUrl);
    for (const m of missing) {
      const target = this._targetFor(m);
      if (target.kind === null) continue; // the probe pass surfaces the reason
      try {
        const res = await execOnTarget(
          target,
          `git -C ${shQuote(m.dir)} remote get-url origin 2>/dev/null`,
          { timeoutMs: 6000 }
        );
        if (res.code !== 0 || res.error) continue;
        const url = normalizeRepoUrl(res.stdout);
        if (!url) continue;
        this.registry.updateModel(m.id, { repoUrl: url });
      } catch {
        /* a repo without a remote (or without git) simply has no link */
      }
    }
  }

  stopTimers() {
    if (this._probeTimer) {
      clearInterval(this._probeTimer);
      this._probeTimer = null;
    }
    this.scheduler.stop();
  }

  /** Called from shutdown(): finalize running jobs so polls don't 404. */
  interruptAll(reason) {
    try {
      this.scheduler.stop();
      this.jobs.interruptAll(reason);
    } catch (err) {
      console.warn("[ModelLauncher] shutdown error:", err?.message || err);
    }
  }

  // ─── Probe ──────────────────────────────────────────────
  /**
   * One probe pass, serialized. Keeps the previous result on failure.
   *
   * Steady state is cheap by design: the container list settles who is
   * running, so ports already owned by a confirmed container see no HTTP at
   * all (see portsNeedingProbe). Two cases still need live port answers:
   *  - a mutating job in flight — readiness is the port flipping up while the
   *    container exists but is still loading weights → force that port;
   *  - the manual Refresh button, and the Start/Restart click, which must not
   *    pick incumbents off a cached tick.
   * A forced pass never piggybacks on an in-flight pass: it waits for that one
   * to settle, then runs once more. A second collision takes the latest
   * verdict instead of queueing behind a wedged target forever.
   */
  async refresh(opts = {}) {
    if (this._probing) {
      if (opts.forcePorts !== "all" || opts._waited) return this._status;
      await this._pass.catch(() => {});
      return this.refresh({ ...opts, _waited: true });
    }
    this._probing = true;
    this._pass = this._probeOnce(opts).finally(() => {
      this._probing = false;
    });
    return this._pass;
  }

  /** The actual pass behind refresh(). Never throws. */
  async _probeOnce(opts) {
    try {
      const models = this.registry.models;
      if (!models.length) {
        if (Object.keys(this._status).length) {
          this._status = {};
          this._notify();
        }
        return this._status;
      }
      const forced = new Set();
      const active = this.jobs.activeJob();
      if (active?.modelId) {
        const m = this.registry.getModel(active.modelId);
        if (m?.port != null) forced.add(String(m.port));
      }
      if (opts.forcePorts === "all") {
        for (const m of models) if (m.port != null) forced.add(String(m.port));
      }
      const result = await probeModels(models, { forcePorts: forced, targetFor: this._targetFor });
      const next = buildModelStatus(models, { ...result, checkedAt: undefined });
      const changed = JSON.stringify(next) !== JSON.stringify(this._status);
      this._status = next;
      this._lastProbeOkAt = containersKnown(result) ? Date.now() : this._lastProbeOkAt;
      // Readiness frees the mutating slot (see releaseReadyStart): a start job
      // whose model is serving has done its job, even though start.sh is still
      // tailing logs. Port-first so we do not cut the transcript the moment
      // the container exists but before it answers /v1/models. During a job
      // the port is force-probed so this stays honest; a port whose verdict
      // came from docker (portChecked false) must never release the slot.
      // A restart chain arms on the first DOWN observation — its own old
      // container serving mid-chain is not the finish signal.
      for (const m of models) {
        const st = next[m.id];
        if (!st?.running) {
          this.jobs.markRestartSawDown(m.id);
          continue;
        }
        if (st.portChecked === false) continue;
        const readySignal = m.port != null ? st.portUp : st.containerUp;
        if (readySignal === true) this.jobs.releaseReadyStart(m.id);
      }
      if (changed) this._notify();
    } catch (err) {
      console.warn("[ModelLauncher] probe failed:", err?.message || err);
    }
    return this._status;
  }

  status() {
    return this._status;
  }

  // ─── WS payload ─────────────────────────────────────────
  /**
   * Snapshot block. MUST stay free of any Date.now()-derived value, otherwise
   * index.js's byte-compare diff cache misses on every tick and an idle
   * dashboard starts broadcasting every poll again.
   *
   * `checkedAt` / `lastProbeOkAt` are therefore excluded; `nextBoundary` is an
   * absolute epoch ms which is stable until the boundary itself moves.
   */
  snapshotPayload() {
    const models = this.registry.models.map((m) => ({
      id: m.id,
      name: m.name,
      dir: m.dir,
      sparkId: m.sparkId ?? null,
      /** Display name of the assigned Spark (its id if the Spark was removed —
       *  the status error tells the whole story in that case). */
      sparkName: m.sparkId ? this.getSpark(m.sparkId)?.name ?? m.sparkId : null,
      description: m.description,
      container: m.container,
      port: m.port,
      position: m.position ?? null,
      apiPath: m.apiPath,
      repoUrl: m.repoUrl,
      hasLogs: Boolean(m.logsScript || m.container),
      canRestart: Boolean(m.restartScript),
      startArgs: m.startArgs?.length ? m.startArgs : null,
      schedule: m.schedule,
      status: this._status[m.id] || {
        running: false,
        containerUp: null,
        portUp: null,
        modelId: null,
        error: null,
      },
      job: this.jobs.getLatest(m.id) || null,
    }));
    return {
      models,
      activeJob: this.jobs.activeJob(),
      scheduler: this.scheduler.statusBlock(),
    };
  }

  // ─── Config passthroughs (used by the routes) ───────────
  schedulerConfig() {
    return getSchedulerConfig();
  }

  setSchedulerConfig(patch) {
    const next = updateSchedulerConfig(patch);
    this._notify();
    return next;
  }

  _notify() {
    try {
      this.onStatusChange();
    } catch {
      /* broadcast is best-effort */
    }
  }
}

/** Singleton shared by the routes and the snapshot builder. */
let _launcher = null;

export function initModelLauncher(hooks) {
  if (!_launcher) _launcher = new ModelLauncher(hooks);
  return _launcher;
}

export function getModelLauncher() {
  return _launcher;
}
