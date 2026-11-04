/**
 * Proxy to the Mac agent's /control endpoint.
 *
 * This module never calls /metrics. A status read does not start a runtime;
 * start and stop run only when the dashboard asks, and only for a Mac node.
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Agent, fetch as undiciFetch } from "undici";
import { macAgentBaseUrl, assertMacAgentTarget } from "./MacAgentCollector.js";
import { pinnedLookup } from "../validate.js";

export const CONTROL_SCHEMA = "sparkdash.mac-control/1";
const STATUS_TIMEOUT_MS = 8000;
const ACTION_TIMEOUT_MS = 680000;
// One current/last job per Spark, never a history. Completed fallbacks expire
// when the Mac supplies a newer operation, a new action starts, or after 10m.
const jobs = new Map();
const COMPLETED_TTL_MS = 600000;

function currentJob(id) {
  for (const [key, job] of jobs) {
    if (!job.pending && Date.now() - job.completedAt >= COMPLETED_TTL_MS) jobs.delete(key);
  }
  return jobs.get(id);
}

export function macControlToken(env = process.env) {
  const token = String(env.SPARKDASH_MAC_CONTROL_TOKEN || "").trim();
  if (token) return token;
  const path = env.SPARKDASH_MAC_CONTROL_TOKEN_FILE || fileURLToPath(new URL("../../config/mac-control-token", import.meta.url));
  try {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const info = fs.fstatSync(fd);
      if (!info.isFile() || info.size > 4096 || (info.mode & 0o077) || info.uid !== process.geteuid()) return "";
      return fs.readFileSync(fd, "utf8").trim();
    } finally { fs.closeSync(fd); }
  } catch { return ""; }
}

export function assertMacControlSpark(spark) {
  if (!spark) {
    return { status: 404, body: { state: "unavailable", error: "Spark not found", reason: "Spark not found" } };
  }
  if (spark.kind !== "mac") {
    const reason = "Runtime control is only available on the Apple Silicon Mac node";
    return { status: 404, body: { state: "unavailable", error: reason, reason } };
  }
  return null;
}

function unavailable(reason, extra = {}) {
  return {
    ...extra,
    state: "unavailable",
    reason,
    error: extra.error || reason,
    serving: extra.serving ?? null,
    targets: extra.targets ?? [],
    authorized: false,
  };
}

function denied(reason, extra = {}) {
  return {
    ...extra,
    state: "denied",
    reason,
    error: reason,
    serving: extra.serving ?? null,
    targets: extra.targets ?? [],
    authorized: false,
  };
}

function mapPayload(payload, { authorized }) {
  if (!payload || payload.schema !== CONTROL_SCHEMA) {
    return unavailable("agent returned an unexpected runtime-control payload");
  }
  const serving = payload.serving === null || Array.isArray(payload.serving) ? payload.serving : null;
  const targets = Array.isArray(payload.targets) ? payload.targets : [];
  const shared = {
    serving,
    targets,
    servingError: payload.servingError ?? null,
    ok: payload.ok,
    output: payload.output ?? null,
    action: payload.action ?? null,
    runtime: payload.runtime ?? null,
    model: payload.model ?? null,
    exitCode: payload.exitCode,
    busy: typeof payload.busy === "boolean" ? payload.busy : undefined,
    operation: mapOperation(payload.operation),
  };
  if (payload.control === "denied") {
    return denied(payload.reason || payload.error || "runtime control permission denied", shared);
  }
  if (payload.control === "disabled") {
    return unavailable(payload.reason || payload.error || "runtime control is not enabled on this agent", shared);
  }
  if (payload.control !== "ready") {
    return unavailable(payload.reason || "runtime control state is unknown", shared);
  }
  if (!authorized) {
    return denied(
      "dashboard has no SPARKDASH_MAC_CONTROL_TOKEN; runtime control is not authorized",
      shared,
    );
  }
  return {
    state: "ready",
    reason: null,
    error: payload.error ?? null,
    authorized: true,
    ...shared,
  };
}

function mapOperation(operation) {
  if (!operation || typeof operation.id !== "string" || !operation.id
      || !["running", "complete"].includes(operation.state)) return undefined;
  const mapped = { id: operation.id, state: operation.state };
  for (const key of ["runtime", "model", "action", "error", "output"]) {
    if (typeof operation[key] === "string" || (["error", "output"].includes(key) && operation[key] === null)) {
      mapped[key] = operation[key];
    }
  }
  if (typeof operation.ok === "boolean") mapped.ok = operation.ok;
  return mapped;
}

async function readBody(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function callAgent(spark, path, { fetchImpl = undiciFetch, method = "GET", body, token, timeoutMs, lookup }) {
  let baseUrl;
  let status = 0;
  let payload = null;
  try {
    // The control listener is the agent's unprivileged port and can differ from
    // the one serving privileged telemetry, so it replaces the port only.
    const endpoint = new URL(macAgentBaseUrl(spark));
    if (spark.agent?.controlPort) endpoint.port = String(spark.agent.controlPort);
    baseUrl = endpoint.toString().replace(/\/$/, "");
    // Resolve once and hand the checked addresses to the connection. Validating
    // here and letting the fetch resolve again would be two answers to one
    // question: the second could return a different address than was checked.
    const addresses = await assertMacAgentTarget(baseUrl, lookup ? { lookup } : undefined);
    // The command can take 600s, followed by a 60s readiness check. Undici's
    // default 300s header/body limits apply independently of AbortSignal, so the
    // pinned dispatcher has to carry that budget too.
    const dispatcher = new Agent({
      headersTimeout: ACTION_TIMEOUT_MS,
      bodyTimeout: ACTION_TIMEOUT_MS,
      connect: { lookup: pinnedLookup(addresses) },
    });
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
        dispatcher,
      });
      status = response.status;
      // Read the answer while the pinned connection is still open: closing the
      // dispatcher first would strand the body.
      payload = await readBody(response);
    } finally {
      await dispatcher.close();
    }
  } catch (err) {
    return unavailable(`mac agent unreachable at ${baseUrl} (${err.message})`);
  }
  if (status === 404 && (!payload || payload.schema !== CONTROL_SCHEMA)) {
    return unavailable("this agent has no runtime control endpoint");
  }
  if (!payload || payload.schema !== CONTROL_SCHEMA) {
    if (status === 403) {
      return denied(payload?.error || payload?.reason || "runtime control permission denied");
    }
    return unavailable(payload?.error || `agent responded ${status}`);
  }
  return mapPayload(payload, { authorized: Boolean(token) });
}

export function runtimeControlHttpStatus(result) {
  if (result?.state === "denied") return 403;
  if (result?.state === "unavailable") return 503;
  return 200;
}

function mergeJob(spark, status) {
  const job = currentJob(spark.id);
  if (!job) return status;
  if (job.pending) {
    return {
      ...status,
      busy: true,
      operation: status.operation?.state === "running" ? status.operation : job.operation,
    };
  }
  // A lost Node connection does not release the Mac's action lock. Only a
  // subsequent Mac status read can establish whether the command is done.
  if (status.busy) {
    return { ...status, operation: status.operation ?? job.operation, error: status.error || job.result.error };
  }
  if (status.operation && status.operation.id !== job.previousOperationId) {
    jobs.delete(spark.id);
    return status;
  }
  return {
    ...status,
    busy: status.state === "ready" ? false : status.busy,
    operation: job.operation,
    ok: job.operation.ok,
    error: job.operation.error ?? status.error,
    output: job.operation.output,
  };
}

export async function readRuntimeControl(spark, { fetchImpl, token = macControlToken(), lookup } = {}) {
  const blocked = assertMacControlSpark(spark);
  if (blocked) return blocked.body;
  if (!spark.agent) {
    return unavailable("Mac node agent is not configured; runtime control has nowhere to send an action");
  }
  const status = await callAgent(spark, "/control", {
    fetchImpl,
    token,
    timeoutMs: STATUS_TIMEOUT_MS,
    lookup,
  });
  return mergeJob(spark, status);
}

function actionProblem(spark, action, request, token) {
  const blocked = assertMacControlSpark(spark);
  if (blocked) return blocked.body;
  if (!spark.agent) return unavailable("Mac node agent is not configured; runtime control has nowhere to send an action");
  if (action !== "start" && action !== "stop") return unavailable("runtime control action must be start or stop");
  if (!token) return denied("dashboard has no SPARKDASH_MAC_CONTROL_TOKEN; runtime control is not authorized");
  if (typeof request.runtime !== "string" || !request.runtime.trim() || request.runtime.trim().length > 64) {
    return unavailable("runtime is required (a name of at most 64 characters)");
  }
  if (request.model != null && typeof request.model !== "string") return unavailable("model must be a string");
  return null;
}

/** Validate and reserve synchronously, then dispatch once without tying the
 * browser connection to the command lifetime. Reads never dispatch actions. */
