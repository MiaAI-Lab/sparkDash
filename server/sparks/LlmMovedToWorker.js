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
 *
 * Reach: each probe is a one-shot direct request, so it only finds an engine whose port is
 * reachable from the dashboard. LlmProbe's SSH-tunnel fallback needs two consecutive failures
 * on a probe that is kept alive (TUNNEL_AFTER_FAILURES), which a fresh probe per attempt never
 * accumulates, so an engine bound to the worker's localhost is not detected and no hint appears.
 * That is deliberate — a background detector should not open SSH tunnels to every paired worker
 * every window — and it means an absent hint is not evidence that the engine has not moved.
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

/**
 * Reconcile one refresh of the moved-engine hints for the whole fleet.
 *
 * Kept here rather than in the route file so the bookkeeping is testable: the three maps are
 * long-lived, and each of them has a way of going wrong that no amount of detector testing
 * would catch — an entry outliving the unit that owns it, or the same move being announced
 * over and over because a worker answers intermittently.
 *
 * @param {object} args
 * @param {object[]} args.sparks      every fleet snapshot, workers carrying `workerHeadId`
 * @param {Map<string, object>} args.hints      head id → current display hint
 * @param {Map<string, object>} args.probeState head id → detector throttle memory
 * @param {Map<string, object>} args.announced   head id → the move already reported as an event
 * @param {(head: object) => Promise<object|null>} args.detect
 * @param {(hint: object, headId: string) => void} [args.onEvent]
 */
export async function reconcileMovedEngineHints({ sparks, hints, probeState, announced, detect, onEvent }) {
  for (const snap of sparks || []) {
    if (snap.role !== "head" || !llmDown(snap)) {
      hints.delete(snap.id);
      probeState.delete(snap.id);
      // A head that answers again, or a unit that is no longer a head: the next move is news.
      announced.delete(snap.id);
      continue;
    }
    const hint = await detect(snap);
    if (!hint) {
      hints.delete(snap.id);
      continue;
    }
    hints.set(snap.id, hint);
    // Announce a move once, and again only when it names a different worker or port. A probe
    // that fails transiently clears the live hint, so comparing against that would re-announce
    // the same move every window for a worker that answers intermittently.
    const last = announced.get(snap.id);
    if (!last || last.workerId !== hint.workerId || last.port !== hint.port) {
      announced.set(snap.id, { workerId: hint.workerId, port: hint.port });
      onEvent?.(hint, snap.id);
    }
  }
  // A unit deleted from the registry leaves the snapshot list without passing through the loop,
  // so prune what it left behind against the live id set.
  const live = new Set((sparks || []).map((s) => s.id));
  for (const map of [hints, probeState, announced]) {
    for (const id of [...map.keys()]) if (!live.has(id)) map.delete(id);
  }
}
