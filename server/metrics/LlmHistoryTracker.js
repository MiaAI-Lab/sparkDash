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
        if (Number.isFinite(waiting)) {
          set("queued", waiting > 0 ? 1 : 0);
        }
        if (Number.isFinite(running) && Number.isFinite(waiting)) {
          set("idle", running === 0 && waiting === 0 ? 1 : 0);
        }
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

        // 1.0 = every running stream decodes at its measured per-stream rate.
        const runningCount = Number(running);
        const gen = Number(entry.generationTps);
        const per = Number(entry.perStreamTps);
        if (
          Number.isFinite(runningCount) &&
          runningCount > 0 &&
          Number.isFinite(gen) &&
          gen >= 0 &&
          Number.isFinite(per) &&
          per > 0
        ) {
          set("decodeEfficiency", Math.min(1, gen / (runningCount * per)));
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

        // TTFT includes queue wait + prefill; shares cover queue + prefill + decode.
        const prefill = out[llmKey(port, "prefillSeconds")];
        const decode = out[llmKey(port, "decodeSeconds")];
        const ttft = out[llmKey(port, "ttftTime")];
        if (finite(prefill) && finite(ttft)) {
          const queue = Math.max(0, ttft - prefill);
          set("queueWait", queue);
          const total = prefill + (finite(decode) ? decode : 0) + queue;
          if (total > 0) set("prefillShare", Math.min(1, Math.max(0, prefill / total)));
        }
        // End-to-end minus TTFT and decode is request overhead.
        const latency = out[llmKey(port, "latencyTime")];
        if (finite(latency) && finite(ttft) && finite(decode)) {
          set("overheadSeconds", Math.max(0, latency - ttft - decode));
        }
      });

      return out;
    },
  };
}
