import { createRateLimiter } from "../validate.js";
import { fetchHelper, helperAllowlist } from "./policy.js";
import { publicHelpers, replaceHelpers, removeHelper, loadHelpers } from "./sources.js";

const allowCheck = createRateLimiter(30, 60_000);

function principalKey(req) {
  return req.principal?.id || req.ip || "anonymous";
}

function sendError(res, err) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({ error: err?.message || "Request failed" });
}

/**
 * Occupancy routes. Callers register this AFTER the dashboard auth middleware
 * so connection checks cannot bypass the configured policy.
 */
export function registerOccupancyRoutes(app, { poller, listSparks, fetchImpl = fetchHelper, allowlist = helperAllowlist } = {}) {
  app.get("/api/occupancy/helpers", (_req, res) => {
    try {
      res.json({ helpers: publicHelpers() });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.put("/api/occupancy/helpers", (req, res) => {
    try {
      const sparks = typeof listSparks === "function" ? listSparks() : [];
      const helpers = replaceHelpers(req.body, { sparks });
      poller?.reconfigure();
      res.json({ helpers });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.delete("/api/occupancy/helpers/:id", (req, res) => {
    try {
      const helpers = removeHelper(req.params.id);
      poller?.reconfigure();
      res.json({ helpers });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post("/api/occupancy/helpers/check", async (req, res) => {
    if (!allowCheck(principalKey(req))) {
      res.status(429).json({ error: "Too many helper checks" });
      return;
    }
    try {
      const url = req.body?.url;
      const token = typeof req.body?.token === "string" ? req.body.token : "";
      const payload = await fetchImpl(url, { token, allowlist: allowlist() });
      res.json({
        ok: true,
        observedAt: payload.observedAt,
        adapters: payload.adapters,
        rowCount: payload.rows.length,
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get("/api/occupancy/health", (_req, res) => {
    const helpers = loadHelpers();
    const health = poller?.health?.() || new Map();
    res.json({
      helpers: helpers.map((helper) => ({
        id: helper.id,
        enabled: helper.enabled,
        ...(health.get(helper.id) || { coverage: "unavailable", error: null, observedAt: null, adapters: {} }),
      })),
    });
  });
}
