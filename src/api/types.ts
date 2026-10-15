// ─── Spark config (matches server/sparks.json) ────────────
export interface SparkConfig {
  id: string;
  name: string;
  /**
   * Unit type:
   * - spark: NVIDIA DGX Spark (default) — DGX Spark specs shown in the header.
   * - host: any Linux box with supported NVIDIA or AMD GPUs, just not a Spark.
   *   Real hardware is auto-detected once online.
   */
  kind?: "spark" | "host";
  /**
   * Optional OS platform override for SSH-collected units. "linux" (default)
   * uses /proc + vendor GPU tooling, "darwin" macOS hosts, "windows" Windows hosts
   * (PowerShell collectors; NVIDIA via nvidia-smi, AMD iGPUs via GPU
   * performance counters).
   */
  platform?: "linux" | "darwin" | "windows";
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
    /** TCP port for SSH. Omitted or invalid values are stored as 22. */
    port?: number;
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
   * Ports that have an encrypted LLM API key stored server-side.
   * The key itself is never returned by the API.
   */
  llmApiKeyPorts?: number[];
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
  /**
   * Probe local ComfyUI and show the ComfyUI card (default false; all roles).
   */
  comfyMonitoring?: boolean;
  /** ComfyUI HTTP port (default 8188). */
  comfyPort?: number;
  /**
   * Opt-in: Hermes Agent CLI (nousresearch/hermes-agent) is installed on this
   * machine. When enabled, sparkDash checks for Hermes updates and can run
   * `hermes update` for you via SSH.
   */
  hermesMonitoring?: boolean;
  /**
   * Report tailnet presence via `tailscale status --json` (default false; all roles).
   */
  tailscaleMonitoring?: boolean;
  /** When true, storage is only updated on manual refresh, not auto-polled. */
  storagePollDisabled?: boolean;
}

export type SparkRole = "head" | "worker" | "standalone";

// ─── Hermes Agent status ───────────────────────────────
/** Opt-in Hermes Agent update monitoring state, pushed in every snapshot. */
export interface HermesStatus {
  /** Opt-in setting from Edit Spark (hermes installed on this machine). */
  monitoring: boolean;
  /** Whether the `hermes` binary was found on the target. null before first check. */
  installed: boolean | null;
  /** Installed version string when detected (e.g. "0.20.0"). */
  version: string | null;
  /** true when `hermes update --check` reports commits behind origin/main. */
  updateAvailable: boolean | null;
  /** Number of commits behind origin/main when reported. */
  behindCommits: number | null;
  /** Last check time (ms epoch). */
  checkedAt: number | null;
  /** One-shot update job state. */
  status: "idle" | "running" | "success" | "error";
  startedAt: number | null;
  finishedAt: number | null;
  /** Short human-readable message when the last check/update failed. */
  error: string | null;
}

/** Latest public Hermes Agent release (changelog for the update dialog). */
export interface HermesRelease {
  /** GitHub release tag, e.g. "v2026.7.7.2". */
  tagName: string;
  /** Human release name, e.g. "Hermes Agent v0.18.1 (v2026.7.7.2)". */
  name: string;
  version: string;
  /** Semantic version of the release (e.g. "0.20.0") for bump detection. */
  semver: string | null;
  publishedAt: string | null;
  htmlUrl: string;
  /** Markdown release body. */
  body: string;
}

/** One pending commit an update would bring (from git HEAD..origin/main). */
export interface HermesPendingCommit {
  sha: string;
  title: string;
}

/** One Spark's outcome from a batch `update-all` call. */
export interface HermesBatchUpdateResult {
  id: string;
  name: string;
  ok: boolean;
  started: boolean;
  skipped?: boolean;
  reason?: string;
}

export interface HermesBatchUpdateResponse {
  success: boolean;
  results: HermesBatchUpdateResult[];
}

/** Per-Spark update preview used by the confirmation dialog. */
export interface HermesUpdatesResponse {
  success: boolean;
  /** Which content the dialog should lead with. */
  view: "commits" | "release";
  /** Latest tagged release (may be null on GitHub API failure). */
  release: HermesRelease | null;
  releaseError: string | null;
  /** Installed hermes version on this Spark (e.g. "0.20.0"), when known. */
  installedVersion: string | null;
  /** Pending commits from git (may be null if the repo can't be read). */
  pending: { count: number; headSha: string | null; commits: HermesPendingCommit[] } | null;
}

// ─── Hardware info ───────────────────────────────────────
export interface HardwareInfo {
  device: string;
  cpuModel: string | null;
  cpuCores: number | null;
  totalMemoryGB: number | null;
  gpuChip: string | null;
  /** Number of physical GPUs behind `gpuChip` (absent on DGX Spark units). */
  gpuCount?: number;
  cudaDriver: string | null;
  storageModel: string | null;
}

// ─── GPU metrics ─────────────────────────────────────────
export interface GpuThrottle {
  /** HW or SW thermal slowdown engaged. */
  thermal: boolean;
  /** HW slowdown (may include thermal or power brake). */
  hwSlowdown: boolean;
  /** SW power-cap scaling limiting clocks. */
  powerCap: boolean;
  /** Any limiting reason above. */
  active: boolean;
  reason: "ok" | "thermal" | "power" | "hw" | "unknown";
  smClockMHz: number | null;
  smClockMaxMHz: number | null;
  /** Current SM clock as % of max (0–100). null when clocks unavailable. */
  smClockPct: number | null;
  /** Max graphics clock locked with `nvidia-smi -lgc` (MHz), from the sparkdash
   *  gpu-clock-cap marker on the host. null/absent when no lock is recorded. */
  clockCapMHz?: number | null;
  /** Human-readable active reasons (tooltip). */
  detail: string;
}

/** GET /api/sparks/:id/gpu-clock: the GPU clock cap (`nvidia-smi -lgc`) and its boot service. */
export type GpuClockStatus =
  | { supported: false; reason?: string }
  | {
      supported: true;
      /** GPU maximum graphics clock (MHz). */
      hwMaxMHz: number | null;
      /** Cap in effect right now (MHz), null when none is recorded. */
      capMHz: number | null;
      /** The server accepts a typed sudo password on this connection (https or the machine itself). */
      passwordAllowed?: boolean;
      /** "root" runs directly, "yes" = passwordless sudo works, "no" = it does not. */
      sudo: "root" | "yes" | "no";
      service: {
        installed: boolean;
        /** "min,max" the service applies at boot. */
        clocks: string | null;
        enabled: string | null;
        active: string | null;
      };
    };

/** One health finding for a Spark (server rules in server/health/HealthEvaluator.js). */
export interface HealthFinding {
  id: "thermal" | "low-power" | "memory" | "xid" | "oom" | "concurrency" | "link-speed" | "roce-link" | "roce-loss";
  severity: "warn" | "critical";
  title: string;
  detail: string;
  hint: string;
}

export interface GpuMetricAvailability {
  temperature: boolean;
  usage: boolean;
  powerDraw: boolean;
  powerLimit: boolean;
  vramUsed: boolean;
  vramTotal: boolean;
}

export interface GpuMetrics {
  vendors?: Array<"amd" | "nvidia" | "intel">;
  metricAvailability?: GpuMetricAvailability;
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
  /** NVIDIA clock throttle / thermal slowdown state from nvidia-smi. */
  throttle?: GpuThrottle | null;
  /** Kernel NVRM NV_ERR_NO_MEMORY count since boot (cached ~60s). */
  nvErrNoMemory?: number;
  /** Kernel Xid errors and OOM-killer kills since boot (cached ~60s). null when the journal is unreadable. */
  kernelErrors?: { xid: number; oomKills: number; lastXid: string | null } | null;
  /**
   * Per-physical-GPU breakdown for multi-card hosts. The fields above stay the
   * fleet-wide aggregate (hottest / busiest card, summed power and VRAM), so a
   * one-GPU DGX Spark has exactly one entry here mirroring them.
   */
  gpus?: GpuDevice[];
}

