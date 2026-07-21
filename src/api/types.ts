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
   * When true, this Spark is a distributed-LLM worker: no local OpenAI API.
   * The LLM card is hidden and LLM ports are not probed.
   */
  workerNode?: boolean;
  /** When true, storage is only updated on manual refresh, not auto-polled. */
  storagePollDisabled?: boolean;
}

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
  /** vLLM KV cache usage fraction (0–1). null when backend !== 'vllm' or unreachable. */
  kvCacheUsage: number | null;
  /** vLLM running request count. null when backend !== 'vllm' or unreachable. */
  requestsRunning: number | null;
  /** vLLM waiting request count. null when backend !== 'vllm' or unreachable. */
  requestsWaiting: number | null;
  /** vLLM time-to-first-token p95 in seconds (histogram quantile). null when unavailable. */
  ttftP95Seconds: number | null;
  /** vLLM inter-token latency p95 in seconds (histogram quantile). null when unavailable. */
  interTokenP95Seconds: number | null;
  /** vLLM cumulative preemption count. null when backend !== 'vllm' or unreachable. */
  preemptionsTotal: number | null;
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
  /** Distributed LLM worker — LLM card inactive / not shown */
  workerNode?: boolean;
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