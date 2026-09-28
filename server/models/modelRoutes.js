/**
 * Model launcher HTTP routes.
 *
 * Kept in its own module and registered with a single call from index.js
 * (before express.static) so the launcher stays merge-isolated: nothing here
 * touches the Spark routes, the monitor map, or the WS plumbing beyond the
 * injected callbacks.
 *
 * Route ordering matters: `/api/models/jobs/:id` is registered before
 * `/api/models/:id/...` so "jobs" can never be mistaken for a model id (the
 * registry also rejects the reserved id set, belt and braces).
 */
import { isValidModelId } from "./ModelRegistry.js";
import { certainlyDown } from "./ModelProbe.js";
import {
  scheduleWindows,
  resolveActiveWindow,
  findScheduleConflicts,
  nextBoundaryAt,
  zonedParts,
} from "../../src/shared/modelSchedules.js";

function err(res, e, fallback = 500) {
  const status = Number.isInteger(e?.status) ? e.status : fallback;
  return res.status(status).json({ error: e?.message || String(e) });
}

/**
 * @param {import("express").Express} app
 * @param {import("./ModelLauncher.js").ModelLauncher} launcher
 * @param {{ forceBroadcast?: () => void }} [hooks]
 */
export function registerModelRoutes(app, launcher, hooks = {}) {
  const broadcast = hooks.forceBroadcast || (() => {});
  const models = () => launcher.registry;

  // ─── Collection ─────────────────────────────────────────
  app.get("/api/models", (_req, res) => {
    res.json({ models: models().models, scheduler: launcher.schedulerConfig() });
  });

  app.post("/api/models", (req, res) => {
    try {
      const model = models().addModel(req.body || {});
      broadcast();
      res.status(201).json({ success: true, model });
    } catch (e) {
      err(res, e, 400);
    }
  });

  // ─── Ordering ───────────────────────────────────────────
  // Registered before the /:id routes below so the literal "order" segment
  // can never be matched as a model id.

  /**
   * Rewire the card order in one shot: body { order: [id, ...] }. Ids missing
   * from the list land at the end in their previous relative order.
   */
  app.put("/api/models/order", (req, res) => {
    if (!Array.isArray(req.body?.order)) {
      return res.status(400).json({ error: "body must be { order: [modelId, ...] }" });
    }
    try {
      const list = models().setOrder(req.body.order);
      broadcast();
      res.json({ success: true, models: list });
    } catch (e) {
      err(res, e, 400);
    }
  });

  /**
   * Nudge one model by a row: body { delta: -1 | 1 } (−1 = up the list). The
   * panel's ↑/↓ buttons post this and read the new positions back from the
   * next snapshot, so there is no local ordering state to keep in sync.
   */
  app.post("/api/models/:id/move", (req, res) => {
    if (!isValidModelId(req.params.id)) return res.status(400).json({ error: "Invalid model id" });
    const delta = Number(req.body?.delta);
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ error: "body must be { delta: -1 | 1 }" });
    }
    try {
      const list = models().moveModel(req.params.id, delta);
      broadcast();
      res.json({ success: true, models: list });
    } catch (e) {
      err(res, e, 400);
    }
  });

  // ─── Scheduler (literal segments before /:id) ───────────
  app.get("/api/scheduler/config", (_req, res) => {
    res.json(launcher.schedulerConfig());
  });

  app.put("/api/scheduler/config", (req, res) => {
    try {
      const next = launcher.setSchedulerConfig({
        enabled: typeof req.body?.enabled === "boolean" ? req.body.enabled : undefined,
        tz: typeof req.body?.tz === "string" ? req.body.tz : undefined,
      });
      broadcast();
      res.json(next);
    } catch (e) {
      err(res, e, 400);
    }
  });

  /**
   * Dry-run the schedule for an instant: which model wins now, and where the
   * conflicts are. Lets the schedule dialog show the truth before saving.
   * Query: at=epoch ms (default now)
   */
  app.post("/api/scheduler/preview", (req, res) => {
    const cfg = launcher.schedulerConfig();
    const tz = typeof req.body?.tz === "string" && req.body.tz ? req.body.tz : cfg.tz;
    const atRaw = req.body?.at ?? req.query?.at;
    const at = Number.isFinite(Number(atRaw)) ? Number(atRaw) : Date.now();
    const dayType = zonedParts(at, tz).dayType;
    const entries = models().models.map((m) => ({
      id: m.id,
      name: m.name,
      scheduleEnabled: Boolean(m.schedule?.enabled),
      windows: scheduleWindows(m.schedule || {}, dayType),
    }));
    const flat = [];
    for (const e of entries) {
      if (!e.scheduleEnabled) continue;
      for (const w of e.windows) flat.push({ ...w, owner: e.id, ownerName: e.name });
    }
    const active = resolveActiveWindow(flat, zonedParts(at, tz).minute);
    res.json({
      at,
      tz,
      dayType,
      clock: `${String(Math.floor(zonedParts(at, tz).minute / 60)).padStart(2, "0")}:${String(zonedParts(at, tz).minute % 60).padStart(2, "0")}`,
      enabled: cfg.enabled,
      activeWindow: active ? { start: active.start, end: active.end, label: active.label, modelId: active.owner, modelName: active.ownerName } : null,
      // Same conflict engine the registry uses on save.
      conflicts: findScheduleConflicts(
        entries.filter((e) => e.scheduleEnabled).map((e) => ({ id: e.id, name: e.name, windows: e.windows }))
      ),
      nextBoundary: active ? nextBoundaryAt(at, tz, [active]) : null,
      plan: entries.map((e) => ({ id: e.id, name: e.name, windows: e.windows.map((w) => w.label) })),
    });
  });

  // ─── Jobs ───────────────────────────────────────────────
  /** Delta poll. `since` is the transcript cursor from the previous response. */
  app.get("/api/models/jobs/:id", (req, res) => {
    const sinceRaw = req.query.since;
    const since =
      sinceRaw != null && sinceRaw !== "" && Number.isFinite(Number(sinceRaw))
        ? Math.max(0, Math.floor(Number(sinceRaw)))
        : null;
    const job = launcher.jobs.getJob(req.params.id, since);
    if (!job) return res.status(404).json({ error: "Model job not found" });
    res.json(job);
  });

  /**
   * Cancel / drop a job.
   *
   * Semantics differ by action:
   *  - A logs tail is bound to the transcript modal that opened it: closing the
   *    modal (an ordinary, non-force DELETE) STOPS the tail. The model is never
   *    touched — this only kills the read-only `docker logs -f` process. Reopen
   *    starts a fresh tail.
   *  - A running mutating job (start/stop/restart) is only DETACHED on modal
   *    close — closing the window mid-start must leave the script and its
   *    container alone. Only the modal's "Cancel script" button (force=1) tears
   *    the process group down.
   *  - A finished job just loses its in-memory record.
   */
  app.delete("/api/models/jobs/:id", (req, res) => {
    const force = req.query.force === "1" || req.query.force === "true";
    const job = launcher.jobs.peek(req.params.id);
    if (!job) return res.status(404).json({ error: "Model job not found" });

    if (job.status === "running" && job.action !== "logs" && !force) {
      // Release the transcript view without disturbing the run.
      return res.json({
        success: true,
        detached: true,
        status: job.status,
        error: null,
      });
    }

    const cancelled = launcher.jobs.cancel(req.params.id);
    if (cancelled) {
      broadcast();
      return res.json(cancelled);
    }
    if (launcher.jobs.remove(req.params.id)) {
      broadcast();
      return res.json({ success: true, removed: true });
    }
    res.status(404).json({ error: "Model job not found" });
  });

  // ─── Single model ───────────────────────────────────────
  app.get("/api/models/:id", (req, res) => {
    const model = models().getModel(req.params.id);
    if (!model) return res.status(404).json({ error: "Model not found" });
    res.json({ model, status: launcher.status()[model.id] ?? null, job: launcher.jobs.getLatest(model.id) });
  });

  app.put("/api/models/:id", (req, res) => {
    if (!isValidModelId(req.params.id)) return res.status(400).json({ error: "Invalid model id" });
    try {
      const model = models().updateModel(req.params.id, req.body || {});
      broadcast();
      res.json({ success: true, model });
    } catch (e) {
      err(res, e, 400);
    }
  });

  app.delete("/api/models/:id", (req, res) => {
    const running = launcher.jobs.activeJob();
    if (running && running.modelId === req.params.id) {
      return res.status(409).json({ error: `Cannot remove a model while its ${running.action} job is running` });
    }
    const removed = models().removeModel(req.params.id);
    if (!removed) return res.status(404).json({ error: "Model not found" });
    broadcast();
    res.json({ success: true, removed });
  });

  /** Edit just the schedule block (the schedule dialog's save path). */
  app.put("/api/models/:id/schedule", (req, res) => {
    try {
      const model = models().setSchedule(req.params.id, req.body?.schedule || req.body || {});
      broadcast();
      res.json({ success: true, model });
    } catch (e) {
      err(res, e, 400);
    }
  });

  // ─── Actions ────────────────────────────────────────────
  /**
   * Start / restart — exclusive. Returns 202 { jobId } and stops any *other*
   * model first, in the same job, so the transcript shows the incumbent's
   * stop.sh followed by the target's script and exactly one container ends up
   * running. Restart gets the same treatment: a restart.sh that runs while
   * another kit holds :8000 dies on that kit's port validation instead of
   * doing its job.
   *
   * The incumbent list is fail-closed and computed from a FRESH probe: a
   * cached tick can be stale by the whole probe interval, and a model whose
   * verdict is merely unknown (docker ps died, LAN probe timed out,
   * container-name drift) still holds the GPU and the port. Unless the probe
   * PROVED a model down, its stop.sh runs first — idempotent and cheap; a
   * skipped live incumbent is the double-book this path exists to prevent.
   */
  function exclusiveAction(action) {
    return async (req, res) => {
      const model = models().getModel(req.params.id);
      if (!model) return res.status(404).json({ error: "Model not found" });
      try {
        await launcher.refresh({ forcePorts: "all" });
        const status = launcher.status();
        const others = models()
          .models.filter((m) => m.id !== model.id && !certainlyDown(status[m.id], m))
          .map((m) => m.id);
        const result = launcher.jobs.startExclusive(model.id, others, {
          source: req.body?.source || "manual",
          action,
        });
        // A human clicked: the choice outranks the schedule until the next boundary.
        launcher.scheduler.noteManual(model.id);
        broadcast();
        res.status(202).json({ jobId: result.jobId, status: "running", stopping: others });
      } catch (e) {
        err(res, e);
      }
    };
  }

  app.post("/api/models/:id/start", exclusiveAction("start"));
  app.post("/api/models/:id/restart", exclusiveAction("restart"));

  for (const action of ["stop", "logs"]) {
    app.post(`/api/models/:id/${action}`, (req, res) => {
      const model = models().getModel(req.params.id);
      if (!model) return res.status(404).json({ error: "Model not found" });
      try {
        const result = launcher.jobs.start(model.id, action, { source: req.body?.source || "manual" });
        if (action === "stop") launcher.scheduler.noteManual(model.id);
        broadcast();
        res.status(202).json(result);
      } catch (e) {
        err(res, e);
      }
    });
  }

  /** Toggle the model on/off for the scheduler without touching its windows. */
  app.post("/api/models/:id/schedule-toggle", (req, res) => {
    const model = models().getModel(req.params.id);
    if (!model) return res.status(404).json({ error: "Model not found" });
    try {
      const next = models().setSchedule(model.id, {
        ...model.schedule,
        enabled: Boolean(req.body?.enabled),
      });
      broadcast();
      res.json({ success: true, model: next });
    } catch (e) {
      err(res, e, 400);
    }
  });

  /**
   * Release the manual override so the schedule re-asserts on the next tick
   * ("auto" chip in the panel header).
   */
  app.post("/api/scheduler/clear-override", (_req, res) => {
    launcher.scheduler.clearOverride();
    broadcast();
    res.json({ success: true });
  });

  /** Manual probe refresh (card spinner / after an external change). Forces
   *  every port once — the skip-if-settled optimisation applies to the
   *  automatic ticks, not to an operator explicitly asking for the truth. */
  app.post("/api/models/refresh", async (_req, res) => {
    await launcher.refresh({ forcePorts: "all" });
    broadcast();
    res.json({ ok: true, status: launcher.status() });
  });

}
