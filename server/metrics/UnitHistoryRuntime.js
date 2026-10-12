/**
 * UnitHistoryRuntime — glue between the running server and UnitHistory: one sampling tick for
 * both depths, the periodic save, the two read-only routes and the shutdown flush. Same shape as
 * server/energy/FleetEnergyRuntime.js, so index.js needs only createUnitHistoryRuntime() +
 * registerUnitHistoryRoutes().
 */
import { collectionWasSuccessful } from "../collectors/SystemCollector.js";
import { deviceReadings } from "./UnitHistory.js";
import { extractSample } from "./historySample.js";
import { HISTORY_RANGES } from "./historyTiers.js";

/** One sample per collector poll at the default 2 s cadence. */
export const HISTORY_SAMPLE_INTERVAL_MS = 2_000;
/** The default GPU window: the dense series' reach. */
const GPU_HISTORY_DEFAULT_WINDOW_MS = 8 * 3600_000;
/** A stale window never shorter than this, whatever the poll interval. */
export const MIN_STALE_WINDOW_MS = 15_000;

/**
 * How old a domain's last real collection may be before its value is a gap: three of the
 * monitor's current intervals for that domain — they follow Settings → Poll interval at runtime
 * (and an env pin) — never under 15 s. A domain without a poll interval of its own gets the floor.
 * @param {{ pollIntervalMs?: (domain: string) => number | null } | null | undefined} monitor
 * @param {string} domain
 */
export function staleWindowMs(monitor, domain) {
  const interval = monitor?.pollIntervalMs?.(domain);
  return Math.max(MIN_STALE_WINDOW_MS, Number.isFinite(interval) && interval > 0 ? 3 * interval : 0);
}

/**
 * `isFresh(domain)` for extractSample from a SparkMonitor's public accessors: the latest poll of
 * the domain returned real data, and that data is within staleWindowMs(). SparkMonitor keeps
 * serving the previous value while a collector fails or hangs, so "it is in the snapshot" is not
 * enough. No monitor → nothing is fresh.
 */
export function monitorFreshness(monitor, atMs) {
  return (domain) => {
    if (!monitor) return false;
    if (!monitor.collectionOk(domain)) return false;
    const at = monitor.lastCollectedAt(domain);
    return at != null && atMs - at <= staleWindowMs(monitor, domain);
  };
}

/** Record the GPU raw series from one snapshot — exactly what the GPU chart has always recorded. */
export function recordGpuSample(store, snap, atMs) {
  const gpu = snap?.metrics?.gpu;
  // Require a real collection: a default/failed GPU result would record a fabricated 0 C / 0 %.
  if (!snap?.online || !gpu || !collectionWasSuccessful(gpu)) return false;
  const draw = gpu.power?.draw;
  const limit = gpu.power?.limit;
  const powerPct = Number.isFinite(draw) && Number.isFinite(limit) && limit > 0 ? Math.min(100, (draw / limit) * 100) : null;
  return store.record(
    snap.id,
    atMs,
    gpu.metricAvailability?.usage === false ? null : gpu.usage,
    gpu.metricAvailability?.temperature === false ? null : gpu.temperature,
    gpu.metricAvailability?.powerDraw === false || gpu.metricAvailability?.powerLimit === false ? null : powerPct,
    deviceReadings(gpu.gpus)
  );
}

/**
 * GET /api/sparks/:id/gpu-history?windowMs= — the GPU raw series (parallel arrays, newest last),
 * always on: 1 min to 8 h from the dense ~2 s series (default 8 h), longer windows up to the
 * store's reach (7 days) from the minute-resolution one (the Temps page's day and week).
 */
export function createGpuHistoryHandler({ store, hasUnit, now = Date.now }) {
  return (req, res) => {
    if (!hasUnit(req.params?.id)) return res.status(404).json({ error: "Spark not found" });
    const windowMs = Math.min(store.maxWindowMs, Math.max(60_000, Number(req.query?.windowMs) || GPU_HISTORY_DEFAULT_WINDOW_MS));
    const atMs = now();
    res.json(store.window(req.params.id, windowMs, atMs));
  };
}

/**
 * GET /api/sparks/:id/history?range=1h|6h|24h|7d|30d (default 1h) — the bucketed tiers.
 * 404 for an unknown unit, 400 for a bad range, `{ enabled: false }` while the setting is off.
 */
export function createUnitHistoryHandler({ store, hasUnit, isEnabled, now = Date.now }) {
  return (req, res) => {
    const id = req.params?.id;
    if (!hasUnit(id)) return res.status(404).json({ error: "Spark not found" });
    const range = req.query?.range ?? "1h";
    if (typeof range !== "string" || !Object.hasOwn(HISTORY_RANGES, range)) {
      return res.status(400).json({
        error: `range must be one of: ${Object.keys(HISTORY_RANGES).join(", ")}`,
      });
    }
    if (!isEnabled()) return res.json({ enabled: false });
    return res.json({ enabled: true, ...store.query(id, range, now()) });
  };
}

export function registerUnitHistoryRoutes(app, deps) {
  app.get("/api/sparks/:id/gpu-history", createGpuHistoryHandler(deps));
  app.get("/api/sparks/:id/history", createUnitHistoryHandler(deps));
}

/**
 * Own the sampling timer and the store's periodic save. The GPU raw series are always sampled;
 * the bucketed tiers only while `isEnabled()` — read on every tick, so the setting takes effect
 * within one tick, without a restart.
 */
export function createUnitHistoryRuntime({
  store,
  orderedSnapshots,
  monitors,
  isEnabled,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logError = console.error,
}) {
  let started = false;
  let stopped = false;
  let sampleTimer = null;

  const reportError = (message, error) => {
    try {
      logError(message, error);
    } catch {
      // Logging must never prevent shutdown from continuing.
    }
  };

  const sample = () => {
    if (stopped) return;
    try {
      const atMs = now();
      const snapshots = orderedSnapshots();
      for (const snap of snapshots) {
        try {
          recordGpuSample(store, snap, atMs);
        } catch {
          /* sampling must never break the server */
        }
      }
      if (!isEnabled()) return;
      store.recordSample(
        snapshots.map((snap) => ({
          id: snap?.id,
          llmPorts: snap?.llmPorts,
          values: extractSample(snap, monitorFreshness(monitors?.get?.(snap?.id), atMs)),
        })),
        atMs
      );
    } catch (error) {
      reportError("[UnitHistory] sample error", error);
    }
  };

  return {
    /** Exposed for tests: run one sampling tick now. */
    sample,

    start() {
      if (started || stopped) return false;
      started = true;
      sampleTimer = setIntervalFn(sample, HISTORY_SAMPLE_INTERVAL_MS);
      sampleTimer?.unref?.();
      store.start();
      return true;
    },

    /** Stop sampling and write synchronously (shutdown). */
    stop() {
      if (stopped) return;
      stopped = true;
      if (sampleTimer !== null) {
        try {
          clearIntervalFn(sampleTimer);
        } catch (error) {
          reportError("[UnitHistory] timer shutdown error", error);
        }
      }
      sampleTimer = null;
      try {
        store.stop();
      } catch (error) {
        reportError("[UnitHistory] shutdown flush error", error);
      }
    },
  };
}
