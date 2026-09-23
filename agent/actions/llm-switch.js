/**
 * llm-switch.js — node-agent action: switch the active LLM.
 *
 * switchLlm(oldPort, newPort): stop old → start new → canary probe → report.
 *
 * Management mechanism is caller-supplied — the recipe catalog knows how
 * each service is managed (Batch 2B does not read recipes; the wiring batch
 * passes them through opts):
 *   opts.oldUnit / opts.newUnit        → `systemctl stop|start <unit>`
 *   opts.oldContainer / opts.newContainer → `docker stop|start <name>`
 * oldPort null/0 → nothing to stop (first boot); skip straight to start.
 *
 * Canary (sglang-oriented — the switch fields in shared/types.ts,
 * mem_fraction_static / tp_size / context_length, are sglang parameters):
 *   phase 1: poll /health until 200            (budget: canaryTimeoutMs)
 *   phase 2: poll /get_server_info until 200   (budget: canaryTimeoutMs)
 *   state:
 *     "ready"   /health 200 + /get_server_info 200 with parsable object
 *     "stopped" /health 404 (server up, endpoint absent — definitive)
 *     "wedged"  /health 200 but /get_server_info 404
 *     "loading" everything else: refused/timeout/5xx/budget exhausted.
 *               Fetch failures degrade to "loading", never "stopped".
 *
 * ActionResponse.status mapping (seam union is success|failure|running —
 * the canary state word travels in message/error, not in status):
 *   ready   → ok=true,  status="success"
 *   loading → ok=true,  status="running" (stop+start succeeded; LLM settling)
 *   wedged  → ok=false, status="failure", error="canary: wedged"
 *   stopped → ok=false, status="failure", error="canary: stopped"
 *
 * Idempotent goal-state tolerances (docker quirks, exit 1 only):
 *   docker start + stderr /already running/    → treated as ok
 *   docker stop  + stderr /no such container/  → treated as ok (nothing to stop)
 *
 * Never throws/rejects — always resolves with an ActionResponse.
 */
