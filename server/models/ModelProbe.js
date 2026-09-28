/**
 * ModelProbe — is a model actually up?
 *
 * Runs on its own timer, independent of the Spark monitors, so the panel is
 * correct even when every browser tab is closed (the scheduler needs that: it
 * must not inherit `updateClientState()`'s pause).
 *
 * Two independent signals, OR'd together:
 *   1. `docker ps --format '{{.Names}}' | grep -qx <name>` — the container the
 *      repo's start.sh creates. Cheap and definitive when configured.
 *   2. `GET http://<probe host>:<port>/v1/models` — answers for a model whose
 *      server is ready to serve, even if the container is named differently
 *      (or runs on the worker only).
 *
 * Both signals are TARGET-AWARE: a model's container lives on the Spark
 * assigned to its card, and its port only answers where it is bound. One
 * `docker ps` per distinct target (a local exec, or a single SSH round-trip
 * per Spark — never one exec per model), and ports are asked against the
 * Spark's probe host (`llmProbeHost`, the same rule the LLM panel uses). A
 * model whose target cannot be resolved (no Spark assigned, Spark deleted)
 * gets an error status and produces no traffic at all.
 *
 * Port attribution only contends WITHIN one machine: two models on different
 * Sparks may share port 8000 and both be up — each owns its own :8000 verdict.
 */
import { execOnTarget } from "./hostExec.js";
import { llmProbeHost } from "../collectors/llmHost.js";
import { LLM_PROBE_TIMEOUT_MS } from "../config.js";

/** The implicit target when a caller has no target resolution (legacy/dev). */
export const LOCAL_TARGET = { kind: "local", key: "local", label: "local host" };

/** (target key, port) pair key — ports contend per machine, not globally. */
function pk(key, port) {
  return `${key}:${port}`;
}

/** Split a pk back into [key, port] (keys themselves contain ':'). */
function upk(portKey) {
  const i = portKey.lastIndexOf(":");
  return [portKey.slice(0, i), portKey.slice(i + 1)];
}

/**
 * List running container names on one target with one command.
 * Returns null on failure (dockerd unreachable / SSH down / nsenter missing)
 * so callers can distinguish "not running" from "unknown".
 * A non-zero exit is ALWAYS unknown, even with partial stdout: a `docker ps`
 * that died mid-print would otherwise report the truncated list as the truth,
 * and a container that dropped out of the tail of that output reads as
 * *confirmed* down — which is exactly how an exclusive Start ends up skipping
 * the incumbent's stop and colliding on its port.
 * @param {ReturnType<import("./hostExec.js").resolveRunTarget>} [target]
 * @returns {Promise<Set<string>|null>}
 */
export async function listRunningContainers(target = LOCAL_TARGET) {
  const res = await execOnTarget(target, "docker ps --format '{{.Names}}' 2>/dev/null", {
    timeoutMs: 6000,
  });
  if (res.error || res.code !== 0) return null;
  return new Set(
    res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
  );
}

/**
 * The HTTP host that can reach a port ON A TARGET: loopback for the local
 * host, the Spark's LAN IP for an SSH target (loopback binds are then only
 * reachable from that machine — same accepted trade-off as the LLM panel).
 * @param {ReturnType<import("./hostExec.js").resolveRunTarget>} target
 */
export function probeHostFor(target) {
  if (!target || target.kind !== "ssh") return "127.0.0.1";
  return llmProbeHost(target.spark) || target.spark?.ssh?.host || "127.0.0.1";
}

/**
 * Probe one candidate port for an OpenAI-compatible /v1/models.
 * @param {number|string} port
 * @param {number} [timeoutMs]
 * @param {string} [host] probe host — loopback unless the model lives remote
 * @returns {Promise<{ ok: boolean, modelId: string|null, status: number|null, error: string|null }>}
 */
export async function probeModelPort(port, timeoutMs = LLM_PROBE_TIMEOUT_MS, host = "127.0.0.1") {
  const url = `http://${host}:${port}/v1/models`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      return { ok: false, modelId: null, status: res.status, error: `HTTP ${res.status}` };
    }
    let modelId = null;
    try {
      const data = JSON.parse(text);
      const first = Array.isArray(data?.data) ? data.data[0] : null;
      modelId = typeof first?.id === "string" ? first.id : null;
    } catch {
      /* non-JSON body still proves the port is answering */
    }
    return { ok: true, modelId, status: res.status, error: null };
  } catch (err) {
    const msg = err?.name === "TimeoutError" ? "timeout" : err?.message || String(err);
    return { ok: false, modelId: null, status: null, error: msg };
  }
}

