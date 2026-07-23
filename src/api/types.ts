// ─── Spark config (matches server/sparks.json) ────────────
export interface SparkConfig {
  id: string;
  name: string;
  lanIp: string;
  cx7Ip?: string | null;
  /**
   * Optional Wake-on-LAN MAC override. When empty, the server uses
   * `detectedMacAddress` from the enP7s7 interface.
   */
  macAddress?: string | null;
  /** Last MAC read from enP7s7 while the Spark was online (read-only). */
  detectedMacAddress?: string | null;
  isLocal: boolean;
  ssh: {
    host: string;
    user: string;
    auth: "key" | "pass";
    /** Request-only: never returned by GET/list */
    password?: string;
    /** Response-only: true when a password is held in server memory */
    hasPassword?: boolean;
  };
  disabledDevices?: string[];
  /** Interface names hidden from the Network panel main view */
  disabledInterfaces?: string[];
  /** HTTP port for the LLM server on this Spark (legacy single-port, prefer llmPorts) */
  llmPort?: number;
  /** HTTP ports for LLM servers on this Spark (default [8888]) */
  llmPorts?: number[];
  /**
   * Cluster role for overview + worker behavior.
   * - head / standalone: local LLM API probed
   * - worker: no local API (LLM card hidden, ports not probed)
   */
  role?: SparkRole;
  /**
   * Legacy/derived: true when role is worker. Prefer `role`.
   * Kept so existing probe/card checks keep working.
   */
  workerNode?: boolean;
  /**
   * Optional label for a worker node (cluster / model name), shown on the overview card.
   * Only meaningful when role is worker.
   */
  workerLabel?: string | null;
  /**
   * Optional id of the head Spark this worker belongs to.
   * Only meaningful when role is worker.
   */
  workerHeadId?: string | null;
  /**
   * Standalone only: probe local LLM and show the LLM card (default true).
   * Forced true for head, forced false for worker.
   */
  llmMonitoring?: boolean;
  /** When true, storage is only updated on manual refresh, not auto-polled. */
  storagePollDisabled?: boolean;
}

export type SparkRole = "head" | "worker" | "standalone";

// ─── Hardware info ───────────────────────────────────────
export interface HardwareInfo {
  device: string;
  cpuModel: string;
  cpuCores: number;
  totalMemoryGB: number;
  gpuChip: string;
  cudaDriver: string | null;
  storageModel: string | null;
}

// ─── GPU metrics ─────────────────────────────────────────
export interface GpuMetrics {
  temperature: number;
  usage: number;
  power: {
    draw: number;
    limit: number;
    /** Estimated total system power draw (GPU + CPU + CX7/peripherals). */
    systemDraw?: number;
  };
  vram: {
    used: number;
    total: number;
    percentage: number;
    /** MemAvailable in MB — the real free memory in the shared pool. */
    available: number;
  };
  /** Top GPU processes by VRAM usage (sorted descending, max 5). */
  processes?: Array<{ pid: number; name: string; vramMB: number }>;
}

// ─── CPU metrics ─────────────────────────────────────────
export interface CpuMetrics {
  usage: number;
  temperature: number;
  draw: number;
  tdp: number;
}

// ─── RAM metrics ─────────────────────────────────────────
export interface RamMetrics {
  used: number;
  total: number;
  percentage: number;
}

// ─── Storage metrics ─────────────────────────────────────
export interface StorageMetrics {
  device: string;
  label: string;
  used: number;
  total: number;
  available: number;
  percentage: number;
  readSpeed: number;
  writeSpeed: number;
  /** Present when device is in disabledDevices; still returned for Settings UI */
  disabled?: boolean;
}

// ─── Network metrics ─────────────────────────────────────
export interface NetworkInterface {
  name: string;
  rxSpeed: number;
  txSpeed: number;
  /** IPv4 address, e.g. "192.168.1.143". null when unset. */
  ip: string | null;
  /** Interface operstate: "up" | "down" | "unknown" */
  operstate: string;
  /** Present when interface is in disabledInterfaces; still returned for Settings UI */
  disabled?: boolean;
}

export interface NetworkMetrics {
  primaryInterface: string | null;
  linkSpeedMbps: number | null;
  interfaces: NetworkInterface[];
  /** MAC of enP7s7 when present (same value persisted as detectedMacAddress). */
  wolMac?: string | null;
}

// ─── Unified memory metrics ──────────────────────────────
export interface UnifiedMemoryMetrics {
  total: number;
  gpuUsed: number;
  cpuUsed: number;
  used: number;
  available: number;
  percentage: number;
  oomRisk: "low" | "medium" | "high";
  bandwidth: {
    current: number;
    peak: number;
  };
}

