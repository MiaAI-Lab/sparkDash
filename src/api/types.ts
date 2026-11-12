import type { EnergyPricePeriod } from "../shared/energyTariff";

// ─── Spark config (matches server/sparks.json) ────────────
export interface SparkConfig {
  id: string;
  name: string;
  /**
   * Unit type:
   * - spark: NVIDIA DGX Spark (default) — DGX Spark specs shown in the header.
   * - host: any Linux box with supported NVIDIA or AMD GPUs, just not a Spark.
   *   Real hardware is auto-detected once online.
   * - mac: an Apple Silicon Mac monitored over SSH with macOS tools
   *   (sysctl, vm_stat, powermetrics) and the optional Mac node agent. Always remote.
   */
  kind?: "spark" | "host" | "mac";
  /**
   * Mac units only: read vitals + the runtime inventory from the on-device agent
   * (`agents/macos/sparkdash_mac_agent.py --serve`) instead of SSH-only reads.
   * Set `url` to override the whole endpoint, or `host`/`port` to build one.
   */
  agent?: MacAgentConfig | null;
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

/** What keeps a cap across reboots on a unit: the systemd unit where passwordless
 *  sudo reaches a root shell, the user's `@reboot` cron line where it does not, or
 *  nothing at all. */
export type GpuClockPersistKind = "unit" | "cron" | "none";

/** GET /api/sparks/:id/gpu-clock: the GPU clock cap (`nvidia-smi -lgc`) and its boot hook. */
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
  /** Settings allows typing it over plain http, so the page's secure-context check is skipped. */
  plainPasswordAllowed?: boolean;
      /** "root" runs directly, "yes" = passwordless sudo works, "no" = it does not. */
      sudo: "root" | "yes" | "no";
      /** What "keep after reboot" would install on this unit. */
      persistKind: GpuClockPersistKind;
      service: {
        installed: boolean;
        /** "min,max" the service applies at boot. */
        clocks: string | null;
        enabled: string | null;
        active: string | null;
      };
      /** The fallback where the boot service cannot be installed. */
      cron: {
        installed: boolean;
        /** "min,max" the @reboot job applies at boot. */
        clocks: string | null;
        /** The job ran at this boot and could not re-apply the cap. */
        failed: boolean;
      };
    };

/** POST /api/sparks/gpu-clock-all: per-unit outcome of a fleet-wide cap or reset. */
export type FleetGpuClockResult =
  | { id: string; ok: true; capMHz: number | null; persistKind: GpuClockPersistKind }
  | { id: string; ok: true; supported: false; reason: string }
  | { id: string; ok: false; error: string };
/** One card in GET /api/sparks/:id/gpu-power. A value nvidia-smi could not give is null. */
export interface GpuPowerCard {
  /** nvidia-smi index, for display. Changes are made by `uuid`. */
  index: number | null;
  uuid: string;
  name: string | null;
  limitW: number | null;
  /** Limit the card actually enforces; can be lower than `limitW`. */
  enforcedW: number | null;
  defaultW: number | null;
  minW: number | null;
  maxW: number | null;
  /** The card reports a limit and a range, so a limit can be set. */
  adjustable: boolean;
  /** Limit the boot service sets for this card, null when it does not list it. */
  bootW: number | null;
}

/** GET /api/sparks/:id/gpu-power: per-card power limits (`nvidia-smi -pl`) and their boot service. */
export type GpuPowerStatus =
  | { supported: false; reason?: string }
  | {
      supported: true;
      cards: GpuPowerCard[];
      /** The server accepts a typed sudo password on this connection (https or the machine itself). */
      passwordAllowed?: boolean;
      /** Settings allows typing it over plain http, so the page's secure-context check is skipped. */
      plainPasswordAllowed?: boolean;
      /** "root" runs directly, "yes" = passwordless sudo works, "no" = it does not. */
      sudo: "root" | "yes" | "no";
      service: {
        installed: boolean;
        enabled: string | null;
        active: string | null;
      };
      /** Other enabled boot units on the host that also set a power limit. */
      otherServices: string[];
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
  temperature: number | null;
  thermal?: { pressureState: string; lastRecordedEvents: string[]; source: string } | null;
  usage: number;
  /** Mac pressure label; agent and SSH sources differ (see agents/macos/README.md). */
  thermalPressure?: string | null;
  /** Mac units: false when `sudo -n powermetrics` is not permitted, so GPU activity and power are unknown. */
  powermetricsAvailable?: boolean;
  /** Mac-agent units: what this node could not read (e.g. gpu.power without root). */
  unavailable?: MetricGap[];
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
  /**
   * Kernel NVRM NV_ERR_NO_MEMORY count since boot (cached ~60s). null while the since-boot
   * baseline is still being read a page at a time, or when the journal is unreadable: the
   * count is unknown then, not zero.
   */
  nvErrNoMemory?: number | null;
  /** Kernel Xid errors and OOM-killer kills since boot (cached ~60s). null when the journal is unreadable. */
  kernelErrors?: { xid: number; oomKills: number; lastXid: string | null } | null;
  /**
   * Per-physical-GPU breakdown for multi-card hosts. The fields above stay the
   * fleet-wide aggregate (hottest / busiest card, summed power and VRAM), so a
   * one-GPU DGX Spark has exactly one entry here mirroring them.
   */
  gpus?: GpuDevice[];
}

export interface GpuPcieLink {
  gen: number | null;
  genMax: number | null;
  width: number | null;
  widthMax: number | null;
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
  /** NVIDIA: fan speed in % of maximum (nvidia-smi fan.speed); null when the card reports none. */
  fanPct?: number | null;
  /** NVIDIA: PCIe link now and at its best (nvidia-smi pcie.link.*); null when unknown or not a PCIe-attached card. */
  pcie?: GpuPcieLink | null;
  /** Intel only: fan speed in rpm, null when the card has no fan sensor. */
  fanRpm?: number | null;
  /** Intel only: "debugfs" = measured VRAM use; "pci-bar" = total only, used is unknown (shown as 0). */
  vramSource?: "debugfs" | "pci-bar";
}

