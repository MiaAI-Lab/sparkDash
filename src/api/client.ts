import type {
  ActivityEvent,
  ActivityEventsPage,
  EnergyHistory,
  TokenHistory,
  DecodeBenchJob,
  DecodeBenchListResponse,
  FleetEnergy,
  HermesBatchUpdateResponse,
  HermesUpdatesResponse,
  LauncherAction,
  LauncherJob,
  LauncherJobRead,
  LauncherListResponse,
  LlmLauncher,
  LlmLauncherInput,
  LlmMetrics,
  LlmDailyResponse,
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

const BASE = "";
const TOKEN = (typeof localStorage !== "undefined" && localStorage.getItem("sparkdashToken")) || "";

function authHeaders(): Record<string, string> {
  return TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
}

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

export function listQualityBench(
  id: string,
  port?: number
): Promise<QualityBenchListResponse> {
  const q =
    port != null && Number.isInteger(port) ? `?port=${encodeURIComponent(port)}` : "";
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

// ─── Hermes update preview ───────────────────────────────
/** Per-Spark update preview (release + pending commits + resolved view). */
export function fetchHermesUpdates(id: string): Promise<HermesUpdatesResponse> {
  return apiFetch(`/api/sparks/${encodeURIComponent(id)}/hermes/updates`);
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
  u: number[];
  c: number[];
  p: Array<number | null>;
}

export function getGpuHistory(sparkId: string, windowMs: number): Promise<GpuHistoryResponse> {
  return apiFetch<GpuHistoryResponse>(`/api/sparks/${encodeURIComponent(sparkId)}/gpu-history?windowMs=${Math.round(windowMs)}`);
}
