/**
 * Detect an engine that moved to the worker node (#271).
 *
 * Workers are deliberately excluded from LLM polling (`SparkMonitor._llmMonitoringEnabled`),
 * heads are always polled. A recipe that starts rank 0 — and therefore the OpenAI API — on the
 * node configured as worker leaves the head's ports unanswered: the head's LLM panel reads
 * "API not ready" and the token totals stop, with nothing pointing at the cause.
 *
 * This detector probes a head's paired workers only while every one of the head's own ports is
 * down, throttled to one probe per window, and returns a display hint. It never writes registry
 * config and never swaps roles: moving rank 0 is the operator's call.
 */

/** Minimum gap between worker probes for one head while it stays down. */
export const MOVED_PROBE_INTERVAL_MS = 60_000;

/** Every configured port of an online head answered nothing. */
export function llmDown(snapshot) {
  if (!snapshot || snapshot.online !== true) return false;
  const llm = Array.isArray(snapshot.metrics?.llm) ? snapshot.metrics.llm : [];
  if (llm.length === 0) return false; // never polled — nothing to compare against
  return llm.every((entry) => entry?.available !== true);
}

/** Workers whose `workerHeadId` points at this head. */
export function pairedWorkers(head, sparks) {
  if (!head || head.role !== "head") return [];
  return (sparks || []).filter(
    (s) => s && s.id !== head.id && s.workerHeadId === head.id && s.online === true
  );
}

/** Ports to probe on a worker: its own `llmPorts`, else the legacy `llmPort`, else 8888. */
export function workerPorts(worker) {
  const raw = Array.isArray(worker?.llmPorts) && worker.llmPorts.length ? worker.llmPorts : null;
  const ports = raw ?? (Number.isInteger(worker?.llmPort) ? [worker.llmPort] : []);
  const valid = ports.filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535);
  return valid.length ? valid : [8888];
}

/**
 * @param {object} args
 * @param {object} args.head        head snapshot (`role: "head"`, `metrics.llm`, `online`)
 * @param {object[]} args.sparks    every fleet snapshot (workers carry `workerHeadId`)
 * @param {(worker: object, port: number) => Promise<object|null>} args.probe
 * @param {Map<string, {at: number, hint: object|null}>} [args.state] per-head throttle memory
 * @param {number} [args.now]
 * @returns {Promise<{workerId: string, workerName: string, port: number, modelId: string|null,
 *                    backend: string|null, message: string}|null>}
 */
export async function detectLlmMovedToWorker({ head, sparks, probe, state, now = Date.now() }) {
  if (!llmDown(head)) {
    state?.delete(head?.id);
    return null;
  }
  const workers = pairedWorkers(head, sparks);
  if (workers.length === 0) return null;

  const prev = state?.get(head.id);
  if (prev && now - prev.at < MOVED_PROBE_INTERVAL_MS) return prev.hint ?? null;

  let hint = null;
  for (const worker of workers) {
    for (const port of workerPorts(worker)) {
      let result = null;
      try {
        result = await probe(worker, port);
      } catch {
        result = null;
      }
      if (result?.available !== true) continue;
      const workerName = worker.name || worker.id;
      const headName = head.name || head.id;
      const modelId = typeof result.modelId === "string" && result.modelId.trim() ? result.modelId.trim() : null;
      hint = {
        workerId: worker.id,
        workerName,
        port,
        modelId,
        backend: result.backend || null,
        message:
          `${workerName} answers on port ${port}${modelId ? ` (${modelId})` : ""} while ` +
          `${headName} does not. The engine may have moved to the worker — swap head and worker?`,
      };
      break;
    }
    if (hint) break;
  }

  state?.set(head.id, { at: now, hint });
  return hint;
}
