/**
 * /api/sparks/:id/storage/*: the Storage Manager. Registered after the auth and Host/Origin
 * middleware, so a token (when SPARKDASH_TOKEN is set) is required exactly as for power actions.
 * Anything that changes a unit uses the destructive limiter; reads use the test limiter.
 */
import { passwordAllowed } from "../gpuclock/routes.js";
import { featureTable } from "./context.js";
import { reclaimedNote } from "./builderPrune.js";

const baseName = (p) => p.slice(p.lastIndexOf("/") + 1) || p;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * One Activity line for a finished bulk delete: plain counts, the first few names, and whether it ran as
 * administrator. "Deleted 11 of 12 items on Spark One (as administrator): a, b, c and 8 more. 1 could not be deleted."
 * @param {{ total: number, elevated: boolean, deleted: string[], failed: { path: string }[], skipped: unknown[], covered: string[] }} job
 * @param {string} sparkName
 */
export function bulkDeleteSummary(job, sparkName) {
  const names = (paths) => {
    const list = paths.map(baseName);
    return list.length === 0 ? "" : `: ${list.slice(0, 3).join(", ")}${list.length > 3 ? ` and ${list.length - 3} more` : ""}`;
  };
  const n = job.deleted.length;
  const where = `on ${sparkName}${job.elevated ? " (as administrator)" : ""}`;
  const head = n === 0 ? `Deleted none of ${plural(job.total, "item")} ${where}` : n === job.total ? `Deleted ${plural(n, "item")} ${where}${names(job.deleted)}` : `Deleted ${n} of ${plural(job.total, "item")} ${where}${names(job.deleted)}`;
  const parts = [`${head}.`];
  if (job.failed.length > 0) parts.push(`${job.failed.length} could not be deleted${n === 0 ? names(job.failed.map((f) => f.path)) : ""}.`);
  if (job.skipped.length > 0) parts.push(`${job.skipped.length} ${job.skipped.length === 1 ? "was" : "were"} not tried.`);
  return parts.join(" ");
}

/**
 * @param {object} app
 * @param {{ manager: object, registry: object, recordEvent: Function, allowRead: Function, allowChange: Function,
 *   rejectLimited: Function, allowPlainPassword?: () => boolean,
 *   adviceRefs?: (spark: object) => { launchers?: object[], llm?: object[] } }} deps
 *   `adviceRefs`: the dashboard's own references for a Spark (its model launchers, the LLM servers it watches), for the
 *   delete advisor.
 */
