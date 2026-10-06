/**
 * MetricsHistoryRuntime — glue between the running server and MetricsHistory:
 * a sampling tick, a flush tick, the read-only route, and the shutdown flush.
 * Same shape as server/energy/FleetEnergyRuntime.js and LlmTokenRuntime.js, so
 * index.js needs only createMetricsHistoryRuntime() + registerMetricsHistoryRoute().
 */
import {
  POLL_INTERVAL_CPU,
  POLL_INTERVAL_GPU,
  POLL_INTERVAL_LLM,
  POLL_INTERVAL_NETWORK,
  POLL_INTERVAL_BANDWIDTH,
} from "../config.js";
import { extractSample, HISTORY_RANGES } from "./MetricsHistory.js";

/** One sample per collector poll at the default 2 s cadence. */
export const HISTORY_SAMPLE_INTERVAL_MS = 2_000;
/** Tiers 1–2 are rewritten at most this often (and once more on shutdown). */
export const HISTORY_FLUSH_INTERVAL_MS = 60_000;
/**
 * A domain whose last collection is older than this is a gap, not a value:
 * SparkMonitor keeps serving the previous reading while polls are paused or
 * failing. Three poll intervals, never under 15 s.
 */
export const MAX_DOMAIN_AGE_MS = Math.max(
  15_000,
  3 * Math.max(
    POLL_INTERVAL_GPU,
    POLL_INTERVAL_CPU,
    POLL_INTERVAL_NETWORK,
    POLL_INTERVAL_LLM,
    POLL_INTERVAL_BANDWIDTH
  )
);

/**
 * The staleness window for one monitor. Settings → Poll interval re-arms its
 * collectors at runtime (SparkMonitor._fastIntervals), so a fixed window would
 * call every 10 s poll stale; three of the monitor's current intervals, never
 * under 15 s. Without that bookkeeping, fall back to the env-based window.
 * @param {Record<string, number> | undefined} intervals
 */
export function maxDomainAgeMs(intervals) {
  const values = intervals
    ? Object.values(intervals).filter((v) => Number.isFinite(v) && v > 0)
    : [];
  if (values.length === 0) return MAX_DOMAIN_AGE_MS;
  return Math.max(15_000, 3 * Math.max(...values));
}

/**
 * `isFresh(domain)` for extractSample, from a SparkMonitor's bookkeeping: the
 * domain was collected within maxDomainAgeMs(), and for GPU / CPU the last
 * collection succeeded (a failed one returns all zeros). No monitor → trust
 * the snapshot (tests, or a monitor that is being replaced).
 */
export function monitorFreshness(monitor, atMs) {
  return (domain) => {
    if (!monitor) return true;
    if (
      (domain === "gpu" || domain === "cpu") &&
      monitor._metricCollectionSuccessful?.[domain] !== true
    ) {
      return false;
    }
    const at = monitor._lastUpdate?.[domain];
    return Number.isFinite(at) && atMs - at <= maxDomainAgeMs(monitor._fastIntervals);
  };
}

/**
 * GET /api/sparks/:id/history?range=1h|6h|24h|7d|30d (default 1h).
 * 404 for an unknown unit, 400 for a bad range, `{ enabled: false }` while the
 * setting is off.
 */
export function createMetricsHistoryHandler({ store, hasUnit, isEnabled, now = Date.now }) {
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

export function registerMetricsHistoryRoute(app, deps) {
  return app.get("/api/sparks/:id/history", createMetricsHistoryHandler(deps));
}

/**
 * Own the sampling and flush timers. The setting is read on every tick, so
 * turning it on starts recording within one tick and turning it off stops it,
 * without a restart.
 */
export function createMetricsHistoryRuntime({
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
  let flushTimer = null;
  let stopResult = false;

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
      if (!isEnabled()) return;
      const atMs = now();
      const units = orderedSnapshots().map((snapshot) => ({
        id: snapshot?.id,
        llmPorts: snapshot?.llmPorts,
        values: extractSample(snapshot, monitorFreshness(monitors?.get?.(snapshot?.id), atMs)),
      }));
      store.record(units, atMs);
    } catch (error) {
      reportError("metrics history sample error", error);
    }
  };

  const flush = () => {
    if (stopped) return;
    try {
      store.flush();
    } catch (error) {
      reportError("metrics history persist error", error);
    }
  };

  const clear = (timer) => {
    if (timer === null) return;
    try {
      clearIntervalFn(timer);
    } catch (error) {
      reportError("metrics history timer shutdown error", error);
    }
  };

  return {
    /** Exposed for tests: run one sampling tick now. */
    sample,

    start() {
      if (started || stopped) return false;
      started = true;
      sample();
      sampleTimer = setIntervalFn(sample, HISTORY_SAMPLE_INTERVAL_MS);
      flushTimer = setIntervalFn(flush, HISTORY_FLUSH_INTERVAL_MS);
      sampleTimer?.unref?.();
      flushTimer?.unref?.();
      return true;
    },

    stop() {
      if (stopped) return stopResult;
      stopped = true;
      clear(sampleTimer);
      clear(flushTimer);
      sampleTimer = null;
      flushTimer = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          store.close();
          stopResult = true;
          break;
        } catch (error) {
          reportError(`metrics history shutdown error (attempt ${attempt}/2)`, error);
        }
      }
      return stopResult;
    },
  };
}
