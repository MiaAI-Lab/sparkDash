/**
 * GET/PUT/DELETE /api/sparks/:id/gpu-clock. Registered after the auth and
 * Host/Origin middleware, so a token (when SPARKDASH_TOKEN is set) is required
 * exactly as for power actions. Changing a cap uses the destructive limiter.
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

export function registerGpuClockRoutes(app, { manager, registry, recordEvent, allowRead, allowChange, rejectLimited }) {
  const handle = (fn) => async (req, res) => {
    try {
      const spark = registry.getSpark(req.params.id);
      if (!spark) return res.status(404).json({ error: "Spark not found" });
      await fn(spark, req, res);
    } catch (err) {
      // Errors from the manager carry a status and a curated message; anything else stays generic.
      const known = Number.isInteger(err?.status);
      res.status(known ? err.status : 500).json({ error: known ? err.message : "GPU clock action failed", code: err?.code });
    }
  };

  app.get(
    "/api/sparks/:id/gpu-clock",
    handle(async (spark, req, res) => {
      if (!allowRead(req)) return rejectLimited(res, "Too many requests");
      // Tell the page whether a typed password would be accepted from here, so it never offers a field the server refuses.
      res.json({ ...(await manager.status(spark)), passwordAllowed: isSecureRequest(req) });
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
    if (!req.body?.sudoPassword || isSecureRequest(req)) return false;
    res.status(400).json({
      error: "Open the dashboard over https or from the Spark itself to type a sudo password here, or use the command to run on the Spark.",
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
}

/**
 * POST /api/sparks/gpu-clock-all — fleet-wide batch, registered before the
 * per-unit routes (a plain Sparks-suffix path, like shutdown-all). Body is
 * `{ maxMHz, persist? }` or `{ reset: true }` — exactly one of maxMHz/reset.
 * One limiter hit per batch; every unit still gets its own Activity event.
 */
export function registerGpuClockFleetRoute(app, { manager, registry, recordEvent, allowChange, rejectLimited }) {
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
    for (const spark of registry.sparks) {
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
    // Skipped units (no GPU) are ok results; any real failure makes the batch unsuccessful.
    res.json({ success: results.every((r) => r.ok), results });
  });
}
