import type {
  AlertChannel,
  AlertTestResult,
  AlertsConfig,
  AlertsConfigUpdate,
  AlertsResponse,
  VulnHuntInstallRequest,
  VulnHuntInstallStarted,
  VulnHuntInstallStream,
  VulnHuntJob,
  VulnHuntReportBundle,
  VulnHuntRun,
  VulnHuntScanRequest,
  VulnHuntSetup,
  VulnHuntStatus,
  VulnHuntStreamRead,
  ActivityEvent,
  ActivityEventsPage,
  EnergyHistory,
  MonthlyEnergy,
  TokenHistory,
  DecodeBenchJob,
  DecodeBenchListResponse,
  FleetEnergy,
  HealthResponse,
  InferenceActivity,
  HermesBatchUpdateResponse,
  GpuClockStatus,
  HermesUpdatesResponse,
  LauncherAction,
  LauncherJob,
  LauncherJobRead,
  LauncherListResponse,
  LlmLauncher,
  LlmLauncherInput,
  LlmMetrics,
  LlmDailyResponse,
  MetricsHistoryRange,
  MetricsHistoryResponse,
  Settings,
  ShowcaseListResponse,
  ShowcaseSessionState,
  ShowcaseStartRequest,
  ShowcaseStartResponse,
  SparkConfig,
  SparkTestResponse,
  StartDecodeBenchRequest,
  PrefillBenchJob,
  PrefillBenchListResponse,
  StartPrefillBenchRequest,
  QualityBenchJob,
  QualityBenchListResponse,
  StartQualityBenchRequest,
} from "./types";
import { VulnHuntApiError } from "./types";
import { authHeaders, reportAuthRequired } from "./authToken";

const BASE = "";

