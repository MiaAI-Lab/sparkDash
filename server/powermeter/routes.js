/**
 * Power-meter routes, behind the dashboard's auth like every other API route. Energy
 * figures live in /api/fleet-energy; these only describe the meters themselves.
 *
 *   GET  /api/power-meters             configured?, each meter's health and history state,
 *                                      each unit's current reading
 *   POST /api/power-meters/reconcile   fetch the meters' history now
 */
export function registerPowerMeterRoutes(app, { status, reconcile = null }) {
  app.get("/api/power-meters", (_req, res) => res.json(status()));
  app.post("/api/power-meters/reconcile", async (_req, res) => {
    if (!reconcile) {
      return res.status(404).json({
        error: "Power meters are not configured. Create config/power-meters.json (see docs/POWER-METERS.md).",
      });
    }
    await reconcile();
    return res.json(status());
  });
}
