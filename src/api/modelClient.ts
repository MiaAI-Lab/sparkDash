/**
 * Model launcher API client — isolated from api/client.ts so the feature's
 * merge surface stays in one new file plus a few additive lines elsewhere.
 * Uses the same apiFetch conventions (throw Error(body.error)).
 */
import type {
  ModelAction,
  ModelActionResponse,
  ModelConfig,
  ModelJob,
  SchedulerConfig,
  SchedulerPreview,
} from "./modelTypes";

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts?.body) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    ...opts,
    headers: { ...headers, ...(opts?.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Registry ──────────────────────────────────────────────
export function fetchModels(): Promise<{ models: ModelConfig[]; scheduler: SchedulerConfig }> {
  return apiFetch("/api/models");
}

export function addModel(config: ModelConfig): Promise<{ success: boolean; model: ModelConfig }> {
  return apiFetch("/api/models", { method: "POST", body: JSON.stringify(config) });
}

export function updateModel(
  id: string,
  patch: Partial<ModelConfig>
): Promise<{ success: boolean; model: ModelConfig }> {
  return apiFetch(`/api/models/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export function deleteModel(id: string): Promise<{ success: boolean; removed: ModelConfig }> {
  return apiFetch(`/api/models/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Nudge a model one slot in the card list: -1 = up, +1 = down. */
export function moveModel(
  id: string,
  delta: -1 | 1
): Promise<{ success: boolean; models: ModelConfig[] }> {
  return apiFetch(`/api/models/${encodeURIComponent(id)}/move`, {
    method: "POST",
    body: JSON.stringify({ delta }),
  });
}

/** Rewrite the whole card order in one shot (hand-edited config, future drag). */
export function setModelOrder(
  order: string[]
): Promise<{ success: boolean; models: ModelConfig[] }> {
  return apiFetch("/api/models/order", { method: "PUT", body: JSON.stringify({ order }) });
}

export function saveModelSchedule(
  id: string,
  schedule: ModelConfig["schedule"]
): Promise<{ success: boolean; model: ModelConfig }> {
  return apiFetch(`/api/models/${encodeURIComponent(id)}/schedule`, {
    method: "PUT",
    body: JSON.stringify({ schedule }),
  });
}

export function toggleModelSchedule(
  id: string,
  enabled: boolean
): Promise<{ success: boolean; model: ModelConfig }> {
  return apiFetch(`/api/models/${encodeURIComponent(id)}/schedule-toggle`, {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

// ─── Actions ───────────────────────────────────────────────
export function startModel(id: string): Promise<ModelActionResponse> {
  return apiFetch(`/api/models/${encodeURIComponent(id)}/start`, {
    method: "POST",
    body: JSON.stringify({ source: "manual" }),
  });
}

export function stopModel(id: string): Promise<ModelActionResponse> {
  return apiFetch(`/api/models/${encodeURIComponent(id)}/stop`, {
    method: "POST",
    body: JSON.stringify({ source: "manual" }),
  });
}

export function restartModel(id: string): Promise<ModelActionResponse> {
  return apiFetch(`/api/models/${encodeURIComponent(id)}/restart`, {
    method: "POST",
    body: JSON.stringify({ source: "manual" }),
  });
}

export function tailModelLogs(id: string): Promise<ModelActionResponse> {
  return apiFetch(`/api/models/${encodeURIComponent(id)}/logs`, {
    method: "POST",
    body: JSON.stringify({ source: "manual" }),
  });
}

// ─── Jobs ──────────────────────────────────────────────────
/**
 * Delta-poll a job transcript. `since` is the previous response's `since`
 * (a char cursor); omit it for a full snapshot.
 */
export function fetchModelJob(jobId: string, since: number | null): Promise<ModelJob> {
  const q = since != null ? `?since=${since}` : "";
  return apiFetch(`/api/models/jobs/${encodeURIComponent(jobId)}${q}`);
}

/**
 * Cancel a running job / drop a finished one.
 * `force` is required to actually tear down a running *mutating* job (the
 * modal's "Cancel script" button); without it the server only detaches the
 * transcript view, so closing a modal can never kill a model.
 */
export function deleteModelJob(
  jobId: string,
  force = false
): Promise<ModelJob | { success: boolean; removed: boolean; detached?: boolean }> {
  return apiFetch(
    `/api/models/jobs/${encodeURIComponent(jobId)}${force ? "?force=1" : ""}`,
    { method: "DELETE" }
  );
}

// ─── Scheduler ─────────────────────────────────────────────
export function fetchSchedulerConfig(): Promise<SchedulerConfig> {
  return apiFetch("/api/scheduler/config");
}

export function updateSchedulerConfig(patch: Partial<SchedulerConfig>): Promise<SchedulerConfig> {
  return apiFetch("/api/scheduler/config", { method: "PUT", body: JSON.stringify(patch) });
}

export function previewScheduler(body?: {
  at?: number;
  tz?: string;
}): Promise<SchedulerPreview> {
  return apiFetch("/api/scheduler/preview", { method: "POST", body: JSON.stringify(body || {}) });
}

export function clearSchedulerOverride(): Promise<{ success: boolean }> {
  return apiFetch("/api/scheduler/clear-override", { method: "POST" });
}

export function refreshModels(): Promise<{ ok: boolean; status: Record<string, unknown> }> {
  return apiFetch("/api/models/refresh", { method: "POST" });
}

export const MODEL_ACTION_LABEL: Record<ModelAction, string> = {
  start: "Start",
  stop: "Stop",
  restart: "Restart",
  logs: "Logs",
};