// ─── Generic fetch wrapper ────────────────────────────────
async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  // Only set Content-Type for requests that actually carry a body. Setting it
  // on GET/DELETE was a no-op but could trigger an unnecessary CORS preflight
  // (OPTIONS) in some proxy setups.
  const headers: Record<string, string> = {};
  if (opts?.body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { ...headers, ...authHeaders(), ...(opts?.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    // The server wants a token we do not have (or ours is stale): ask for one.
    if (res.status === 401) reportAuthRequired();
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Sparks CRUD ─────────────────────────────────────────
export function fetchSparks(): Promise<{ sparks: SparkConfig[] }> {
  return apiFetch("/api/sparks");
}

export function fetchFleetEnergy(): Promise<FleetEnergy> {
  return apiFetch("/api/fleet-energy");
}

/** Optional, sanitized inference request activity from a configured private source. */
export function fetchInferenceActivity(): Promise<InferenceActivity> {
  return apiFetch("/api/inference/activity");
}

/** Fleet activity log, newest first. */
export async function fetchEvents(opts?: {
  limit?: number;
  sparkId?: string;
  sinceId?: number;
}): Promise<ActivityEvent[]> {
  const q = new URLSearchParams();
  if (opts?.limit != null) q.set("limit", String(opts.limit));
  if (opts?.sparkId) q.set("sparkId", opts.sparkId);
  if (opts?.sinceId != null) q.set("sinceId", String(opts.sinceId));
  const qs = q.toString();
  const res = await apiFetch<{ events: ActivityEvent[] }>(`/api/events${qs ? `?${qs}` : ""}`);
  return Array.isArray(res.events) ? res.events : [];
}

/** Delete Activity history: everything, or only events older than `olderThanMs`. */
export function clearEvents(olderThanMs?: number): Promise<{ removed: number }> {
  const qs = olderThanMs != null ? `?olderThanMs=${Math.floor(olderThanMs)}` : "";
  return apiFetch(`/api/events${qs}`, { method: "DELETE" });
}

/** Whether this server can restart itself (Docker with a restart policy). */
export function fetchRestartAvailable(): Promise<{ available: boolean }> {
  return apiFetch("/api/restart");
}

/** Ask the server to restart; Docker brings it back a few seconds later. */
export function restartServer(): Promise<{ restarting: boolean }> {
  return apiFetch("/api/restart", { method: "POST" });
}

/** Delete recorded fleet energy: everything, or only minutes older than `olderThanMs`. */
export function clearFleetEnergy(olderThanMs?: number): Promise<{ removed: number }> {
  const qs = olderThanMs != null ? `?olderThanMs=${Math.floor(olderThanMs)}` : "";
  return apiFetch(`/api/fleet-energy${qs}`, { method: "DELETE" });
}

/** Reset counted token totals and history (all Sparks, or one). */
export function resetTokenTotals(sparkId?: string): Promise<{ removed: number }> {
  const qs = sparkId ? `?sparkId=${encodeURIComponent(sparkId)}` : "";
  return apiFetch(`/api/llm-token-totals${qs}`, { method: "DELETE" });
}

/** One page of the fleet activity log (newest first). `beforeId` loads older events. */
export function fetchEventsPage(opts?: {
  limit?: number;
  sparkId?: string;
  beforeId?: number;
}): Promise<ActivityEventsPage> {
  const q = new URLSearchParams();
  if (opts?.limit != null) q.set("limit", String(opts.limit));
  if (opts?.sparkId) q.set("sparkId", opts.sparkId);
  if (opts?.beforeId != null) q.set("beforeId", String(opts.beforeId));
  const qs = q.toString();
  return apiFetch(`/api/events${qs ? `?${qs}` : ""}`);
}

/** Daily (35 d) and hourly (72 h) token buckets per Spark / port / model. */
export function fetchTokenHistory(): Promise<TokenHistory> {
  return apiFetch("/api/llm-token-totals/history");
}

/** Hourly fleet energy for up to 31 days, per node. */
export function fetchEnergyHistory(): Promise<EnergyHistory> {
  return apiFetch("/api/fleet-energy/history");
}

/** Permanent per-month fleet energy (survives resets, restarts and fleet changes). */
export function fetchMonthlyEnergy(): Promise<MonthlyEnergy> {
  return apiFetch("/api/fleet-energy/monthly");
}

/** Latest metrics snapshot for one Spark (includes per-port LLM modelId). */
export function fetchSparkMetrics(id: string): Promise<{
  metrics?: { llm?: LlmMetrics[] };
}> {
  return apiFetch(`/api/sparks/${id}/metrics`);
}

/** Daily busy tok/s rollups for one Spark LLM port. */
export function fetchLlmDaily(
  id: string,
  port: number,
  days = 14
): Promise<LlmDailyResponse> {
  const q = new URLSearchParams({ port: String(port), days: String(days) });
  return apiFetch(`/api/sparks/${encodeURIComponent(id)}/llm/daily?${q.toString()}`);
}

export function addSpark(config: SparkConfig): Promise<{ success: boolean; spark: SparkConfig }> {
  return apiFetch("/api/sparks", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

export function updateSpark(
  id: string,
  patch: Partial<SparkConfig>
): Promise<{ success: boolean; spark: SparkConfig }> {
  return apiFetch(`/api/sparks/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteSpark(id: string): Promise<{ success: boolean; removed: SparkConfig }> {
  return apiFetch(`/api/sparks/${id}`, { method: "DELETE" });
}

/** Persist tab bar order (array of spark ids). */
export function reorderSparks(
  order: string[]
): Promise<{ success: boolean; sparks: SparkConfig[] }> {
  return apiFetch("/api/sparks/order", {
    method: "PUT",
    body: JSON.stringify({ order }),
  });
}

/** Save SSH password only (works while the host is offline). */
export function setSparkPassword(
  id: string,
  password: string
): Promise<{ success: boolean; spark: SparkConfig; hasPassword: boolean }> {
  return apiFetch(`/api/sparks/${id}/password`, {
    method: "PUT",
    body: JSON.stringify({ password }),
  });
}

// ─── Test connectivity ────────────────────────────────────
/** Test a registered Spark by id */
export function testSpark(id: string): Promise<SparkTestResponse> {
  return apiFetch(`/api/sparks/${id}/test`, { method: "POST" });
}

/** Ephemeral test — does not persist a Spark or start a monitor */
export function testSparkConfig(config: Omit<SparkConfig, "id"> & { id?: string }): Promise<SparkTestResponse> {
  return apiFetch("/api/sparks/test", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

/** Cancel a ComfyUI job (interrupt running and/or remove from queue). */
export function cancelComfyJob(
  sparkId: string,
  promptId: string
): Promise<{ success: boolean; ok?: boolean; method?: string; message?: string }> {
  return apiFetch(`/api/sparks/${encodeURIComponent(sparkId)}/comfy/cancel`, {
    method: "POST",
    body: JSON.stringify({ promptId }),
  });
}

// ─── Disabled storage devices ─────────────────────────────
export function updateDisabledDevices(
  id: string,
  disabledDevices: string[]
): Promise<{ success: boolean; disabledDevices: string[] }> {
  return apiFetch(`/api/sparks/${id}/disabled-devices`, {
    method: "PUT",
    body: JSON.stringify({ disabledDevices }),
  });
}

// ─── Disabled network interfaces ──────────────────────────
export function updateDisabledInterfaces(
  id: string,
  disabledInterfaces: string[]
): Promise<{ success: boolean; disabledInterfaces: string[] }> {
  return apiFetch(`/api/sparks/${id}/disabled-interfaces`, {
    method: "PUT",
    body: JSON.stringify({ disabledInterfaces }),
  });
}

// ─── Manual metric refresh ────────────────────────────────
export function refreshSparkMetric(
  id: string,
  domain: string
): Promise<{ success: boolean; domain: string }> {
  return apiFetch(`/api/sparks/${id}/refresh/${domain}`, { method: "POST" });
}

// ─── LLM decode benchmark ─────────────────────────────
/** Start an async decode bench (returns 202 job). */
export function startDecodeBench(
  id: string,
  body: StartDecodeBenchRequest
): Promise<DecodeBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/bench`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getDecodeBench(
  id: string,
  benchId: string
): Promise<DecodeBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/bench/${benchId}`);
}

export function listDecodeBench(
  id: string,
  port?: number
): Promise<DecodeBenchListResponse> {
  const q =
    port != null && Number.isInteger(port) ? `?port=${encodeURIComponent(port)}` : "";
  return apiFetch(`/api/sparks/${id}/llm/bench${q}`);
}

export function cancelDecodeBench(
  id: string,
  benchId: string
): Promise<DecodeBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/bench/${benchId}`, {
    method: "DELETE",
  });
}

/** Clear finished benchmark history for a Spark (optionally one LLM port). */
export function clearDecodeBenchHistory(
  id: string,
  port?: number
): Promise<{ success: boolean }> {
  const q =
    port != null && Number.isInteger(port) ? `?port=${encodeURIComponent(port)}` : "";
  return apiFetch(`/api/sparks/${id}/llm/bench${q}`, { method: "DELETE" });
}

// ─── LLM prefill benchmark ────────────────────────────
export function startPrefillBench(
  id: string,
  body: StartPrefillBenchRequest
): Promise<PrefillBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/prefill-bench`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getPrefillBench(
  id: string,
  benchId: string
): Promise<PrefillBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/prefill-bench/${benchId}`);
}

export function listPrefillBench(
  id: string,
  port?: number
): Promise<PrefillBenchListResponse> {
  const q =
    port != null && Number.isInteger(port) ? `?port=${encodeURIComponent(port)}` : "";
  return apiFetch(`/api/sparks/${id}/llm/prefill-bench${q}`);
}

export function cancelPrefillBench(
  id: string,
  benchId: string
): Promise<PrefillBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/prefill-bench/${benchId}`, {
    method: "DELETE",
  });
}

export function clearPrefillBenchHistory(
  id: string,
  port?: number
): Promise<{ success: boolean }> {
  const q =
    port != null && Number.isInteger(port) ? `?port=${encodeURIComponent(port)}` : "";
  return apiFetch(`/api/sparks/${id}/llm/prefill-bench${q}`, { method: "DELETE" });
}

// ─── LLM quality benchmark ────────────────────────────
export function startQualityBench(
  id: string,
  body: StartQualityBenchRequest
): Promise<QualityBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/quality-bench`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Full run (with per-item rows) — active or from history. */
export function getQualityBench(
  id: string,
  benchId: string
): Promise<QualityBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/quality-bench/${benchId}`);
}

/** `historyPort` scopes the saved-run list on its own: a port, or "all" for every endpoint on the unit. */
export function listQualityBench(
  id: string,
  port?: number,
  historyPort?: number | "all"
): Promise<QualityBenchListResponse> {
  const params = new URLSearchParams();
  if (port != null && Number.isInteger(port)) params.set("port", String(port));
  if (historyPort != null) params.set("historyPort", String(historyPort));
  const q = params.size ? `?${params}` : "";
  return apiFetch(`/api/sparks/${id}/llm/quality-bench${q}`);
}

export function cancelQualityBench(
  id: string,
  benchId: string
): Promise<QualityBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/quality-bench/${benchId}`, {
    method: "DELETE",
  });
}

export function clearQualityBenchHistory(
  id: string,
  port?: number
): Promise<{ success: boolean }> {
  const q =
    port != null && Number.isInteger(port) ? `?port=${encodeURIComponent(port)}` : "";
  return apiFetch(`/api/sparks/${id}/llm/quality-bench${q}`, { method: "DELETE" });
}

// ─── LLM Prompt Showcase ──────────────────────────────
/** Start a concurrent prompt showcase (returns 202 session). */
export function startShowcase(
  id: string,
  body: ShowcaseStartRequest
): Promise<ShowcaseStartResponse> {
  return apiFetch(`/api/sparks/${id}/llm/showcase`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Active session + finished history summaries. */
export function listShowcase(id: string): Promise<ShowcaseListResponse> {
  return apiFetch(`/api/sparks/${id}/llm/showcase`);
}

export function getShowcase(
  id: string,
  sessionId: string,
  opts?: { since?: number }
): Promise<ShowcaseSessionState> {
  const q =
    opts?.since != null && Number.isFinite(opts.since)
      ? `?since=${encodeURIComponent(String(opts.since))}`
      : "";
  return apiFetch(`/api/sparks/${id}/llm/showcase/${sessionId}${q}`);
}

export function cancelShowcase(
  id: string,
  sessionId: string
): Promise<ShowcaseSessionState> {
  return apiFetch(`/api/sparks/${id}/llm/showcase/${sessionId}`, {
    method: "DELETE",
  });
}

/**
 * Fire-and-forget cancel sent while the page unloads (pagehide/beforeunload).
 * `keepalive` lets the request outlive the tab; it carries the same bearer
 * token as every other API call, or a token-protected server rejects it and
 * the session keeps running.
 */
export function cancelShowcaseBeacon(id: string, sessionId: string): void {
  const url = `${BASE}/api/sparks/${encodeURIComponent(id)}/llm/showcase/${encodeURIComponent(sessionId)}`;
  void fetch(url, { method: "DELETE", keepalive: true, headers: authHeaders() }).catch(() => {
    /* the page is going away — nothing to report to */
  });
}

/** Clear finished showcase history for a Spark. */
export function clearShowcaseHistory(
  id: string
): Promise<{ success: boolean }> {
  return apiFetch(`/api/sparks/${id}/llm/showcase`, { method: "DELETE" });
}

// ─── LLM probe ports (per Spark) ─────────────────────────
/** Replace all LLM ports for a Spark (hot update). */
export function updateLlmPorts(
  id: string,
  llmPorts: number[]
): Promise<{ success: boolean; llmPorts: number[] }> {
  return apiFetch(`/api/sparks/${id}/llm-ports`, {
    method: "PUT",
    body: JSON.stringify({ llmPorts }),
  });
}

/** Add a single LLM port to a Spark (hot update). */
export function addLlmPort(
  id: string,
  port: number
): Promise<{ success: boolean; llmPorts: number[] }> {
  return apiFetch(`/api/sparks/${id}/llm-ports`, {
    method: "POST",
    body: JSON.stringify({ port }),
  });
}

/** Remove an LLM port from a Spark (hot update). */
export function removeLlmPort(
  id: string,
  port: number
): Promise<{ success: boolean; llmPorts: number[] }> {
  return apiFetch(`/api/sparks/${id}/llm-ports/${port}`, {
    method: "DELETE",
  });
}

/** Backward-compat: replace all ports via the legacy single-port endpoint. */
export function updateLlmPort(
  id: string,
  llmPort: number
): Promise<{ success: boolean; llmPort: number; llmPorts: number[] }> {
  return apiFetch(`/api/sparks/${id}/llm-port`, {
    method: "PUT",
    body: JSON.stringify({ llmPort }),
  });
}

/**
 * Set or clear an optional LLM API key for one port.
 * Pass apiKey "" to clear. Key is stored encrypted server-side and never returned.
 */
export function setLlmApiKey(
  id: string,
  port: number,
  apiKey: string
): Promise<{
  success: boolean;
  hasApiKey: boolean;
  llmApiKeyPorts: number[];
}> {
  return apiFetch(`/api/sparks/${id}/llm-ports/${port}/api-key`, {
    method: "PUT",
    body: JSON.stringify({ apiKey }),
  });
}

// ─── Hermes Agent ────────────────────────────────────
/** One-click `hermes update` via SSH on the Spark (background job; 202 when started). */
export function updateHermes(id: string): Promise<{ success: boolean; reason?: string }> {
  return apiFetch(`/api/sparks/${id}/hermes/update`, { method: "POST" });
}

/** Run `hermes update` on every Spark with Hermes Agent monitoring enabled. */
export function updateAllHermes(): Promise<HermesBatchUpdateResponse> {
  return apiFetch("/api/sparks/hermes/update-all", { method: "POST" });
}

/** Force an immediate `hermes update --check` on the Spark. */
export function checkHermes(id: string): Promise<{ success: boolean }> {
  return apiFetch(`/api/sparks/${id}/hermes/check`, { method: "POST" });
}

// ─── Power management ────────────────────────────────────
export interface PowerResult {
  success: boolean;
  message?: string;
  output?: string;
  mac?: string;
  broadcast?: string;
  error?: string;
}

export interface BatchPowerResult {
  success: boolean;
  results: {
    id: string;
    ok: boolean;
    error?: string;
    skipped?: boolean;
    mac?: string;
    broadcast?: string;
  }[];
}

/** Gracefully shut down a single Spark (host script: spark-shutdown). */
export function shutdownSpark(id: string): Promise<PowerResult> {
  return apiFetch(`/api/sparks/${id}/shutdown`, { method: "POST" });
}

/** Send a Wake-on-LAN magic packet to a single Spark. */
export function wakeSpark(id: string): Promise<PowerResult> {
  return apiFetch(`/api/sparks/${id}/wake`, { method: "POST" });
}

/** Shut down Sparks that are currently online. */
export function shutdownAllSparks(): Promise<BatchPowerResult> {
  return apiFetch("/api/sparks/shutdown-all", { method: "POST" });
}

/** Send WoL to all registered Sparks that have a MAC configured. */
export function wakeAllSparks(): Promise<BatchPowerResult> {
  return apiFetch("/api/sparks/wake-all", { method: "POST" });
}

// ─── GPU clock cap (Spark units) ─────────────────────────
export function fetchGpuClock(id: string): Promise<GpuClockStatus> {
  return apiFetch(`/api/sparks/${encodeURIComponent(id)}/gpu-clock`);
}

/** Command to paste into a terminal on the unit itself: asks for the sudo password there. */
export function fetchGpuClockCommand(
  id: string,
  q: { action: "apply"; maxMHz: number; persist: boolean } | { action: "reset" }
): Promise<{ command: string }> {
  const params = new URLSearchParams({ action: q.action });
  if (q.action === "apply") {
    params.set("maxMHz", String(q.maxMHz));
    params.set("persist", q.persist ? "1" : "0");
  }
  return apiFetch(`/api/sparks/${encodeURIComponent(id)}/gpu-clock/command?${params}`);
}

/** Cap the GPU graphics clock now; `persist` also installs the boot service. */
export function setGpuClock(
  id: string,
  body: { maxMHz: number; minMHz?: number; persist: boolean; sudoPassword?: string }
): Promise<{ success: boolean; capMHz: number; persist: boolean }> {
  return apiFetch(`/api/sparks/${encodeURIComponent(id)}/gpu-clock`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

/** Remove the cap and the boot service. */
export function resetGpuClock(id: string, sudoPassword?: string): Promise<{ success: boolean }> {
  return apiFetch(`/api/sparks/${encodeURIComponent(id)}/gpu-clock`, {
    method: "DELETE",
    ...(sudoPassword ? { body: JSON.stringify({ sudoPassword }) } : {}),
  });
}

// ─── Hermes update preview ───────────────────────────────
/** Per-Spark update preview (release + pending commits + resolved view). */
export function fetchHermesUpdates(id: string): Promise<HermesUpdatesResponse> {
  return apiFetch(`/api/sparks/${encodeURIComponent(id)}/hermes/updates`);
}

// ─── Health ───────────────────────────────────────────────
/** Server health and auth posture (bind host, authMode). */
export function fetchHealth(): Promise<HealthResponse> {
  return apiFetch("/api/health");
}

// ─── Global settings ──────────────────────────────────────
export function fetchSettings(): Promise<Settings> {
  return apiFetch("/api/settings");
}

export function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  return apiFetch("/api/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

// ─── Alert notifications ─────────────────────────────────
export function fetchAlerts(): Promise<AlertsResponse> {
  return apiFetch("/api/alerts");
}

export function fetchAlertsConfig(): Promise<AlertsConfig> {
  return apiFetch("/api/alerts/config");
}

export function updateAlertsConfig(update: AlertsConfigUpdate): Promise<AlertsConfig> {
  return apiFetch("/api/alerts/config", {
    method: "PUT",
    body: JSON.stringify(update),
  });
}

/**
 * Send one test message. With `channel`, the unsaved draft is tested (a masked
 * URL resolves against `channelId` on the server).
 */
export function testAlertChannel(channelId: string | undefined, channel?: AlertChannel): Promise<AlertTestResult> {
  return apiFetch("/api/alerts/test", {
    method: "POST",
    body: JSON.stringify({ channelId, channel }),
  });
}

// ─── LLM launchers (register a directory, run its start.sh / stop.sh) ───
const launchersBase = (sparkId: string) => `/api/sparks/${encodeURIComponent(sparkId)}/llm-launchers`;

/** List a Spark's registered models. `withStatus` adds one SSH round trip for running/stopped. */
export function fetchLaunchers(sparkId: string, withStatus = false): Promise<LauncherListResponse> {
  return apiFetch(`${launchersBase(sparkId)}${withStatus ? "?status=1" : ""}`);
}

export function addLauncher(sparkId: string, input: LlmLauncherInput): Promise<{ launcher: LlmLauncher }> {
  return apiFetch(launchersBase(sparkId), { method: "POST", body: JSON.stringify(input) });
}

export function updateLauncher(
  sparkId: string,
  launcherId: string,
  input: Partial<LlmLauncherInput>
): Promise<{ launcher: LlmLauncher }> {
  return apiFetch(`${launchersBase(sparkId)}/${encodeURIComponent(launcherId)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function removeLauncher(sparkId: string, launcherId: string): Promise<{ success: boolean }> {
  return apiFetch(`${launchersBase(sparkId)}/${encodeURIComponent(launcherId)}`, { method: "DELETE" });
}

/** Start the model's start.sh, run its stop.sh, or re-open its running output. Returns the job to follow. */
export function runLauncher(sparkId: string, launcherId: string, action: LauncherAction): Promise<{ job: LauncherJob }> {
  return apiFetch(`${launchersBase(sparkId)}/${encodeURIComponent(launcherId)}/${action}`, { method: "POST" });
}

/** Lines of a job after `since` (a sequence number), plus the unfinished last line. */
export function readLauncherJob(sparkId: string, jobId: string, since = 0): Promise<LauncherJobRead> {
  return apiFetch(`${launchersBase(sparkId)}/jobs/${encodeURIComponent(jobId)}?since=${since}`);
}

/** Stop watching the active job. A start script keeps running on the Spark. */
export function cancelLauncherJob(sparkId: string): Promise<{ success: boolean }> {
  return apiFetch(`${launchersBase(sparkId)}/jobs/active`, { method: "DELETE" });
}

// ─── Tool Eval ───────────────────────────────────────────
import type {
  ToolEvalInstallRead,
  ToolEvalJob,
  ToolEvalPreviewResponse,
  ToolEvalProbeResponse,
  ToolEvalRun,
  ToolEvalRunList,
  ToolEvalRunRequest,
  ToolEvalSpec,
  ToolEvalStatus,
  ToolEvalUpdateCheck,
  ToolEvalStreamRead,
} from "./types";
import { ToolEvalApiError } from "./types";

const teBase = (sparkId: string) => `/api/sparks/${encodeURIComponent(sparkId)}/tool-eval`;

/** Like apiFetch, but keeps the status code, the `errors[]` list and the busy job of a failed response. */
async function teFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders() };
  if (opts?.body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { ...opts, headers: { ...headers, ...(opts?.headers as Record<string, string> | undefined) } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    throw new ToolEvalApiError(
      (typeof body.error === "string" && body.error) || res.statusText || `HTTP ${res.status}`,
      res.status,
      Array.isArray(body.errors) ? body.errors.filter((e: unknown): e is string => typeof e === "string") : [],
      (body.active as ToolEvalJob | undefined) ?? null
    );
  }
  return res.json();
}

const post = (body?: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body ?? {}) });

export function fetchToolEvalSpec(): Promise<ToolEvalSpec> {
  return teFetch("/api/tool-eval/spec");
}

export function fetchToolEvalStatus(sparkId: string): Promise<ToolEvalStatus> {
  return teFetch(`${teBase(sparkId)}/status`);
}

export function fetchToolEvalUpdateCheck(sparkId: string): Promise<ToolEvalUpdateCheck> {
  return teFetch(`${teBase(sparkId)}/update-check`);
}

export function fetchToolEvalInstallCommand(sparkId: string, extras: string[], upgrade: boolean): Promise<{ command: string }> {
  const q = new URLSearchParams({ extras: extras.join(",") });
  if (upgrade) q.set("upgrade", "1");
  return teFetch(`${teBase(sparkId)}/install-command?${q}`);
}

export function startToolEvalInstall(sparkId: string, extras: string[], upgrade: boolean): Promise<{ job: ToolEvalJob; command: string }> {
  return teFetch(`${teBase(sparkId)}/install`, post({ extras, upgrade }));
}

export function readToolEvalInstall(sparkId: string, lineSince: number): Promise<ToolEvalInstallRead> {
  return teFetch(`${teBase(sparkId)}/install/stream?lineSince=${lineSince}`);
}

export function previewToolEval(sparkId: string, req: ToolEvalRunRequest): Promise<ToolEvalPreviewResponse> {
  return teFetch(`${teBase(sparkId)}/preview`, post(req));
}

export function probeToolEval(sparkId: string, options: Record<string, unknown>, port?: number): Promise<ToolEvalProbeResponse> {
  return teFetch(`${teBase(sparkId)}/probe`, post({ options, port }));
}

export function fetchToolEvalRuns(sparkId: string, type?: string): Promise<ToolEvalRunList> {
  return teFetch(`${teBase(sparkId)}/runs${type ? `?type=${encodeURIComponent(type)}` : ""}`);
}

export function startToolEvalRun(sparkId: string, req: ToolEvalRunRequest): Promise<{ run: ToolEvalRun; job: ToolEvalJob }> {
  return teFetch(`${teBase(sparkId)}/runs`, post(req));
}

export function fetchToolEvalRun(sparkId: string, runId: string): Promise<{ run: ToolEvalRun; job: ToolEvalJob | null }> {
  return teFetch(`${teBase(sparkId)}/runs/${encodeURIComponent(runId)}`);
}

export function readToolEvalRun(sparkId: string, runId: string, lineSince = 0, eventSince = 0): Promise<ToolEvalStreamRead> {
  return teFetch(`${teBase(sparkId)}/runs/${encodeURIComponent(runId)}/stream?lineSince=${lineSince}&eventSince=${eventSince}`);
}

export function attachToolEvalRun(sparkId: string, runId: string): Promise<{ job: ToolEvalJob }> {
  return teFetch(`${teBase(sparkId)}/runs/${encodeURIComponent(runId)}/attach`, post());
}

export function stopToolEvalRun(sparkId: string, runId: string): Promise<{ success: boolean; output?: string }> {
  return teFetch(`${teBase(sparkId)}/runs/${encodeURIComponent(runId)}/stop`, post());
}

export function refreshToolEvalRun(sparkId: string, runId: string): Promise<{ state: { state: string; exitCode?: number }; run: ToolEvalRun | null }> {
  return teFetch(`${teBase(sparkId)}/runs/${encodeURIComponent(runId)}/refresh`, post());
}

export function fetchToolEvalResult(sparkId: string, runId: string): Promise<{ run: ToolEvalRun | null; result: unknown }> {
  return teFetch(`${teBase(sparkId)}/runs/${encodeURIComponent(runId)}/result`);
}

export function deleteToolEvalRun(sparkId: string, runId: string): Promise<{ success: boolean }> {
  return teFetch(`${teBase(sparkId)}/runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
}

/** Stop watching the live job; a benchmark run keeps going on the Spark. */
export function cancelToolEvalWatch(sparkId: string): Promise<{ success: boolean }> {
  return teFetch(`${teBase(sparkId)}/watch`, { method: "DELETE" });
}

/** Recent GPU history kept by the server (parallel arrays, oldest first; `p` is null where power was unknown). */
export interface GpuHistoryResponse {
  t: number[];
  /** Null where usage / temperature was unknown (e.g. a vendor tool reported no value). */
  u: Array<number | null>;
  c: Array<number | null>;
  p: Array<number | null>;
  /** Per-card series of a multi-GPU host, parallel to `t` (null where the card had no reading). Absent on older servers. */
  gpus?: Array<{ index: number; name: string | null; u: Array<number | null>; c: Array<number | null>; p: Array<number | null> }>;
}

export function getGpuHistory(sparkId: string, windowMs: number): Promise<GpuHistoryResponse> {
  return apiFetch<GpuHistoryResponse>(`/api/sparks/${encodeURIComponent(sparkId)}/gpu-history?windowMs=${Math.round(windowMs)}`);
}

// ─── Security scans (VulnHunter) ─────────────────────────
const vhBase = (sparkId: string) => `/api/sparks/${encodeURIComponent(sparkId)}/vulnhunt`;
const vhRun = (sparkId: string, runId: string) => `${vhBase(sparkId)}/runs/${encodeURIComponent(runId)}`;

/** Like apiFetch, but keeps the status code, a busy job (409) and the `canForce` flag of a failed response. */
async function vhFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts?.body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { ...opts, headers: { ...headers, ...authHeaders() } });
  if (!res.ok) {
    if (res.status === 401) reportAuthRequired();
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    const active = body.active && typeof body.active === "object" ? (body.active as Partial<VulnHuntJob>) : null;
    throw new VulnHuntApiError(
      (typeof body.error === "string" && body.error) || res.statusText || `HTTP ${res.status}`,
      res.status,
      active,
      body.canForce === true
    );
  }
  return res.json();
}

export function fetchVulnHuntSetup(): Promise<VulnHuntSetup> {
  return vhFetch("/api/vulnhunt/setup");
}

export function fetchVulnHuntStatus(sparkId: string): Promise<VulnHuntStatus> {
  return vhFetch(`${vhBase(sparkId)}/status`);
}

export function listVulnHuntRuns(sparkId: string): Promise<{ runs: VulnHuntRun[]; active: VulnHuntJob | null }> {
  return vhFetch(`${vhBase(sparkId)}/runs`);
}

export function startVulnHuntScan(sparkId: string, req: VulnHuntScanRequest): Promise<{ run: VulnHuntRun; job: VulnHuntJob }> {
  return vhFetch(`${vhBase(sparkId)}/runs`, { method: "POST", body: JSON.stringify(req) });
}

export function readVulnHuntStream(sparkId: string, runId: string, lineSince = 0): Promise<VulnHuntStreamRead> {
  return vhFetch(`${vhRun(sparkId, runId)}/stream?lineSince=${lineSince}`);
}

export function fetchVulnHuntReport(sparkId: string, runId: string): Promise<{ run: VulnHuntRun | null; report: VulnHuntReportBundle }> {
  return vhFetch(`${vhRun(sparkId, runId)}/report`);
}

export function attachVulnHuntScan(sparkId: string, runId: string): Promise<{ job: VulnHuntJob }> {
  return vhFetch(`${vhRun(sparkId, runId)}/attach`, { method: "POST", body: "{}" });
}

/** Rejects when the unit did not stop the scan (the server answers 200 with `success: false` then). */
export async function stopVulnHuntScan(sparkId: string, runId: string): Promise<{ success: boolean; output?: string }> {
  const res = await vhFetch<{ success: boolean; output?: string }>(`${vhRun(sparkId, runId)}/stop`, { method: "POST", body: "{}" });
  if (!res.success) {
    const why = (res.output ?? "").trim();
    throw new Error(why === "not running" ? "The scan is not running on the unit any more." : why ? `The unit did not stop the scan: ${why.slice(0, 200)}` : "The unit did not stop the scan.");
  }
  return res;
}

export function refreshVulnHuntScan(
  sparkId: string,
  runId: string
): Promise<{ state: { state: "running" | "gone" | "finished" | "unknown"; exitCode?: number }; run: VulnHuntRun | null }> {
  return vhFetch(`${vhRun(sparkId, runId)}/refresh`, { method: "POST", body: "{}" });
}

/** `force` deletes a scan whose state the server could not confirm (after a 409 with `canForce`). */
export function deleteVulnHuntScan(sparkId: string, runId: string, force = false): Promise<{ success: boolean }> {
  return vhFetch(`${vhRun(sparkId, runId)}${force ? "?force=1" : ""}`, { method: "DELETE" });
}

/** Stop watching the live job; a scan keeps going on the unit. */
/** Install (or update) VulnHunter on the unit; `{ harness }` also sets up that harness's skill and wrapper. 400/403/409 come back as VulnHuntApiError with the server's message. */
export function installVulnHunt(sparkId: string, req: VulnHuntInstallRequest): Promise<VulnHuntInstallStarted> {
  return vhFetch(`${vhBase(sparkId)}/install`, { method: "POST", body: JSON.stringify(req) });
}

/** The latest install job and its output since `lineSince`; null when no install has run since the dashboard started. */
export async function readVulnHuntInstallStream(sparkId: string, lineSince = 0): Promise<VulnHuntInstallStream | null> {
  try {
    return await vhFetch<VulnHuntInstallStream>(`${vhBase(sparkId)}/install/stream?lineSince=${lineSince}`);
  } catch (e) {
    if (e instanceof VulnHuntApiError && e.status === 404) return null;
    throw e;
  }
}

/** Save the harness command on the unit. Write-only: the dashboard never reads it back. */
export function saveVulnHuntHostCommand(sparkId: string, command: string): Promise<{ success: boolean }> {
  return vhFetch(`${vhBase(sparkId)}/host-command`, { method: "PUT", body: JSON.stringify({ command }) });
}

export function clearVulnHuntHostCommand(sparkId: string): Promise<{ success: boolean }> {
  return vhFetch(`${vhBase(sparkId)}/host-command`, { method: "DELETE" });
}

export function cancelVulnHuntWatch(sparkId: string): Promise<{ success: boolean }> {
  return vhFetch(`${vhBase(sparkId)}/watch`, { method: "DELETE" });
}

// ─── REA (Reverse Engineer Anything) tool ────────────────
import type {
  ReaInstallStream,
  ReaJob,
  ReaResultSummary,
  ReaRun,
  ReaRunRequest,
  ReaSetup,
  ReaSpec,
  ReaStatus,
  ReaStreamRead,
  ReaUploadCommitted,
  ReaUploadCreated,
  ReaViewQuery,
} from "./types";
import { ReaApiError } from "./types";

const reaBase = (sparkId: string) => `/api/sparks/${encodeURIComponent(sparkId)}/rea`;
const reaRun = (sparkId: string, runId: string) => `${reaBase(sparkId)}/runs/${encodeURIComponent(runId)}`;
const reaUpload = (sparkId: string, uploadId: string) => `${reaBase(sparkId)}/uploads/${encodeURIComponent(uploadId)}`;

const reaForbiddenListeners = new Set<() => void>();
/** Called after any REA call answered 403 (the opt-in was switched off while the page was open). Returns the unsubscribe. */
export function onReaForbidden(fn: () => void): () => void {
  reaForbiddenListeners.add(fn);
  return () => {
    reaForbiddenListeners.delete(fn);
  };
}
function notifyReaForbidden() {
  for (const fn of Array.from(reaForbiddenListeners)) {
    try {
      fn();
    } catch {
      /* a listener must not break the call */
    }
  }
}

async function reaError(res: Response): Promise<ReaApiError> {
  if (res.status === 401) reportAuthRequired();
  if (res.status === 403) notifyReaForbidden();
  const body = await res.json().catch(() => ({}) as Record<string, unknown>);
  const active = body.active && typeof body.active === "object" ? (body.active as Partial<ReaJob>) : null;
  return new ReaApiError(
    (typeof body.error === "string" && body.error) || res.statusText || `HTTP ${res.status}`,
    res.status,
    active,
    body.canForce === true
  );
}

/** Like apiFetch, but keeps the status code, a busy job (409) and the `canForce` flag of a failed response. */
async function reaFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts?.body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { ...opts, headers: { ...headers, ...authHeaders() } });
  if (!res.ok) throw await reaError(res);
  return res.json();
}

export function fetchReaSetup(): Promise<ReaSetup> {
  return reaFetch("/api/rea/setup");
}

export function fetchReaSpec(): Promise<ReaSpec> {
  return reaFetch("/api/rea/spec");
}

export function fetchReaStatus(sparkId: string): Promise<ReaStatus> {
  return reaFetch(`${reaBase(sparkId)}/status`);
}

export function installRea(sparkId: string): Promise<{ job: ReaJob; version: string }> {
  return reaFetch(`${reaBase(sparkId)}/install`, { method: "POST", body: "{}" });
}

/** The latest install job and its output since `lineSince`; null when none has run since the dashboard started. */
export async function readReaInstallStream(sparkId: string, lineSince = 0): Promise<ReaInstallStream | null> {
  try {
    return await reaFetch<ReaInstallStream>(`${reaBase(sparkId)}/install/stream?lineSince=${lineSince}`);
  } catch (e) {
    if (e instanceof ReaApiError && e.status === 404) return null;
    throw e;
  }
}

/** Install Ghidra (and a JDK 21 when the unit has none) on the unit. Streamed through readReaGhidraInstallStream. */
export function installReaGhidra(sparkId: string): Promise<{ job: ReaJob; version: string }> {
  return reaFetch(`${reaBase(sparkId)}/ghidra/install`, { method: "POST", body: "{}" });
}

/** The latest Ghidra install job and its output since `lineSince`; null when none has run since the dashboard started. */
export async function readReaGhidraInstallStream(sparkId: string, lineSince = 0): Promise<ReaInstallStream | null> {
  try {
    return await reaFetch<ReaInstallStream>(`${reaBase(sparkId)}/ghidra/install/stream?lineSince=${lineSince}`);
  } catch (e) {
    if (e instanceof ReaApiError && e.status === 404) return null;
    throw e;
  }
}

export function listReaRuns(sparkId: string): Promise<{ runs: ReaRun[]; active: ReaJob | null }> {
  return reaFetch(`${reaBase(sparkId)}/runs`);
}

export function startReaRun(sparkId: string, req: ReaRunRequest): Promise<{ run: ReaRun; job: ReaJob }> {
  return reaFetch(`${reaBase(sparkId)}/runs`, { method: "POST", body: JSON.stringify(req) });
}

export function readReaStream(sparkId: string, runId: string, lineSince = 0): Promise<ReaStreamRead> {
  return reaFetch(`${reaRun(sparkId, runId)}/stream?lineSince=${lineSince}`);
}

/** 409 while the run is still going. */
export function fetchReaResult(sparkId: string, runId: string): Promise<{ run: ReaRun | null; summary: ReaResultSummary }> {
  return reaFetch(`${reaRun(sparkId, runId)}/result`);
}

/** One bounded page of a run's result (400 when the workflow has no paged view). */
export function fetchReaView(sparkId: string, runId: string, q: ReaViewQuery = {}): Promise<{ view: unknown }> {
  const p = new URLSearchParams();
  if (q.kind === "summary") p.set("kind", "summary");
  if (q.collection) p.set("collection", q.collection);
  if (q.facet) p.set("facet", q.facet);
  if (q.offset !== undefined) p.set("offset", String(q.offset));
  if (q.limit !== undefined) p.set("limit", String(q.limit));
  const qs = p.toString();
  return reaFetch(`${reaRun(sparkId, runId)}/view${qs ? `?${qs}` : ""}`);
}

export function attachReaRun(sparkId: string, runId: string): Promise<{ job: ReaJob }> {
  return reaFetch(`${reaRun(sparkId, runId)}/attach`, { method: "POST", body: "{}" });
}

/** Rejects when the unit did not stop the run (a 200 with `success: false`). */
export async function stopReaRun(sparkId: string, runId: string): Promise<{ success: boolean; output?: string }> {
  const res = await reaFetch<{ success?: boolean; output?: string }>(`${reaRun(sparkId, runId)}/stop`, { method: "POST", body: "{}" });
  if (res.success === false) {
    const why = (res.output ?? "").trim();
    throw new Error(why === "not running" ? "The run is not running on the unit any more." : why ? `The unit did not stop the run: ${why.slice(0, 200)}` : "The unit did not stop the run.");
  }
  return { success: true, output: res.output };
}

export function refreshReaRun(
  sparkId: string,
  runId: string
): Promise<{ state: { state: "running" | "gone" | "finished" | "unknown"; exitCode?: number }; run: ReaRun | null }> {
  return reaFetch(`${reaRun(sparkId, runId)}/refresh`, { method: "POST", body: "{}" });
}

/** `force` deletes a run whose state the server could not confirm (after a 409 with `canForce`). */
export function deleteReaRun(sparkId: string, runId: string, force = false): Promise<{ success: boolean }> {
  return reaFetch(`${reaRun(sparkId, runId)}${force ? "?force=1" : ""}`, { method: "DELETE" });
}

/** Stop watching the live job; a run keeps going on the unit. */
export function cancelReaWatch(sparkId: string): Promise<{ success: boolean }> {
  return reaFetch(`${reaBase(sparkId)}/watch`, { method: "DELETE" });
}

/** Path of the export download (the browser needs the auth header, so use `downloadReaExport` for a click). */
export function exportReaUrl(sparkId: string, runId: string): string {
  return `${reaRun(sparkId, runId)}/export`;
}

/** Fetch the export with the auth header and hand it to the browser as a file download. */
export async function downloadReaExport(sparkId: string, runId: string): Promise<void> {
  const res = await fetch(`${BASE}${exportReaUrl(sparkId, runId)}`, { headers: authHeaders() });
  if (!res.ok) throw await reaError(res);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = `${runId}.json`;
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

export function compareReaRuns(sparkId: string, leftRunId: string, rightRunId: string): Promise<{ result: unknown }> {
  return reaFetch(`${reaBase(sparkId)}/compare`, { method: "POST", body: JSON.stringify({ leftRunId, rightRunId }) });
}

export function createReaUpload(sparkId: string): Promise<ReaUploadCreated> {
  return reaFetch(`${reaBase(sparkId)}/uploads`, { method: "POST", body: "{}" });
}

export interface PutReaUploadOptions {
  /** The file is a .zip / .tar / .tar.gz / .tgz archive to extract on commit. */
  archive?: boolean;
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

/** One file as a raw (not multipart) PUT body, with upload progress and abort. Rejects with a ReaApiError (status 0: network or abort). */
export function putReaUploadFile(
  sparkId: string,
  uploadId: string,
  relPath: string,
  body: Blob,
  opts: PutReaUploadOptions = {}
): Promise<{ path: string; bytes: number; sha256: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const q = `path=${encodeURIComponent(relPath)}${opts.archive ? "&archive=1" : ""}`;
    xhr.open("PUT", `${BASE}${reaUpload(sparkId, uploadId)}/files?${q}`);
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded, e.total);
    };
    const onAbort = () => xhr.abort();
    if (opts.signal) {
      if (opts.signal.aborted) return reject(new ReaApiError("Upload cancelled", 0));
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const done = () => opts.signal?.removeEventListener("abort", onAbort);
    xhr.onload = () => {
      done();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(xhr.responseText || "{}");
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        opts.onProgress?.(body.size, body.size);
        return resolve(parsed as { path: string; bytes: number; sha256: string });
      }
      if (xhr.status === 401) reportAuthRequired();
      if (xhr.status === 403) notifyReaForbidden();
      reject(new ReaApiError((typeof parsed.error === "string" && parsed.error) || xhr.statusText || `HTTP ${xhr.status}`, xhr.status));
    };
    xhr.onerror = () => {
      done();
      reject(new ReaApiError("The upload could not reach the dashboard.", 0));
    };
    xhr.onabort = () => {
      done();
      reject(new ReaApiError("Upload cancelled", 0));
    };
    xhr.send(body);
  });
}

export function commitReaUpload(sparkId: string, uploadId: string): Promise<ReaUploadCommitted> {
  return reaFetch(`${reaUpload(sparkId, uploadId)}/commit`, { method: "POST", body: "{}" });
}

export function deleteReaUpload(sparkId: string, uploadId: string): Promise<{ success: boolean }> {
  return reaFetch(reaUpload(sparkId, uploadId), { method: "DELETE" });
}

/** The 48 h / 30 d unit history (Settings → Metrics history; `{ enabled: false }` while off). */
export function getUnitHistory(sparkId: string, range: MetricsHistoryRange): Promise<MetricsHistoryResponse> {
  return apiFetch<MetricsHistoryResponse>(`/api/sparks/${encodeURIComponent(sparkId)}/history?range=${range}`);
}