// ─── LLM metrics ─────────────────────────────────────────
export interface LlmMetrics {
  available: boolean;
  backend: "vllm" | "llama.cpp" | "sglang" | null;
  modelId: string | null;
  modelPath: string | null;
  contextLength: number | null;
  /** GPU memory utilization for the LLM engine (0–1), e.g. 0.9. Only from vLLM internal info. */
  gpuMemoryUtilization: number | null;
  slotsActive: number;
  slotsTotal: number;
  generationTps: number;
  prefillTps: number;
  /** Cumulative total output (generation) tokens as reported by the LLM server */
  totalOutputTokens: number;
  /** vLLM KV cache usage fraction (0–1). null when backend !== vllm or unreachable. */
  kvCacheUsage?: number | null;
  /** vLLM running request count. null when unavailable. */
  requestsRunning?: number | null;
  /** vLLM waiting request count. null when unavailable. */
  requestsWaiting?: number | null;
  /** vLLM time-to-first-token p95 in seconds. null when unavailable. */
  ttftP95Seconds?: number | null;
  /** vLLM cumulative preemption count. null when unavailable. */
  preemptionsTotal?: number | null;
  /** vLLM prefix-cache hit rate (hits/queries, 0–1). null when unavailable. */
  prefixCacheHitRate?: number | null;
  /** vLLM end-to-end request latency p95 in seconds. null when unavailable. */
  e2eP95Seconds?: number | null;
  /** vLLM inter-token latency p95 in seconds. null when unavailable. */
  itlP95Seconds?: number | null;
  /** vLLM speculative/MTP acceptance rate (accepted/drafted, 0–1). null when unavailable. */
  mtpAcceptanceRate?: number | null;
  error: string | null;
}

// ─── Full metrics snapshot ────────────────────────────────
export interface SparkMetrics {
  gpu: GpuMetrics | null;
  cpu: CpuMetrics | null;
  ram: RamMetrics | null;
  storage: StorageMetrics[];
  network: NetworkMetrics | null;
  unifiedMemory: UnifiedMemoryMetrics | null;
  /** Array of LLM metrics, one per configured port. Empty array when no ports. */
  llm: LlmMetrics[];
}

// ─── Spark snapshot (server pushes this) ──────────────────
export interface SparkSnapshot {
  id: string;
  name: string;
  online: boolean;
  /** Uptime in seconds, or null when offline */
  uptime: number | null;
  disabledDevices: string[];
  disabledInterfaces: string[];
  storagePollDisabled?: boolean;
  /** Cluster role (head / worker / standalone) */
  role?: SparkRole;
  /** Distributed LLM worker — LLM card inactive / not shown (role === worker) */
  workerNode?: boolean;
  /** Optional cluster/model label when role is worker */
  workerLabel?: string | null;
  /** Optional head Spark id when role is worker */
  workerHeadId?: string | null;
  /** Standalone: whether LLM is probed (head always true, worker always false) */
  llmMonitoring?: boolean;
  /** LLM server port (first port, for backward compat) */
  llmPort: number;
  /** All LLM server ports configured for this Spark */
  llmPorts: number[];
  hardware: HardwareInfo;
  metrics: SparkMetrics;
}

// ─── WebSocket envelope ───────────────────────────────────
export interface WsSnapshot {
  type: "snapshot";
  sparks: SparkSnapshot[];
  refreshInterval: number;
}

// ─── API responses ────────────────────────────────────────
export interface Settings {
  pollIntervalMs: number;
  defaultLlmPort: number;
  autoHideOffline: boolean;
  temperatureUnit: "celsius" | "fahrenheit";
  /** Persist prompts / HTTP traces / GPU samples on decode benchmark runs. */
  benchDebugTraces: boolean;
  /** Layout density — comfortable (default) or compact. */
  density: "comfortable" | "compact";
}

export interface SparksListResponse {
  sparks: SparkConfig[];
}

export interface SparkTestResponse {
  id: string;
  ssh: { ok: boolean; message: string };
  llm: { ok: boolean; message: string };
  ok: boolean;
}

export interface ApiError {
  error: string;
}

// ─── LLM decode benchmark ────────────────────────────────
export interface DecodeBenchConfig {
  port: number;
  modelId: string | null;
  concurrencies: number[];
  maxTokens: number;
}

