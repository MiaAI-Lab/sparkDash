/**
 * AutoPower routes. Polled by the Overview card (not part of the WS snapshot,
 * so live counters here are fine — unlike the diff-cached payload).
 */
import { AUTOPOWER_FEATURE } from "../config.js";
import { updateAutoPowerConfig } from "./store.js";

/**
 * @param {import("express").Express} app
 * @param {import("./AutoPowerManager.js").AutoPowerManager} manager
 */
export function registerAutoPowerRoutes(app, manager) {
  /** Full status: config + live idle/watch/wake state. */
  app.get("/api/autopower", (_req, res) => {
    // `feature` is the master switch (server/config.js). When false the panel
    // hides itself and stops polling; nothing here can move the fleet.
    res.json({ ...manager.statusBlock(), feature: AUTOPOWER_FEATURE });
  });

  /** Merge a config patch (also the on/off button: { enabled: true|false }). */
  app.put("/api/autopower/config", (req, res) => {
    if (!AUTOPOWER_FEATURE) {
      return res.status(409).json({ error: "AutoPower is disabled (AUTOPOWER_FEATURE)" });
    }
    try {
      const config = updateAutoPowerConfig(req.body || {});
      res.json({ config });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  /** Force a tick right now — used by the dialog to preview its own changes. */
  app.post("/api/autopower/tick", async (_req, res) => {
    if (!AUTOPOWER_FEATURE) {
      return res.status(409).json({ error: "AutoPower is disabled (AUTOPOWER_FEATURE)" });
    }
    const decision = await manager.runTick();
    res.json({ decision, status: manager.statusBlock() });
  });
}