export async function beginRuntimeControl(spark, action, request = {}, {
  fetchImpl = undiciFetch, token = macControlToken(), lookup,
} = {}) {
  const problem = actionProblem(spark, action, request, token);
  if (problem) return problem;
  const existing = currentJob(spark.id);
  if (existing?.pending) {
    return {
      state: "ready", reason: null, authorized: true, serving: null, targets: [],
      ...existing.view, busy: true, operation: existing.operation,
    };
  }
  // Reserve before the status await: concurrent requests must not both pass
  // an idle agent status and then dispatch duplicate actions.
  const job = { pending: true };
  jobs.set(spark.id, job);
  try {
    const status = await callAgent(spark, "/control", { fetchImpl, token, timeoutMs: STATUS_TIMEOUT_MS, lookup });
    if (status.state !== "ready" || status.busy) return status;
    const runtime = request.runtime.trim();
    const target = status.targets.find((row) => row.name === runtime);
    const refuse = (reason) => unavailable(reason, { ...status, ok: false });
    if (!target) return refuse(`unknown runtime ${runtime}`);
    if (target[action === "start" ? "startable" : "stoppable"] !== true) {
      return refuse(target.reason || `${runtime} cannot ${action}`);
    }
    const models = Array.isArray(target.models) ? target.models : [];
    let model = request.model?.trim() || undefined;
    if (model && !models.some((row) => row.id === model)) return refuse(`unknown model ${model} for runtime ${runtime}`);
    if (!model && action === "start") {
      if (models.length > 1) return refuse("model is required");
      model = models[0]?.id;
    }
    job.previousOperationId = status.operation?.id;
    job.operation = { id: randomUUID(), state: "running", runtime, ...(model ? { model } : {}), action };
    job.view = { ...status, busy: true, operation: job.operation, ok: undefined, error: null, output: null };
    const complete = (result) => {
      job.result = result;
      job.operation = result.operation?.state === "complete" ? result.operation : {
        ...job.operation, state: "complete", ok: result.ok === true,
        error: result.error ?? result.reason ?? null, output: result.output ?? null,
      };
      job.completedAt = Date.now();
      job.pending = false;
    };
    // actRuntimeControl owns the sole POST and its long timeout; never retry a
    // connection failure, since the Mac may still be executing the command.
    void actRuntimeControl(spark, action, { runtime, model }, { fetchImpl, token, lookup })
      .then(complete, (err) => complete(unavailable(`runtime control ${action} failed (${err.message})`)));
    return job.view;
  } finally {
    if (!job.operation) {
      if (existing) jobs.set(spark.id, existing);
      else jobs.delete(spark.id);
    }
  }
}

export async function actRuntimeControl(spark, action, request = {}, {
  fetchImpl = undiciFetch,
  token = macControlToken(),
  lookup,
} = {}) {
  const problem = actionProblem(spark, action, request, token);
  if (problem) return problem;
  const runtime = request.runtime.trim();
  const body = { runtime };
  if (request.model) body.model = String(request.model);
  return callAgent(spark, `/control/${action}`, {
    fetchImpl,
    method: "POST",
    body,
    token,
    timeoutMs: ACTION_TIMEOUT_MS,
    lookup,
  });
}