/**
 * Fold probe results onto model configs. Pure — the caller owns the cache so
 * the WS payload can stay byte-stable between ticks.
 *
 * Port attribution: every kit here serves on the same 8000, so "something
 * answers on :8000" does NOT prove *this* model is up. When a container for
 * that port is confirmed up, that container owns the port and the other
 * models probing it are told the port is held elsewhere. Only when no
 * container claims the port does a bare port answer prove liveness. All of
 * this is scoped to ONE machine: the same port on a different Spark is a
 * different question with a different answer.
 *
 * @param {object[]} models registry configs
 * @param {{ containers: Map<string, Set<string>|null>, ports: Record<string, {ok:boolean, modelId:string|null, error:string|null}>, keys: Record<string, string|null>, reasons?: Record<string, string>, checkedAt?: number }} result
 *   `ports` is keyed by `${targetKey}:${port}` (see probeModels)
 * @returns {Record<string, { running: boolean, containerUp: boolean, portUp: boolean,
 *   portChecked: boolean, modelId: string|null, checkedAt: number, error: string|null }>}
 */
export function buildModelStatus(models, result) {
  const out = {};
  const containers = result?.containers; // Map<targetKey, Set|null>
  const ports = result?.ports || {};
  const keys = result?.keys || {};
  const reasons = result?.reasons || {};
  // A result without `keys` is the legacy single-host shape: everything local.
  const keyOf = (m) => (result?.keys ? (keys[m.id] ?? null) : "local");

  // (key,port) → model that owns it via a confirmed-up container.
  const portOwner = new Map();
  if (containers) {
    for (const m of models) {
      if (m.port == null || !m.container) continue;
      const key = keyOf(m);
      if (key == null) continue;
      const set = containers.get(key);
      if (set && set.has(m.container)) portOwner.set(pk(key, m.port), m);
    }
  }

  for (const m of models) {
    const key = keyOf(m);
    if (key == null) {
      // Unresolvable target: no traffic was sent, nothing is known except
      // that the operator must fix the assignment. Never read as "down".
      out[m.id] = {
        running: false,
        containerUp: null,
        portUp: null,
        portChecked: false,
        modelId: null,
        checkedAt: result?.checkedAt ?? null,
        error: reasons[m.id] || "No Spark assigned",
      };
      continue;
    }
    const set = containers ? containers.get(key) : null;
    const containerUp = set ? Boolean(m.container && set.has(m.container)) : null;
    const portKey = m.port != null ? pk(key, m.port) : null;
    const portRes = portKey ? ports[portKey] || null : null;
    const owner = portKey ? portOwner.get(portKey) || null : null;
    const heldByOther =
      portRes?.ok && owner && owner.id !== m.id ? owner.name || owner.id : null;

    /**
     * `portChecked` records whether :port was actually asked this tick. When a
     * confirmed container settles the question the GET is skipped and the
     * verdict comes from the container list instead — strictly more honest than
     * a request that could only ever answer "someone else is holding it".
     */
    let portUp = null;
    let portChecked = true;
    let modelId = null;
    if (portRes) {
      portUp = portRes.ok ? !heldByOther : false;
      modelId = heldByOther ? null : portRes.modelId ?? null;
    } else if (owner && set) {
      portChecked = false; // docker ps settled it, no HTTP needed
      portUp = owner.id === m.id;
    } else if (m.port != null) {
      portChecked = false; // docker failed and this port was not asked
    }
    // Unknown container status (docker check failed) must not read as down.
    const running = Boolean(containerUp === true || (portChecked && portUp === true));
    const errors = [];
    if (!set && m.container)
      errors.push(key === "local" ? "docker ps unavailable" : `docker ps unavailable on ${key}`);
    if (heldByOther) errors.push(`:${m.port} answering but held by ${heldByOther}`);
    else if (!portChecked && owner && owner.id !== m.id)
      errors.push(`:${m.port} held by ${owner.name || owner.id}`);
    else if (portRes && !portRes.ok && portRes.error) errors.push(`:${m.port} ${portRes.error}`);

    out[m.id] = {
      running,
      containerUp,
      portUp: portChecked || owner ? portUp : null,
      portChecked,
      modelId,
      checkedAt: result?.checkedAt ?? null,
      error: errors.length ? errors.join("; ") : null,
    };
  }
  return out;
}

/**
 * Did a probe verdict PROVE the model is down? Only when both signals said a
 * hard no: `docker ps` answered (containerUp is the confirmed false, not the
 * unknown null) and the model's container was NOT in the list, and the port is
 * not serving it either — refused, unchecked-with-no-verdict, or held by
 * another model's confirmed container.
 *
 * This is the incumbent filter for the exclusive Start/Restart: everything
 * that is not *provably* down must be stopped first. Uncertainty reads as
 * incumbent on purpose — a model invisible to docker (container-name drift) or
 * invisible to the LAN probe (loopback bind, 3 s timeout under load) still
 * holds the GPU and the port, and skipping its stop is the exact failure that
 * makes the new kit's own port validation the only guard. Stopping an
 * already-stopped model costs one cheap idempotent stop.sh.
 *
 * @param {{running?: boolean, containerUp?: boolean|null, portUp?: boolean|null}|null|undefined} st
 * @param {{port?: number|null}} model
 */
export function certainlyDown(st, model) {
  if (!st || st.running !== false) return false;
  if (st.containerUp !== false) return false; // docker unknown → no proof
  if (model?.port == null) return true; // no port left to contradict the container miss
  return st.portUp === false; // null = unknown verdict → not proof
}