// ─── CPU metrics ─────────────────────────────────────────
export interface CpuMetrics {
  usage: number;
  /** False when the CPU usage read was unavailable; the numeric placeholder is not a measured zero. */
  usageAvailable?: boolean;
  /** Availability entries from the same CPU sample. */
  unavailable?: MetricGap[];
  temperature: number | null;
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
  /** RDMA payload throughput from the port's port_rcv_data / port_xmit_data counters, bytes/s. */
  rdmaRxBps: number | null;
  rdmaTxBps: number | null;
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
  /** False when the endpoint answered but this poll's stats could not be read: its rates are unknown, not zero. */
  measurementValid?: boolean;
  /** Why the last poll's stats could not be read; null while they can. */
  measurementError?: string | null;
  backend: "vllm" | "llama.cpp" | "sglang" | "lmstudio" | "ollama" | "ds4" | "exl3" | "q27" | "tensorfold" | "freetoken" | "radiance" | "strata" | "flare" | "locals" | "splash" | "pico" | null;
  /** How the monitor reaches the engine: its own address, or an SSH forward when only SSH gets there. */
  via?: "direct" | "ssh-tunnel";
  modelId: string | null;
  modelPath: string | null;
  /** Engine version from vLLM's GET /version; null when the backend reports none or it could not be read. */
  engineVersion?: string | null;
  /** Exact served request IDs from /v1/models, in response order. */
  models?: string[];
  contextLength: number | null;
  /** GPU memory utilization for the LLM engine (0–1), e.g. 0.9. Only from vLLM internal info. */
  gpuMemoryUtilization: number | null;
  /** Occupied slots; null when the backend does not report occupancy. */
  slotsActive: number | null;
  slotsTotal: number;
  generationTps: number;
  /** How generationTps was measured when a backend exposes a fallback. */
  generationTpsSource?: "window" | "slot-mean" | "probe-sample" | "dashboard-stream" | null;
  /**
   * Average decode tok/s of ONE stream (aggregate ÷ active streams when all
   * decode in lockstep). Only engines publishing a per-token latency histogram
   * report it; null otherwise.
   */
  perStreamTps?: number | null;
  /**
   * Prefill rate over completed requests, held for up to 20 seconds.
   * This effective rate includes cache credit; see prefillTpsSource.
   * Not continuously measured live or an individual-request rate.
   */
  perStreamPrefillTps?: number | null;
  /** TensorFold: live throughput or a held, cache-inclusive completed-request window. */
  prefillTpsSource?: "live" | "completed-effective" | "completed-split" | null;
  prefillTps: number;
  /** A prompt is being processed right now. With no live rate available (TensorFold reports totals only for finished requests) the UI says "prefilling" instead of 0. */
  prefillActive?: boolean;
  /** A request is generating right now, even when the backend has no live rate. */
  decodeActive?: boolean;
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
   * TensorFold live prompt-position gauge: tokens of the prompt currently being
   * prefilled (`tensorfold:prefill_progress_tokens`). It advances during a long
   * prefill while the completed counters stay frozen. null when the build does
   * not publish it or the last full /metrics scrape failed.
   */
  prefillProgressTokens?: number | null;
  /**
   * TensorFold live generation position: `generation_tokens_total` plus the
   * nonnegative `generation_tokens_running`. null when unavailable.
   */
  generationProgressTokens?: number | null;
  /**
   * Share of the engine's KV cache pool held by requests (0–1): vLLM, q27,
   * SGLang (`token_usage`) and TensorFold (`pool_tokens`). null when unknown.
   */
  kvCacheUsage?: number | null;
  /**
   * TensorFold's own cache observation (`/health.live.cache`): the shared pool's disjoint
   * categories, the prompt-state snapshot store, and the engine's limits. Never derived from
   * `kvCacheUsage`, which is one stream's share of its window. Null for other backends.
   */
  cache?: LlmCacheMetrics | null;
  /** Cumulative TTFT / request-latency histogram buckets for the history sampler. TensorFold only. */
  cacheHistograms?: LlmCacheHistograms | null;
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

/**
 * One TensorFold cache observation. `status` decides what may be read:
 * - full: pool and an enabled prompt-state store are both present and consistent;
 * - partial: one of them is (a disabled store is partial, not absent);
 * - unavailable: the engine publishes no cache group (an older build) — not a measured 0;
 * - inconsistent: the engine itself reports accounting that does not add up; no values;
 * - unsupported: a schema version this dashboard does not read; no values;
 * - invalid: the group was not an object.
 */
export interface LlmCacheMetrics {
  status: "full" | "partial" | "unavailable" | "inconsistent" | "unsupported" | "invalid";
  source: "health";
  schemaVersion?: number | null;
  /** Engine process identity (a u64 nanosecond stamp as a string), for reset detection. */
  engineEpoch?: string | null;
  /** Engine-clock epoch ms of the observation; null when absent. */
  observedAt?: number | null;
  /** One request's positions at most. */
  contextLimitPositions?: number | null;
  /** Requests the engine admits at once. */
  streamCapacity?: number | null;
  pool?: LlmCachePool | null;
  promptState?: LlmCachePromptState | null;
  /** Which groups were missing from a consistent report: "pool", "prompt_state". */
  missing?: string[];
  reason?: string | null;
}

/**
 * The shared pool in positions. The four categories are a partition of `capacityPositions`;
 * `invalidationsTotal` counts valid-to-stale transitions (a later resume of that prefix must
 * reprocess it), `placementBlocksTotal` counts placements refused for lack of room.
 */
export interface LlmCachePool {
  capacityPositions: number;
  activeReservedPositions: number;
  retainedPrefixPositions: number;
  retainedGrowthPositions: number;
  unclaimedPositions: number;
  validStates: number | null;
  invalidationsTotal: number | null;
  placementBlocksTotal: number | null;
}

/**
 * The prompt-state snapshot store: a byte budget separate from the pool. `heldBytes` is charged
 * storage, `spareBytes` reusable backend storage; `failuresTotal` is the legacy aggregate and the
 * three stages partition it (null on a build that predates the classification).
 */
export interface LlmCachePromptState {
  enabled: boolean;
  budgetBytes: number | null;
  heldBytes: number | null;
  spareBytes: number | null;
  entries: number | null;
  hitsTotal: number | null;
  missesTotal: number | null;
  evictionsTotal: number | null;
  refusalsTotal: number | null;
  failuresTotal: number | null;
  failuresKeepTotal: number | null;
  failuresRestoreTotal: number | null;
  failuresPeerForgetTotal: number | null;
}

/** Cumulative Prometheus-style bucket counts; `edges` ends at Infinity. */
export interface LlmCacheHistogram {
  edges: number[];
  counts: number[];
}

export interface LlmCacheHistograms {
  ttft: LlmCacheHistogram;
  latency: LlmCacheHistogram;
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
  /**
   * Mac-agent units: model runtimes detected on the machine. null for other
   * transports (DGX Sparks, macs read over SSH) — an empty array only when the
   * agent actually answered and found nothing serving.
   */
  runtimes?: MacRuntime[] | null;
  /** Mac-agent units: metrics the node declared unavailable (never zeroed). */
  unavailable?: MetricGap[] | null;
  /** Mac-agent units: whether the agent answered the last runtime poll. */
  agentOnline?: boolean | null;
}

// ─── Mac node agent ──────────────────────────────────────────
export interface MacAgentConfig {
  /** Full base URL, e.g. http://100.64.0.10:8790 (wins over host/port). */
  url?: string | null;
  /** Host to reach the agent on; defaults to the unit's probe host. */
  host?: string | null;
  /** Agent listen port (default 8790). */
  port?: number | null;
  /** Optional user-agent control port when telemetry uses a privileged collector. */
  controlPort?: number | null;
}

/** One detected model runtime, from the Mac agent's data-driven inventory. */
export interface MacRuntime {
  /** Inventory name — e.g. "omlx", "splash-35b", "tensorfold", or "other-runtime". */
  name: string;
  /** Display label; for other-runtime this is the command basename. */
  label: string;
  /** "server" (owns a listener) or "watchdog" (a launcher, not serving). */
  role: string;
  pid: number;
  command: string;
  script?: string | null;
  port: number | null;
  /** Served model id when argv or the server's own API exposes one. */
  model?: string | null;
  /** "serving" (health path answered) | "listening" | "running". */
  state: string;
  detectedBy: string;
  health?: { ok: boolean; url: string };
}

/** A metric this node could not read, with the reason shown in the UI. */
export interface MetricGap {
  metric: string;
  reason: string;
}

/** One launchable catalog entry from the Mac agent's control endpoint. */
export interface RuntimeControlTarget {
  name: string;
  label: string;
  group: string;
  groupLabel: string;
  models: { id: string; label: string }[];
  startable: boolean;
  stoppable: boolean;
  reason?: string | null;
}

/**
 * Mac runtime control as the dashboard server reports it.
 * `serving` is null when the probe did not answer — that is not "nothing serving".
 */
export interface RuntimeControlView {
  state: "ready" | "unavailable" | "denied";
  reason: string | null;
  serving: MacRuntime[] | null;
  targets: RuntimeControlTarget[];
  error?: string | null;
  output?: string | null;
  ok?: boolean;
  authorized?: boolean;
  /** Browser transport failed; the action's outcome must be reconciled by polling. */
  transportError?: boolean;
  busy?: boolean;
  operation?: {
    id: string;
    state: "running" | "complete";
    runtime?: string;
    model?: string;
    action?: string;
    ok?: boolean;
    error?: string | null;
    output?: string | null;
  };
}

// ─── Spark snapshot (server pushes this) ──────────────────
/** Hint attached to a head whose engine answers on a paired worker (#271). */
export interface LlmMovedToWorker {
  workerId: string;
  workerName: string;
  port: number;
  modelId: string | null;
  backend: string | null;
  message: string;
}

export interface SparkSnapshot {
  id: string;
  /** Configured Mac collection transport; independent of current agent reachability. */
  macTransport?: "ssh" | "agent";
  /** Active health findings, most important first is not guaranteed; sort with sortFindings. */
  health?: HealthFinding[];
  name: string;
  /** Why the last liveness check failed, when offline. null/absent when online. */
  offlineReason?: string | null;
  /** Unit type: spark (DGX Spark), host (dedicated GPU Linux box), or mac (Apple Silicon). */
  kind?: "spark" | "host" | "mac";
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
  /**
   * Head only: the engine answers on a paired worker while every head port is down (#271).
   * Display-only hint — sparkDash never swaps roles itself.
   */
  llmMovedTo?: LlmMovedToWorker | null;
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

export type AlertChannelType = "ntfy" | "discord" | "slack" | "gotify" | "webhook";

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
  /** Wall power from external meters; present only while power meters are configured. */
  wall?: FleetWallEnergy;
}

/**
 * Wall power in the shape of FleetEnergy's own fields. Energy and coverage include time
 * filled from the estimate (estimate × the node's learned wall/estimate ratio).
 */
export interface FleetWallEnergy {
  /** Nodes with a meter. */
  nodeIds: string[];
  /** Metered nodes whose last reading is fresh. */
  freshNodeIds: string[];
  /** Nodes counted at estimate × ratio right now (no fresh reading, or no meter). */
  filledNodeIds: string[];
  staleNodeIds: string[];
  /** Ratio used to fill each node (its own, else the fleet's); null = not learned yet. */
  ratios: Record<string, number | null>;
  ownRatios: Record<string, number | null>;
  fleetRatio: number | null;
  currentWatts30s: number | null;
  /** True when the current figure includes filled nodes. */
  currentFilled: boolean;
  energy24hKwh: number | null;
  filledEnergy24hKwh: number | null;
  energy31dKwh: number | null;
  whPerOutputToken24h: number | null;
  coverage24hMs: number;
  coverage24hWindowMs: number;
  coverage31dMs: number;
  coverage31dWindowMs: number;
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
  /** The running server's package version; absent on servers that predate the field. */
  version?: string | null;
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
  /** "tou": the hours in energyPricePeriods have their own price; other hours cost energyPricePerKwh. */
  energyPriceMode?: "flat" | "tou";
  /** Time-of-use periods (whole local hours [from, to), wrapping past midnight when from > to). */
  energyPricePeriods?: EnergyPricePeriod[];
  /**
   * VRAM bars split by engine / system / free and judged by headroom. On by
   * default (server DEFAULTS and the UI's pre-load fallback both say true).
   */
  showVramBreakdown: boolean;
  /** Serve GET /metrics in Prometheus text format. Off by default (404 when off). */
  prometheusExport: boolean;
  /** Allow typing a sudo password over plain http from another machine. Off by default. */
  allowPlainSudoPassword?: boolean;
  /** Let the Intel (xe) probe read debugfs VRAM through sudo -n. Off by default. */
  intelVramSudo: boolean;
  /**
   * Keep 48 h / 30 days of per-unit history on the server and chart it in a History
   * panel on the unit page. Off by default.
   */
  metricsHistory?: boolean;
  /** Alert notifications (Settings → Alerts). Off by default; while off nothing is evaluated or sent. */
  alertsEnabled?: boolean;
  /** Publish the activity feed and per-unit readings to an MQTT broker. Off by default. */
  mqttEnabled: boolean;
  /** Broker URL: mqtt://, mqtts://, ws:// or wss://. */
  mqttUrl: string;
  /** Broker username, if any; the password comes from SPARKDASH_MQTT_PASSWORD. */
  mqttUsername: string;
  /** Topic root for everything published (events, status, metrics). */
  mqttTopicPrefix: string;
  /** Publish Home Assistant MQTT discovery configs (requires MQTT publishing). */
  mqttDiscovery: boolean;
  /** Discovery prefix — match the integration's setting in Home Assistant (default "homeassistant"). */
  mqttDiscoveryPrefix: string;
  /** Read-only API Keys page (LiteLLM keys via a host bridge). Off by default; while off there is no nav entry. */
  apiKeysEnabled?: boolean;
  /**
   * Hide harness sessions older than this. Finite: 1 minute through 14 days.
   * Missing or out of range becomes 12 hours.
   */
  occupancyMaxAgeMs: number;
  /**
   * GPU temperature (°C) at which the Health finding warns, and at which it turns
   * critical. Defaults 85 and 90; warn is always below critical. Alerts reuse the finding.
   */
  healthTempWarnC: number;
  healthTempCriticalC: number;
  /** Stream-sample engines without gauges (Pico): measured from one tiny streamed completion every 15 s. Off by default. */
  llmStreamSample?: boolean;
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
  /** Rows this adapter lost to the shared 500-row budget; 0 means all were included. */
  dropped: number;
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
  | "memAvailableMB"
  | "memGpuMB"
  | "memSysMB"
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
  /** TensorFold shared-cache history: a separate grid fed by counter deltas. Null when absent. */
  cache?: MetricsHistoryCache | null;
}

/**
 * One aggregated cache bucket. Every field is optional: a bucket exists only where an observation
 * landed, and a figure the engine did not report stays absent rather than zero.
 */
export interface MetricsHistoryCachePoint {
  t: number;
  /** Observations behind this bucket. */
  n: number;
  /** Sum of valid observation-pair durations, not assumed wall-clock coverage. Absent on legacy data. */
  coveredMs?: number;
  coveragePartial?: boolean;
  histogramSamples?: { ttft: number; latency: number };
  /** Pool in positions: means of the categories, `capacity` is the bucket's effective step value. */
  pool?: {
    capacity: number;
    active: number | null;
    prefix: number | null;
    growth: number | null;
    unclaimed: number | null;
  };
  /** Bucket peaks of the pool categories. */
  poolMax?: { active: number | null; prefix: number | null; growth: number | null };
  /** The pool capacity or the snapshot budget changed inside this bucket (a configuration step). */
  capacityChanged?: boolean;
  budgetChanged?: boolean;
  /** Snapshot store: charged/spare bytes (mean), budget bytes (step), entries (mean). */
  store?: { held: number | null; spare: number | null; entries: number | null; budget: number | null };
  running?: number;
  waiting?: number;
  validStates?: number;
  /** Token-weighted reuse over the bucket: cached prompt tokens / prompt tokens. */
  reusePct?: number;
  promptTokens?: number;
  cachedTokens?: number;
  completions?: number;
  /** Counter deltas: replacements, invalidations, refusals, classified failures. */
  churn?: Partial<Record<
    "completions" | "hits" | "misses" | "evictions" | "refusals" | "failures" | "failuresKeep" |
    "failuresRestore" | "failuresPeerForget" | "invalidations" | "placementsBlocked" | "placementBlocks",
    number
  >>;
  /**
   * Window p95 from summed histogram bucket counts. `value` is null with `open: true` when the
   * percentile falls in the +Inf bucket (the figure is then only bounded below).
   */
  ttftP95?: { value: number | null; lowerBound?: number; upperBound?: number | null; open?: boolean; exact: false };
  latencyP95?: { value: number | null; lowerBound?: number; upperBound?: number | null; open?: boolean; exact: false };
}

export interface MetricsHistoryCacheEndpoints {
  port: number;
  engineEpoch: string | null;
  firstAvailableAt?: number;
  points: MetricsHistoryCachePoint[];
}

export interface MetricsHistoryCacheEvent {
  t: number;
  until?: number;
  port: number;
  kind:
    | "engine_restart"
    | "counter_reset"
    | "observation_backwards"
    | "telemetry_lost"
    | "telemetry_invalid"
    | "histogram_edges_changed"
    | "clock_skew"
    | "collection_gap"
    | "cache_pressure";
  detail?: Record<string, unknown> | null;
}

export interface MetricsHistoryCache {
  range: MetricsHistoryRange;
  stepMs: number;
  from: number;
  to: number;
  endpoints: MetricsHistoryCacheEndpoints[];
  events: MetricsHistoryCacheEvent[];
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
  /** Sampling temperature (default 0.7). Older runs have none: they ran at 0. */
  temperature?: number;
  /** Sent only for a detected TensorFold backend; absent means no top_k override. */
  topK?: number;
  /** Thinking on (default). Older runs have none: they ran with it off. */
  thinking?: boolean;
  /** Prompt tokens each stream carries before it decodes (deep-context start). Absent: empty context. */
  contextTokens?: number;
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
  /** Prompt tokens the server served from its prefix cache. */
  cachedTokens?: number;
  /** Deep-context runs: did this stream decode from the prefilled KV? */
  contextCache?: "cached" | "partial" | "uncached" | "unknown";
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
  /** Deep-context runs: the prefix cache did not serve every stream's context, so tok/s is not clean. */
  warning?: string;
  /** Deep-context runs: prompt tokens per stream and the time spent prefilling them before the wave. */
  contextTokens?: number;
  contextPrefillMs?: number;
  contextCache?: { cached: number; partial: number; uncached: number; unknown: number };
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
  /** Deep-context runs: streams prefilled so far for the current level. */
  prefill?: { done: number; total: number } | null;
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
  defaultTemperature?: number;
  defaultThinking?: boolean;
  minContextTokens?: number;
  maxContextTokens?: number;
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
  /** 0–2, default 0.7. */
  temperature?: number;
  /** Default true. */
  thinking?: boolean;
  /** Prefill every stream with this many prompt tokens before the decode wave. 0 or omitted: start empty. */
  contextTokens?: number;
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
  /** Ceiling when the model's context is unknown. */
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
export type QualityCategory = "qa" | "reason" | "arith" | "track" | "gsm8k" | "mmlu" | "mmlupro" | "math500" | "follow" | "long" | "tokenizer" | "fidelity" | "divergence";

/** WP3: the divergence category's structural rates (no pass rate). */
export interface QualityDivergenceSummary {
  rows: number;
  terminatedPct: number | null;
  loops: number;
  loopPct: number | null;
  jsonValidPct: number | null;
  jsonSchemaPct: number | null;
  toolOkPct: number | null;
  meanChars: number | null;
  meanTokens: number | null;
}

/** WP2: the fidelity category's token-weighted corpus statistics (no pass rate). */
export interface QualityFidelitySummary {
  docs: number;
  tokens: number;
  bytes: number;
  sumNll: number;
  k: number;
  nll?: number;
  ppl?: number;
  bitsPerByte?: number | null;
}

/** WP2: what a run's fidelity category scored against. */
export interface QualityFidelityInfo {
  corpusVersion: number | null;
  corpusSha256: string | null;
  k: number;
  docs: number;
  /** True once the per-position side file was written (needed for a fidelity comparison). */
  sideFile?: boolean;
}

export interface QualityFidelityCompareDoc {
  id: string;
  tokens: number;
  match: boolean;
  nllA?: number;
  nllB?: number;
  dNll?: number;
  top1AgreementPct?: number | null;
  tailLossPct?: number | null;
  divergence?: number | null;
  scoredTop?: number;
}

/** WP2: `GET …/quality-bench/:benchId/fidelity-compare?with=<ref>` — A is the test run, B the reference. */
export interface QualityFidelityCompare {
  a: string;
  b: string;
  comparable: boolean;
  reason: string | null;
  k?: { a: number | null; b: number | null };
  tokens?: number;
  matchedDocs?: number;
  mismatchedDocs?: number;
  nllA?: number;
  nllB?: number;
  pplA?: number;
  pplB?: number;
  /** NLL(A) − NLL(B) per token, positive = the test run is worse; with a document-bootstrap 95 % CI. */
  dNll?: number;
  dNllCi?: [number, number];
  top1AgreementPct?: number | null;
  /** Share of positions where the reference's top-1 token is outside the test run's top-K. */
  tailLossPct?: number | null;
  /** Truncated-support divergence (ref ‖ test) over the shared top-K with an "other" bucket: a diagnostic, not a KL. */
  divergence?: number | null;
  docs?: QualityFidelityCompareDoc[];
}

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
  /** WP0: the run repeats every category (and runs it serially when batched) to measure noise. */
  noiseFloor?: boolean;
  /** WP1: "default" | "full" carry a headline overall; "custom" is a partial run. Absent on old runs. */
  profile?: "default" | "full" | "fidelity" | "custom";
  host?: string;
  tls?: boolean;
}

/** WP0: the served build, read from `/v1/models` (TensorFold's `tensorfold` object, vLLM's `/version`, …). */
export interface QualityEngineRecord {
  backend: string | null;
  modelId: string | null;
  ownedBy: string | null;
  engineVersion: string | null;
  gitCommit: string | null;
  patches: string | null;
  device: string | null;
  checkpoint: string | null;
  checkpointSha256: string | null;
  quantization: Record<string, unknown> | null;
  computeDtype: string | null;
  kvCacheDtype: string | null;
  tensorParallel: number | null;
  contextLength: number | null;
  speculative: { enabled?: boolean; kind?: string; name?: string } | null;
  tokenizerSha256: string | null;
  tokenizerName: string | null;
  promptBos: boolean | null;
  promptLogprobsCap: number | null;
  reasoning: Record<string, unknown> | null;
  params?: number | null;
  fileSizeBytes?: number | null;
}

/** WP0: what the engine was measured to do (never inferred from its name). */
export interface QualityEngineCapabilities {
  promptLogprobs: boolean;
  /** "openai-completions" (vLLM / TensorFold shape) when supported. */
  shape: string | null;
  reason: string | null;
  probedAt: number;
  positions?: number;
  promptTokens?: number | null;
  aligned?: boolean | null;
  actualIncluded?: boolean;
  promptTokenIds?: boolean;
  exactMode?: string | null;
  cap?: number;
  capSource?: "advertised" | "probed";
}

export interface QualityEngineInfo {
  record: QualityEngineRecord | null;
  capabilities: QualityEngineCapabilities | null;
  modelsReachable?: boolean;
  error?: string;
  probedAt: number;
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
  /** Full visible reply (capped), kept on rows that need auditing: failed, truncated or disputed. Scoring v3. */
  reply?: string;
  /** The item's reference answer is wrong or ambiguous; the row is reported, never scored. Scoring v3. */
  disputed?: boolean;
  /** Reasoning tokens as the server counted them; null when it reports none. WP0. */
  reasoningTokens?: number | null;
  /** Length of the reasoning text the stream carried. WP0. */
  reasoningChars?: number;
  /** Reasoning tail (capped), kept on failed rows only. WP0. */
  reasoning?: string;
  /** Long-context items: the size the prompt was built for. WP0. */
  size?: number;
  /** Whether the item asked for thinking. WP1. */
  thinking?: boolean;
  /** Suite v2 grades: correct units (steps, people, keys) over the item's units. */
  gradeCorrect?: number;
  gradeTotal?: number;
  /** WP3 divergence rows: structural checks on the stored reply. */
  chars?: number;
  terminated?: boolean;
  loop?: { loop: boolean; cycle: number | null; tailShare: number };
  json?: { valid: boolean; schema: boolean; fenced: boolean; missing: string[] };
  tool?: { called: boolean; nameOk: boolean; argsOk: boolean; name: string | null; wrong: string[] };
  toolCalls?: Array<{ name: string | null; arguments: string }>;
  /** WP2 fidelity rows: the document and its token-weighted scores. */
  docId?: string;
  kind?: string;
  lang?: string;
  bytes?: number;
  k?: number;
  tokens?: number;
  sumNll?: number;
  nll?: number;
  ppl?: number;
  bitsPerByte?: number | null;
  top1Pct?: number;
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
  /** Replies cut off by max_tokens before an answer: not scored (scoring v3; absent on older runs). */
  truncated?: number;
  /** Items with a disputed reference answer: not scored (scoring v3; absent on older runs). */
  disputed?: number;
  /** True when `truncated` > 0: pct covers only the replies that finished under this budget. */
  budgetLimited?: boolean;
  /** WP1: scored ÷ total, in percent. */
  coveragePct?: number | null;
  /** WP1: passed ÷ everything that ran (scored + truncated), in percent. */
  budgetedPct?: number | null;
  /** WP1: Wilson 95 % interval of pct / budgetedPct, in percent. */
  ci?: [number, number] | null;
  budgetedCi?: [number, number] | null;
  /** WP1, long recall: keys found share and its prompt-clustered bootstrap interval. */
  keysPct?: number;
  keysCi?: [number, number] | null;
  /** Suite v2 grades (arithmetic steps, tracked people): correct units over all units, with an item-clustered interval. */
  gradeCorrect?: number;
  gradeTotal?: number;
  gradePct?: number;
  gradeCi?: [number, number] | null;
  /** WP2, fidelity only. */
  fidelity?: QualityFidelitySummary;
  /** WP3, divergence only. */
  divergence?: QualityDivergenceSummary;
  meanCompletionTokens: number;
  /** Every reply that hit max_tokens, whether or not it had answered by then. */
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
  /** Mean of the category percentages; null for a custom (partial) profile since WP1. */
  overallPct: number | null;
  /** WP1: stratified bootstrap 95 % interval of the overall. */
  overallCi?: [number, number] | null;
  /** WP1: run hygiene warnings, e.g. a thinking-off category whose replies carried reasoning. */
  warnings?: QualityRunWarning[];
  /** WP2: corpus and K the fidelity category scored with. */
  fidelity?: QualityFidelityInfo;
  /** WP2: why the fidelity category was skipped on this engine. */
  fidelityUnsupported?: string;
  /** Long sizes skipped because they exceed the model context. */
  skippedLongSizes: number[];
  /** Noise-floor passes beyond the primary one (full runs only). WP0. */
  passes?: QualityNoisePassRows[];
  /** Noise floor: the extra passes paired with the primary pass. WP0. */
  noise?: QualityNoiseSummary | null;
  /** Measured prompt tokens per long size (the sizes are word-count estimates). WP0. */
  longTokens?: Record<string, number>;
}

export interface QualityRunWarning {
  kind: "thinkingNotHonoured";
  category: QualityCategory;
  rows: number;
  reasoningRows: number;
  truncated: number;
}

export interface QualityNoisePassRows {
  index: number;
  kind: "repeat" | "serial";
  concurrency: number;
  items: QualityItemResult[];
}

export interface QualityNoisePass {
  index: number;
  kind: "repeat" | "serial";
  concurrency: number;
  pairs: number;
  discordant: number;
  identical: number;
  flipPct: number | null;
  identicalPct: number | null;
  categories: Partial<Record<QualityCategory, { pairs: number; discordant: number; identical: number; flipPct: number | null }>>;
}

export interface QualityNoiseSummary {
  primaryConcurrency: number;
  passes: QualityNoisePass[];
  /** Largest flip rate between passes at identical settings. */
  repeatFlipPct: number | null;
  /** Largest flip rate between the batched primary pass and a concurrency-1 pass. */
  batchFlipPct: number | null;
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
  /** WP0: engine record and measured capabilities; null until probed, absent on older runs. */
  engine?: QualityEngineInfo | null;
  /** WP4: the unit the run was made on (absent on older runs). */
  unit?: { id: string; name: string } | null;
  /** WP4: the cost side read from the probe and the last decode bench at start. */
  cost?: QualityRunCost | null;
  error: string | null;
  /** Working time: wall clock minus the time spent paused. */
  durationMs: number;
  /** True while the run waits at the pause gate (status stays "running"); absent on older runs. */
  paused?: boolean;
  pausedAt?: number | null;
  /** Time spent paused so far, the open pause included; a resumed run counts its downtime here. */
  pausedMs?: number;
  /** A finished run that can be relaunched from its saved rows (set on records, never on a running job). */
  resumable?: boolean;
  /** Times the run was relaunched from its rows, when last, and how many rows it took over. */
  resumes?: number;
  resumedAt?: number | null;
  resumedFrom?: number | null;
}

/** WP4: what serving this model costs on the unit, read at run start; every field may be null. */
export interface QualityRunCost {
  /** Live per-stream decode tok/s from the probe at start. */
  perStreamTps?: number | null;
  /** Live aggregate generation tok/s from the probe at start. */
  generationTps?: number | null;
  /** Last decode benchmark on this port: single-stream tok/s and the best aggregate. */
  decodeTps1?: number | null;
  decodeTpsBest?: number | null;
  decodeBenchAt?: number | null;
  weightsGb?: number | null;
  kvCacheGb?: number | null;
  vramUsedGb?: number | null;
  vramTotalGb?: number | null;
}

/** WP4: a pinned reference run for a model family (`qualityFamilyKey`). */
export interface QualityReference {
  sparkId: string;
  benchId: string;
  modelId: string | null;
  pinnedAt: number;
}

/** WP4: `GET /api/quality-bench/runs` — every unit's saved runs (summaries) and the pinned references. */
export interface QualityFleetResponse {
  runs: QualityBenchJob[];
  references: Record<string, QualityReference>;
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
  noiseFloor?: boolean;
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

// ─── Model discovery ("Discover on this Spark") ───
/** A model the discovery scan found on the dashboard's own Spark. */
export type ModelCandidateKind = "scripted" | "ollama" | "huggingface";

export interface ModelCandidate {
  kind: ModelCandidateKind;
  name: string;
  /** Absolute folder (scripted) or cache dir (huggingface); ollama has none. */
  directory?: string;
  startScript?: string;
  stopScript?: string | null;
  /** Ollama weights only: human size string from `ollama list`. */
  size?: string;
}

export interface ModelDiscoveryResponse {
  candidates: ModelCandidate[];
  scannedRoots: string[];
  notes: string[];
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
  /**
   * Whether the backend measured the cache split for this bucket. `false` means the
   * engine publishes no prefix-cache counter, so `cachedTokens` is not a miss count.
   * Absent on data recorded before the flag existed (treated as reported).
   */
  cacheReported?: boolean;
  /**
   * Prompt tokens credited while the engine published no cached-prompt counter: neither
   * cached nor computed. Absent on older data (then `cacheReported: false` means all of it).
   */
  unreportedPromptTokens?: number;
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
  // ── Optional, present only in hours that have them ──
  /** GPU board draw as measured, per node. */
  nodeGpuWh?: Record<string, number>;
  /** CPU draw as modelled from utilization, per node. */
  nodeCpuWh?: Record<string, number>;
  nodePartsCoverageMs?: Record<string, number>;
  /** Wall energy a meter measured, per node. */
  nodeWallWh?: Record<string, number>;
  nodeWallCoverageMs?: Record<string, number>;
  /** Part of the measured coverage the meter's own record confirmed. */
  nodeWallMeteredMs?: Record<string, number>;
  /** Wall energy filled from the estimate where no meter measured. */
  nodeWallFilledWh?: Record<string, number>;
  nodeWallFilledMs?: Record<string, number>;
  /** Fleet wall figures, measured plus filled, while every node was covered. */
  avgWallWatts?: number | null;
  fleetWallWh?: number;
  fleetWallFilledWh?: number;
  fleetWallCoverageMs?: number;
  wallCoveredOutputTokens?: number;
}

export interface EnergyHistory {
  estimated: boolean;
  membershipChanged: boolean;
  generatedAt: number;
  retentionMs: number;
  nodeIds: string[];
  /** Present only while power meters are configured. */
  wallNodeIds?: string[];
  wallRatios?: Record<string, number | null>;
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
  nodes: Record<string, MonthlyEnergyNode>;
  totalWh: number;
  fleetWh: number;
  fleetCoverageMs: number;
  outputTokens: number;
  coveredOutputTokens: number;
  whPerOutputToken: number | null;
  /** From this instant on, every node's energy is also kept per hour (hourWh). Absent for months from before hourly records. */
  binnedFromMs?: number;
  // ── Present only in months with wall power (measured or filled) ──
  totalWallWh?: number;
  totalWallFilledWh?: number;
  fleetWallWh?: number;
  fleetWallFilledWh?: number;
  fleetWallCoverageMs?: number;
  wallCoveredOutputTokens?: number;
  wallWhPerOutputToken?: number | null;
}

export interface MonthlyEnergyNode {
  wh: number;
  coverageMs: number;
  gpuWh?: number;
  cpuWh?: number;
  partsCoverageMs?: number;
  wallWh?: number;
  wallCoverageMs?: number;
  wallMeteredMs?: number;
  wallFilledWh?: number;
  wallFilledMs?: number;
  /** Wh per UTC hour of the month, index 0 = its first hour; trailing empty hours left out. */
  hourWh?: number[];
  /** The same for wall power, filled time included. */
  wallHourWh?: number[];
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

// ─── Storage Manager ─────────────────────────────────────
/** Run a storage action as an administrator. The password is used for this call only. */
export interface StorageElevation {
  sudo?: boolean;
  sudoPassword?: string;
  /** Keep a typed password on the dashboard server (encrypted) once sudo has accepted it. */
  remember?: boolean;
}

export interface StorageFilesystem {
  source: string;
  fstype: string;
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availBytes: number;
}

/** The folders directly inside one folder, for the folder picker. */
export interface StorageFolders {
  path: string;
  dirs: string[];
  /** The list was cut: the folder holds more folders than are shown. */
  more: boolean;
}

export interface StorageStatus {
  user: string | null;
  /** The dashboard remembers this account's sudo password (encrypted), so none needs typing. */
  sudoSaved?: boolean;
  /** "root" runs directly, "yes" = passwordless sudo works, "no" = a password is needed. */
  sudo: "root" | "yes" | "no";
  filesystems: StorageFilesystem[];
  docker: { state: "ok" | "missing" | "denied" | "down"; rootDir: string | null };
  /** The home folder of the account the dashboard uses on this Spark. */
  homeDir?: string | null;
  /** Home folders of ordinary people under /home (used when the account itself is root). */
  peopleHomes?: string[];
  /** The server accepts a typed sudo password on this connection (https or the machine itself). */
  passwordAllowed?: boolean;
  /** Settings allows typing it over plain http, so the page's secure-context check is skipped. */
  plainPasswordAllowed?: boolean;
  /** The owner allowed deleting folders as administrator on this Spark for this account, or null. */
  elevatedDeleteAck?: StorageElevatedDeleteAck | null;
}

/** The owner's acknowledgement that processes of the Spark's account are treated as having root access. */
export interface StorageElevatedDeleteAck {
  /** The account name the page showed when it was confirmed. */
  user: string | null;
  acknowledgedAt: number;
}

/**
 * A delete that was staged on the Spark and never finished ("Needs attention"). `staged`: the item waits in
 * the staging folder. `interrupted`: its delete stopped part way. `conflict`: it could not be put back because
 * its name was taken. `in-place`: it never moved. `gone`: neither it nor the staged copy is there any more.
 * `unknown` / `unreadable`: something else is in the way; check by hand.
 */
export interface StorageQuarantineItem {
  id: string;
  state: "staged" | "interrupted" | "conflict" | "in-place" | "gone" | "unknown" | "unreadable";
  elevated: boolean;
  type: StorageEntryType;
  createdAt: number | null;
  /** Where it was. */
  path: string;
  /** Where it waits now. */
  stagedPath: string;
  reason: string | null;
}

/** One item of a bulk delete that was tried and not deleted. */
export interface StorageBulkDeleteFailure {
  path: string;
  /** The single delete's error code (`permission`, `not-found`, `protected-descendant`, `unreachable`, …). */
  code: string;
  message: string;
  /** Part of it may already be gone. */
  partial: boolean;
  /** Kept on the Spark under "Needs attention". */
  quarantineId?: string;
  /** As administrator: the command to run on the Spark by hand. */
  command?: string;
}

/**
 * A bulk delete (POST …/storage/delete-many): its items run one after another on the server under one busy lock,
 * each as a full single delete. `done` items of `total` have been tried; `current` is the one being deleted.
 * `covered` paths were inside another listed folder (deleted with it, not run on their own). `stopped`: why the
 * run ended early (`bad-password`, `password-locked`, `no-ack`, `unreachable`, `unit-busy`, `no-sudo`, `time-limit`, …),
 * with the rest in `skipped`.
 */
export interface StorageBulkDeleteJob {
  id: string;
  state: "running" | "done";
  elevated: boolean;
  total: number;
  done: number;
  current: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** Finished, and every item was deleted. */
  success: boolean;
  deleted: string[];
  failed: StorageBulkDeleteFailure[];
  skipped: { path: string; reason: string }[];
  covered: string[];
  stopped: { code: string; message: string } | null;
}

/**
 * The delete advisor (POST …/storage/advise): how careful to be before deleting, from evidence only. "low": nothing
 * found and everything checked. "review": something worth a look, or not everything could be checked. "high": in use
 * now, work that exists only here (git), or what looks like credentials.
 */
export type StorageAdviceLevel = "low" | "review" | "high";

/** One thing the advisor saw. "note": context that never changes the level (a date, a copy elsewhere, a known place). */
export interface StorageAdviceReason {
  rule: string;
  level: StorageAdviceLevel | "note";
  text: string;
}

export interface StorageAdviceItem {
  path: string;
  level: StorageAdviceLevel;
  /** Every check ran in full. False: see `unchecked`; the level is then at least "review". */
  complete: boolean;
  /** Highest first, notes last. */
  reasons: StorageAdviceReason[];
  /** What could not be checked, and why. */
  unchecked: { rule: string; text: string }[];
}

export interface StorageAdvice {
  /** Server time of the check. */
  checkedAt: number;
  /** Changes within this many minutes counted as recent. */
  recentMinutes: number;
  /** The highest item level. */
  level: StorageAdviceLevel;
  complete: boolean;
  /** The paths checked, in the order sent (without those inside another listed folder). */
  items: StorageAdviceItem[];
  /** Paths inside another listed folder: checked as part of it. */
  covered: string[];
}

/** How dealing with a Needs-attention item ended: put back, deleted, or only its record dropped. */
export interface StorageQuarantineResult {
  success: boolean;
  id: string;
  outcome: "restored" | "deleted" | "in-place" | "gone" | "forgotten" | null;
}

/** How the dashboard reaches a Spark (roadmap §4), what the probe found there, and what that allows. */
export interface StorageContext {
  /** "ssh": over SSH as that account. "native-local": the dashboard runs on the Spark itself. "container-local": from the dashboard's container through the host's mount namespace. */
  kind: "ssh" | "native-local" | "container-local";
  transport: "ssh" | "nsenter" | "local";
  uid: number | null;
  account: string | null;
  /** $HOME as the programs see it, and the account's home from the user database. */
  home: string | null;
  accountHome: string | null;
  hostname: string | null;
  bootId: string | null;
  /** Shares the host's PID namespace: true, false, or null when that could not be read. */
  hostPidNs: boolean | null;
  inContainer: boolean;
  sudo: "root" | "yes" | "no";
  linger: "yes" | "no" | "unknown";
  capabilities: string[];
  probedAt: number;
  /** Each feature's verdict: offered, or not with the reason. */
  features: Record<string, { supported: boolean; reason: string | null }>;
}

export type StorageEntryType = "dir" | "file" | "link" | "other";

export interface StorageEntry {
  path: string;
  bytes: number;
  type: StorageEntryType;
  /** Children were scanned: anything not listed is part of the folder's "smaller items". */
  expanded: boolean;
  /** Why this cannot be deleted from the dashboard, or null when it can. */
  locked: string | null;
  /** The name has bytes that cannot be sent back to the unit. */
  unsafe?: true;
  /**
   * Part of `bytes` held by files that also have hard links outside this entry: deleting it does not free
   * them. `bytes` counts every file once, like `du -s` of this entry alone.
   */
  sharedBytes?: number;
  /**
   * The newest modification time of anything in it (a file's or link's own), in whole seconds since 1970 by
   * the Spark's clock. Left out when not known: the basic scan, analyses from before dates were recorded,
   * a scan stopped early, or nothing readable.
   */
  modifiedAt?: number;
}

export interface StorageScanRequest extends StorageElevation {
  path?: string;
  depth?: number;
  /** "new" replaces the result on the page; "drill" rescans one folder and swaps it in. */
  mode?: "new" | "drill";
}

/**
 * What a stop request achieved: "pending" (asked), "terminated" (stopped, nothing left running),
 * "already-gone" (it had ended), or "not-terminated" / "unknown" (could not be confirmed: the Spark stays busy).
 */
export type StorageStopOutcome = "pending" | "terminated" | "already-gone" | "not-terminated" | "unknown";

export interface StorageScanJob {
  id: string;
  /** "stopping": a stop was asked for and is not confirmed yet. */
  state: "running" | "stopping" | "done" | "error" | "cancelled";
  path: string;
  depth: number;
  mode: "new" | "drill";
  elevated: boolean;
  startedAt: number;
  finishedAt: number | null;
  error: { code: string; message: string } | null;
  /** "Stop scan" is offered. False for a scan run through sudo: the dashboard's account cannot stop it. */
  cancellable?: boolean;
  /** Stopping is best effort here (the dashboard runs in a container that may not see the Spark's processes). */
  cancelBestEffort?: boolean;
  /** Server time by which the Spark ends the scan by itself (scans run through sudo), else null. */
  stopsByItselfAt?: number | null;
  stop?: { requestedAt: number; outcome: StorageStopOutcome; message: string | null } | null;
  /** The Spark stays busy for this job: other storage work is refused until its processes are known to be gone. */
  holdsSpark?: boolean;
  holdReason?: "running" | "stopping" | "unconfirmed" | "unreachable" | null;
  /** Server time by which the hold ends by itself at the latest, when known. */
  holdUntil?: number | null;
}

export interface StorageSession {
  root: string;
  scannedAt: number;
  /** When the analysis was made. Looking inside a folder later refreshes that folder only. */
  analysedAt?: number;
  elevated: boolean;
  /** Folders the scan was not allowed to read. */
  unreadable: number;
  /** The unit stopped the scan before it finished, so sizes are incomplete. */
  timedOut: boolean;
  /** "exact": every file counted once, shared sizes known. "approx": hard-linked files may be counted in several folders. */
  hardlinks?: "exact" | "approx";
  /** The scan that made this analysis recorded modification times (the basic scan and older analyses did not). */
  dated?: boolean;
  entries: StorageEntry[];
}

export interface StorageScanSnapshot {
  job: StorageScanJob | null;
  revision: number;
  /** Null when `since` already matches. */
  session: StorageSession | null;
  /** Server clock, to time a running scan without trusting this browser's clock. */
  now?: number;
}

export interface DockerUsageRow {
  count: number | null;
  active: number | null;
  sizeBytes: number | null;
  reclaimableBytes: number | null;
}

export interface DockerImage {
  id: string;
  tags: string[];
  sizeBytes: number | null;
  created: string | null;
  usedBy: { name: string; state: string }[];
  /** "unused" images are the ones that can be removed. */
  /** "unknown": the Spark could not list its containers, so nobody can say whether one uses it (never removable). */
  status: "running" | "stopped" | "unused" | "unknown";
  /**
   * A registry digest is recorded (pulled from, or pushed to, a registry). false: none, so it was built or
   * loaded on this Spark and may be the only copy. null or missing: not reported.
   */
  registryDigest?: boolean | null;
}

export interface DockerContainer {
  id: string;
  name: string;
  /** Docker's state word: running, exited, created, paused, dead… */
  state: string;
  /** The image it was made from. */
  imageId: string;
  created: string | null;
  /** Not running, so it can be removed. */
  removable: boolean;
  /** When it last stopped, as Docker reported it. Missing when it never ran or the Spark did not say. */
  finishedAt?: string | null;
}

export interface DockerStorage {
  rootDir: string | null;
  usage: Partial<Record<"images" | "containers" | "volumes" | "buildCache", DockerUsageRow>>;
  images: DockerImage[];
  /** Stopped containers first. */
  containers: DockerContainer[];
  /** What the Spark could list. Containers not "ok": no image counts as unused. */
  listing?: { images: "ok" | "partial" | "failed"; containers: "ok" | "failed" };
}

/** The outcome of removing images or containers: IDs removed, skipped (in use, gone…) and failed. */
export interface DockerRemoveResult {
  success: boolean;
  removed: string[];
  skipped: { id: string; reason: string }[];
  failed: { id: string; message: string }[];
}

/**
 * Clearing Docker's unused build cache last used more than `olderThanDays` ago, on the builder built into the
 * daemon. `adapter`: "buildx" (pinned to the Docker context's own builder) or "daemon" (no buildx).
 * `reclaimedBytes`: what Docker says it reclaimed, null when it did not say.
 */
export interface DockerBuilderPruneResult {
  success: boolean;
  olderThanDays: number;
  adapter: "buildx" | "daemon" | null;
  reclaimedBytes: number | null;
}
