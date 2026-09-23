/**
 * LlmTokenRuntime — glue that connects the token ledger to the running
 * server without coupling it to SparkMonitor internals.
 *
 * Local-only module (like server/energy/FleetEnergyRuntime.js): index.js only
 * needs createLlmTokenRuntime() + registerLlmTokenTotalsRoute().
 */
import { extractTokenObservations, normalizeLlmTokenRange } from "./LlmTokenLedger.js";

/** Ledger sampling cadence. Independent of the probe poll interval on purpose. */
const TOKEN_SAMPLE_INTERVAL_MS = 15_000;

/** Convenience re-export so index.js needs a single import for the whole feature. */
export { llmTokenLedger } from "./LlmTokenLedger.js";

/**
 * Build the read-only Express handler for GET /api/llm-token-totals.
 * Optional `?range=` (all | today | 7d | 14d | 30d); invalid values fall back to all.
 * @param {import("./LlmTokenLedger.js").LlmTokenLedger} ledger
 */
export function createLlmTokenTotalsHandler(ledger) {
  return (req, res) =>
    res.json(ledger.snapshot(normalizeLlmTokenRange(req?.query?.range)));
}

/** Register the read-only token-totals endpoint. */
export function registerLlmTokenTotalsRoute(app, ledger) {
  return app.get("/api/llm-token-totals", createLlmTokenTotalsHandler(ledger));
}

/**
 * Own the ledger lifecycle: sampling tick + graceful close. The tick derives
 * observations straight from orderedSnapshots() (same input the fleet-energy
 * sampler uses), so nothing else in the server needs to know this exists.
 */
export function createLlmTokenRuntime({
  ledger,
  orderedSnapshots,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logError = console.error,
}) {
  let started = false;
  let stopped = false;
  let timer = null;
  let stopResult = false;

  const reportError = (message, error) => {
    try {
      logError(message, error);
    } catch {
      // Logging must never prevent shutdown from continuing.
    }
  };

  const tick = () => {
    if (stopped) return;
    try {
      ledger.record(extractTokenObservations(orderedSnapshots()), now());
    } catch (error) {
      reportError("llm token ledger sample error", error);
    }
  };

  return {
    start() {
      if (started || stopped) return false;
      started = true;
      tick();
      timer = setIntervalFn(tick, TOKEN_SAMPLE_INTERVAL_MS);
      return true;
    },

    stop() {
      if (stopped) return stopResult;
      stopped = true;
      if (timer !== null) {
        try {
          clearIntervalFn(timer);
        } catch (error) {
          reportError("llm token ledger timer shutdown error", error);
        }
        timer = null;
      }
      try {
        ledger.close();
        stopResult = true;
      } catch (error) {
        reportError("llm token ledger shutdown error", error);
      }
      return stopResult;
    },
  };
}