/**
 * Which (target,port) pairs still need an HTTP probe, given the
 * running-container lists.
 *
 * Only ONE model can run at a time per machine (that is what this panel exists
 * to guarantee), so the container list already settles most questions — on
 * each machine independently:
 *
 *  - Port P is *owned* by the model whose container is confirmed up on P of
 *    that target. That model's liveness is proven by the container, and every
 *    other model probing P there is known not to be the one answering — a GET
 *    for either would only re-derive what docker already told us. Skipped.
 *  - A port nobody owns is probed: either it is refused (cheap) or something
 *    unscheduled answers it, which is news worth having.
 *  - `forcePorts` (a start/restart job in flight, or the manual Refresh
 *    button) are always probed — readiness detection has to watch the port
 *    flip up while the container exists but is still loading weights.
 *
 * @param {object[]} models
 * @param {Map<string, Set<string>|null>} containers targetKey → running names (or null when unknown)
 * @param {Set<string>} [forcePorts] port numbers (as strings) that must be probed regardless
 * @param {(model: object) => string|null} [keyOf] model → target key, null = unresolvable
 * @returns {Set<string>} `${targetKey}:${port}` keys to probe
 */
export function portsNeedingProbe(models, containers, forcePorts = new Set(), keyOf = () => "local") {
  const wanted = new Set();
  const owners = new Set();
  if (containers) {
    for (const m of models) {
      const key = keyOf(m);
      if (key == null || m.port == null || !m.container) continue;
      const set = containers.get(key);
      if (set && set.has(m.container)) owners.add(pk(key, m.port));
    }
  }
  for (const m of models) {
    const key = keyOf(m);
    if (key == null) continue; // unassigned: no traffic, error status instead
    if (!Number.isInteger(m.port) || m.port < 1 || m.port > 65535) continue;
    const portKey = pk(key, m.port);
    if (forcePorts.has(String(m.port))) wanted.add(portKey);
    else if (owners.has(portKey)) continue; // settled by docker ps
    else wanted.add(portKey);
  }
  return wanted;
}

/**
 * Poll every model once. Never throws; on infrastructure failure a target's
 * container list reports null so the caller can keep the previous status.
 *
 * Container lists are fetched first because they decide how much HTTP work is
 * left (see portsNeedingProbe): with one model running that is normally a
 * single `docker ps` and ZERO port probes.
 *
 * @param {object[]} models
 * @param {{ portTimeoutMs?: number, fetchPort?: typeof probeModelPort, listContainers?: typeof listRunningContainers, forcePorts?: Iterable<string|number>, targetFor?: (model: object) => object }} [opts]
 *   `targetFor` maps a model to its run target (hostExec.resolveRunTarget
 *   shape); the default probes everything on the local host.
 */
export async function probeModels(models, opts = {}) {
  const targetFor = opts.targetFor || (() => LOCAL_TARGET);
  const listContainers = opts.listContainers || listRunningContainers;
  const fetchPort = opts.fetchPort || probeModelPort;
  const portTimeoutMs = opts.portTimeoutMs || LLM_PROBE_TIMEOUT_MS;
  const forcePorts = new Set(Array.from(opts.forcePorts || []).map(String));

  // Resolve every model's target exactly once; ports and containers share it.
  const keys = {};
  const reasons = {};
  /** @type {Map<string, object>} targetKey → target */
  const byTarget = new Map();
  for (const m of models) {
    let t;
    try {
      t = targetFor(m);
    } catch (err) {
      t = { kind: null, error: err?.message || String(err) };
    }
    if (!t || t.kind === null) {
      keys[m.id] = null;
      reasons[m.id] = t?.error || "No run target";
      continue;
    }
    keys[m.id] = t.key || LOCAL_TARGET.key;
    if (!byTarget.has(keys[m.id])) byTarget.set(keys[m.id], t);
  }
  const keyOf = (m) => keys[m.id] ?? null;

  const containers = new Map(
    await Promise.all(
      [...byTarget.entries()].map(async ([key, target]) => {
        const set = await Promise.resolve()
          .then(() => listContainers(target))
          .catch(() => null);
        return [key, set ?? null];
      })
    )
  );

  const wantedPorts = [...portsNeedingProbe(models, containers, forcePorts, keyOf)];
  const portResults = await Promise.all(
    wantedPorts.map(async (portKey) => {
      const [key, port] = upk(portKey);
      const r = await fetchPort(port, portTimeoutMs, probeHostFor(byTarget.get(key))).catch(
        (err) => ({
          ok: false,
          modelId: null,
          status: null,
          error: err?.message || String(err),
        })
      );
      return [portKey, r];
    })
  );

  return {
    containers,
    ports: Object.fromEntries(portResults),
    keys,
    reasons,
    // Caller replaces this before diffing; kept out of the WS payload.
    checkedAt: Date.now(),
  };
}

/**
 * Did at least one target answer `docker ps` this tick? ModelLauncher uses
 * this (instead of the old single `containers === null` check) to decide
 * whether the probe pass as a whole was informative.
 * @param {Awaited<ReturnType<typeof probeModels>>} result
 */
export function containersKnown(result) {
  if (!result?.containers) return false;
  for (const set of result.containers.values()) if (set !== null) return true;
  return false;
}