export interface DecodeBenchStreamResult {
  index: number;
  ttftMs: number;
  decodeTps: number;
  decodeTokens: number;
  completionTokens: number;
  totalMs: number;
  error: string | null;
  /** Exact prompt used for this stream (debug). */
  prompt?: string | null;
  /** Compact HTTP/SSE trace (no full completion body). */
  http?: {
    url: string | null;
    status: number | null;
    headers: Record<string, string>;
    completionId: string | null;
    finishReason: string | null;
    sseEventCount: number;
    firstSseDataPreview: string | null;
    request: {
      model: string | null;
      maxTokens: number | null;
      temperature: number;
      stream: boolean;
      promptChars: number;
    };
  };
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  contentPreview?: {
    first: string;
    last: string;
    chars: number;
  } | null;
  decodeMs?: number | null;
}

/** One concurrency wave (all streams at that concurrency). */
export interface DecodeBenchLevelResult {
  concurrency: number;
  streamsOk: number;
  streamsFailed: number;
  /** Mean per-stream decode tok/s after first token */
  meanDecodeTps: number;
  medianDecodeTps: number;
  minDecodeTps: number;
  maxDecodeTps: number;
  meanTtftMs: number;
  medianTtftMs: number;
  /** Client: total post-first-token tokens / concurrent decode window */
  aggregateDecodeTps: number;
  /**
   * Median server-side generation tok/s from live-style /metrics polls during the wave.
   * Null when the backend does not expose counters.
   */
  serverGenerationTps: number | null;
  /** Peak sample of server generation tok/s during the wave */
  serverGenerationTpsMax?: number | null;
  /** Number of positive rate samples collected from the engine */
  serverGenerationSamples?: number;
  totalDecodeTokens: number;
  totalCompletionTokens: number;
  durationMs: number;
  error: string | null;
  streams: DecodeBenchStreamResult[];
  model: string | null;
  /** ~1 Hz GPU/VRAM/power samples during the wave (debug). */
  hardwareSamples?: Array<{
    t: number;
    gpuUsage: number | null;
    temperature: number | null;
    powerDraw: number | null;
    powerLimit?: number | null;
    vramUsed: number | null;
    vramTotal: number | null;
    vramAvailable?: number | null;
    memAvailable?: number | null;
  }>;
}

export interface DecodeBenchProgress {
  currentConcurrency: number | null;
  completedLevels: number;
  totalLevels: number;
  message: string;
}

export interface DecodeBenchJob {
  benchId: string;
  sparkId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt: number | null;
  config: DecodeBenchConfig & { debug?: boolean };
  progress: DecodeBenchProgress;
  results: DecodeBenchLevelResult[];
  error: string | null;
  durationMs: number;
}

export interface DecodeBenchDefaults {
  allowedConcurrencies: number[];
  defaultMaxTokens: number;
  minMaxTokens: number;
  maxMaxTokens: number;
}

export interface DecodeBenchListResponse {
  active: DecodeBenchJob | null;
  /** Most recent finished job (optionally for a given port) */
  last: DecodeBenchJob | null;
  history: DecodeBenchJob[];
  defaults: DecodeBenchDefaults;
}

export interface StartDecodeBenchRequest {
  port?: number;
  concurrencies: number[];
  maxTokens?: number;
  modelId?: string | null;
}

// ─── LLM Prompt Showcase ─────────────────────────────────
export interface ShowcaseStartRequest {
  port: number;
  modelId?: string | null;
  maxTokens?: number;
  /** When true, enable model thinking/reasoning flags (UI defaults to off). */
  thinking?: boolean;
  prompts: string[];
}

export interface ShowcaseStreamState {
  streamId: string;
  label: string;
  prompt: string;
  status: "pending" | "streaming" | "completed" | "error" | "cancelled";
  contentAppend?: string;
  content?: string;
  contentLength: number;
  reasoningAppend?: string;
  reasoning?: string;
  reasoningLength?: number;
  resetContent?: boolean;
  tokenCount: number;
  ttftMs: number | null;
  decodeTps: number;
  liveTokPerSec: number;
  model: string | null;
  error: string | null;
}

export interface ShowcaseSessionState {
  sessionId: string;
  sparkId: string;
  status: "running" | "completed" | "cancelled" | "error";
  rev: number;
  port: number;
  modelId?: string | null;
  startedAt?: number;
  /** Median server generation tok/s from /metrics during the run (null if unavailable). */
  serverGenerationTps?: number | null;
  serverGenerationTpsMax?: number | null;
  serverGenerationSamples?: number;
  streams: ShowcaseStreamState[];
  error?: string | null;
}

export interface ShowcaseStartResponse {
  sessionId: string;
  status: "running";
}