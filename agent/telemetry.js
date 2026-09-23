/**
 * telemetry.js — aggregate all collectors into a NodeAgentSnapshot.
 *
 * Seam type: NodeAgentSnapshot (shared/types.ts), validated against
 * shared/api.schema.json.
 *
 * Ownership notes (Batch 1A scope):
 *  - `versions` is derived from live LLM probes (LlmMetrics) + ComfyUI probe:
 *    the actual running configuration, not recipes.
 *  - `services`, `memory`, `requests`, `topology` are owned by later batches
 *    (1B catalog) or the registry — reported null/[] here, which the seam
 *    contract allows ("null means not available").
 *  - Batch 1A working types that have no NodeAgentSnapshot field yet (LlmMetrics,
 *    ComfyMetrics, SystemdUnit) are attached as ADDITIONAL properties (`llm`,
 *    `comfy`, `systemd`) — permitted by api.schema.json (no
 *    additionalProperties restriction) so the dashboard can consume raw probe
 *    data; Batch 5B can formalize them in types.ts.
 */
import { collectGpu } from "./collectors/gpu.js";
import { collectCpu } from "./collectors/cpu.js";
import { collectMem } from "./collectors/mem.js";
import { collectDisk } from "./collectors/disk.js";
import { collectNet } from "./collectors/net.js";
import { collectDocker } from "./collectors/docker.js";
import { collectSystemd } from "./collectors/systemd.js";
import { collectLlm } from "./collectors/llm.js";
import { collectComfy } from "./collectors/comfy.js";
import { readTextFile, parseUptimeSeconds } from "./collectors/util.js";

export const AGENT_VERSION = "0.1.0";

/**
 * Derive quantization from a model id/path reference.
 * @param {string | null | undefined} s
 * @returns {string | null}
 */
export function detectQuantization(s) {
  if (!s) return null;
  const t = String(s).toLowerCase();
  if (t.includes("nvfp4")) return "nvfp4";
  if (t.includes("fp8")) return "fp8";
  if (t.includes("bf16")) return "bf16";
  if (t.includes("awq") || t.includes("gptq") || t.includes("int4") || t.includes("int8")) {
    return "other";
  }
  return null;
}

/**
 * Map live probe results to VersionInfo[] (seam type).
 * @param {Array<Record<string, any>>} llm LlmMetrics[]
 * @param {object | null} comfy ComfyMetrics | null
 * @param {number} nowMs
 * @returns {Array<object>}
 */
export function buildVersions(llm, comfy, nowMs) {
  const out = [];
  for (const l of Array.isArray(llm) ? llm : []) {
    if (!l || l.backend == null) continue;
    out.push({
      serviceName: `llm:${l.port}`,
      kind: "llm",
      engine: String(l.backend),
      engineVersion: l.version != null ? String(l.version) : null,
      modelId: l.modelId != null ? String(l.modelId) : null,
      modelPath: l.modelPath != null ? String(l.modelPath) : null,
      modelRevision: null,
      quantization: detectQuantization(l.modelPath || l.modelId),
      contextLength: l.contextLength,
      memFraction: l.gpuMemoryUtilization,
      tpSize: null,
      port: l.port,
      state: "running",
      polledAt: nowMs,
    });
  }
  if (comfy && typeof comfy === "object") {
    out.push({
      serviceName: `comfyui:${comfy.port}`,
      kind: "image",
      engine: "comfyui",
      engineVersion: comfy.version != null ? String(comfy.version) : null,
      modelId: null,
      modelPath: null,
      modelRevision: null,
      quantization: null,
      contextLength: null,
      memFraction: null,
      tpSize: null,
      port: comfy.port,
      state: "running",
      polledAt: nowMs,
    });
  }
  return out;
}

/**
 * Assemble a NodeAgentSnapshot from pre-collected pieces.
 * (Exported for tests; collectTelemetry is the production entry point.)
 * @param {object} parts
 * @returns {object} NodeAgentSnapshot
 */
export function assembleSnapshot({
  nodeId,
  nodeName,
  lanIp,
  agentVersion = AGENT_VERSION,
  nowMs = Date.now(),
  uptimeSeconds = null,
  gpu = null,
  cpu = null,
  mem = null,
  disk = [],
  net = [],
  containers = [],
  systemdUnits = [],
  llm = [],
  comfy = null,
}) {
  return {
    nodeId,
    nodeName,
    lanIp,
    agentVersion,
    online: true,
    uptimeSeconds,
    gpu,
    cpu,
    mem,
    disk,
    net,
    containers,
    versions: buildVersions(llm, comfy, nowMs),
    services: [], // Batch 1B: agent/catalog/services.js
    memory: null, // Batch 1B: agent/catalog/memory.js
    requests: null, // Batch 1B: agent/catalog/services.js
    topology: null, // registry-owned (manual designation, E11)
    polledAt: nowMs,
    // Batch 1A extras (additive; schema permits additional properties):
    llm,
    comfy,
    systemd: systemdUnits,
  };
}

/**
 * Collect the full telemetry snapshot for this node.
 *
 * @param {string} nodeId
 * @param {string} nodeName
 * @param {string} lanIp
 * @param {number[] | string} ports LLM server ports to probe
 * @param {number | null} comfyPort ComfyUI port (null/0 = skip)
 * @param {{ now?: () => number, readFile?: (path: string) => Promise<string>, inject?: object }} [opts]
 *   `inject` maps collector names to override fns (test hook):
 *   gpu/cpu/mem/disk/net/docker/systemd/uptime → () => result; llm → (ports) => result; comfy → (port) => result.
 * @returns {Promise<object>} NodeAgentSnapshot
 */
export async function collectTelemetry(nodeId, nodeName, lanIp, ports = [], comfyPort = null, opts = {}) {
  const nowMs = opts.now ? opts.now() : Date.now();
  const inj = opts.inject || {};
  const readFile = opts.readFile || readTextFile;

  const [
    gpu,
    cpu,
    mem,
    disk,
    net,
    containers,
    systemdUnits,
    llm,
    comfy,
  ] = await Promise.all([
    inj.gpu ? inj.gpu() : collectGpu(opts),
    inj.cpu ? inj.cpu() : collectCpu(opts),
    inj.mem ? inj.mem() : collectMem(opts),
    inj.disk ? inj.disk() : collectDisk(opts),
    inj.net ? inj.net() : collectNet(opts),
    inj.docker ? inj.docker() : collectDocker(opts),
    inj.systemd ? inj.systemd() : collectSystemd(opts),
    inj.llm ? inj.llm(ports) : collectLlm(ports, opts),
    inj.comfy ? inj.comfy(comfyPort) : collectComfy(comfyPort, opts),
  ]);

  let uptimeSeconds = null;
  if (inj.uptime) {
    uptimeSeconds = await inj.uptime();
  } else {
    try {
      uptimeSeconds = parseUptimeSeconds(await readFile("/proc/uptime"));
    } catch {
      /* unknown */
    }
  }

  return assembleSnapshot({
    nodeId,
    nodeName,
    lanIp,
    nowMs,
    uptimeSeconds,
    gpu,
    cpu,
    mem,
    disk,
    net,
    containers,
    systemdUnits,
    llm,
    comfy,
  });
}
