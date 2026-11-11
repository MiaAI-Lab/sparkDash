/**
 * GET/PUT/DELETE /api/sparks/:id/gpu-clock and GET/PUT /api/sparks/:id/gpu-power.
 * Registered after the auth and Host/Origin middleware, so a token (when
 * SPARKDASH_TOKEN is set) is required exactly as for power actions. Changing a
 * cap or a limit uses the destructive limiter.
 */
import { gpuClockUnsupportedReason } from "./GpuClockManager.js";
import { parseCapRequest } from "./commands.js";

const LOOPBACK = /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/;
const FORWARDED = ["x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded"];

/**
 * A sudo password may only be typed over https or from the machine itself: on a plain-http
 * LAN page it would cross the network in the clear. A loopback peer only counts when the
 * request was not relayed (a same-host reverse proxy on plain http makes every client look
 * local, and says so with a forwarding header). A proxy's X-Forwarded-Proto is the client's
 * own claim; this guards against mistakes, not against the person typing.
 */
export function isSecureRequest(req) {
  const h = req.headers || {};
  if (req.secure === true) return true;
  if (String(h["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase() === "https") return true;
  const relayed = FORWARDED.some((name) => h[name] !== undefined);
  return !relayed && LOOPBACK.test(String(req.socket?.remoteAddress || ""));
}

/** How the cap is kept across boots, for the Activity line and the fleet report. */
const keptText = (persistKind) => (persistKind === "cron" ? " by the @reboot cron job" : " by the boot service");

/** Whole-batch budget for the fleet route; one unit's own timeout is 45 s, so this fits a few slow ones. */
export const FLEET_DEADLINE_MS = 3 * 60_000;

/**
 * Whether a typed sudo password may be accepted on this request: https or the machine itself, or the
 * person turned on "Allow sudo password over plain http" in Settings (`allowPlain`).
 */
export function passwordAllowed(req, allowPlain = false) {
  return allowPlain === true || isSecureRequest(req);
}

export function registerGpuClockRoutes(app, { manager, registry, recordEvent, allowRead, allowChange, rejectLimited, allowPlainPassword = () => false }) {
  const handle = (fn) => async (req, res) => {
    try {
      const spark = registry.getSpark(req.params.id);
      if (!spark) return res.status(404).json({ error: "Spark not found" });
      await fn(spark, req, res);
    } catch (err) {
      // Errors from the manager carry a status and a curated message; anything else stays generic.
      const known = Number.isInteger(err?.status);
      res.status(known ? err.status : 500).json({ error: known ? err.message : "GPU action failed", code: err?.code });
    }
  };

  // Tell the page whether a typed password would be accepted from here, so it never offers a field the server refuses.
  const passwordFlags = (req) => ({
    passwordAllowed: passwordAllowed(req, allowPlainPassword()),
    // The page's own secure-context check does not apply when this is on.
    plainPasswordAllowed: allowPlainPassword() === true,
  });

  app.get(
    "/api/sparks/:id/gpu-clock",
    handle(async (spark, req, res) => {
      if (!allowRead(req)) return rejectLimited(res, "Too many requests");
      res.json({ ...(await manager.status(spark)), ...passwordFlags(req) });
    })
  );

  // Command to paste into a terminal on the unit itself (asks for the sudo password there).
  app.get(
    "/api/sparks/:id/gpu-clock/command",
    handle(async (spark, req, res) => {
      if (!allowRead(req)) return rejectLimited(res, "Too many requests");
      res.json(manager.command(spark, req.query));
    })
  );

  const refuseInsecurePassword = (req, res) => {
    if (!req.body?.sudoPassword || passwordAllowed(req, allowPlainPassword())) return false;
    res.status(400).json({
      error: "Open the dashboard over https or from the Spark itself to type a sudo password here, turn on Settings → Allow sudo password over plain http, or use the command to run on the Spark.",
      code: "insecure-transport",
    });
    return true;
  };

  app.put(
    "/api/sparks/:id/gpu-clock",
    handle(async (spark, req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many GPU clock changes, try again in a minute");
      if (refuseInsecurePassword(req, res)) return;
      const out = await manager.apply(spark, req.body);
      recordEvent({
        type: "gpu.clock.set",
        severity: "info",
        sparkId: spark.id,
        message: `GPU clock capped at ${out.capMHz} MHz${out.persist ? ` (kept after reboot${keptText(out.persistKind)})` : ""}`,
      });
      res.json({ success: true, ...out });
    })
  );

  app.delete(
    "/api/sparks/:id/gpu-clock",
    handle(async (spark, req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many GPU clock changes, try again in a minute");
      if (refuseInsecurePassword(req, res)) return;
      await manager.reset(spark, req.body);
      recordEvent({ type: "gpu.clock.reset", severity: "info", sparkId: spark.id, message: "GPU clock cap removed" });
      res.json({ success: true });
    })
  );

  app.get(
    "/api/sparks/:id/gpu-power",
    handle(async (spark, req, res) => {
      if (!allowRead(req)) return rejectLimited(res, "Too many requests");
      res.json({ ...(await manager.powerStatus(spark)), ...passwordFlags(req) });
    })
  );

  app.put(
    "/api/sparks/:id/gpu-power",
    handle(async (spark, req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many GPU power limit changes, try again in a minute");
      if (refuseInsecurePassword(req, res)) return;
      const out = await manager.setPower(spark, req.body);
      const set = out.limits.map((l) => `GPU ${l.index ?? l.uuid} ${l.watts} W`).join(", ");
      recordEvent({
        type: "gpu.power.set",
        severity: "info",
        sparkId: spark.id,
        message: set
          ? `GPU power limit: ${set} (${out.persist ? "kept after reboot" : "until the next reboot"})`
          : out.persist ? "GPU power limits kept after reboot" : "GPU power limits no longer kept after reboot",
      });
      res.json({ success: true, ...out });
    })
  );
}

/**
 * POST /api/sparks/gpu-clock-all — fleet-wide batch, registered before the
 * per-unit routes (a plain Sparks-suffix path, like shutdown-all). Body is
 * `{ maxMHz, persist? }` or `{ reset: true }` — exactly one of maxMHz/reset.
 * One limiter hit per batch; every unit still gets its own Activity event.
 */
export function registerGpuClockFleetRoute(
  app,
  { manager, registry, recordEvent, allowChange, rejectLimited, fleetDeadlineMs = FLEET_DEADLINE_MS }
) {
  app.post("/api/sparks/gpu-clock-all", async (req, res) => {
    const { maxMHz, persist, reset } = req.body ?? {};
    const wantsReset = reset === true;
    if (wantsReset === (maxMHz !== undefined)) {
      return res.status(400).json({ error: "Send either { maxMHz } or { reset: true }, not both" });
    }
    if (!wantsReset) {
      try {
        // The same bounds as the per-unit route: a preset list in the UI is not a
        // guard, and an out-of-range cap must not be answered with a 200.
        parseCapRequest({ maxMHz, persist });
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }
    if (!allowChange(req)) return rejectLimited(res, "Too many GPU clock changes, try again in a minute");
    const results = [];
    // One slow or hung unit must not hold the whole batch: past the deadline the
    // remaining units are reported as not attempted, so the answer still arrives.
    const deadline = Date.now() + fleetDeadlineMs;
    for (const spark of registry.sparks) {
      if (Date.now() > deadline) {
        results.push({ id: spark.id, ok: false, error: "Not attempted: the fleet change ran out of time before this unit" });
        continue;
      }
      const unsupported = gpuClockUnsupportedReason(spark);
      if (unsupported) {
        // Every unit is named in the report: a PC cannot take a cap, and saying so
        // is the answer. Silence would read as "forgotten" in a fleet-wide action.
        results.push({ id: spark.id, ok: true, supported: false, reason: unsupported });
        continue;
      }
      try {
        if (wantsReset) {
          await manager.reset(spark);
          recordEvent({
            type: "gpu.clock.reset",
            severity: "info",
            sparkId: spark.id,
            message: "Fleet reset: GPU clock cap removed",
          });
          results.push({ id: spark.id, ok: true, capMHz: null, persistKind: "none" });
        } else {
          const out = await manager.apply(spark, { maxMHz, persist: persist === true });
          recordEvent({
            type: "gpu.clock.set",
            severity: "info",
            sparkId: spark.id,
            message: `Fleet cap: GPU clock capped at ${out.capMHz} MHz${out.persist ? ` (kept after reboot${keptText(out.persistKind)})` : ""}`,
          });
          // The hook is per unit — one Spark may take the service where another falls
          // back to cron — so the report says which one took, not just that it persisted.
          results.push({ id: spark.id, ok: true, capMHz: out.capMHz, persistKind: out.persistKind });
        }
      } catch (err) {
        // No NVIDIA GPU is a normal fleet answer; anything else — including a GPU
        // that cannot report its maximum — is a failure and says so.
        if (err?.code === "no-nvidia") {
          results.push({ id: spark.id, ok: true, supported: false, reason: err.message });
        } else {
          results.push({ id: spark.id, ok: false, error: err?.message || String(err) });
        }
      }
    }
    // Skipped units (no GPU) are ok results, but they changed nothing: a batch where
    // no unit was actually capped or reset is not a success, however many were skipped.
    const applied = results.filter((r) => r.ok && r.supported !== false).length;
    res.json({ success: results.every((r) => r.ok) && applied > 0, applied, results });
  });
}