/** One physical GPU; `index` is a stable dashboard identity and `physicalIndex` is the vendor's index (nvidia-smi, amd-smi, or Intel sysfs). */
export interface GpuDevice {
  /** Stable dashboard identity; AMD indices use a separate internal range. */
  index: number;
  /** Physical index reported by the vendor tool. */
  physicalIndex?: number;
  /** Absent on payloads from servers older than vendor tagging; treat as "nvidia". */
  vendor?: "amd" | "nvidia" | "apple" | "intel";
  metricAvailability?: GpuMetricAvailability;
  name: string | null;
  /** NVIDIA GPU uuid; null for other vendors. */
  uuid: string | null;
  temperature: number;
  usage: number;
  power: { draw: number; limit: number };
  vram: { used: number; total: number; percentage: number; available: number };
  throttle?: GpuThrottle | null;
  /** Processes holding memory on this card only. */
  processes?: Array<{ pid: number; name: string; vramMB: number }>;
  /** Intel only: fan speed in rpm, null when the card has no fan sensor. */
  fanRpm?: number | null;
  /** Intel only: "debugfs" = measured VRAM use; "pci-bar" = total only, used is unknown (shown as 0). */
  vramSource?: "debugfs" | "pci-bar";
}

// ─── CPU metrics ─────────────────────────────────────────
export interface CpuMetrics {
  usage: number;
  temperature: number;
  /** What the temperature reading is: "CPU", or "ACPI"/"SoC" for a board zone. */
  temperatureLabel?: string | null;
  /** Raw sensor name behind the reading (e.g. "acpitz", "coretemp"). */
  temperatureSource?: string | null;
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

// ─── RoCE / RDMA (server/collectors/roce.js) ──────────────
export interface RoceQos {
  /** "pcp" or "dscp" (mlnx_qos "Priority trust state"). */
  trust: string | null;
  /** Priorities with PFC enabled; [] means PFC is off everywhere; null when mlnx_qos is unavailable. */
  pfcPriorities: number[] | null;
  cableLen: number | null;
  /** priority -> DSCP values, present in DSCP trust mode. */
  dscpMap: Record<string, number[]> | null;
}

export interface RoceDevice {
  /** RDMA device, e.g. "rocep1s0f0". */
  name: string;
  /** Its network interface, e.g. "enp1s0f0np0". */
  netdev: string | null;
  state: string | null;
  physState: string | null;
  active: boolean;
  /** Was ACTIVE at some point while sparkDash watched; an uncabled port never is. */
  everActive: boolean;
  rateGbps: number | null;
  linkLayer: string | null;
  operstate: string | null;
  mtu: number | null;
  speedMbps: number | null;
  rxBps: number | null;
  txBps: number | null;
  rxErrors: number | null;
  txErrors: number | null;
  rxDropped: number | null;
  txDropped: number | null;
  /** RDMA hw_counters, lifetime totals. */
  counters: Record<string, number>;
  /** Change since the previous sample. */
  deltas: Record<string, number>;
  loss: { rising: string[]; streak: number };
  /** ethtool -S subset (discards, CRC, pause frames, per-priority). */
  eth: Record<string, number> | null;
  flowControl: { rx: boolean | null; tx: boolean | null } | null;
  qos: RoceQos | null;
}

export interface RoceMetrics {
  available: true;
  sampledAt: number;
  devices: RoceDevice[];
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
  /** The LLM port this snapshot came from — lets the UI match panels to probes by port, not array position. */
  port?: number;
  available: boolean;
  backend: "vllm" | "llama.cpp" | "sglang" | "lmstudio" | "ollama" | "ds4" | "exl3" | "q27" | "tensorfold" | "freetoken" | null;
  /** How the monitor reaches the engine: its own address, or an SSH forward when only SSH gets there. */
  via?: "direct" | "ssh-tunnel";
  modelId: string | null;
  modelPath: string | null;
  /** Exact served request IDs from /v1/models, in response order. */
  models?: string[];
  contextLength: number | null;
  /** GPU memory utilization for the LLM engine (0–1), e.g. 0.9. Only from vLLM internal info. */
  gpuMemoryUtilization: number | null;
  /** Occupied slots; null when the backend does not report occupancy. */
  slotsActive: number | null;
  slotsTotal: number;
  generationTps: number;
  prefillTps: number;
  /** A prompt is being processed right now. With no live rate available (TensorFold reports totals only for finished requests) the UI says "prefilling" instead of 0. */
  prefillActive?: boolean;
  /** Live cached-prefill tok/s when the backend splits kinds (ds4, llama.cpp, sglang). */
  cachedPrefillTps?: number | null;
  /** Live uncached/computed prefill tok/s when split is available. */
  uncachedPrefillTps?: number | null;
  /** Cumulative total output (generation) tokens as reported by the LLM server */
  totalOutputTokens: number;
  /** Cumulative cached (prefix-cache served) prompt tokens. null when the backend does not expose the split. */
  totalCachedTokens: number | null;
  /** Cumulative total prompt (prefill) tokens as reported by the LLM server. null when the backend does not expose it. */
  totalPromptTokens: number | null;
  /**
   * Share of the engine's KV cache pool held by requests (0–1): vLLM, q27,
   * SGLang (`token_usage`) and TensorFold (`pool_tokens`). null when unknown.
   */
  kvCacheUsage?: number | null;
  /** Allocated KV-cache pool in tokens (vLLM `cache_config_info`). null when unknown. */
  kvCacheTokens?: number | null;
  /** Free tokens in that pool (pool × (1 − usage)). null when pool or usage is unknown. */
  kvCacheTokensAvailable?: number | null;
  /** Allocated KV-cache pool in bytes. null when unknown. */
  kvCacheMemoryBytes?: number | null;
  /** Engine KV cache pool size in GB (SGLang). null when the backend does not report it. */
  kvCacheGb?: number | null;
  /** Engine model weights resident in GPU memory, GB (SGLang). null when not reported. */
  weightsGb?: number | null;
  /** vLLM running request count. null when unavailable. */
  requestsRunning?: number | null;
  /** vLLM waiting request count. null when unavailable. */
  requestsWaiting?: number | null;
  /** vLLM time-to-first-token p95 in seconds. null when unavailable. */
  ttftP95Seconds?: number | null;
  /** Live recent-window mean TTFT (seconds) from vLLM histogram sum/count deltas. null when unavailable. */
  ttftSeconds?: number | null;
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
  /**
   * Observational exposure hint from unauthenticated probe reachability +
   * configured target host scope. null when auth status is unknown.
   * Does not claim process bind address.
   */
  posture?: LlmPosture | null;
  /**
   * Epoch ms of the last poll in which this endpoint generated or prefilled
   * tokens. Server memory only: null after a sparkDash restart until traffic.
   */
  lastActiveAt?: number | null;
  error: string | null;
}

/** One UTC day of busy tok/s rollups (null avg = no busy samples). */
export interface LlmDailyDay {
  date: string;
  decodeMax: number;
  decodeAvg: number | null;
  prefillMax: number;
  prefillAvg: number | null;
  cachedPrefillMax: number | null;
  cachedPrefillAvg: number | null;
  uncachedPrefillMax: number | null;
  uncachedPrefillAvg: number | null;
}

export interface LlmDailyResponse {
  sparkId: string;
  port: number;
  days: LlmDailyDay[];
}

/** Security posture badge payload from LlmProbe. */
export interface LlmPosture {
  /** ok = green, warn = amber, danger = red */
  level: "ok" | "warn" | "danger";
  auth: "open" | "protected" | "keyed";
  scope: "local" | "lan" | "public" | "unknown";
  /** Short badge text */
  label: string;
  /** Tooltip / title detail */
  detail: string;
}

// ─── ComfyUI metrics ─────────────────────────────────────
/** Active or queued ComfyUI job (parsed from /queue prompt graph). */
export interface ComfyJob {
  id: string;
  status: "running" | "pending";
  /** Workflow title when present in extra_pnginfo. */
  title: string | null;
  /** Model weight files referenced by loader nodes. */
  models: string[];
  nodeCount: number;
  steps: number | null;
  width: number | null;
  height: number | null;
  batchSize: number | null;
  sampler: string | null;
  /** Queue entry create time (ms epoch when available). */
  createTime: number | null;
}

/** Live or estimated progress for the active Comfy job. */
export interface ComfyProgress {
  promptId: string | null;
  nodeId: string | null;
  nodeLabel: string | null;
  value: number;
  max: number;
  percent: number | null;
  updatedAt: number;
  /** ws = Comfy WebSocket frames; estimate = elapsed/avg heuristic */
  source?: "ws" | "estimate";
}

export interface ComfyLastJob {
  id: string;
  status: "completed" | "failed" | "cancelled" | string;
  title: string | null;
  durationMs: number | null;
  endedAt: number | null;
}

export interface ComfyModelsInstalled {
  checkpoints: string[];
  loras: string[];
}

export interface ComfyMetrics {
  available: boolean;
  port: number;
  version: string | null;
  pytorchVersion: string | null;
  /** Primary device type from /system_stats (e.g. cpu, cuda) — not VRAM. */
  deviceType?: string | null;
  queueRunning: number;
  queuePending: number;
  /** Currently executing job, if any. */
  activeJob?: ComfyJob | null;
  /** Next pending jobs (capped server-side). */
  pendingJobs?: ComfyJob[];
  progress?: ComfyProgress | null;
  lastJob?: ComfyLastJob | null;
  modelsInstalled?: ComfyModelsInstalled | null;
  /** Estimated ms until queue idle (running remainder + pending × avg). */
  queueEtaMs?: number | null;
  /** Browser-openable ComfyUI base URL (probe host + port). */
  openUrl?: string | null;
  error: string | null;
}

export interface TailscaleMetrics {
  /** True when `tailscale status --json` was read and had a Self entry. */
  available: boolean;
  /**
   * The node's OWN view of whether it is talking to the coordination server.
   * null when tailscale did not report it.
   */
  online: boolean | null;
  /** tailscaled's own state: Running | Stopped | NeedsLogin | NoState. */
  backendState: string | null;
  hostName: string | null;
  dnsName: string | null;
  tailscaleIp: string | null;
  /** DERP relay region, or null when the node has a direct path. */
  relay: string | null;
  /** ISO timestamp; null when key expiry is disabled for this node. */
  keyExpiry: string | null;
  keyExpired: boolean;
  version: string | null;
  /** Tailscale's own health warnings — these explain a false `online`. */
  health: string[];
  error: string | null;
}

// ─── Full metrics snapshot ────────────────────────────────
export interface SparkMetrics {
  gpu: GpuMetrics | null;
  cpu: CpuMetrics | null;
  ram: RamMetrics | null;
  storage: StorageMetrics[];
  network: NetworkMetrics | null;
  /** RoCE / RDMA ports; null when the unit has no RDMA devices. */
  roce?: RoceMetrics | null;
  unifiedMemory: UnifiedMemoryMetrics | null;
  /** Array of LLM metrics, one per configured port. Empty array when no ports. */
  llm: LlmMetrics[];
  /** Loaded models discovered in private vLLM containers over SSH; no throughput claim. */
  residentModels?: Array<{ modelId: string; container: string }>;
  /** ComfyUI probe result when monitoring is enabled; null when off or not yet polled. */
  comfy?: ComfyMetrics | null;
  /** Tailnet probe result when monitoring is enabled; null when off or not yet polled. */
  tailscale?: TailscaleMetrics | null;
}

// ─── Spark snapshot (server pushes this) ──────────────────
export interface SparkSnapshot {
  id: string;
  /** Active health findings, most important first is not guaranteed; sort with sortFindings. */
  health?: HealthFinding[];
  name: string;
  /** Why the last liveness check failed, when offline. null/absent when online. */
  offlineReason?: string | null;
  /** Unit type: spark (DGX Spark) or host (dedicated GPU Linux box). */
  kind?: "spark" | "host";
  /** OS of an SSH-collected unit; Windows units have no model launchers or CPU temperature. */
  platform?: "linux" | "darwin" | "windows";
  online: boolean;
  /** Uptime in seconds, or null when offline */
  uptime: number | null;
  /** LAN IP for browser deep-links (e.g. Open ComfyUI). */
  lanIp?: string;
  isLocal?: boolean;
  disabledDevices: string[];
  disabledInterfaces: string[];
  storagePollDisabled?: boolean;
  /** Cluster role (head / worker / standalone) */
  role?: SparkRole;
  /** Distributed LLM worker — LLM card inactive / not shown (role === worker) */
  workerNode?: boolean;
  /** Optional cluster/model label when role is worker */
  workerLabel?: string | null;
  /**
   * Derived worker label: live mirror of the head's served model id.
   * Display-only (never written to config). A non-empty manual workerLabel
   * takes priority over this in the UI.
   */
  workerDerivedLabel?: string | null;
  /** Optional head Spark id when role is worker */
  workerHeadId?: string | null;
  /** Standalone: whether LLM is probed (head always true, worker always false) */
  llmMonitoring?: boolean;
  /** LLM server port (first port, for backward compat) */
  llmPort: number;
  /** All LLM server ports configured for this Spark */
  llmPorts: number[];
  /** Ports with a stored LLM API key (key itself never exposed) */
  llmApiKeyPorts?: number[];
  /** Whether ComfyUI is probed (opt-in; all roles) */
  comfyMonitoring?: boolean;
  /** ComfyUI HTTP port (default 8188) */
  comfyPort?: number;
  /** Whether tailnet presence is probed (opt-in; all roles) */
  tailscaleMonitoring?: boolean;
  /** Hermes Agent update monitoring state (present in every snapshot). */
  hermes?: HermesStatus;
  hardware: HardwareInfo;
  metrics: SparkMetrics;
  /** Harness sessions by LLM port. Absent until the occupancy poller has a projection. */
  conversations?: Record<string, ConversationRow[]>;
}

// ─── WebSocket envelope ───────────────────────────────────
export interface WsSnapshot {
  type: "snapshot";
  /** Server generation time; optional while clients and servers roll independently. */
  generatedAt?: number;
  sparks: SparkSnapshot[];
  refreshInterval: number;
  /** Alert notifications' firing set — present only while `alertsEnabled` is on. */
  alerts?: { active: AlertInstance[] };
}

// ─── Alert notifications (server/alerts) ──────────────────
export type AlertSeverity = "warning" | "critical";

/**
 * One pending or firing alert (GET /api/alerts, WS `alerts.active`). The
 * condition is a Health finding or an Overview strip exception; `ruleId` is the
 * finding id (thermal, memory, …) or the strip's (offline, throttle, disk, llm, tailnet).
 */
export interface AlertInstance {
  /** `${unitId}:${ruleId}` — the same key the Overview strip uses. */
  key: string;
  ruleId: string;
  ruleName: string;
  unitId: string;
  unitName: string;
  severity: AlertSeverity;
  /** Highest severity reached while firing (a resolved alert is routed by it). */
  peakSeverity?: AlertSeverity;
  state: "pending" | "firing";
  /** Short predicate after the unit name ("GPU is running hot"). */
  label: string;
  summary: string;
  /** Epoch ms the condition first held — survives a server restart. */
  startsAt: number;
  firingAt: number | null;
}

/** One firing / resolved transition (newest first in `recent`). */
export interface AlertEvent {
  id: number;
  at: number;
  status: "firing" | "resolved";
  key: string;
  ruleId: string;
  ruleName: string;
  unitId: string;
  unitName: string;
  severity: AlertSeverity;
  label: string;
  summary: string;
  startsAt: number;
  endsAt: number | null;
}

export interface AlertsResponse {
  enabled: boolean;
  active: AlertInstance[];
  pending: AlertInstance[];
  recent: AlertEvent[];
}

/** A rule as GET /api/alerts/config describes it: where it comes from, on/off and `for`. */
export interface AlertRule {
  id: string;
  name: string;
  description: string;
  source: "health" | "strip";
  defaults: { enabled: boolean; forSec: number };
  /** Only the values the user changed. */
  overrides: { enabled?: boolean; forSec?: number };
}

export type AlertChannelType = "ntfy" | "discord" | "slack" | "webhook";

export interface AlertChannel {
  /** Absent on a channel added in the dialog and not yet saved. */
  id?: string;
  name: string;
  type: AlertChannelType;
  /** Masked by the server (`https://ntfy.sh…ab12`); send it back unchanged to keep it. */
  url: string;
  /** The server has a URL for this channel (in its encrypted secrets store). */
  hasUrl?: boolean;
  enabled: boolean;
  minSeverity: AlertSeverity;
  /** `lastError` is a status code or a fixed reason, never a server's answer. */
  status?: { lastSentAt: number | null; lastError: string | null; lastErrorAt: number | null };
}

export interface AlertsConfig {
  enabled: boolean;
  /** 0 = no reminders while an alert keeps firing. */
  repeatIntervalMin: number;
  rules: AlertRule[];
  channels: AlertChannel[];
}

export interface AlertsConfigUpdate {
  repeatIntervalMin?: number;
  rules?: Record<string, { enabled?: boolean; forSec?: number }>;
  channels?: AlertChannel[];
}

export interface AlertTestResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface FleetEnergy {
  estimated: boolean;
  membershipChanged: boolean;
  restartRequired: boolean;
  trackedNodeIds: string[];
  currentNodeIds: string[];
  freshNodeCount: number;
  /** Tracked nodes without a fresh power reading right now (offline or stale telemetry). */
  staleNodeIds?: string[];
  currentWatts30s: number | null;
  energy24hKwh: number | null;
  energy31dKwh: number | null;
  whPerOutputToken24h: number | null;
  outputTokens24h: number;
  coverage24hMs: number;
  /** Window coverage24hMs is measured over (server-owned; fleet-size independent). */
  coverage24hWindowMs?: number;
  coverage31dMs: number;
  coverage31dWindowMs?: number;
  nodeCoverage24hMs: Record<string, number>;
  nodeCoverage31dMs: Record<string, number>;
  hourlyWatts24h: Array<number | null>;
}

// ─── API responses ────────────────────────────────────────
/**
 * How the server authenticates requests (GET /api/health).
 * "open-remote" — bound off loopback with no SPARKDASH_TOKEN: anyone who can reach it can mutate.
 * "required-missing" — the same bind with SPARKDASH_ALLOW_OPEN_REMOTE=0, failing closed.
 */
export type AuthMode = "bearer" | "loopback-open" | "open-remote" | "required-missing";

export interface HealthResponse {
  ok: boolean;
  bindHost: string;
  authMode: AuthMode;
  errors: string[];
  warnings: string[];
}

export interface InferenceActivity {
  enabled: boolean;
  available: boolean;
  /** Approved non-secret display labels, never API keys. */
  labels: string[];
  generatedAt: string | null;
  error: string | null;
  active: Array<{
    principal: string;
    model: string;
    count: number;
    oldestAgeMs: number;
    newestAgeMs: number;
  }>;
  recent: Array<{
    principal: string;
    model: string;
    durationMs: number;
    status: number | null;
    observedAt: string;
  }>;
  overflowed: boolean;
}

export interface Settings {
  /** Read-only server capability; configured through environment variables. */
  inferenceActivityEnabled?: boolean;
  pollIntervalMs: number;
  defaultLlmPort: number;
  autoHideOffline: boolean;
  /** Hide worker-role Sparks from Overview cards and the tab bar. */
  hideWorkers: boolean;
  temperatureUnit: "celsius" | "fahrenheit";
  /** Persist prompts / HTTP traces / GPU samples on decode benchmark runs. */
  benchDebugTraces: boolean;
  /** Layout density — compact (default) or comfortable. */
  density: "comfortable" | "compact";
  /** Overview Fleet Energy card. Off by default. */
  showFleetEnergy: boolean;
  /** Overview active fleet exceptions strip. Off by default. */
  showFleetExceptions: boolean;
  /** Overview search field + status filter. Off by default. */
  showOverviewSearch: boolean;
  showLlmTokenTotals: boolean;
  /** Overview KPI tiles and the Recent activity card; each can be hidden. All on by default. */
  showKpiDecode?: boolean;
  showKpiPower?: boolean;
  showKpiMemory?: boolean;
  showKpiTokens?: boolean;
  showActivityFeed?: boolean;
  /** Benchmark dialogs offer "Copy image" — a PNG share card of the results. */
  benchShareImage: boolean;
  /** IANA time zone for the Tokens, Energy and Activity charts; "" follows the browser. */
  timeZone?: string;
  /** Electricity price per kWh for cost estimates on the energy page; null = not set. */
  energyPricePerKwh: number | null;
  /** Currency symbol shown with cost estimates. */
  energyCurrency: string;
  /**
   * VRAM bars split by engine / system / free and judged by headroom. On by
   * default (server DEFAULTS and the UI's pre-load fallback both say true).
   */
  showVramBreakdown: boolean;
  /** Serve GET /metrics in Prometheus text format. Off by default (404 when off). */
  prometheusExport: boolean;
  /** Let the Intel (xe) probe read debugfs VRAM through sudo -n. Off by default. */
  intelVramSudo: boolean;
  /** VulnHunter scans, installs and harness-command changes are opt-in (off by default). */
  vulnhuntEnabled: boolean;
  /** REA (Tools): install, uploads and analysis runs on a unit are opt-in (off by default). */
  reaEnabled: boolean;
  /**
   * Keep 48 h / 30 days of per-unit history on the server and chart it in a History
   * panel on the unit page. Off by default.
   */
  metricsHistory?: boolean;
  /** Alert notifications (Settings → Alerts). Off by default; while off nothing is evaluated or sent. */
  alertsEnabled?: boolean;
  /**
   * Hide harness sessions older than this. Finite: 1 minute through 14 days.
   * Missing or out of range becomes 12 hours.
   */
  occupancyMaxAgeMs: number;
}

export type OccupancyBadge = "unknown" | "generating" | "stalled";

export interface ConversationRow {
  id: string;
  source: string;
  handle: string;
  badge: OccupancyBadge;
  port: number;
  routingProvenance?: string;
  stale?: boolean;
  lastUsedAt?: number;
  agent?: string;
  contextUsed?: number | null;
  contextWindow?: number | null;
  contextApprox?: boolean;
}

export interface OccupancyRoute {
  harness: string;
  sparkId: string;
  port: number;
  cwdPrefix?: string;
}

export interface OccupancyHelper {
  id: string;
  label: string;
  url: string;
  enabled: boolean;
  harnesses: string[];
  routes: OccupancyRoute[];
  hasToken: boolean;
}

export interface OccupancyHelperInput {
  id?: string;
  label?: string;
  url: string;
  enabled?: boolean;
  harnesses: string[];
  routes: OccupancyRoute[];
  token?: string;
}

export interface OccupancyAdapterSummary {
  coverage: "supported" | "unsupported" | "unavailable" | "partial" | string;
  stale: boolean;
  rows: number;
  error: string | null;
}

export interface OccupancyCheck {
  ok: boolean;
  observedAt: number;
  adapters: Record<string, OccupancyAdapterSummary>;
  rowCount: number;
}

// ─── Unit history (GET /api/sparks/:id/history) ──────────
export type MetricsHistoryRange = "1h" | "6h" | "24h" | "7d" | "30d";

/** One series in one bucket. `min` only on memFreeMB (headroom's low point). */
export interface HistoryStat {
  avg: number;
  max: number;
  min?: number;
}

/** Unit-level series: %, °C, W, MB, bytes/s. */
export type HistoryUnitSeries =
  | "gpuUtil"
  | "gpuTemp"
  | "gpuPower"
  | "memUsedMB"
  | "memFreeMB"
  | "cpuUtil"
  | "cpuTemp"
  | "ramUsedMB"
  | "netRx"
  | "netTx";

/** Per LLM endpoint: tok/s, and the KV pool fill as 0–1. */
export type HistoryLlmSeries = "genTps" | "prefillTps" | "kvUsage";

/** A bucket; a series the unit did not report in it is absent (a gap). */
export type HistoryPoint = { t: number } & Partial<Record<HistoryUnitSeries, HistoryStat>>;
export type HistoryLlmPoint = { t: number } & Partial<Record<HistoryLlmSeries, HistoryStat>>;

export interface MetricsHistoryData {
  enabled: true;
  range: MetricsHistoryRange;
  /** Bucket width of the points; a jump larger than this is a gap. */
  stepMs: number;
  /** Window the range covers (epoch ms); the x-axis spans exactly this. */
  from: number;
  to: number;
  points: HistoryPoint[];
  llm: Array<{ port: number; points: HistoryLlmPoint[] }>;
}

export type MetricsHistoryResponse = MetricsHistoryData | { enabled: false };

export interface SparksListResponse {
  sparks: SparkConfig[];
}

export interface SparkTestResponse {
  id: string;
  capabilities: Array<{
    id: "host" | "llm" | "comfy" | "hermes" | "tailnet";
    label: string;
    status: "pass" | "fail" | "skipped";
    required: boolean;
    message: string;
    recovery: string | null;
  }>;
  ssh: { ok: boolean; message: string };
  llm: { ok: boolean; message: string; skipped?: boolean };
  comfy?: { ok: boolean; message: string; skipped?: boolean };
  ok: boolean;
}

export interface ApiError {
  error: string;
}

// ─── LLM decode benchmark ────────────────────────────────
/** Output-shape label for decode bench prompts (not guided decoding). */
export type DecodeBenchPromptType = "structured" | "prose" | "code" | "json";

/** On-demand remote LLM endpoint for decode/prefill benches. */
export interface LlmBenchTarget {
  host: string;
  port: number;
  tls: boolean;
}

export interface DecodeBenchConfig {
  port: number;
  modelId: string | null;
  concurrencies: number[];
  maxTokens: number;
  /** Output-shape label only — not guided decoding / JSON schema. */
  promptType?: DecodeBenchPromptType;
  /** On-demand remote host (Tailscale HTTPS, etc.). */
  host?: string;
  tls?: boolean;
}

export interface DecodeBenchStreamResult {
  index: number;
  ttftMs: number;
  /** First answer token (post-reasoning) in ms from request start; null when the reply never leaves the reasoning phase. */
  ttftContentMs: number | null;
  /** Number of streamed chunks that carried reasoning (not answer) text. */
  reasoningChunks: number;
  decodeTps: number;
  decodeTokens: number;
  completionTokens: number;
  prefillTps: number;
  prefillTokens: number;
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
  meanPrefillTps: number;
  medianPrefillTps: number;
  /** Sum prompt tokens / concurrent TTFT window (min start → max first token) */
  aggregatePrefillTps: number;
  totalPrefillTokens: number;
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
  /** Generation tok/s measured from the streams of the running wave; null before the first token. */
  liveTps?: number | null;
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
  promptTypes: DecodeBenchPromptType[];
  defaultPromptType: DecodeBenchPromptType;
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
  /** Output type: structured (default), prose, code, json. Prompt only. */
  promptType?: DecodeBenchPromptType;
  /** On-demand remote LLM host (hostname or URL). Skips this Spark's LAN/SSH path. */
  host?: string;
  tls?: boolean;
}

// ─── LLM prefill benchmark ───────────────────────────────
export interface PrefillBenchConfig {
  port: number;
  modelId: string | null;
  contextSizes: number[];
  /** Model context the run was started against (null/absent when unknown). */
  contextLength?: number | null;
  host?: string;
  tls?: boolean;
}

export interface PrefillBenchSizeResult {
  targetTokens: number;
  promptTokens: number;
  promptChars: number;
  prefillTps: number;
  /** "server" = backend-reported prompt timing; "ttft" = tokens / (TTFT − calibrated overhead). */
  method?: "server" | "ttft";
  /** Prompt tokens served from the prefix cache (excluded from the rate). */
  cachedTokens?: number;
  /** Successful samples (the reported values are the median-rate one). */
  samples?: number;
  /** Samples the size asked for; samples < samplesRequested means a partial row (see `notice`). */
  samplesRequested?: number;
  /** The TTFT-method rate leans heavily on the overhead calibration (overhead > 30% of TTFT). */
  lowConfidence?: boolean;
  /** Why a row is partial (some samples failed or were cancelled). */
  notice?: string;
  /** Fixed per-request overhead subtracted from TTFT, ms. */
  overheadMs?: number;
  ttftMs: number;
  ttftContentMs: number | null;
  completionTokens: number;
  durationMs: number;
  model: string | null;
  error: string | null;
}

export interface PrefillBenchProgress {
  currentContext: number | null;
  completedLevels: number;
  totalLevels: number;
  message: string;
}

export interface PrefillBenchJob {
  benchId: string;
  sparkId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt: number | null;
  config: PrefillBenchConfig;
  progress: PrefillBenchProgress;
  results: PrefillBenchSizeResult[];
  error: string | null;
  durationMs: number;
}

export interface PrefillBenchDefaults {
  allowedContextSizes: number[];
  defaultContextSizes: number[];
  minContextSize?: number;
  maxContextSize?: number;
}

export interface PrefillBenchListResponse {
  active: PrefillBenchJob | null;
  last: PrefillBenchJob | null;
  history: PrefillBenchJob[];
  defaults: PrefillBenchDefaults;
}

export interface StartPrefillBenchRequest {
  port?: number;
  contextSizes: number[];
  modelId?: string | null;
  host?: string;
  tls?: boolean;
}

// ─── LLM quality benchmark ───────────────────────────────
export type QualityCategory = "qa" | "reason" | "arith" | "track" | "gsm8k" | "mmlu" | "follow" | "long";

export interface QualityBenchConfig {
  port: number;
  modelId: string | null;
  /** Model context from the live probe or `/v1/models` (null when unknown). */
  contextLength: number | null;
  suiteVersion: number;
  /** Scoring-rule version; runs with different values are not comparable. Absent on old runs (= 1). */
  scoringVersion?: number;
  categories: QualityCategory[];
  longSizes: number[];
  longItems: number;
  concurrency: number;
  /** Free-text run label, e.g. "fp4 KV". */
  label: string;
  host?: string;
  tls?: boolean;
}

export interface QualityItemResult {
  id: string;
  category: QualityCategory;
  ok: boolean;
  /** Short reply excerpt (head for direct answers, tail for thinking categories). */
  excerpt: string;
  /** sha256 prefix of the reply — "identical replies" in compare. */
  hash: string;
  finishReason: string | null;
  completionTokens: number;
  promptTokens: number;
  durationMs: number;
  error: string | null;
  /** Parsed answer, failing test line, or long-recall key counts. */
  detail: string | null;
  longCorrect?: number;
  longTotal?: number;
  longStale?: number;
}

export interface QualityCategorySummary {
  /** Passed among scored items (request errors/timeouts excluded). */
  passed: number;
  /** Every item run, errors included. */
  total: number;
  /** Items that got an answer (total − errors); pct = passed / scored. Absent on old runs. */
  scored?: number;
  pct: number | null;
  errors: number;
  meanCompletionTokens: number;
  hitMaxTokens: number;
  keysFound?: number;
  keysTotal?: number;
  stale?: number;
}

export interface QualityBenchResults {
  /** Omitted in history summaries — fetch the run by id for per-item rows. */
  items?: QualityItemResult[];
  itemCount?: number;
  categories: Partial<Record<QualityCategory, QualityCategorySummary>>;
  /** Mean of the category percentages. */
  overallPct: number | null;
  /** Long sizes skipped because they exceed the model context. */
  skippedLongSizes: number[];
}

export interface QualityBenchProgress {
  currentCategory: QualityCategory | null;
  categoryDone: number;
  categoryTotal: number;
  done: number;
  total: number;
  message: string;
}

export interface QualityBenchJob {
  benchId: string;
  sparkId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt: number | null;
  config: QualityBenchConfig;
  progress: QualityBenchProgress;
  results: QualityBenchResults;
  error: string | null;
  durationMs: number;
}

export interface QualityBenchDefaults {
  categories: QualityCategory[];
  defaultCategories: QualityCategory[];
  longSizes: number[];
  defaultLongSizes: number[];
  defaultLongItems: number;
  maxLongItems: number;
  defaultConcurrency: number;
  maxConcurrency: number;
}

export interface QualityBenchListResponse {
  active: QualityBenchJob | null;
  last: QualityBenchJob | null;
  /** Newest first, last 30 runs; summaries only (no per-item rows). */
  history: QualityBenchJob[];
  defaults: QualityBenchDefaults;
}

export interface StartQualityBenchRequest {
  port?: number;
  categories: QualityCategory[];
  longSizes?: number[];
  longItems?: number;
  concurrency?: number;
  label?: string;
  modelId?: string | null;
  host?: string;
  tls?: boolean;
}

// ─── LLM Prompt Showcase ─────────────────────────────────
export type ShowcasePromptType = "structural" | "text" | "mixed";

export interface ShowcaseStartRequest {
  port: number;
  modelId?: string | null;
  maxTokens?: number;
  /** Sampling temperature (0–2). Defaults to 0.7 on the server. */
  temperature?: number;
  /** When true, enable model thinking/reasoning flags (UI defaults to off). */
  thinking?: boolean;
  /** Catalog mode used to seed prompts (structural / text / mixed). */
  promptType?: ShowcasePromptType | null;
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
  peakTokPerSec?: number;
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
  maxTokens?: number | null;
  temperature?: number;
  thinking?: boolean;
  promptType?: ShowcasePromptType | null;
  startedAt?: number;
  completedAt?: number | null;
  /** Median server generation tok/s from /metrics during the run (null if unavailable). */
  serverGenerationTps?: number | null;
  serverGenerationTpsMax?: number | null;
  serverGenerationSamples?: number;
  totalTokens?: number;
  meanDecodeTps?: number;
  peakStreamTps?: number;
  streamCount?: number;
  streams: ShowcaseStreamState[];
  error?: string | null;
  /** True when loaded from disk history (not a live poll session). */
  fromHistory?: boolean;
}

/** List-row for finished showcase runs (no stream bodies). */
export interface ShowcaseHistorySummary {
  sessionId: string;
  sparkId: string;
  status: "completed" | "cancelled" | "error" | string;
  port: number;
  modelId?: string | null;
  maxTokens?: number | null;
  temperature?: number;
  thinking?: boolean;
  promptType?: ShowcasePromptType | null;
  startedAt?: number | null;
  completedAt?: number | null;
  serverGenerationTps?: number | null;
  serverGenerationTpsMax?: number | null;
  totalTokens: number;
  meanDecodeTps: number;
  peakStreamTps: number;
  streamCount: number;
  error?: string | null;
}

export interface ShowcaseListResponse {
  active: { sessionId: string; status: string } | null;
  history: ShowcaseHistorySummary[];
}

export interface ShowcaseStartResponse {
  sessionId: string;
  status: "running";
}

export interface ActivityEvent {
  id: number;
  ts: number;
  type: string;
  severity: "info" | "warn" | "error" | "success";
  sparkId?: string | null;
  sparkName?: string | null;
  message: string;
  data?: unknown;
}

// ─── User-registered LLM launchers (start.sh / stop.sh) ───
export interface LlmLauncher {
  id: string;
  name: string;
  /** Absolute directory (or ~/…) holding the scripts. */
  dir: string;
  startScript: string;
  stopScript: string;
  /** LLM port this model serves on, used to show "serving" when the probe sees it. */
  port: number | null;
  notes: string;
  createdAt?: number;
}

export type LlmLauncherInput = {
  name: string;
  dir: string;
  startScript?: string;
  stopScript?: string;
  port?: number | null;
  notes?: string;
};

export type LauncherAction = "start" | "stop" | "attach";
export type LauncherJobStatus = "running" | "completed" | "failed" | "cancelled" | "detached";
export type LauncherRunState = "running" | "stopped" | "unknown";

export interface LauncherJob {
  id: string;
  sparkId: string;
  launcherId: string;
  launcherName: string;
  action: LauncherAction;
  status: LauncherJobStatus;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export interface LauncherListResponse {
  launchers: LlmLauncher[];
  job: LauncherJob | null;
  statuses?: Record<string, LauncherRunState>;
}

export interface LauncherJobRead {
  job: LauncherJob;
  lines: { seq: number; text: string }[];
  partial: string;
  nextSeq: number;
  truncated: boolean;
}

// ─── Detailed fleet pages: history APIs ───
/** One bucket of token traffic for one (Spark, port, model). `t` is a UTC date ("2026-10-07") or UTC hour ("2026-10-07T14"). */
export interface TokenHistoryRow {
  t: string;
  sparkId: string;
  port: number;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from the prefix cache (always <= promptTokens). */
  cachedTokens: number;
}

export interface TokenHistory {
  generatedAt: number;
  retention: { days: number; hours: number };
  firstDay: string | null;
  firstHour: string | null;
  day: TokenHistoryRow[];
  hour: TokenHistoryRow[];
}

/** One UTC hour of fleet energy. `t` is the hour start in ms. */
export interface EnergyHistoryRow {
  t: number;
  nodeWh: Record<string, number>;
  nodeCoverageMs: Record<string, number>;
  avgWatts: number | null;
  fleetEnergyWh: number;
  fleetCoverageMs: number;
  outputTokens: number;
  coveredOutputTokens: number;
}

export interface EnergyHistory {
  estimated: boolean;
  membershipChanged: boolean;
  generatedAt: number;
  retentionMs: number;
  nodeIds: string[];
  hourly: EnergyHistoryRow[];
}

/** One UTC month of the permanent energy roll-up. */
export interface MonthlyEnergyMonth {
  /** "YYYY-MM" (UTC). */
  month: string;
  startMs: number;
  /** Exclusive end of the month. */
  endMs: number;
  /** False while the month is still the current one. */
  closed: boolean;
  /** Nodes that reported in this month (the scope at the time). */
  nodeIds: string[];
  nodes: Record<string, { wh: number; coverageMs: number }>;
  totalWh: number;
  fleetWh: number;
  fleetCoverageMs: number;
  outputTokens: number;
  coveredOutputTokens: number;
  whPerOutputToken: number | null;
}

export interface MonthlyEnergy {
  estimated: boolean;
  generatedAt: number;
  foldedThroughMs: number;
  /** Oldest first. */
  months: MonthlyEnergyMonth[];
}

export interface ActivityEventsPage {
  events: ActivityEvent[];
  /** Id of the oldest event the server still holds (null when it has none). */
  oldestId: number | null;
}

// ─── Tool Eval (tool-eval-bench on a Spark) ───────────────

export type ToolEvalKind =
  | "bool" | "int" | "float" | "string" | "text" | "choice" | "csv" | "list"
  | "repeat" | "path" | "url" | "json" | "range" | "secret";

export interface ToolEvalArgSpec {
  name: string;
  flag: string;
  kind: ToolEvalKind;
  group: string;
  label: string;
  help: string;
  default?: number | string;
  min?: number;
  max?: number;
  choices?: string[];
  /** RegExp source (the server strips the RegExp object). */
  pattern?: string;
  itemPattern?: string;
  maxItems?: number;
  secret?: boolean;
  maxLen?: number;
  maxBytes?: number;
}

export interface ToolEvalGroup {
  id: string;
  label: string;
  help: string;
}

export interface ToolEvalSpec {
  groups: ToolEvalGroup[];
  args: ToolEvalArgSpec[];
  backends: string[];
  categories: string[];
  types: Record<string, string>;
  install: { extras: string[]; source?: string };
}

export interface ToolEvalStatus {
  reachable?: boolean;
  installed: boolean;
  version: string | null;
  path: string | null;
  uv: string | null;
  python: string | null;
  pythonVersion: string | null;
  workDir: string | null;
  error: string | null;
}

export interface ToolEvalUpdateCheck {
  installed: boolean;
  installedCommit?: string | null;
  latestCommit?: string | null;
  latestDate?: string | null;
  /** null when it cannot be told (no commit in the installed version, or GitHub did not answer). */
  upToDate?: boolean | null;
  error?: string | null;
}

export type ToolEvalRunStatus = "running" | "completed" | "failed" | "stopped" | "gone";

export interface ToolEvalRunSummary {
  finalScore: number | null;
  rating: string | null;
  deployability: number | null;
  responsiveness: number | null;
  totalScenarios: number | null;
  safetyWarnings: number;
  toolRunId: string | null;
  model: string | null;
  backend: string | null;
  counts: { pass: number; partial: number; fail: number; other: number } | null;
  toolVersion: string | null;
}

export interface ToolEvalRun {
  id: string;
  sparkId: string;
  type: string;
  typeLabel: string;
  status: ToolEvalRunStatus;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  label: string;
  port: number;
  model: string | null;
  baseUrl: string;
  command: string;
  options: Record<string, unknown>;
  summary: ToolEvalRunSummary | null;
  resultCached: boolean;
}

export type ToolEvalJobStatus = "running" | "completed" | "failed" | "cancelled" | "detached" | "stopped";

export interface ToolEvalJob {
  id: string;
  sparkId: string;
  kind: "run" | "attach" | "install";
  type: string | null;
  status: ToolEvalJobStatus;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export interface ToolEvalLine {
  seq: number;
  text: string;
  stream?: "out" | "err";
}

export interface ToolEvalEvent {
  seq: number;
  event: string;
  [key: string]: unknown;
}

export interface ToolEvalScenarioProgress {
  id: string | null;
  title: string | null;
  category: string | null;
  status: string;
  points: number | null;
  durationSeconds: number | null;
}

export interface ToolEvalProgress {
  phase: string;
  server: { baseUrl: string | null; backend: string | null } | null;
  model: string | null;
  total: number | null;
  index: number;
  done: number;
  current: { id: string | null; title: string | null; category: string | null } | null;
  counts: { pass: number; partial: number; fail: number; other: number };
  points: number;
  scenarios: ToolEvalScenarioProgress[];
  finalScore: number | null;
  error: { code: string; message: string | null } | null;
}

export interface ToolEvalLive {
  job: ToolEvalJob;
  lines: ToolEvalLine[];
  events: ToolEvalEvent[];
  partial: string;
  progress: ToolEvalProgress;
  nextLine: number;
  nextEvent: number;
}

export interface ToolEvalStreamRead {
  run: ToolEvalRun | null;
  live: ToolEvalLive | null;
}

export interface ToolEvalInstallRead {
  job: ToolEvalJob;
  lines: ToolEvalLine[];
  partial?: string;
  nextLine: number;
}

export interface ToolEvalRunRequest {
  type: string;
  options: Record<string, unknown>;
  extraArgs?: string;
  port?: number;
  useSavedKey?: boolean;
  dryRun?: boolean;
}

export interface ToolEvalPreviewResponse {
  ok: boolean;
  command: string;
  port?: number;
  usesSavedKey?: boolean;
  dryRun?: { ok: boolean; exitCode: number | null; output: string; error: string | null };
}

export interface ToolEvalProbeResponse {
  ok: boolean;
  exitCode: number | null;
  output: string;
  error: string | null;
  target: string;
}

export interface ToolEvalRunList {
  runs: ToolEvalRun[];
  active: ToolEvalJob | null;
}

/** Error thrown by the Tool Eval client; carries the server's per-field messages and any busy job. */
export class ToolEvalApiError extends Error {
  status: number;
  errors: string[];
  active: ToolEvalJob | null;
  constructor(message: string, status: number, errors: string[] = [], active: ToolEvalJob | null = null) {
    super(message);
    this.name = "ToolEvalApiError";
    this.status = status;
    this.errors = errors;
    this.active = active;
  }
}

// ─── Security scans (VulnHunter on a unit) ────────────────

export type VulnHuntSeverity = "High+" | "High" | "Medium" | "Low" | "Informational";
export type VulnHuntRunStatus = "running" | "completed" | "failed" | "stopped" | "detached" | "gone";

export interface VulnHuntSetup {
  repository: string;
  /** The VulnHunter revision the dashboard installs. */
  pinnedRev: string;
  /** Where the unit's user keeps the harness command (a path, never its contents). */
  hostCommandFile: string;
  steps: string[];
  limits: { defaultTimeoutMinutes: number; minTimeoutMinutes: number; maxTimeoutMinutes: number };
  /** The VulnHunter opt-in setting (Settings); off by default. */
  enabled: boolean;
  /** Same as `enabled`: scans, installs and harness-command changes are refused until it is on. */
  startAllowed: boolean;
  startBlockedReason: string | null;
  /** VULNHUNT_ALLOWED_HOSTS: when not empty, scans may only clone from these hosts. */
  allowedHosts: string[];
}

export interface VulnHuntStatus {
  reachable: boolean;
  installed: boolean;
  path: string | null;
  git: boolean;
  setsid: boolean;
  hostCommand: {
    source: "env" | "file" | "none" | "unsafe";
    program: string | null;
    found: boolean;
    file: string | null;
    configured: boolean;
  };
  ready: boolean;
  runRoot: string | null;
  error: string | null;
  /** What the dashboard's installer knows about the unit. */
  install: VulnHuntInstallInfo;
}

export interface VulnHuntInstallInfo {
  pinnedRev: string;
  installedRev: string | null;
  upToDate: boolean;
  skillsDir: string | null;
  agentsDir: string | null;
  /** Version of the Python 3.11+ found on the unit (for example "3.12"); null when there is none. */
  python311: string | null;
  /** Absolute paths of harness skills directories that exist on the unit. */
  skillsDirCandidates: string[];
  /** The agent harnesses the one-click setup knows, and what the unit has of each. */
  harnesses: VulnHuntHarness[];
}

export type VulnHuntHarnessId = "claude" | "codex" | "opencode";

export interface VulnHuntHarness {
  id: VulnHuntHarnessId;
  label: string;
  /** Its CLI exists on the unit. */
  found: boolean;
  /** The dashboard's wrapper script for this harness is installed on the unit. */
  wrapperInstalled: boolean;
  skillsDir: string;
  /** The preset starts the agent with tool restrictions that enforce a read-only scan. */
  roEnforced: boolean;
  note: string;
}

/** Either the one-click variant (a harness id) or the manual one (explicit directories). */
export type VulnHuntInstallRequest = { harness: VulnHuntHarnessId } | { skillsDir: string; agentsDir?: string };

export interface VulnHuntInstallJob {
  id: string;
  sparkId: string;
  kind: "install";
  status: "running" | "completed" | "failed" | "detached" | "cancelled";
  exitCode: number | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface VulnHuntInstallStream {
  job: VulnHuntInstallJob;
  lines: VulnHuntLine[];
  partial: string;
  nextLine: number;
}

export interface VulnHuntInstallStarted {
  job: VulnHuntInstallJob;
  revision: string;
  repository: string;
}

export interface VulnHuntJob {
  id: string;
  sparkId: string;
  kind: "run" | "attach";
  type: string;
  status: "running" | "completed" | "failed" | "stopped" | "detached" | "cancelled";
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  stage: string | null;
}

export interface VulnHuntReportHeader {
  runId: string | null;
  repository: string | null;
  auditDate: string | null;
  branch: string | null;
  model: string | null;
  findingsSummary: string | null;
}

export interface VulnHuntManifest {
  scanId: string | null;
  agentExitCode: number | null;
  costUsd: number | null;
}

export interface VulnHuntCounts {
  "High+": number;
  High: number;
  Medium: number;
  Low: number;
  Informational: number;
  unrated: number;
}

export interface VulnHuntRun {
  id: string;
  sparkId: string;
  status: VulnHuntRunStatus;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  note: string | null;
  label: string;
  source: { type: "url" | "path"; value: string };
  readOnly: boolean;
  timeoutMinutes: number;
  command: string;
  runDir: string;
  /** When the authorization was given and by whom (the dashboard's name for the requester). */
  authorization?: { at: number; by: string } | null;
  resultCached: boolean;
  summary: null | {
    hasReport: boolean;
    header: VulnHuntReportHeader | null;
    manifest: VulnHuntManifest | null;
    total: number;
    counts: VulnHuntCounts;
    exploitPass: number;
    artifactCount: number;
    resultsDir: string | null;
  };
}

export interface VulnHuntFinding {
  id: string;
  title: string;
  cwe: string | null;
  severity: VulnHuntSeverity | null;
  runtime: string | null;
  exploitTest: string | null;
  measuredImpact: string | null;
  status: string | null;
}

export interface VulnHuntReportBundle {
  dir: string;
  /** Markdown written by the scanning agent: untrusted, show as plain text only. */
  report: string;
  findings: VulnHuntFinding[];
  artifacts: string[];
  header: VulnHuntReportHeader;
  manifest: VulnHuntManifest | null;
}

export interface VulnHuntLine {
  seq: number;
  text: string;
  stream: "out" | "err";
}

export interface VulnHuntStreamRead {
  run: VulnHuntRun | null;
  live: null | {
    job: VulnHuntJob;
    lines: VulnHuntLine[];
    events: unknown[];
    partial: string;
    progress: { stage: "starting" | "clone" | "hunt" | "collect" | "done" };
    nextLine: number;
    nextEvent: number;
  };
}

export interface VulnHuntScanRequest {
  source: { type: "url" | "path"; value: string };
  readOnly: boolean;
  /** Only sent when the scan may execute code on the unit. */
  confirmExecute?: boolean;
  authorized: true;
  timeoutMinutes?: number;
  label?: string;
}

/** Error of the security-scan client: keeps the status, the busy job (409) and the delete `canForce` flag. */
export class VulnHuntApiError extends Error {
  status: number;
  active: Partial<VulnHuntJob> | null;
  canForce: boolean;
  constructor(message: string, status: number, active: Partial<VulnHuntJob> | null = null, canForce = false) {
    super(message);
    this.name = "VulnHuntApiError";
    this.status = status;
    this.active = active;
    this.canForce = canForce;
  }
}

// ─── REA (Reverse Engineer Anything) tool ────────────────
// Appended section: types of the /api/rea and /api/sparks/:id/rea endpoints.

export type ReaExecClass = "static" | "native-provider" | "executes-target" | "device" | "network";
export type ReaProviderId = "auto" | "ghidra" | "hopper" | "ida";

export interface ReaSetup {
  repository: string;
  pinnedVersion: string;
  node: { min: string };
  limits: { defaultTimeoutMinutes: number; maxTimeoutMinutes: number; uploadMaxBytes: number; uploadMaxFiles: number };
  enabled: boolean;
  startAllowed: boolean;
  startBlockedReason: string | null;
  deviceWritesEnabled: boolean;
}

export interface ReaEffects {
  launchesProcess: boolean;
  network: boolean;
  writesFs: boolean;
  mutatesDevice: boolean;
  usesProvider: boolean;
}

export type ReaArgKind = "bool" | "int" | "string" | "choice" | "list" | "intlist" | "path" | "json";

export interface ReaArgSpec {
  name: string;
  flag: string | null;
  kind: ReaArgKind;
  help: string;
  positional?: boolean;
  required?: boolean;
  choices?: string[];
  min?: number;
  max?: number;
  default?: string | number | boolean;
  pattern?: string;
  maxLength?: number;
  maxItems?: number;
  jsonType?: "object" | "array";
  allowEmpty?: boolean;
  /** The value (or each list entry) must not contain . or .. path segments. Absent on older servers. */
  noDotDot?: boolean;
  secret?: boolean;
  /** This option is only accepted together with the option of that name. */
  with?: string;
}

export type ReaResultShape = "javascript-app" | "layout" | "native-function" | "generic";

export interface ReaWorkflowSpec {
  id: string;
  label: string;
  group: string;
  blurb: string;
  command: string;
  execClass: ReaExecClass;
  effects: ReaEffects;
  targetKinds: Array<"path" | "upload">;
  targets: 0 | 1 | 2;
  targetLabel: string | null;
  target2Label: string | null;
  needsProvider: boolean;
  prerequisites: string[];
  args: ReaArgSpec[];
  positionals: string[];
  requireOneOf: string[] | null;
  resultShape: ReaResultShape;
  defaultTimeoutMinutes: number;
  viewable: boolean;
}

export interface ReaSpec {
  groups: Array<{ id: string; label: string; help?: string }>;
  workflows: ReaWorkflowSpec[];
  execClasses: Array<{ id: ReaExecClass; label: string; help: string; needsConfirm: boolean }>;
}

export interface ReaDoctorCheck {
  name: string;
  ok: boolean;
  classification?: string;
  detail?: string;
  remediation?: string;
}

/** Ghidra on the unit and whether the dashboard can install it (the optional native-analysis engine). */
export interface ReaGhidraStatus {
  /** `uname -m` of the unit (aarch64 units build Ghidra's decompiler on the unit). */
  arch: string | null;
  /** The Ghidra directory REA would use, from GHIDRA_INSTALL_DIR, the dashboard's install or the PATH. */
  dir: string | null;
  version: string | null;
  /** The native decompiler for this CPU exists in that directory. */
  nativeOk: boolean;
  /** Major version of the 64-bit full JDK REA would use; null when there is none. */
  javaMajor: number | null;
  /** Installed by this dashboard (and exported to REA by it). */
  managed: boolean;
  pinnedVersion: string;
  installable: boolean;
  installReason: string | null;
  freeKib: number | null;
}

export interface ReaStatus {
  reachable: boolean;
  node: {
    path: string | null;
    version: string | null;
    ok: boolean;
    /** The install can fetch the pinned official Node.js into the user's home when none is usable. */
    installable?: boolean;
    installReason?: string | null;
    installVersion?: string | null;
  };
  npm: boolean;
  /** python3 is on the unit (needed only to unpack archive uploads). */
  python3?: boolean;
  ghidra?: ReaGhidraStatus;
  installed: boolean;
  version: string | null;
  pinnedVersion: string;
  upToDate: boolean;
  launcher: string | null;
  doctor: { healthy: boolean; checks: ReaDoctorCheck[] } | null;
  providers: Array<{ id: string; label: string; available: boolean; reason?: string }>;
  engines: Array<{ id: string; label: string; found: boolean; path?: string; unlocks: string }>;
  error: string | null;
}

export interface ReaLine {
  seq: number;
  text: string;
}

export type ReaJobStatus = "running" | "completed" | "failed" | "stopped" | "detached" | "cancelled";

export interface ReaJob {
  id: string;
  sparkId: string;
  kind?: string;
  type?: string;
  status: ReaJobStatus;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  stage?: string | null;
}

export interface ReaInstallStream {
  job: ReaJob;
  lines: ReaLine[];
  partial: string;
  nextLine: number;
}

export type ReaRunStatus = "running" | "completed" | "failed" | "stopped" | "detached" | "gone";

export interface ReaRun {
  id: string;
  sparkId: string;
  status: ReaRunStatus;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  note: string | null;
  label: string;
  workflowId: string;
  workflowLabel: string;
  command: string;
  target: { kind: "path" | "upload"; display: string } | null;
  target2?: { kind: "path" | "upload"; display: string } | null;
  provider: string | null;
  execClass: ReaExecClass;
  effects: ReaEffects;
  authorization?: { at: number; by: string } | null;
  confirmedExecute: boolean;
  timeoutMinutes: number;
  resultBytes: number | null;
  resultCached: boolean;
  summary: ReaResultSummary | null;
}

export interface ReaResultSummary {
  kind: string;
  headline: Record<string, unknown>;
  tables: Array<{ id: string; label: string; total: number; columns: string[] }>;
  findings: Array<{ severity?: string; title: string; detail: string }>;
  limitations: string[];
  unknowns: string[];
  identity: { sha256?: string; format?: string; arch?: string; [key: string]: unknown };
  truncated: boolean;
}

export interface ReaStreamRead {
  run: ReaRun | null;
  live: null | {
    job: ReaJob;
    lines: ReaLine[];
    partial: string;
    progress?: { stage?: string | null } | null;
    nextLine: number;
  };
}

export type ReaTarget =
  | { kind: "path"; value: string }
  | { kind: "upload"; uploadId: string; relPath?: string };

export interface ReaRunRequest {
  workflowId: string;
  target?: ReaTarget;
  target2?: ReaTarget;
  provider?: ReaProviderId;
  options?: Record<string, string | number | boolean | string[] | number[]>;
  timeoutMinutes?: number;
  authorized: true;
  confirmExecute?: true;
  label?: string;
}

export interface ReaViewQuery {
  /** A named collection (modules, sections, symbols). */
  collection?: string;
  /** A native-function or layout facet (pseudocode, mitigations, ...). */
  facet?: string;
  offset?: number;
  limit?: number;
  kind?: "summary";
}

export interface ReaUploadCreated {
  uploadId: string;
  maxBytes: number;
  maxFiles: number;
}

export interface ReaUploadCommitted {
  uploadId: string;
  root: string;
  files: number;
  bytes: number;
  extracted: boolean;
}

/** Error of the REA client: keeps the status, the busy job (409) and the delete `canForce` flag. */
export class ReaApiError extends Error {
  status: number;
  active: Partial<ReaJob> | null;
  canForce: boolean;
  constructor(message: string, status: number, active: Partial<ReaJob> | null = null, canForce = false) {
    super(message);
    this.name = "ReaApiError";
    this.status = status;
    this.active = active;
    this.canForce = canForce;
  }
}
