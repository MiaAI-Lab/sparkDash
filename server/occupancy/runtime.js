import { getSettings } from "../settings.js";
import { createOccupancyPoller } from "./poller.js";
import { registerOccupancyRoutes } from "./routes.js";

/** Dashboard-side owner of helper polling. Bridges stay on the helper host. */
export function createOccupancyRuntime({ listSparks } = {}) {
  const poller = createOccupancyPoller({
    listSparks,
    maxAgeMs: () => getSettings().occupancyMaxAgeMs,
  });
  return {
    poller,
    start() {
      poller.start();
    },
    async stop() {
      await poller.stop();
    },
    projection() {
      return poller.projection();
    },
    register(app) {
      registerOccupancyRoutes(app, { poller, listSparks });
    },
  };
}
