import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// ─── Spark config file path ──────────────────────────────
const SPARKS_JSON_PATH = process.env.SPARKS_JSON_PATH || path.join(ROOT, "config", "sparks.json");
const GPU_MEMORY_JSON_PATH =
  process.env.GPU_MEMORY_JSON_PATH || path.join(ROOT, "config", "gpu-memory.json");
/** Encrypted SSH password store (never served by API; lives on config volume). */
const SPARKS_SECRETS_PATH =
  process.env.SPARKS_SECRETS_PATH || path.join(ROOT, "config", "sparks-secrets.json");
/** AES key file (auto-generated if SPARKDASH_SECRETS_KEY unset). */
const SECRETS_KEY_PATH =
  process.env.SECRETS_KEY_PATH || path.join(ROOT, "config", ".secrets-key");

// ─── LLM probe timeout ──────────────────────────────────
const LLM_PROBE_TIMEOUT_MS = 3000;
const SSH_CONNECT_TIMEOUT = 5; // seconds

// ─── Poll intervals (milliseconds) ───────────────────────
const POLL_INTERVAL_GPU = parseInt(process.env.POLL_INTERVAL_GPU || "2000", 10);
const POLL_INTERVAL_CPU = parseInt(process.env.POLL_INTERVAL_CPU || "2000", 10);
const POLL_INTERVAL_NETWORK = parseInt(process.env.POLL_INTERVAL_NETWORK || "2000", 10);
const POLL_INTERVAL_STORAGE = parseInt(process.env.POLL_INTERVAL_STORAGE || "5000", 10);
const POLL_INTERVAL_LLM = parseInt(process.env.POLL_INTERVAL_LLM || "2000", 10);
// ComfyUI: queue state moves on job boundaries, not per token — poll slower.
const POLL_INTERVAL_COMFY = parseInt(process.env.POLL_INTERVAL_COMFY || "3000", 10);
// dmon -c 1 -d 1 blocks ~1s; default 2s avoids stacking with in-flight guards
const POLL_INTERVAL_BANDWIDTH = parseInt(process.env.POLL_INTERVAL_BANDWIDTH || "2000", 10);
// Dedicated liveness (sshTest / local ping) cadence — not a metric domain.
const POLL_INTERVAL_LIVENESS = parseInt(process.env.POLL_INTERVAL_LIVENESS || "5000", 10);

// ─── Port ────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "5555", 10);
const LLM_PORT = parseInt(process.env.LLM_PORT || "8888", 10);
// Suggested default only — video monitoring stays off until videoPorts is set.
const COMFY_PORT = parseInt(process.env.COMFY_PORT || "8188", 10);

// ─── DGX Spark constants ────────────────────────────────
const DGX_SPARK = {
  TOTAL_POWER_W: 250,
  CPU_TDP_W: 65,
  GPU_POWER_W: 100,
  MEMORY_HBM_SIZE_GB: 128,
  MEMORY_PEAK_BANDWIDTH_GBPS: 400,
  THERMAL_THRESHOLDS: {
    junction: { warning: 85, critical: 95 },
    memory: { warning: 75, critical: 85 },
    pcb: { warning: 65, critical: 75 },
  },
  FAN_RPM_WARNING: 4000,
  FAN_RPM_CRITICAL: 5000,
};

// ─── Unit conversions ───────────────────────────────────
const UNIT_CONVERSION = {
  BYTES_TO_MB: 1024 * 1024,
  BYTES_TO_GB: 1024 * 1024 * 1024,
  MICRO_TO_WATT: 1e6,
  MILLI_TO_SEC: 1000,
};

// ─── Hardware defaults ───────────────────────────────────
const HARDWARE_DEFAULTS = {
  CPU_TDP_FALLBACK: 185,
};

// ─── Host paths for Docker bind mounts ───────────────────
const HOST_PATHS = {
  PROC: process.env.HOST_PROC_PATH || "/host/proc",
  SYS: process.env.HOST_SYS_PATH || "/host/sys",
  ROOT: process.env.HOST_ROOT_PATH || "/host/root",
};

export {
  SPARKS_JSON_PATH,
  GPU_MEMORY_JSON_PATH,
  SPARKS_SECRETS_PATH,
  SECRETS_KEY_PATH,
  LLM_PROBE_TIMEOUT_MS,
  SSH_CONNECT_TIMEOUT,
  POLL_INTERVAL_GPU,
  POLL_INTERVAL_CPU,
  POLL_INTERVAL_NETWORK,
  POLL_INTERVAL_STORAGE,
  POLL_INTERVAL_LLM,
  POLL_INTERVAL_COMFY,
  POLL_INTERVAL_BANDWIDTH,
  POLL_INTERVAL_LIVENESS,
  PORT,
  LLM_PORT,
  COMFY_PORT,
  DGX_SPARK,
  UNIT_CONVERSION,
  HARDWARE_DEFAULTS,
  HOST_PATHS,
  ROOT,
};