import { normalizeModelId } from "../collectors/llm.js";
import {
  runExec,
  buildActionResponse,
  withIdempotency,
  isValidUnitName,
} from "./systemd.js";

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_CANARY_TIMEOUT_MS = 30000;
const DEFAULT_POLL_MS = 500;
const PER_REQUEST_TIMEOUT_MS = 3000;
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.\-]{0,127}$/;

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {unknown} n */
function numOrNull(n) {
  const v = typeof n === "string" ? Number(n) : n;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * True when `name` is a safe docker container name (docker charset,
 * no whitespace / metacharacters).
 * @param {unknown} name
 * @returns {boolean}
 */
export function isValidContainerName(name) {
  return typeof name === "string" && CONTAINER_NAME_RE.test(name);
}

/**
 * True when `p` is a valid TCP port (integers 1–65535; numeric strings ok).
 * @param {unknown} p
 * @returns {boolean}
 */
export function validPort(p) {
  const n = typeof p === "string" ? Number(p) : p;
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/**
 * Parse a sglang /get_server_info payload into canary fields.
 * Mirrors agent/collectors/llm.js applySglangInfo.
 * @param {object} info
 */
function parseServerInfo(info) {
  let modelId = null;
  if (info.model_path != null && String(info.model_path).trim()) {
    const s = String(info.model_path).trim();
    modelId = normalizeModelId(s);
    if (modelId && modelId.startsWith("/")) modelId = modelId.split("/").pop();
  }
  const contextLength =
    numOrNull(info.context_length) ?? numOrNull(info.max_total_tokens);
  const memFraction = numOrNull(info.mem_fraction_static);
  const tpSize = numOrNull(
    info.tp_size ?? info.tensor_parallel_size ?? info.num_tp_gpus
  );
  return { state: "ready", modelId, contextLength, memFraction, tpSize };
}

/**
 * Canary-probe one LLM port: /health, then /get_server_info.
 * @param {number|string|null|undefined} port
 * @param {{
 *   actionId?: string,
 *   serviceName?: string,
 *   timeoutMs?: number|null,
 *   canaryTimeoutMs?: number|null,
 *   pollMs?: number|null,
 *   fetch?: (url: string, opts?: object) => Promise<any>
 * }} [opts]
 * @returns {Promise<{
 *   state: "ready"|"loading"|"wedged"|"stopped",
 *   modelId: string|null,
 *   contextLength: number|null,
 *   memFraction: number|null,
 *   tpSize: number|null
 * }>}
 */
export async function canaryProbe(port, opts = {}) {
  const o = opts || {};
  const p = typeof port === "string" ? Number(port) : port;
  const fetchFn = typeof o.fetch === "function" ? o.fetch : globalThis.fetch;
  /** @param {string} state */
  const result = (state) => ({
    state,
    modelId: null,
    contextLength: null,
    memFraction: null,
    tpSize: null,
  });

  if (!validPort(p)) return result("stopped");
  if (typeof fetchFn !== "function") return result("loading");

  const budgetMs =
    Number.isFinite(o.canaryTimeoutMs) && o.canaryTimeoutMs > 0
      ? o.canaryTimeoutMs
      : DEFAULT_CANARY_TIMEOUT_MS;
  const pollMs =
    Number.isFinite(o.pollMs) && o.pollMs > 0 ? o.pollMs : DEFAULT_POLL_MS;
  const base = `http://127.0.0.1:${p}`;

  // Phase 1 — /health until 200. 404 is definitive ("stopped"); refused,
  // timeouts and 5xx keep polling until the budget expires ("loading").
  const healthStart = Date.now();
  let healthy = false;
  let stopped = false;
  for (;;) {
    const remaining = budgetMs - (Date.now() - healthStart);
    if (remaining <= 0) break;
    try {
      const res = await fetchFn(`${base}/health`, {
        signal: AbortSignal.timeout(Math.min(PER_REQUEST_TIMEOUT_MS, remaining)),
      });
      if (res.status === 200) {
        healthy = true;
        break;
      }
      if (res.status === 404) {
        stopped = true;
        break;
      }
      // 5xx / other: server is up but not ready → keep polling.
    } catch {
      // refused / per-request timeout / network → keep polling (graceful).
    }
    await sleep(Math.min(pollMs, Math.max(0, budgetMs - (Date.now() - healthStart))));
  }
  if (stopped) return result("stopped");
  if (!healthy) return result("loading");

  // Phase 2 — /get_server_info until 200 with a parsable object.
  const infoStart = Date.now();
  for (;;) {
    const remaining = budgetMs - (Date.now() - infoStart);
    if (remaining <= 0) return result("loading");
    try {
      const res = await fetchFn(`${base}/get_server_info`, {
        signal: AbortSignal.timeout(Math.min(PER_REQUEST_TIMEOUT_MS, remaining)),
      });
      if (res.status === 404) return result("wedged");
      if (res.status === 200) {
        const info = await res.json().catch(() => null);
        if (info && typeof info === "object" && !Array.isArray(info)) {
          return parseServerInfo(info);
        }
        // 200 with an unparseable body: still settling → keep polling.
      }
      // other statuses → keep polling.
    } catch {
      // keep polling.
    }
    await sleep(Math.min(pollMs, Math.max(0, budgetMs - (Date.now() - infoStart))));
  }
}

/**
 * Switch the active LLM: stop old → start new → canary probe → report state.
 * @param {number|string|null} oldPort port of the LLM to stop; null/0 → skip
 * @param {number|string} newPort port the new LLM must serve on
 * @param {{
 *   actionId?: string,
 *   serviceName?: string,
 *   timeoutMs?: number|null,
 *   canaryTimeoutMs?: number|null,
 *   pollMs?: number|null,
 *   oldUnit?: string|null,
 *   newUnit?: string|null,
 *   oldContainer?: string|null,
 *   newContainer?: string|null,
 *   exec?: (file: string, args: string[], runOpts?: {timeoutMs?: number}) => Promise<any>,
 *   fetch?: (url: string, opts?: object) => Promise<any>
 * }} [opts]
 * @returns {Promise<import("./systemd.js").ActionResponse>}
 */
export function switchLlm(oldPort, newPort, opts = {}) {
  const o = opts || {};
  const exec = typeof o.exec === "function" ? o.exec : runExec;
  const actionId = typeof o.actionId === "string" ? o.actionId : "";
  const newP = typeof newPort === "string" ? Number(newPort) : newPort;
  const serviceName =
    typeof o.serviceName === "string" && o.serviceName.length > 0
      ? o.serviceName
      : validPort(newP)
        ? `llm:${newP}`
        : "llm";
  const timeoutMs =
    Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_TIMEOUT_MS;

  return withIdempotency(actionId, async () => {
    const t0 = Date.now();
    /** @param {string} message @param {string} error @returns {import("./systemd.js").ActionResponse} */
    const fail = (message, error) =>
      buildActionResponse({
        actionId,
        serviceName,
        status: "failure",
        ok: false,
        message,
        error,
        durationMs: Date.now() - t0,
      });

    if (!validPort(newP)) {
      return fail(`invalid newPort: ${JSON.stringify(newPort)}`, "invalid newPort");
    }
    const oldP = oldPort == null ? 0 : typeof oldPort === "string" ? Number(oldPort) : oldPort;
    if (oldP !== 0 && !validPort(oldP)) {
      return fail(`invalid oldPort: ${JSON.stringify(oldPort)}`, "invalid oldPort");
    }

    // 1. Stop the old LLM (systemd unit or docker container, per recipe).
    if (oldP !== 0) {
      if (isValidUnitName(o.oldUnit)) {
        const r = await exec("systemctl", ["stop", o.oldUnit], { timeoutMs });
        if (r.notFound) return fail("systemctl not found", "systemctl not found");
        if (r.timedOut)
          return fail(
            `systemctl stop ${o.oldUnit} → timed out after ${timeoutMs}ms (state unknown)`,
            "timeout"
          );
        if (r.exitCode !== 0)
          return fail(
            `systemctl stop ${o.oldUnit} → exit ${r.exitCode}`,
            r.stderr.trim() || `exit ${r.exitCode}`
          );
      } else if (isValidContainerName(o.oldContainer)) {
        const r = await exec("docker", ["stop", o.oldContainer], { timeoutMs });
        if (r.notFound) return fail("docker not found", "docker not found");
        if (r.timedOut)
          return fail(
            `docker stop ${o.oldContainer} → timed out after ${timeoutMs}ms (state unknown)`,
            "timeout"
          );
        // "No such container" → nothing to stop; goal state already reached.
        if (r.exitCode !== 0 && !/no such container/i.test(r.stderr))
          return fail(
            `docker stop ${o.oldContainer} → exit ${r.exitCode}`,
            r.stderr.trim() || `exit ${r.exitCode}`
          );
      } else {
        return fail(
          `cannot stop old LLM on port ${oldP}: no oldUnit or oldContainer specified`,
          "old LLM not manageable"
        );
      }
    }

    // 2. Start the new LLM.
    let started = null;
    if (isValidUnitName(o.newUnit)) {
      const r = await exec("systemctl", ["start", o.newUnit], { timeoutMs });
      if (r.notFound) return fail("systemctl not found", "systemctl not found");
      if (r.timedOut)
        return fail(
          `systemctl start ${o.newUnit} → timed out after ${timeoutMs}ms (state unknown)`,
          "timeout"
        );
      if (r.exitCode !== 0)
        return fail(
          `systemctl start ${o.newUnit} → exit ${r.exitCode}`,
          r.stderr.trim() || `exit ${r.exitCode}`
        );
      started = o.newUnit;
    } else if (isValidContainerName(o.newContainer)) {
      const r = await exec("docker", ["start", o.newContainer], { timeoutMs });
      if (r.notFound) return fail("docker not found", "docker not found");
      if (r.timedOut)
        return fail(
          `docker start ${o.newContainer} → timed out after ${timeoutMs}ms (state unknown)`,
          "timeout"
        );
      // "already running" → goal state already reached.
      if (r.exitCode !== 0 && !/already running/i.test(r.stderr))
        return fail(
          `docker start ${o.newContainer} → exit ${r.exitCode}`,
          r.stderr.trim() || `exit ${r.exitCode}`
        );
      started = o.newContainer;
    } else {
      return fail(
        `cannot start new LLM on port ${newP}: no newUnit or newContainer specified`,
        "new LLM not manageable"
      );
    }

    // 3. Canary probe, then report state.
    const probe = await canaryProbe(newP, o);
    const durationMs = Date.now() - t0;
    if (probe.state === "ready") {
      return buildActionResponse({
        actionId,
        serviceName,
        status: "success",
        ok: true,
        message: `LLM switch complete: ${started} → port ${newP} ready (model: ${probe.modelId ?? "unknown"})`,
        error: null,
        durationMs,
      });
    }
    if (probe.state === "loading") {
      return buildActionResponse({
        actionId,
        serviceName,
        status: "running",
        ok: true,
        message: `LLM switch: ${started} started on port ${newP}, still loading (canary not ready within budget)`,
        error: null,
        durationMs,
      });
    }
    if (probe.state === "wedged") {
      return buildActionResponse({
        actionId,
        serviceName,
        status: "failure",
        ok: false,
        message: `LLM on port ${newP} is wedged: /health OK but /get_server_info 404`,
        error: "canary: wedged",
        durationMs,
      });
    }
    return buildActionResponse({
      actionId,
      serviceName,
      status: "failure",
      ok: false,
      message: `LLM on port ${newP} did not come up: /health 404 (stopped)`,
      error: "canary: stopped",
      durationMs,
    });
  });
}
