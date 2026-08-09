/**
 * ComfyUI mutation helpers (cancel / interrupt) — server-side only.
 */
import { COMFY_PORT, COMFY_PROBE_TIMEOUT_MS } from "../config.js";
import { isAllowedTargetHost } from "../validate.js";
import { llmProbeHost } from "./llmHost.js";

/**
 * @param {object} spark
 * @param {number} [port]
 */
function baseUrl(spark, port) {
  const host = llmProbeHost(spark);
  if (!isAllowedTargetHost(host)) {
    throw new Error(`Invalid or disallowed ComfyUI host: ${host}`);
  }
  const p =
    Number.isInteger(port) && port >= 1 && port <= 65535
      ? port
      : Number(spark?.comfyPort) || COMFY_PORT;
  return `http://${host}:${p}`;
}

/**
 * Cancel a ComfyUI job by prompt id.
 * Prefers /api/jobs/:id/cancel; falls back to interrupt + queue delete.
 *
 * @param {object} spark
 * @param {string} promptId
 * @param {number} [port]
 * @returns {Promise<{ ok: boolean, method: string, message: string }>}
 */
export async function comfyCancelJob(spark, promptId, port) {
  if (!promptId || typeof promptId !== "string") {
    return { ok: false, method: "none", message: "promptId required" };
  }
  const root = baseUrl(spark, port);
  const signal = AbortSignal.timeout(COMFY_PROBE_TIMEOUT_MS);

  // 1) Modern jobs API
  try {
    const res = await fetch(`${root}/api/jobs/${encodeURIComponent(promptId)}/cancel`, {
      method: "POST",
      signal,
    });
    if (res.ok || res.status === 200 || res.status === 204) {
      return { ok: true, method: "api_jobs_cancel", message: "cancelled" };
    }
    // 404 → try legacy paths
    if (res.status !== 404) {
      const text = await res.text().catch(() => "");
      // still try legacy below if not clearly ok
      if (res.status >= 500) {
        return {
          ok: false,
          method: "api_jobs_cancel",
          message: `HTTP ${res.status} ${text.slice(0, 120)}`,
        };
      }
    }
  } catch {
    /* fall through */
  }

  // 2) Interrupt running (targeted)
  try {
    await fetch(`${root}/interrupt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt_id: promptId }),
      signal: AbortSignal.timeout(COMFY_PROBE_TIMEOUT_MS),
    });
  } catch {
    /* ignore */
  }

  // 3) Delete from pending queue
  try {
    const res = await fetch(`${root}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [promptId] }),
      signal: AbortSignal.timeout(COMFY_PROBE_TIMEOUT_MS),
    });
    if (res.ok) {
      return { ok: true, method: "queue_delete", message: "removed from queue / interrupted" };
    }
  } catch (err) {
    return { ok: false, method: "queue_delete", message: err.message };
  }

  // Interrupt alone may have worked for running jobs
  return { ok: true, method: "interrupt", message: "interrupt requested" };
}
