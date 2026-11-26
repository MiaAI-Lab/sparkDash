import { llmKey } from "./historyTiers.js";

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/** Counters older than this are a gap, not one sample. */
const MAX_GAP_MS = 60_000;

/** Delta of two cumulative counters; null on first sample or reset. */
function delta(current, previous) {
  if (!finite(current) || current < 0) return { delta: null, next: previous };
  if (!finite(previous)) return { delta: null, next: current };
  if (current < previous) return { delta: null, next: current };
  return { delta: current - previous, next: current };
}

/** Live gauges plus per-sample counter deltas for each configured LLM port. */
export function createLlmHistoryTracker() {
  /** @type {Map<string, Map<number, { prev: Record<string, number|null>, at: number }>>} */
  const units = new Map();

  return {
    reset(unitId) {
      if (typeof unitId === "string") units.delete(unitId);
    },

    record(snapshot, atMs, isFresh = () => true) {
      if (!snapshot || snapshot.online !== true || !isFresh("llm")) return {};
      const unitId = snapshot.id;
      if (typeof unitId !== "string" || unitId === "") return {};
      const entries = Array.isArray(snapshot.metrics?.llm) ? snapshot.metrics.llm : [];
      const configured = Array.isArray(snapshot.llmPorts) ? snapshot.llmPorts : [];
      let ports = units.get(unitId);
      if (!ports) {
        ports = new Map();
        units.set(unitId, ports);
      }
      const out = {};

      entries.forEach((entry, index) => {
        const port = Number.isInteger(entry?.port) ? entry.port : configured[index];
        if (
          !Number.isInteger(port) ||
          !configured.includes(port) ||
          entry?.available !== true ||
          entry?.measurementValid === false
        ) {
          return;
        }
        let state = ports.get(port);
        if (!state) {
          state = { prev: {}, at: atMs };
          ports.set(port, state);
        }
        // Seed after a gap instead of reporting it as one interval.
        const gap = !finite(state.at) || atMs - state.at > MAX_GAP_MS;
        state.at = atMs;

        const set = (name, value) => {
          if (finite(value)) out[llmKey(port, name)] = value;
        };

        set("perStreamTps", entry.perStreamTps);
        const running = entry.slots?.running ?? entry.requestsRunning;
        const waiting = entry.slots?.waiting ?? entry.requestsWaiting;
        set("requestsRunning", running);
        set("requestsWaiting", waiting);
        set("slotsTotal", entry.slots?.total ?? entry.slotsTotal);
        // A positive rate means decoding even when the backend has no flag.
        const generating =
          entry.decodeActive === true ||
          (Number.isFinite(entry.generationTps) && entry.generationTps > 0);
        set("prefillActive", entry.prefillActive === true ? 1 : 0);
        set("decodeActive", generating ? 1 : 0);
        set("cacheHitRate", entry.prefixCacheHitRate);
        set("mtpAcceptance", entry.mtpAcceptanceRate);
        set("prefillProgress", entry.prefillProgressTokens);
        set("generationProgress", entry.generationProgressTokens);
        if (finite(entry.deviceMemoryBytes)) {
          set("deviceMemory", entry.deviceMemoryBytes / 1024 ** 3);
        }

        const counters = [
          ["prefillSeconds", entry.prefillSecondsTotal],
          ["prefillCount", entry.prefillCountTotal],
          ["decodeSeconds", entry.decodeSecondsTotal],
          ["decodeCount", entry.decodeCountTotal],
          ["ttftTime", entry.ttftSecondsTotal],
          ["ttftCount", entry.ttftCountTotal],
          ["latencyTime", entry.latencySecondsTotal],
          ["latencyCount", entry.latencyCountTotal],
          ["tpotTime", entry.tpotSecondsTotal],
          ["tpotCount", entry.tpotCountTotal],
          ["preemptions", entry.preemptionsTotal],
          ["promptTokens", entry.totalPromptTokens],
          ["cachedTokens", entry.totalCachedTokens],
          ["genTokens", entry.totalOutputTokens],
          ["decodeRounds", entry.decodeRoundsTotal],
        ];
        for (const [name, current] of counters) {
          if (gap) {
            state.prev[name] = finite(current) && current >= 0 ? current : null;
            continue;
          }
          const { delta: d, next } = delta(current, state.prev[name]);
          state.prev[name] = next;
          if (d != null) set(name, d);
        }
      });

      return out;
    },
  };
}