export function registerStorageRoutes(app, { manager, registry, recordEvent, allowRead, allowChange, rejectLimited, allowPlainPassword = () => false, adviceRefs = () => ({}) }) {
  const handle = (fn) => async (req, res) => {
    try {
      const spark = registry.getSpark(req.params.id);
      if (!spark) return res.status(404).json({ error: "Spark not found" });
      await fn(spark, req, res);
    } catch (err) {
      // Errors from the manager carry a status and a curated message; anything else stays generic.
      const known = Number.isInteger(err?.status);
      res.status(known ? err.status : 500).json({
        error: known ? err.message : "Storage action failed",
        code: err?.code,
        ...(err?.partial === true ? { partial: true } : {}),
        // Delete v2: the item is kept under "Needs attention", or the command to run by hand.
        ...(typeof err?.quarantineId === "string" ? { quarantineId: err.quarantineId } : {}),
        ...(typeof err?.command === "string" ? { command: err.command } : {}),
        // Bulk delete: the path that refused the whole request.
        ...(typeof err?.path === "string" ? { path: err.path } : {}),
      });
    }
  };

  /** A typed sudo password may only cross https or stay on the machine itself, unless Settings allows plain http. */
  const refuseInsecurePassword = (req, res) => {
    if (!req.body?.sudoPassword || passwordAllowed(req, allowPlainPassword())) return false;
    res.status(400).json({
      error: "Open the dashboard over https or from the Spark itself to type a sudo password here, turn on Settings → Allow sudo password over plain http, or run the command on the Spark.",
      code: "insecure-transport",
    });
    return true;
  };

  const name = (spark) => spark.name || spark.id;

  app.get(
    "/api/sparks/:id/storage",
    handle(async (spark, req, res) => {
      if (!allowRead(req)) return rejectLimited(res, "Too many requests");
      res.json({
        ...(await manager.status(spark)),
        passwordAllowed: passwordAllowed(req, allowPlainPassword()),
        plainPasswordAllowed: allowPlainPassword() === true,
      });
    })
  );

  // How the dashboard reaches this Spark (ssh, native-local, container-local), what the probe found there, and
  // which features that allows. Read-only; a cached answer costs nothing, so only a real probe is rate limited.
  app.get(
    "/api/sparks/:id/storage/context",
    handle(async (spark, req, res) => {
      const refresh = req.query.refresh === "1";
      if ((refresh || !manager.contextOf(spark)) && !allowRead(req)) return rejectLimited(res, "Too many requests");
      const context = await manager.context(spark, { refresh });
      res.json({ ...context, features: featureTable(context) });
    })
  );

  // The folders inside one folder, for the folder picker (read-only).
  app.get(
    "/api/sparks/:id/storage/folders",
    handle(async (spark, req, res) => {
      if (!allowRead(req)) return rejectLimited(res, "Too many requests");
      res.json(await manager.listFolders(spark, typeof req.query.path === "string" ? req.query.path : "/"));
    })
  );

  // Forget the sudo password the dashboard remembers for this Spark's account.
  app.delete(
    "/api/sparks/:id/storage/sudo-password",
    handle(async (spark, req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many storage changes, try again in a minute");
      res.json({ success: true, ...manager.forgetSudo(spark) });
    })
  );

  app.get(
    "/api/sparks/:id/storage/scan",
    handle(async (spark, req, res) => {
      // No limiter: this is a cheap in-memory read that the page polls every 1.5 s while a scan runs
      // (40 a minute would trip the 20-a-minute read limit and hide a finished scan).
      const since = /^\d{1,12}$/.test(String(req.query.since ?? "")) ? Number(req.query.since) : null;
      res.json({ ...manager.snapshot(spark, since), now: Date.now() });
    })
  );

  app.post(
    "/api/sparks/:id/storage/scan",
    handle(async (spark, req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many storage requests, try again in a minute");
      if (refuseInsecurePassword(req, res)) return;
      res.status(202).json({ job: manager.startScan(spark, req.body) });
    })
  );

  // Stop the scan on the unit (not just stop following it). Answers at once with the job "stopping"; the
  // outcome arrives in `job.stop` on the next polls, and the Spark stays busy (`job.holdsSpark`) until the
  // unit confirms. 409 `not-cancellable` for a scan run through sudo (it stops by itself at `stopsByItselfAt`).
  // The read limiter: a stop must not be refused for being asked too often.
  app.delete(
    "/api/sparks/:id/storage/scan",
    handle(async (spark, req, res) => {
      if (!allowRead(req)) return rejectLimited(res, "Too many requests");
      res.json({ job: manager.cancelScan(spark) });
    })
  );

  // Before a delete: what is known about the paths (programs or containers using them, git work, keys, recent changes,
  // the dashboard's own references, same-name-and-size items on other Sparks), with a level. Read-only and never
  // elevated: it uses the read limiter and neither waits for nor takes the Spark's busy slot. `{ paths }` as for
  // delete-many; a path that may not be deleted refuses the request.
  app.post(
    "/api/sparks/:id/storage/advise",
    handle(async (spark, req, res) => {
      if (!allowRead(req)) return rejectLimited(res, "Too many requests");
      res.json(
        await manager.advise(spark, req.body, {
          refs: () => adviceRefs(spark),
          nameOf: (id) => {
            const other = registry.getSpark(id);
            return other ? other.name || other.id : null;
          },
        })
      );
    })
  );

  app.post(
    "/api/sparks/:id/storage/delete",
    handle(async (spark, req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many storage changes, try again in a minute");
      if (refuseInsecurePassword(req, res)) return;
      const out = await manager.delete(spark, req.body);
      recordEvent({
        type: "storage.delete",
        severity: "info",
        sparkId: spark.id,
        message: `Deleted ${out.path} on ${name(spark)}${req.body?.sudo === true ? " (as administrator)" : ""}`,
      });
      res.json({ success: true, ...out });
    })
  );

  // Delete several files and folders: every path is checked first (one that may not be deleted refuses the whole
  // request, nothing runs), then each one is deleted exactly as POST …/delete would, one after another under one
  // busy lock. Answers 202 at once with the job; GET …/delete-many/:jobId follows it ({ done, total, current, … }).
  // One request counts once against the change limiter, however many paths it carries; one Activity entry
  // summarises the run when it ends.
  app.post(
    "/api/sparks/:id/storage/delete-many",
    handle(async (spark, req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many storage changes, try again in a minute");
      if (refuseInsecurePassword(req, res)) return;
      const job = manager.startDeleteMany(spark, req.body, {
        onFinish: (done) => recordEvent({ type: "storage.delete-many", severity: done.success ? "info" : "warn", sparkId: spark.id, message: bulkDeleteSummary(done, name(spark)) }),
      });
      res.status(202).json({ job });
    })
  );

  // The latest bulk delete on this Spark (running or finished; null if none since the dashboard started), or one
  // by id (404 when it is no longer the latest). No limiter: a cheap in-memory read the page polls while one runs.
  app.get(
    "/api/sparks/:id/storage/delete-many",
    handle(async (spark, _req, res) => {
      res.json({ job: manager.deleteManyJob(spark) });
    })
  );
  app.get(
    "/api/sparks/:id/storage/delete-many/:jobId",
    handle(async (spark, req, res) => {
      const job = manager.deleteManyJob(spark, req.params.jobId);
      if (!job) return res.status(404).json({ error: "This bulk delete is no longer known to the dashboard", code: "not-found" });
      res.json({ job });
    })
  );

  // Needs attention: deletes that were staged on the unit and never finished (read-only).
  app.get(
    "/api/sparks/:id/storage/quarantine",
    handle(async (spark, req, res) => {
      if (!allowRead(req)) return rejectLimited(res, "Too many requests");
      res.json(await manager.quarantine(spark));
    })
  );

  // Put a staged item back where it was (never replacing anything), delete it for good, or (forget) drop a
  // record whose item is no longer staged; forget is refused when anything is staged there.
  for (const action of ["restore", "delete", "forget"]) {
    app.post(
      `/api/sparks/:id/storage/quarantine/:qid/${action}`,
      handle(async (spark, req, res) => {
        if (!allowChange(req)) return rejectLimited(res, "Too many storage changes, try again in a minute");
        if (refuseInsecurePassword(req, res)) return;
        const out = await manager.resolveQuarantined(spark, req.params.qid, action, req.body);
        if (out.outcome === "restored" || out.outcome === "deleted") {
          recordEvent({
            type: `storage.quarantine.${action}`,
            severity: "info",
            sparkId: spark.id,
            message: `${out.outcome === "restored" ? "Put back" : "Deleted"} an item kept after an unfinished delete on ${name(spark)}${req.body?.sudo === true ? " (as administrator)" : ""}`,
          });
        }
        res.json({ success: true, ...out });
      })
    );
  }

  // The owner's acknowledgement that lets administrator deletes remove folders on this Spark, and revoking it.
  app.post(
    "/api/sparks/:id/storage/elevated-delete-ack",
    handle(async (spark, req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many storage changes, try again in a minute");
      const ack = manager.acknowledgeElevatedDelete(spark, req.body);
      recordEvent({ type: "storage.elevated-delete.ack", severity: "info", sparkId: spark.id, message: `Allowed deleting folders as administrator on ${name(spark)}` });
      res.json({ success: true, ack });
    })
  );

  app.delete(
    "/api/sparks/:id/storage/elevated-delete-ack",
    handle(async (spark, req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many storage changes, try again in a minute");
      const out = manager.revokeElevatedDelete(spark);
      if (out.revoked) {
        recordEvent({ type: "storage.elevated-delete.revoke", severity: "info", sparkId: spark.id, message: `Turned off deleting folders as administrator on ${name(spark)}` });
      }
      res.json({ success: true, ...out });
    })
  );

  // POST because it can carry a sudo password; it only reads.
  app.post(
    "/api/sparks/:id/storage/docker",
    handle(async (spark, req, res) => {
      if (!allowRead(req)) return rejectLimited(res, "Too many requests");
      if (refuseInsecurePassword(req, res)) return;
      res.json(await manager.docker(spark, req.body));
    })
  );

  app.post(
    "/api/sparks/:id/storage/docker/remove-containers",
    handle(async (spark, req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many storage changes, try again in a minute");
      if (refuseInsecurePassword(req, res)) return;
      const out = await manager.removeContainers(spark, req.body);
      if (out.removed.length > 0) {
        recordEvent({
          type: "storage.docker.containers",
          severity: "info",
          sparkId: spark.id,
          message: `Removed ${out.removed.length} stopped Docker container${out.removed.length === 1 ? "" : "s"} on ${name(spark)}`,
        });
      }
      res.json({ success: true, ...out });
    })
  );

  app.post(
    "/api/sparks/:id/storage/docker/remove-images",
    handle(async (spark, req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many storage changes, try again in a minute");
      if (refuseInsecurePassword(req, res)) return;
      const out = await manager.removeImages(spark, req.body);
      if (out.removed.length > 0) {
        recordEvent({
          type: "storage.docker.images",
          severity: "info",
          sparkId: spark.id,
          message: `Removed ${out.removed.length} unused Docker image${out.removed.length === 1 ? "" : "s"} on ${name(spark)}`,
        });
      }
      res.json({ success: true, ...out });
    })
  );

  // Clear Docker's unused build cache last used more than `olderThanDays` (1..365) days ago, on the builder built
  // into the daemon. Answers { olderThanDays, adapter, reclaimedBytes } (Docker's own figure, null when not said).
  app.post(
    "/api/sparks/:id/storage/docker/prune-builder-cache",
    handle(async (spark, req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many storage changes, try again in a minute");
      if (refuseInsecurePassword(req, res)) return;
      const out = await manager.pruneBuilderCache(spark, req.body);
      if (out.reclaimedBytes !== 0) {
        recordEvent({
          type: "storage.docker.builder-cache",
          severity: "info",
          sparkId: spark.id,
          message: `Cleared Docker build cache not used for ${out.olderThanDays} day${out.olderThanDays === 1 ? "" : "s"} on ${name(spark)}${reclaimedNote(out.reclaimedBytes)}`,
        });
      }
      res.json({ success: true, ...out });
    })
  );
}
