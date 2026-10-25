/**
 * Proxy to the Mac agent's /control endpoint.
 *
 * This module never calls /metrics. A status read does not start a runtime;
 * start and stop run only when the dashboard asks, and only for a Mac node.
 */

import { macAgentBaseUrl, assertMacAgentTarget } from "./MacAgentCollector.js";

export const CONTROL_SCHEMA = "sparkdash.mac-control/1";
const STATUS_TIMEOUT_MS = 8000;
const ACTION_TIMEOUT_MS = 50000;

export function macControlToken(env = process.env) {
  return String(env.SPARKDASH_MAC_CONTROL_TOKEN || "").trim();
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

async function readBody(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function callAgent(spark, path, { fetchImpl, method = "GET", body, token, timeoutMs }) {
  let baseUrl;
  let response;
  try {
    baseUrl = macAgentBaseUrl(spark);
    await assertMacAgentTarget(baseUrl);
    response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch (err) {
    return unavailable(`mac agent unreachable at ${baseUrl} (${err.message})`);
  }
  const payload = await readBody(response);
  if (response.status === 404 && (!payload || payload.schema !== CONTROL_SCHEMA)) {
    return unavailable("this agent has no runtime control endpoint");
  }
  if (!payload || payload.schema !== CONTROL_SCHEMA) {
    if (response.status === 403) {
      return denied(payload?.error || payload?.reason || "runtime control permission denied");
    }
    return unavailable(payload?.error || `agent responded ${response.status}`);
  }
  return mapPayload(payload, { authorized: Boolean(token) });
}

export function runtimeControlHttpStatus(result) {
  if (result?.state === "denied") return 403;
  if (result?.state === "unavailable") return 503;
  return 200;
}

export async function readRuntimeControl(spark, { fetchImpl = globalThis.fetch, token = macControlToken() } = {}) {
  const blocked = assertMacControlSpark(spark);
  if (blocked) return blocked.body;
  if (!spark.agent) {
    return unavailable("Mac node agent is not configured; runtime control has nowhere to send an action");
  }
  return callAgent(spark, "/control", {
    fetchImpl,
    token,
    timeoutMs: STATUS_TIMEOUT_MS,
  });
}

export async function actRuntimeControl(spark, action, request = {}, {
  fetchImpl = globalThis.fetch,
  token = macControlToken(),
} = {}) {
  const blocked = assertMacControlSpark(spark);
  if (blocked) return blocked.body;
  if (!spark.agent) {
    return unavailable("Mac node agent is not configured; runtime control has nowhere to send an action");
  }
  if (action !== "start" && action !== "stop") {
    return unavailable(`unknown runtime control action ${action}`);
  }
  if (!token) {
    return denied("dashboard has no SPARKDASH_MAC_CONTROL_TOKEN; runtime control is not authorized");
  }
  const runtime = String(request.runtime || "").trim();
  if (!runtime) return unavailable("runtime is required");
  const body = { runtime };
  if (request.model) body.model = String(request.model);
  return callAgent(spark, `/control/${action}`, {
    fetchImpl,
    method: "POST",
    body,
    token,
    timeoutMs: ACTION_TIMEOUT_MS,
  });
}
