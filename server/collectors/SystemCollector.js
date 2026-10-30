import fs from "fs";
import path from "path";
import childProcess from "child_process";
import { HOST_PATHS, GPU_MEMORY_JSON_PATH, DGX_SPARK, HARDWARE_DEFAULTS, POLL_INTERVAL_NVERR } from "../config.js";
import { normalizeMac, WOL_INTERFACE } from "../wol.js";
import { sshExec } from "./ssh.js";
import { getSettings } from "../settings.js";
import { RoceSampler } from "./roce.js";
import { KernelJournal } from "./kernelJournal.js";
import { IntelSudoGate, IntelVramCache, buildIntelProbeScript, parseIntelProbe, sampleIntelCards } from "./intelGpu.js";
import {
  WINDOWS_GPU_SCRIPT,
  WINDOWS_SYSTEM_SCRIPT,
  parseWindowsSystem,
  splitWindowsGpuOutput,
  windowsGpuAsLinuxOutput,
} from "./windowsMetrics.js";

/**
 * Parse legacy kernel counter output. Exported for tests. Returns null when the
 * output has no counters (journal unreadable), so callers keep the last value.
 * @param {unknown} raw
 * @returns {{ xid: number, oomKills: number, lastXid: string|null } | null}
 */
export function parseKernelErrors(raw) {
  const lines = String(raw ?? "").split("\n");
  const m = /xid=(\d+)\s+oom=(\d+)/.exec(lines[0] ?? "");
  if (!m) return null;
  const xid = Number.parseInt(m[1], 10);
  const oomKills = Number.parseInt(m[2], 10);
  const lastLine = (lines[1] ?? "").trim();
  const code = /Xid \([^)]*\):\s*(\d+)/.exec(lastLine);
  const lastXid = xid > 0 && lastLine ? (code ? `Xid ${code[1]}` : lastLine.replace(/[^\x20-\x7e]/g, "").slice(0, 80)) : null;
  return { xid, oomKills, lastXid };
}

// nvidia-smi / NVML cannot read back a `nvidia-smi -lgc` lock (no getter
// exists; clocks.max.* is the hardware max). Whoever sets the lock drops a
// one-line marker "<maxMHz> [<boot_id>]" so the dashboard can show it. A
// boot_id that no longer matches means the box rebooted and the lock is gone.
export const CLOCK_CAP_FILES = [
  "/run/sparkdash/gpu-clock-cap",
  "$HOME/.config/sparkdash/gpu-clock-cap",
];
const CLOCK_CAP_CMD =
  `cat ${CLOCK_CAP_FILES.join(" ")} 2>/dev/null | head -1; cat /proc/sys/kernel/random/boot_id 2>/dev/null || true`;

/**
 * Parse CLOCK_CAP_CMD output (marker line, then the current boot_id).
 * Exported for tests. Returns the locked max graphics clock in MHz, or null.
 * @param {unknown} raw
 * @returns {number|null}
 */
export function parseClockCap(raw) {
  const lines = String(raw ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const capLine = lines.find((l) => /^\d+(\s|$)/.test(l)); // first token must be wholly numeric — a bare boot_id line (e.g. "139dcc9e-…") starts with digits and must NOT parse as a cap
  if (!capLine) return null;
  const [mhzRaw, markerBoot] = capLine.split(/\s+/);
  const mhz = Number.parseInt(mhzRaw, 10);
  if (!Number.isFinite(mhz) || mhz <= 0) return null;
  const currentBoot = lines.filter((l) => uuid.test(l)).pop();
  if (markerBoot && currentBoot && markerBoot.toLowerCase() !== currentBoot.toLowerCase()) return null;
  return mhz;
}

/**
 * Parse `grep -c` stdout into a non-negative integer. Exported for tests.
 * @param {unknown} raw
 * @returns {number}
 */
export function parseNvErrNoMemoryCount(raw) {
  const line = String(raw ?? "").trim().split("\n").pop() ?? "";
  const n = Number.parseInt(line, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export const COLLECTION_SUCCESS = Symbol("sparkdash.collectionSuccess");

export function collectionWasSuccessful(result) {
  return result?.[COLLECTION_SUCCESS] === true;
}

const NVIDIA_SIDE_FAILED = Symbol("sparkdash.nvidiaSideFailed");

/** True when nvidia-smi is installed but gave no devices on a host that has an Intel card. */
export function nvidiaSideFailed(result) {
  return result?.[NVIDIA_SIDE_FAILED] === true;
}

function markNvidiaSideFailed(result, failed) {
  if (failed) Object.defineProperty(result, NVIDIA_SIDE_FAILED, { value: true, enumerable: false, configurable: true });
  return result;
}

/** Convert amd-smi JSON output into the collector's per-device GPU shape. */
export function parseAmdSmiMetrics(raw, limitRaw = null) {
  let payload;
  let limits;
  try { payload = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return []; }
  try { limits = typeof limitRaw === "string" ? JSON.parse(limitRaw) : limitRaw; } catch { limits = null; }
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.gpu_data) ? payload.gpu_data : [];
  const limitRows = Array.isArray(limits) ? limits : Array.isArray(limits?.gpu_data) ? limits.gpu_data : [];
  const number = (v) => {
    if (v == null) return null;
    const candidate = typeof v === "object" ? v.value : v;
    if (candidate == null || String(candidate).trim() === "") return null;
    const n = Number(candidate);
    return Number.isFinite(n) ? n : null;
  };
  return rows.map((row, i) => {
    const used = number(row?.mem_usage?.used_vram);
    const total = number(row?.mem_usage?.total_vram);
    const free = number(row?.mem_usage?.free_vram);
    const temperature = number(row?.temperature?.edge);
    const usage = number(row?.usage?.gfx_activity);
    const powerDraw = number(row?.power?.socket_power);
    const powerLimit = number(
      row?.power?.socket_power_limit ?? row?.power?.power_limit ??
      limitRows[i]?.socket_power_limit ?? limitRows[i]?.limit?.ppt0?.socket_power_limit ??
      limitRows[i]?.limit?.socket_power_limit
    );
    const physicalIndex = Number.isFinite(Number(row?.gpu)) ? Number(row.gpu) : i;
    return {
      index: physicalIndex,
      physicalIndex,
      name: row?.name || "AMD GPU",
      uuid: row?.uuid || null,
      vendor: "amd",
      temperature: temperature ?? 0,
      usage: usage ?? 0,
      powerDraw: powerDraw ?? 0,
      powerLimit: powerLimit ?? 0,
      power: { draw: powerDraw ?? 0, limit: powerLimit ?? 0 },
      vram: {
        used: used ?? 0,
        total: total ?? 0,
        percentage: total > 0 && used != null ? Math.round((used / total) * 100) : 0,
        available: free ?? (total != null && used != null ? Math.max(0, total - used) : 0),
      },
      metricAvailability: {
        temperature: temperature != null,
        usage: usage != null,
        powerDraw: powerDraw != null,
        powerLimit: powerLimit != null,
        vramUsed: used != null,
        vramTotal: total != null,
      },
      throttle: null,
      processes: [],
    };
  });
}

/**
 * Locate and run macmon on a macOS unit. Non-interactive SSH sessions get a minimal
 * PATH, so Homebrew and cargo locations are tried explicitly. MACMON_PATH overrides.
 */
const MACMON_CANDIDATES = [
  process.env.MACMON_PATH,
  "/opt/homebrew/bin/macmon",
  "/usr/local/bin/macmon",
  "$HOME/.cargo/bin/macmon",
].filter(Boolean);
export const MACMON_CMD =
  // The GPU's share of unified memory first (macmon only reports RAM as a whole): the driver's
  // "In use system memory" per accelerator, filtered to those lines, so macmon's JSON stays last.
  `ioreg -r -d 1 -w 0 -c IOAccelerator 2>/dev/null | grep -o '"In use system memory"=[0-9]*'; ` +
  `for m in ${MACMON_CANDIDATES.map((p) => (p.startsWith("$HOME") ? `"${p}"` : `'${p.replace(/'/g, `'\\''`)}'`)).join(" ")} "$(command -v macmon 2>/dev/null)"; do ` +
  'if [ -n "$m" ] && [ -x "$m" ]; then "$m" pipe -s 1 -i 200 --soc-info || "$m" pipe -s 1 -i 200; exit 0; fi; done; echo NO_MACMON';

/**
 * Bytes of unified memory the GPU holds, summed over the `"In use system memory"=N` lines MACMON_CMD
 * prints from the GPU driver's statistics; null when there are none (no accelerator entry, or ioreg
 * unavailable), so callers keep reporting the pool as a whole.
 */
export function parseMacGpuMemory(output) {
  const matches = [...String(output ?? "").matchAll(/^"In use system memory"=(\d+)\s*$/gm)];
  if (matches.length === 0) return null;
  return matches.reduce((sum, m) => sum + Number(m[1]), 0);
}

/**
 * The GPU's share of a macmon sample's RAM in use (MB); null when ioreg gave none.
 *
 * A figure at or above the whole pool's use is not a GPU share — duplicate accelerator entries,
 * or the counter not meaning what we read it as. Capping it there would publish the rest of the
 * pool as `cpuUsed: 0`, asserting as measured fact that the CPU side holds nothing, so an
 * implausible reading leaves the pool unsplit instead.
 */
export function macGpuUsedMB(sample, ramUsedMB) {
  const bytes = sample?.gpuInUseBytes;
  if (bytes == null || !Number.isFinite(bytes)) return null;
  if (!Number.isFinite(ramUsedMB) || ramUsedMB <= 0) return null;
  const mb = Math.round(bytes / 1048576);
  return mb > ramUsedMB ? null : mb;
}

/** Last JSON line of `macmon pipe` output, parsed; null when absent or malformed. */
export function parseMacmonSample(output) {
  const line = String(output ?? "").trim().split("\n").filter((l) => l.trim().startsWith("{")).pop();
  if (!line) return null;
  try {
    const j = JSON.parse(line);
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

/** One SSH round trip: BSD link counters, interface addresses/state, default route. */
export const MAC_NETWORK_CMD =
  "netstat -ibn 2>/dev/null; echo '---IFCONFIG---'; ifconfig -a 2>/dev/null; echo '---ROUTE---'; route -n get default 2>/dev/null || true";

/**
 * Parse the combined macOS network probe. Keeps physical `en*` interfaces
 * (including Ethernet and Wi-Fi) and drops loopback, tunnels and bridges so
 * encapsulated traffic is not counted twice. Byte counters are cumulative;
 * rates are deltas against `lastStats`, which this function updates.
 *
 * @param {string} output
 * @param {Map<string, {rxBytes:number, txBytes:number, time:number}>} lastStats
 * @param {number} now
 */
export function parseMacNetwork(output, lastStats = new Map(), now = Date.now()) {
  const text = String(output ?? "");
  const [netstatPart, rest = ""] = text.split("---IFCONFIG---");
  const [ifconfigPart = "", routePart = ""] = rest.split("---ROUTE---");

  const config = new Map();
  let current = null;
  for (const line of ifconfigPart.split("\n")) {
    const head = /^(\w+): flags=/.exec(line);
    if (head) {
      current = { ip: null, operstate: "unknown", media: null, ether: null };
      config.set(head[1], current);
      continue;
    }
    if (!current) continue;
    const status = /^\s+status:\s*(\S+)/.exec(line);
    if (status) current.operstate = status[1] === "active" ? "up" : "down";
    const inet = /^\s+inet\s+(\d+\.\d+\.\d+\.\d+)/.exec(line);
    if (inet) current.ip = inet[1];
    const media = /^\s+media:\s*(.+)$/.exec(line);
    if (media) current.media = media[1].trim();
    const ether = /^\s+ether\s+([0-9a-f:]{17})/i.exec(line);
    if (ether) current.ether = ether[1];
  }

  const interfaces = [];
  const seen = new Set();
  for (const line of netstatPart.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const name = parts[0];
    if (!/^en\d+$/.test(name) || seen.has(name)) continue;
    const linkIdx = parts.findIndex((p) => p.startsWith("<Link#"));
    if (linkIdx < 0) continue;
    const rxBytes = Number(parts[linkIdx + 4]);
    const txBytes = Number(parts[linkIdx + 7]);
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue;
    const iface = config.get(name) || {};
    const prev = lastStats.get(name);
    const dtSec = prev ? (now - prev.time) / 1000 : 0;
    const rxSpeed = prev && dtSec > 0 ? Math.max(0, (rxBytes - prev.rxBytes) / dtSec) : 0;
    const txSpeed = prev && dtSec > 0 ? Math.max(0, (txBytes - prev.txBytes) / dtSec) : 0;
    lastStats.set(name, { rxBytes, txBytes, time: now });
    seen.add(name);
    // A Mac exposes many dormant en* interfaces (Thunderbolt, USB, Wi-Fi).
    // Keep an interface when it is up or has carried traffic; drop the rest
    // so the network panel lists what is actually in use.
    if (iface.operstate !== "up" && rxBytes === 0 && txBytes === 0) continue;
    interfaces.push({
      name,
      rxSpeed: Math.round(rxSpeed),
      txSpeed: Math.round(txSpeed),
      ip: iface.ip ?? null,
      operstate: iface.operstate ?? "unknown",
      disabled: false,
    });
  }

  const routeMatch = /interface:\s*(\w+)/.exec(routePart);
  const routed = routeMatch?.[1];
  const primaryInterface =
    (routed && interfaces.some((i) => i.name === routed) ? routed : null) ||
    interfaces.find((i) => i.operstate === "up")?.name ||
    interfaces[0]?.name ||
    null;

  const media = primaryInterface ? config.get(primaryInterface)?.media : null;
  let linkSpeedMbps = null;
  const speed = media ? /(\d+)\s*(Gbase|baseT|Base-T|Gbps|base)/i.exec(media) : null;
  if (speed) {
    const n = Number(speed[1]);
    linkSpeedMbps = /g/i.test(speed[2]) ? n * 1000 : n;
  }

  return {
    primaryInterface,
    linkSpeedMbps,
    interfaces,
    wolMac: primaryInterface ? config.get(primaryInterface)?.ether ?? null : null,
  };
}

/** One SSH round trip: APFS capacity plus aggregate block-device byte counters. */
export const MAC_STORAGE_CMD =
  "df -k 2>/dev/null; echo '---IOREG---'; /usr/sbin/ioreg -r -c IOBlockStorageDriver -k Statistics -l 2>/dev/null | /usr/bin/grep '\"Statistics\"' || true";

/**
 * Parse macOS `df -k`. The APFS system (`/`) and Data
 * (`/System/Volumes/Data`) volumes share one container: reporting only `/`
 * hides user data, while reporting both would double the capacity. Collapse a
 * same-container pair into one entry with container allocation and the shared
 * free space. Other `/System/Volumes/*` mounts are internal and omitted.
 *
 * @param {string} output
 * @param {string[]} disabledDevices
 */
export function parseMacDf(output, disabledDevices = []) {
  const rows = [];
  const PSEUDO = new Set(["devfs", "autofs", "tmpfs", "overlay"]);
  for (const line of String(output ?? "").trim().split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const isTyped = /^[a-z]+$/.test(parts[1] || "");
    let fsys, type, size, used, avail, mountRest;
    if (isTyped) {
      // GNU-style df -T (not normally used on macOS)
      [fsys, type, size, used, avail, , ...mountRest] = parts;
    } else {
      // BSD df: fs, 1024-blocks, used, available, capacity, iused, ifree, %iused, mount
      if (parts.length < 9) continue;
      [fsys, size, used, avail, , , , , ...mountRest] = parts;
      type = "apfs";
    }
    const mount = mountRest.join(" ") || "/";
    if (PSEUDO.has(String(type || "").toLowerCase())) continue;
    if (!mount.startsWith("/") || mount === "/dev") continue;
    if (mount === "/boot/efi" || mount.includes("/snap")) continue;
    if (/^\/System\/Volumes\//.test(mount) && mount !== "/System/Volumes/Data") continue;
    const toMB = (v) => Math.round((parseInt(v, 10) || 0) / 1024);
    rows.push({
      device: fsys.split("/").pop() || fsys,
      mount,
      used: toMB(used),
      total: toMB(size),
      available: toMB(avail),
    });
  }

  const parentDevice = (device) => (String(device).match(/^disk\d+/) || [device])[0];
  const root = rows.find((r) => r.mount === "/");
  const data = rows.find((r) => r.mount === "/System/Volumes/Data");
  const sameContainer = root && data && parentDevice(root.device) === parentDevice(data.device);
  const consumed = new Set([root, data].filter(Boolean));
  const out = [];

  const push = (row, label, device, used, total, available) => {
    const isDisabled =
      disabledDevices.includes(device) || disabledDevices.includes(label) || disabledDevices.includes(row.mount);
    out.push({
      device,
      label,
      used,
      total,
      available,
      percentage: total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0,
      readSpeed: 0,
      writeSpeed: 0,
      disabled: isDisabled,
    });
  };

  if (sameContainer) {
    const total = Math.max(root.total, data.total);
    const available = Math.max(0, Math.min(total, root.available, data.available));
    const used = total - available;
    // Preserve the existing root device ID so exclusions can still be toggled.
    push(root, "/", root.device, used, total, available);
  } else {
    if (root) push(root, "/", root.device, root.used, root.total, root.available);
    if (data) push(data, "/", parentDevice(data.device), data.used, data.total, data.available);
  }

  for (const row of rows) {
    if (consumed.has(row)) continue;
    if (out.some((d) => d.label === row.mount)) continue;
    push(row, row.mount, row.device, row.used, row.total, row.available);
  }
  return out;
}

/**
 * Sum the IOBlockStorageDriver lifetime byte counters from an `ioreg` dump.
 * One driver exists per physical block device; summing them gives aggregate
 * system disk throughput, not per-volume throughput. Returns null when the
 * Statistics dictionaries are absent or malformed.
 *
 * @param {string} output
 * @returns {{ readBytes: number, writeBytes: number } | null}
 */
export function parseMacIoregDiskStats(output) {
  const text = String(output ?? "");
  let readBytes = 0;
  let writeBytes = 0;
  let found = false;
  const number = (raw) => Number.parseInt(raw, /^0x/i.test(raw) ? 16 : 10);
  const lines = text.split("\n");
  // Apple's IOBlockStorageDriver dictionary uses spaced keys and may print
  // 64-bit counters in hex. APFS also publishes a driver-level Statistics
  // dictionary that mirrors the physical disk; summing both doubles I/O.
  // Physical-driver blocks carry timing/retry keys that the APFS mirror lacks,
  // so only those blocks are summed.
  const candidates = [];
  for (const line of lines) {
    if (!line.includes('"Statistics"')) continue;
    if (!/"Total Time \(Read\)"|"Latency Time \(Write\)"|"Retries \(Read\)"/.test(line)) continue;
    candidates.push(line);
  }
  const spacedRead = candidates.flatMap((line) => [...line.matchAll(/"Bytes\s*\(Read\)"\s*=\s*(0x[0-9a-f]+|\d+)/gi)]);
  const spacedWrite = candidates.flatMap((line) => [...line.matchAll(/"Bytes\s*\(Write\)"\s*=\s*(0x[0-9a-f]+|\d+)/gi)]);
  if (spacedRead.length > 0 || spacedWrite.length > 0) {
    for (const m of spacedRead) { readBytes += number(m[1]); found = true; }
    for (const m of spacedWrite) { writeBytes += number(m[1]); found = true; }
  } else {
    for (const m of text.matchAll(/"BytesRead"\s*=\s*(0x[0-9a-f]+|\d+)/gi)) {
      readBytes += number(m[1]);
      found = true;
    }
    for (const m of text.matchAll(/"BytesWritten"\s*=\s*(0x[0-9a-f]+|\d+)/gi)) {
      writeBytes += number(m[1]);
      found = true;
    }
  }
  if (!found || !Number.isSafeInteger(readBytes) || !Number.isSafeInteger(writeBytes)) return null;
  return { readBytes, writeBytes };
}

const REMOTE_GPU_SECTIONS = new Set(["NVIDIA", "NVIDIA_VRAM", "NVIDIA_APPS", "AMD", "AMD_LIMITS", "INTEL", "MEMINFO", "CLOCK_CAP"]);

/**
 * Split the remote GPU probe output into named sections. A section starts at a
 * line that is exactly one of the known `__NAME__` markers; anything else (JSON,
 * GPU names, even ones containing "__") is section content.
 */
export function splitRemoteGpuSections(output) {
  const sections = {};
  let current = null;
  const lines = [];
  const flush = () => { if (current) sections[current] = lines.join("\n").trim(); lines.length = 0; };
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const m = /^__([A-Z_]+)__$/.exec(line.trim());
    if (m && REMOTE_GPU_SECTIONS.has(m[1])) { flush(); current = m[1]; continue; }
    if (current) lines.push(line);
  }
  flush();
  return sections;
}

// How long a local poll trusts "amd-smi is not installed" before probing again.
const AMD_SMI_ABSENT_TTL_MS = 5 * 60 * 1000;

const AMD_GPU_FIELDS = ["temperature", "usage", "powerDraw", "powerLimit", "vramUsed", "vramTotal"];
const AMD_SMI_RESOLVER = [
  'amd_smi="${AMD_SMI_PATH:-}"',
  'if [ -z "$amd_smi" ] || [ ! -x "$amd_smi" ]; then amd_smi="$(command -v amd-smi 2>/dev/null || true)"; fi',
  // Versioned ROCm dirs come from find, not a shell glob: the remote login shell
  // may be zsh, where an unmatched glob aborts the whole probe (no matches found).
  'if [ -z "$amd_smi" ]; then for amd_candidate in "${ROCM_PATH:+$ROCM_PATH/bin/amd-smi}" "${ROCM_HOME:+$ROCM_HOME/bin/amd-smi}" /opt/rocm/bin/amd-smi $(find /opt -maxdepth 4 \\( -path \'/opt/rocm/core-*/bin/amd-smi\' -o -path \'/opt/rocm-*/bin/amd-smi\' \\) 2>/dev/null | sort); do if [ -x "$amd_candidate" ]; then amd_smi="$amd_candidate"; break; fi; done; fi',
].join("; ");
// Keep vendor namespaces disjoint so collection failures cannot make AMD reuse
// an NVIDIA device's index in per-card histories or Prometheus labels.
const AMD_GPU_INDEX_OFFSET = 1000;
const INTEL_GPU_INDEX_OFFSET = 2000;

function tagCollectionResult(result, successful) {
  Object.defineProperty(result, COLLECTION_SUCCESS, {
    value: successful === true,
    enumerable: false,
    configurable: true,
  });
  return result;
}

/**
 * SystemCollector — collects hardware metrics for a Spark.
 * In Phase 2, this is the LOCAL path only (no SSH).
 * Remote path added in Phase 3.
 */
// Discover models in private vLLM containers on remote Linux units.
// Read only; no port publication, container changes, or inference requests.
// Each container is parsed and probed in its own try block, so one odd
// container never drops the models found in the others.
//
// The output comes from a remote host, so it is bounded twice: here in the
// script, and again when the collector parses it. The script also has to
// finish well inside sshExec's 10 s default, or it is killed and the card
// flaps: docker calls are capped at 2 s each, the container loop stops after
// RESIDENT_MODELS_BUDGET_S, and every HTTP request is 1 s with a bounded read.
const RESIDENT_MODELS_MAX = 50; // models kept
const RESIDENT_MODELS_MAX_CONTAINERS = 20; // vLLM containers probed
const RESIDENT_MODELS_MAX_LEN = 200; // chars per model id / container name
const RESIDENT_MODELS_MAX_BODY = 64 * 1024; // bytes read from /v1/models
const RESIDENT_MODELS_BUDGET_S = 5;
export const RESIDENT_MODELS_CMD = `python3 - <<'PY'
import json, subprocess, time, urllib.request, shlex
T0 = time.monotonic()
MAX_MODELS = ${RESIDENT_MODELS_MAX}
MAX_CONTAINERS = ${RESIDENT_MODELS_MAX_CONTAINERS}
MAX_LEN = ${RESIDENT_MODELS_MAX_LEN}
MAX_BODY = ${RESIDENT_MODELS_MAX_BODY}
BUDGET = ${RESIDENT_MODELS_BUDGET_S}
try:
    ids = subprocess.check_output(['docker', 'ps', '-q'], timeout=2, text=True).split()[:200]
    containers = json.loads(subprocess.check_output(['docker', 'inspect', *ids], timeout=2, text=True)) if ids else []
except Exception:
    raise SystemExit(1)
models = []
probed = 0
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
for c in containers:
    if len(models) >= MAX_MODELS or probed >= MAX_CONTAINERS or time.monotonic() - T0 > BUDGET:
        break
    try:
        if 'vllm' not in c.get('Config', {}).get('Image', '').lower():
            continue
        probed += 1
        cmd = c.get('Config', {}).get('Cmd') or []
        try:
            args = shlex.split(' '.join(cmd))
        except ValueError:
            args = list(cmd)
        port = 8000
        for i, arg in enumerate(args):
            if arg == '--port' and i + 1 < len(args):
                port = int(args[i + 1])
            elif arg.startswith('--port='):
                port = int(arg.split('=', 1)[1])
        if not 0 < port < 65536:
            continue
        name = str(c.get('Name', '')).lstrip('/')[:MAX_LEN]
        addresses = [n.get('IPAddress') for n in c.get('NetworkSettings', {}).get('Networks', {}).values() if n.get('IPAddress')]
        for address in addresses:
            if time.monotonic() - T0 > BUDGET:
                break
            try:
                with opener.open('http://%s:%s/v1/models' % (address, port), timeout=1) as r:
                    data = json.loads(r.read(MAX_BODY))
                for model in data.get('data', []):
                    if isinstance(model.get('id'), str) and model['id'] and len(models) < MAX_MODELS:
                        models.append({'modelId': model['id'][:MAX_LEN], 'container': name})
                break
            except Exception:
                continue
    except Exception:
        continue
print(json.dumps(models))
PY`;

/** Separates `df` output from the block-device counters in the remote storage command. */
const REMOTE_IO_MARKER = "---sparkdash-block-io---";
/** Samples of one disk closer together than this (ms) are the same poll and share one rate. */
const DISK_RATE_MIN_WINDOW_MS = 250;

export class SystemCollector {
  constructor(spark) {
    this.spark = spark;
    this._nvidiaSmiPath = this._resolveNvidiaSmiPath();

    // Rate-tracking baselines
    this.lastNetworkStats = new Map();
    this.lastCpuStat = null;
    this._cpuCollectionSequence = 0;
    /** Last computed CPU usage percentage (0-100) — used by GPU system-draw estimate. */
    this.lastCpuUsagePct = 0;
    this.lastRaplReading = null;
    this.lastDiskIO = new Map();
    this.currentDiskIOSpeeds = new Map();

    // Cached ARM detection (resolved lazily once; /proc/cpuinfo never changes
    // mid-process). Avoids a redundant host read on every CPU poll.
    this._isArmCached = null;

    // GPU VRAM per-PID cache
    this.nvidiaComputeAppsCache = new Map();
    // Intel (xe) energy / idle-residency baselines per PCI address
    this._intelState = new Map();
    // Remembers a failed `sudo -n` VRAM read so it is not retried every poll
    this._intelSudo = new IntelSudoGate();
    // Last debugfs VRAM reading, so working `sudo -n` runs once per window, not per poll
    this._intelVram = new IntelVramCache();
    // Whether any xe-driver card exists on this host (local path), re-checked rarely
    this._intelPresent = { value: null, at: 0 };

    // Cached hardware info
    this._hardwareInfo = null;
    this._kernelJournal = new KernelJournal(async (cmd) => {
      if (!this.spark.isLocal) return sshExec(this.spark, cmd, { timeoutMs: 8000 });
      return this._hasHostProc()
        ? this._execOnHost(cmd, { allowContainerFallback: false, maxBuffer: 10 * 1024 * 1024 })
        : this._execFileP("sh", ["-c", cmd], { timeout: 8000, maxBuffer: 10 * 1024 * 1024 });
    }, POLL_INTERVAL_NVERR);

    // Rootless-Docker nsenter state (classified once, then remembered).
    this._nsenterBroken = false;
    /** Cached "container netns is the host's" check (network_mode: host). */
    this._containerNetnsShared = null;
  }

  /**
   * Loaded models in private vLLM containers. Resolves to an array (empty when
   * there are none) or to null when discovery itself failed (SSH or docker
   * error, unparsable output), so a caller can tell "none" from "unknown".
   */
  async probeResidentModels(execute = sshExec) {
    if (this.spark.isLocal || this.spark.platform === "windows" || this.spark.platform === "darwin") return [];
    try {
      const value = JSON.parse(await execute(this.spark, RESIDENT_MODELS_CMD));
      if (!Array.isArray(value)) return null;
      const text = (v) => (typeof v === "string" && v ? v.slice(0, RESIDENT_MODELS_MAX_LEN) : null);
      const out = [];
      for (const m of value) {
        const modelId = text(m?.modelId);
        const container = text(m?.container);
        if (modelId && container) out.push({ modelId, container });
        if (out.length >= RESIDENT_MODELS_MAX) break;
      }
      return out;
    } catch {
      return null;
    }
  }

  /** Like probeResidentModels, but an unknown result is an empty list. */
  async collectResidentModels(execute = sshExec) {
    return (await this.probeResidentModels(execute)) ?? [];
  }

  /** Collect GPU metrics (temperature, usage, power, VRAM). */
  async collectGpu() {
    try {
      if (this.isMac && !this.spark.isLocal) {
        const macGpu = await this._getRemoteGpuMac();
        return tagCollectionResult(macGpu, macGpu.gpus.length > 0);
      }
      const gpuData = this.spark.isLocal
        ? await this._getGPUAll()
        : this.isWindows
          ? this._withoutUnmeteredProcesses(
              await this._getRemoteGpu(async () => windowsGpuAsLinuxOutput(await this._windowsRun("gpu", WINDOWS_GPU_SCRIPT)))
            )
          : await this._getRemoteGpu();
      // A broken NVIDIA side must not look healthy just because another vendor's card answered.
      return tagCollectionResult(gpuData, this._isSuccessfulGpuCollection(gpuData) && !nvidiaSideFailed(gpuData));
    } catch (err) {
      console.error(`[SystemCollector] GPU error for ${this.spark.id}:`, err.message);
      return tagCollectionResult(this._defaultGpu(), false);
    }
  }

  /** Collect CPU metrics (usage, temperature, power). */
  async collectCpu() {
    const collectionSequence = ++this._cpuCollectionSequence;
    try {
      if (!this.spark.isLocal) {
        if (this.isMac) {
          const macCpu = await this._getRemoteCpuMac();
          return tagCollectionResult(macCpu, macCpu.temperatureSource === "macmon");
        }
        const cpuData = this.isWindows
          ? await this._getWindowsCpu(collectionSequence)
          : await this._getRemoteCpu(collectionSequence);
        return tagCollectionResult(cpuData, this._isSuccessfulCpuCollection(cpuData));
      }

      // Read /proc/stat once and compute usage BEFORE estimating power.
      // Previously _getCPUPower re-read /proc/stat in parallel with _getCPUUsage,
      // racing on lastCpuStat and producing 0% (idle power) on the first poll.
      const usage = await this._getCPUUsage();
      if (!this._isValidCpuStat(usage)) {
        throw new Error("invalid /proc/stat CPU counters");
      }
      const totalDiff = usage.total - (this.lastCpuStat?.total || usage.total);
      const usedDiff = usage.used - (this.lastCpuStat?.used || usage.used);
      const cpuPercentage = totalDiff > 0 ? Math.round((usedDiff / totalDiff) * 100) : 0;
      const usageFraction = totalDiff > 0 ? usedDiff / totalDiff : 0;
      // Temperature and power can run in parallel — power is now a pure
      // function of the usage fraction (no extra /proc/stat read).
      const [tempReading, power] = await Promise.all([
        this._getCPUTemperatureReading(),
        this._getCPUPower(usageFraction),
      ]);
      if (collectionSequence === this._cpuCollectionSequence) {
        this.lastCpuStat = usage;
        this.lastCpuUsagePct = cpuPercentage;
      }
      const cpuData = {
        usage: cpuPercentage,
        temperature: tempReading.temperature,
        temperatureLabel: tempReading.temperatureLabel,
        temperatureSource: tempReading.temperatureSource,
        ...power,
      };
      return tagCollectionResult(cpuData, this._isSuccessfulCpuCollection(cpuData));
    } catch (err) {
      console.error(`[SystemCollector] CPU error for ${this.spark.id}:`, err.message);
      return tagCollectionResult(this._defaultCpu(), false);
    }
  }

  _isSuccessfulGpuCollection(gpu) {
    if (Array.isArray(gpu?.gpus) && gpu.gpus.length > 0) {
      return Object.values(gpu.metricAvailability ?? {}).some(Boolean) ||
        gpu.gpus.some((device) => Object.values(device.metricAvailability ?? {}).some(Boolean));
    }
    return (
      Number.isFinite(gpu?.temperature) &&
      gpu.temperature > 0 &&
      Number.isFinite(gpu?.usage) &&
      Number.isFinite(gpu?.power?.draw) &&
      gpu.power.draw >= 0 &&
      Number.isFinite(gpu?.power?.limit) &&
      gpu.power.limit > 0
    );
  }

  _isSuccessfulCpuCollection(cpu) {
    return (
      Number.isFinite(cpu?.usage) &&
      cpu.usage >= 0 &&
      cpu.usage <= 100 &&
      Number.isFinite(cpu?.draw) &&
      cpu.draw > 0 &&
      Number.isFinite(cpu?.tdp) &&
      cpu.tdp > 0
    );
  }

  _isValidCpuStat(cpuStat) {
    return (
      Number.isFinite(cpuStat?.total) &&
      cpuStat.total > 0 &&
      Number.isFinite(cpuStat?.used) &&
      cpuStat.used >= 0 &&
      cpuStat.used <= cpuStat.total
    );
  }

  /** Prevent an earlier monitor lifecycle from updating shared CPU baselines. */
  invalidatePendingCollections() {
    this._cpuCollectionSequence += 1;
  }

  /** Collect RAM metrics. */
  async collectRam() {
    if (!this.spark.isLocal) {
      if (this.isWindows) return this._getWindowsRam();
      if (this.isMac) return (await this._macmonRam()) ?? this._getRemoteRamMac();
      return this._getRemoteRam();
    }
    try {
      return await this._getRamUsage();
    } catch (err) {
      console.error(`[SystemCollector] RAM error for ${this.spark.id}:`, err.message);
      return this._defaultRam();
    }
  }

  /** Collect storage metrics per mount. */
  async collectStorage() {
    if (!this.spark.isLocal) {
      if (this.isWindows) return this._getWindowsStorage();
      if (this.isMac) return this._getRemoteStorageMac();
      return this._getRemoteStorage();
    }
    try {
      return await this._getDiskUsage();
    } catch (err) {
      console.error(`[SystemCollector] Storage error for ${this.spark.id}:`, err.message);
      return [];
    }
  }

  /** Collect network metrics (interfaces, speeds). */
  async collectNetwork() {
    if (!this.spark.isLocal && this.isMac) return this._getRemoteNetworkMac();
    if (!this.spark.isLocal) return this.isWindows ? this._getWindowsNetwork() : this._getRemoteNetwork();
    try {
      const interfaces = this._tagDisabledInterfaces(await this._getNetworkMetrics());
      let primaryInterface = await this._getDefaultNetworkInterface();
      // Prefer an enabled iface for primary display when default is hidden
      if (primaryInterface && (this.spark.disabledInterfaces || []).includes(primaryInterface)) {
        const alt = interfaces.find((i) => !i.disabled);
        primaryInterface = alt?.name ?? primaryInterface;
      }
      const linkSpeed = primaryInterface ? await this._getNetworkLinkSpeedMbps(primaryInterface) : null;
      const wolMac = await this._getWolInterfaceMac();
      return { primaryInterface, linkSpeedMbps: linkSpeed, interfaces, wolMac };
    } catch (err) {
      console.error(`[SystemCollector] Network error for ${this.spark.id}:`, err.message);
      return this._defaultNetwork();
    }
  }

  /**
   * RoCE / RDMA state of this unit (see roce.js), or null when it has no RDMA devices
   * (or is a Windows / macOS unit). Throttled internally: calling it every poll is fine.
   */
  async collectRoce() {
    if (this.isWindows || this.isMac) return null;
    this._roceSampler ??= new RoceSampler({
      run: (script) =>
        this.spark.isLocal
          ? this._hasHostProc()
            ? // RoCE reads /sys/class/infiniband — useless inside the container.
              this._execOnHost(script, { allowContainerFallback: false })
            : this._exec(script)
          : sshExec(this.spark, script, { timeoutMs: 8000 }),
    });
    try {
      return await this._roceSampler.sample();
    } catch (err) {
      console.error(`[SystemCollector] RoCE error for ${this.spark.id}:`, err.message);
      return undefined; // could not read: the caller keeps its previous value
    }
  }

  /** Collect unified memory metrics. */
  async collectUnifiedMemory() {
    if (!this.spark.isLocal && this.isMac) return this._getRemoteUnifiedMemoryMac();
    if (!this.spark.isLocal) return this.isWindows ? this._getWindowsUnifiedMemory() : this._getRemoteUnifiedMemory();
    try {
      return await this._getUnifiedMemory();
    } catch (err) {
      console.error(`[SystemCollector] Unified memory error for ${this.spark.id}:`, err.message);
      return this._defaultUnifiedMemory();
    }
  }

  // ─── GPU helpers ─────────────────────────────────────────
  async _getGPUAll() {
    const vramRead = this._intelVram.stale;
    const [gpuOut, amd, clockCapMHz, intelOut] = await Promise.all([
      this._nvidiaSmi(
        "--query-gpu=temperature.gpu,utilization.gpu,power.draw,power.limit,clocks.current.sm,clocks.max.sm,clocks_throttle_reasons.hw_thermal_slowdown,clocks_throttle_reasons.sw_thermal_slowdown,clocks_throttle_reasons.hw_slowdown,clocks_throttle_reasons.sw_power_cap,index,name,uuid --format=csv,noheader,nounits"
      ).catch(() => null),
      this._probeLocalAmd(),
      this._readLocalClockCap(),
      this._probeIntelLocal(vramRead),
    ]);
    const nvidiaDevices = this._parseGpuLines(gpuOut ?? "");
    this._applyClockCap(nvidiaDevices, clockCapMHz);
    const intelDevices = this._intelDevices(this._sampleIntel(intelOut, vramRead));
    const otherDevices = [...amd.devices, ...intelDevices];
    // nvidia-smi failing is normal on a host without NVIDIA; installed-but-failing next to an Intel card is not.
    const nvidiaFailed = gpuOut === null && intelDevices.length > 0 && (await this._nvidiaSmiInstalled());
    this._lastVramPerDevice = [];
    const nvidiaVram = nvidiaDevices.length ? await this._queryNvidiaVram() : { used: 0, total: 0, percentage: 0, available: 0 };
    const otherVram = this._sumDeviceVram(otherDevices);
    const devices = [...nvidiaDevices, ...otherDevices];
    const gpu = this._aggregateGpuDevices(devices);
    if (!nvidiaDevices.length) this.nvidiaComputeAppsCache.clear();
    const vram = this._combineVram(nvidiaVram, otherVram);

    // Estimate total system power: GPU draw + CPU draw + ~20W CX7/peripherals
    let systemDraw = gpu.powerDraw;
    try {
      const cpuPower = await this._getCPUPower();
      systemDraw += cpuPower.draw;
    } catch {}
    systemDraw += 20; // CX7 NIC + peripherals estimate
    systemDraw = Math.round(systemDraw);

    // Top 5 GPU processes by VRAM usage (a PID spanning several GPUs is summed)
    const apps = this._cachedApps();
    const processes = this._topProcesses(apps);

    return markNvidiaSideFailed({
      temperature: gpu.temperature,
      usage: gpu.usage,
      power: { draw: gpu.powerDraw, limit: gpu.powerLimit, systemDraw },
      vram,
      processes,
      throttle: gpu.throttle,
      nvErrNoMemory: await this._nvErrNoMemory(),
      kernelErrors: await this._kernelErrors(),
      gpus: [
        ...this._buildGpuDevices(nvidiaDevices, this._lastVramPerDevice ?? [], apps, nvidiaVram),
        ...otherDevices,
      ],
      vendors: [...new Set(devices.map((device) => device.vendor))],
      metricAvailability: {
        ...gpu.metricAvailability,
        vramUsed: devices.some((device) => device.metricAvailability?.vramUsed !== false),
        vramTotal: devices.some((device) => device.metricAvailability?.vramTotal !== false),
      },
    }, nvidiaFailed);
  }

  /** Whether nvidia-smi exists on the host. Cached for 10 minutes; only asked when it just failed. */
  async _nvidiaSmiInstalled() {
    const c = (this._nvidiaInstalled ??= { value: null, at: 0 });
    const now = Date.now();
    if (c.value != null && now - c.at < 10 * 60 * 1000) return c.value;
    let found = false;
    try {
      found = String(await this._execOnHost("command -v nvidia-smi 2>/dev/null")).trim() !== "";
    } catch {
      found = false;
    }
    this._nvidiaInstalled = { value: found, at: now };
    return found;
  }

  /**
   * Local amd-smi probe. Each probe spawns a host shell, so once amd-smi has
   * produced nothing on a host that has never shown an AMD GPU, skip it for
   * AMD_SMI_ABSENT_TTL_MS. A host that has reported AMD data is always polled.
   */
  async _probeLocalAmd() {
    const none = { devices: [] };
    if (!this._amdEverSeen && Date.now() < (this._amdAbsentUntil ?? 0)) return none;
    const metricsOut = await this._amdSmi("metric -u -p -m -t --json").catch(() => "");
    if (!parseAmdSmiMetrics(metricsOut).length) {
      if (!this._amdEverSeen) this._amdAbsentUntil = Date.now() + AMD_SMI_ABSENT_TTL_MS;
      return none;
    }
    this._amdEverSeen = true;
    const limitsOut = await this._amdSmi("static -l --json").catch(() => "");
    return {
      devices: parseAmdSmiMetrics(metricsOut, limitsOut)
        .map((device) => ({ ...device, index: AMD_GPU_INDEX_OFFSET + device.index })),
    };
  }

  /** Intel (xe) probe on this host, in the host mount namespace. "" when unavailable. */
  async _probeIntelLocal(vram = true) {
    if (process.platform !== "linux") return "";
    if (!this._hasXeCard()) return "";
    try {
      return await this._execOnHost(buildIntelProbeScript({ sudo: this._intelSudo.allowed && getSettings().intelVramSudo, vram }));
    } catch {
      return "";
    }
  }

  /** Where sysfs may be mounted: the host bind mount in the container, else /sys. */
  _sysRoots() {
    return [HOST_PATHS.SYS, "/sys"];
  }

  /**
   * Whether an `xe`-driver card is present, read from sysfs without spawning
   * anything. Cached; re-checked every 10 minutes so a hot-added card is found
   * eventually. A failed read counts as "maybe" and is not cached.
   */
  _hasXeCard() {
    const c = this._intelPresent;
    const now = Date.now();
    if (c.value != null && now - c.at < 10 * 60 * 1000) return c.value;
    try {
      const root = this._sysRoots()
        .map((r) => path.join(r, "class/drm"))
        .find((d) => fs.existsSync(d));
      let found = false;
      if (root) {
        for (const name of fs.readdirSync(root)) {
          if (!/^card\d+$/.test(name)) continue;
          try {
            if (path.basename(fs.readlinkSync(path.join(root, name, "device/driver"))) === "xe") {
              found = true;
              break;
            }
          } catch {
            // no driver bound
          }
        }
      }
      this._intelPresent = { value: found, at: now };
      return found;
    } catch {
      return true;
    }
  }

  /** Probe output -> sampled Intel cards (power and usage from counter deltas). [] when none. */
  _sampleIntel(probeOut, vramRead = true) {
    const cards = parseIntelProbe(probeOut);
    this._intelSudo.observe(cards);
    this._intelVram.apply(cards, vramRead);
    const { devices, next } = sampleIntelCards(cards, this._intelState);
    this._intelState = next;
    return devices.map((d) => ({
      ...d,
      throttle: this._buildThrottle({ smClockMHz: d.smClockMHz, smClockMaxMHz: d.smClockMaxMHz }),
    }));
  }

  /**
   * Sampled Intel cards as finished devices, the same shape parseAmdSmiMetrics
   * returns, in their own index range. Missing numbers are reported as
   * unavailable instead of zero: no power cap file means no power limit, and a
   * card whose VRAM usage could not be read (debugfs not readable) only knows
   * its PCI BAR size.
   */
  _intelDevices(sampled) {
    return sampled.map((d, i) => {
      const measured = d.vramSource === "debugfs";
      const used = measured ? d.vramUsedMB : 0;
      const total = d.vramTotalMB;
      return {
        index: INTEL_GPU_INDEX_OFFSET + i,
        physicalIndex: i,
        name: d.name,
        uuid: null,
        vendor: "intel",
        pci: d.pci,
        temperature: d.temperature,
        usage: d.usage,
        powerDraw: d.powerDraw,
        powerLimit: d.powerLimit,
        power: { draw: d.powerDraw, limit: d.powerLimit },
        vram: {
          used,
          total,
          percentage: total > 0 ? Math.round((used / total) * 100) : 0,
          available: Math.max(0, total - used),
        },
        fanRpm: d.fanRpm ?? null,
        vramSource: d.vramSource,
        metricAvailability: {
          temperature: d.temperature > 0,
          usage: true,
          powerDraw: true,
          powerLimit: d.powerLimit > 0,
          vramUsed: measured,
          vramTotal: total > 0,
        },
        throttle: d.throttle,
        processes: [],
      };
    });
  }

  _sumDeviceVram(devices) {
    const available = devices.filter((d) => d.metricAvailability?.vramTotal);
    return {
      used: devices.some((d) => d.metricAvailability?.vramUsed)
        ? devices.reduce((sum, d) => sum + (d.metricAvailability?.vramUsed ? d.vram.used : 0), 0) : 0,
      total: available.reduce((sum, d) => sum + d.vram.total, 0),
      available: available.reduce((sum, d) => sum + d.vram.available, 0),
    };
  }

  _combineVram(a, b) {
    const used = (a?.used || 0) + (b?.used || 0);
    const total = (a?.total || 0) + (b?.total || 0);
    const available = (a?.available || 0) + (b?.available || 0);
    return { used, total, percentage: total > 0 ? Math.round((used / total) * 100) : 0, available };
  }

  /**
   * VRAM from nvidia-smi.
   *
   * On GB10 the GPU and CPU share one unified HBM3e pool, so "VRAM" is really the
   * GPU-allocated portion of that pool. To stay consistent with the Unified Memory
   * panel (which is `MemTotal`/`MemAvailable` based), we:
   *   - use `MemTotal` (OS-visible pool) as the VRAM `total` when nvidia-smi reports
   *     N/A (the spec 128 GB is only a last resort),
   *   - report `used` as GPU-allocated memory (compute-apps sum) — this is what the
   *     GPU is actually holding, NOT total pool pressure,
   *   - expose `available` = `MemAvailable`, the real free memory shared with the CPU.
   * `percentage` is `used / MemTotal` so it is comparable to the Unified Memory
   * percentage (both denominate against the same pool).
   */
  async _queryNvidiaVram({ computeOut = null } = {}) {
    let used = null;
    let total = null;
    let availableMB = 0;

    try {
      const memOut = await this._nvidiaSmi(
        "--query-gpu=memory.used,memory.total --format=csv,noheader,nounits"
      );
      const perDevice = this._parseVramLines(memOut);
      this._lastVramPerDevice = perDevice;
      ({ used, total } = this._sumVram(perDevice));
    } catch {
      /* memory.* often N/A on GB10 */
    }

    // Compute-apps sum is the reliable "used" path on unified-memory GB10.
    // Track whether the live query succeeded so we don't resurrect a stale
    // gpu-memory.json after VRAM is cleared (cron is ~1/min).
    let computeAppsQueried = false;
    let computeSum = 0;
    try {
      const raw =
        computeOut != null
          ? computeOut
          : await this._nvidiaSmi(
              "--query-compute-apps=pid,process_name,used_gpu_memory,gpu_uuid --format=csv,noheader,nounits"
            );
      const apps = this._parseComputeApps(raw);
      this.nvidiaComputeAppsCache.clear();
      for (const app of apps) {
        this.nvidiaComputeAppsCache.set(this._computeAppKey(app), {
          pid: app.pid,
          name: app.name,
          vramMB: app.vramMB,
          gpuUuid: app.gpuUuid ?? null,
        });
        computeSum += app.vramMB;
      }
      computeAppsQueried = true;
      // Prefer live compute-apps for used (including 0 = cleared).
      if (used == null || used === 0) used = computeSum;
    } catch {
      /* Docker without host PID ns often fails/empties here — file fallback below */
    }

    // Host cron file (gpu-memory.sh): backup when live compute-apps is unavailable
    // (container PID namespace without `pid: host`). Do not apply when we already
    // got a live answer — that was the "stuck at 98 GB after clear" bug.
    const file = this._readGpuMemoryFileFull();
    if (!computeAppsQueried) {
      if ((used == null || used === 0) && file.used > 0) used = file.used;
      if (
        this.nvidiaComputeAppsCache.size === 0 &&
        Array.isArray(file.processes) &&
        file.processes.length > 0
      ) {
        for (const proc of file.processes) {
          const pid = Number(proc?.pid);
          const vramMB = this._parseSmiNumber(proc?.vramMB);
          const name =
            typeof proc?.name === "string" && proc.name.trim()
              ? proc.name.trim()
              : "unknown";
          if (!Number.isInteger(pid) || pid <= 0 || vramMB == null) continue;
          this.nvidiaComputeAppsCache.set(pid, { pid, name, vramMB, gpuUuid: null });
        }
        if ((used == null || used === 0) && this.nvidiaComputeAppsCache.size > 0) {
          let sum = 0;
          for (const entry of this.nvidiaComputeAppsCache.values()) {
            sum += entry.vramMB || 0;
          }
          if (sum > 0) used = sum;
        }
      }
    }
    if (total == null && file.total > 0) total = file.total;

    // Unified-memory pool size + actual available memory from /proc/meminfo.
    // This matches the Unified Memory panel's basis so the two read consistently.
    const { totalMB: memTotalMB, availMB } = await this._readMeminfoMB();
    availableMB = availMB;

    const usedMB = Math.round(used || 0);
    let totalMB = Math.round(total || 0);

    if (this.spark.kind === "host") {
      // Discrete GPU VRAM: trust nvidia-smi's memory.total (e.g. 24 GB L4), and
      // only fall back to the OS pool / Spark spec when nvidia-smi says N/A.
      // Free VRAM = total − used (unlike the shared pool, GPU memory is dedicated).
      if (totalMB <= 0 && memTotalMB > 0) totalMB = memTotalMB;
      else if (totalMB <= 0) totalMB = DGX_SPARK.MEMORY_HBM_SIZE_GB * 1024; // Convert to MB
      if (totalMB > 0) availableMB = Math.max(0, totalMB - usedMB);
    } else {
      // GB10 shared HBM pool: prefer the OS-visible pool (MemTotal) as the total,
      // fall back to nvidia-smi, then the hardware spec (HBM) only if nothing known.
      if (memTotalMB > 0) totalMB = memTotalMB;
      else if (totalMB <= 0) totalMB = DGX_SPARK.MEMORY_HBM_SIZE_GB * 1024; // Convert to MB
      availableMB = availMB;
    }

    const percentage = totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : 0;

    return { used: usedMB, total: totalMB, percentage, available: availableMB };
  }

  /** Parse nvidia-smi numeric field; treat [N/A] / empty as null. */
  _parseSmiNumber(value) {
    if (value == null) return null;
    const t = String(value).trim();
    if (!t || /^\[?n\/a\]?$/i.test(t)) return null;
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Parse every line of the `--query-gpu` output — one per physical GPU.
   * Fields 0-9 are the metrics; 10-12 (`index,name,uuid`) identify the card.
   * Returns [] when nvidia-smi printed nothing.
   */
  _parseGpuLines(output, { source = "nvidia" } = {}) {
    const lines = String(output ?? "").trim().split("\n").filter(Boolean);
    return lines.map((line, i) => {
      const parts = line.split(",").map((s) => s.trim());
      const rawTemperature = this._parseSmiNumber(parts[0]);
      const rawUsage = this._parseSmiNumber(parts[1]);
      const rawPowerDraw = this._parseSmiNumber(parts[2]);
      const rawPowerLimit = this._parseSmiNumber(parts[3]);
      const smClockMHz = this._parseSmiNumber(parts[4]);
      const smClockMaxMHz = this._parseSmiNumber(parts[5]);
      const hwThermal = this._parseSmiActive(parts[6]);
      const swThermal = this._parseSmiActive(parts[7]);
      const hwSlowdown = this._parseSmiActive(parts[8]);
      const powerCap = this._parseSmiActive(parts[9]);
      const index = this._parseSmiNumber(parts[10]) ?? i;
      const name = parts[11] && !/^\[?n\/a\]?$/i.test(parts[11]) ? parts[11] : null;
      const uuid = parts[12] && /^GPU-/i.test(parts[12]) ? parts[12] : null;
      const vendor = /nvidia/i.test(name || "") ? "nvidia" : /amd|radeon/i.test(name || "") ? "amd" : source === "windows" ? "unknown" : "nvidia";
      const windowsAdapter = source === "windows" && vendor !== "nvidia";
      const temperature = rawTemperature ?? 0;
      const usage = rawUsage ?? 0;
      const powerDraw = rawPowerDraw ?? 0;
      const powerLimit = rawPowerLimit ?? (windowsAdapter ? 0 : 120);
      return {
        vendor,
        index,
        physicalIndex: index,
        name,
        uuid,
        temperature,
        usage,
        powerDraw,
        powerLimit,
        throttle: this._buildThrottle({
          hwThermal,
          swThermal,
          hwSlowdown,
          powerCap,
          smClockMHz,
          smClockMaxMHz,
        }),
        metricAvailability: {
          temperature: !windowsAdapter && rawTemperature != null,
          usage: rawUsage != null,
          powerDraw: !windowsAdapter && rawPowerDraw != null,
          // NVIDIA keeps the historical 120 W default for an N/A limit (GB10),
          // so the limit stays shown; only non-NVIDIA adapters report honestly.
          powerLimit: !windowsAdapter && (vendor === "nvidia" || rawPowerLimit != null),
          vramUsed: !windowsAdapter,
          vramTotal: !windowsAdapter,
        },
      };
    });
  }

  /**
   * Fold per-GPU readings into the single `gpu` object the rest of the app
   * consumes: hottest temperature, busiest card's usage, summed power, and
   * the throttle state of the first card that is actually throttling.
   * A one-GPU box (every DGX Spark) is unchanged by this.
   */
  _aggregateGpuDevices(devices) {
    if (!devices.length) {
      return {
        temperature: 0,
        usage: 0,
        powerDraw: 0,
        powerLimit: 120,
        throttle: this._defaultThrottle(),
        metricAvailability: Object.fromEntries(AMD_GPU_FIELDS.map((field) => [field, false])),
      };
    }
    const worst = devices.find((d) => d.throttle?.active) ?? devices[0];
    const round2 = (n) => Math.round(n * 100) / 100;
    const available = (d, field) => d.metricAvailability?.[field] !== false;
    const temps = devices.filter((d) => available(d, "temperature")).map((d) => d.temperature);
    const usages = devices.filter((d) => available(d, "usage")).map((d) => d.usage);
    const draws = devices.filter((d) => available(d, "powerDraw")).map((d) => d.powerDraw);
    const limits = devices.filter((d) => available(d, "powerLimit")).map((d) => d.powerLimit);
    return {
      temperature: temps.length ? Math.max(...temps) : 0,
      usage: usages.length ? Math.max(...usages) : 0,
      powerDraw: round2(draws.reduce((sum, n) => sum + n, 0)),
      powerLimit: round2(limits.reduce((sum, n) => sum + n, 0)),
      throttle: worst.throttle,
      metricAvailability: Object.fromEntries(AMD_GPU_FIELDS.map((field) => [field, devices.some((d) => available(d, field))])),
    };
  }

  /** Aggregate view of `--query-gpu` output (all GPUs folded into one). */
  _parseGpuLine(output) {
    return this._aggregateGpuDevices(this._parseGpuLines(output));
  }

  /** Parse `--query-gpu=memory.used,memory.total` — one line per GPU; N/A → null. */
  _parseVramLines(output) {
    return String(output ?? "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(",").map((s) => s.trim());
        return { used: this._parseSmiNumber(parts[0]), total: this._parseSmiNumber(parts[1]) };
      });
  }

  /** Sum per-GPU VRAM; stays null when no card reported a number (GB10 says N/A). */
  _sumVram(perDevice) {
    let used = null;
    let total = null;
    for (const d of perDevice) {
      if (d.used != null) used = (used ?? 0) + d.used;
      if (d.total != null) total = (total ?? 0) + d.total;
    }
    return { used, total };
  }

  /**
   * Cache key for a compute app. One PID can hold memory on several GPUs
   * (llama.cpp with a layer split does), so the key carries the GPU uuid.
   */
  _computeAppKey(app) {
    return app.gpuUuid ? `${app.pid}:${app.gpuUuid}` : String(app.pid);
  }

  /** Flatten the compute-apps cache back into a list. */
  _cachedApps() {
    return Array.from(this.nvidiaComputeAppsCache.entries()).map(([key, info]) => ({
      pid: info.pid ?? parseInt(String(key), 10) ?? 0,
      name: info.name,
      vramMB: info.vramMB || 0,
      gpuUuid: info.gpuUuid ?? null,
    }));
  }

  /** Top processes by VRAM, merged per PID across GPUs (sorted descending). */
  _topProcesses(apps, limit = 5) {
    const byPid = new Map();
    for (const app of apps) {
      const cur = byPid.get(app.pid);
      if (cur) cur.vramMB += app.vramMB;
      else byPid.set(app.pid, { pid: app.pid, name: app.name, vramMB: app.vramMB });
    }
    return Array.from(byPid.values())
      .sort((a, b) => b.vramMB - a.vramMB)
      .slice(0, limit);
  }

  /**
   * Per-GPU metrics for multi-card hosts. `perDeviceVram` lines are in the same
   * order as `devices` (nvidia-smi prints both by index). When a card reports
   * no memory numbers (unified-memory GB10) it inherits the aggregate `vram`.
   */
  _buildGpuDevices(devices, perDeviceVram, apps, aggregateVram) {
    return devices.map((d, i) => {
      const own = d.uuid ? apps.filter((a) => a.gpuUuid === d.uuid) : [];
      const mem = perDeviceVram[i] ?? { used: null, total: null };
      let vram;
      if (mem.total == null || devices.length === 1) {
        vram = { ...aggregateVram };
      } else {
        let used = mem.used;
        if ((used == null || used === 0) && own.length) {
          used = own.reduce((sum, a) => sum + a.vramMB, 0);
        }
        const usedMB = Math.round(used || 0);
        const totalMB = Math.round(mem.total);
        vram = {
          used: usedMB,
          total: totalMB,
          percentage: totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : 0,
          available: Math.max(0, totalMB - usedMB),
        };
      }
      return {
        vendor: d.vendor ?? "nvidia",
        index: d.index,
        name: d.name,
        uuid: d.uuid,
        temperature: d.temperature,
        usage: d.usage,
        power: { draw: d.powerDraw, limit: d.powerLimit },
        vram,
        throttle: d.throttle,
        processes: this._topProcesses(own),
        metricAvailability: d.metricAvailability,
      };
    });
  }

  /** Parse nvidia-smi Active / Not Active fields. */
  _parseSmiActive(value) {
    if (value == null) return false;
    const t = String(value).trim();
    if (!t || /^\[?n\/a\]?$/i.test(t)) return false;
    if (/^not\s*active$/i.test(t)) return false;
    if (/^active$/i.test(t)) return true;
    // Bitmask form (rare with this query): non-zero means active
    if (/^0x[0-9a-f]+$/i.test(t)) return BigInt(t) !== 0n;
    const n = parseInt(t, 10);
    if (Number.isFinite(n)) return n !== 0;
    return false;
  }

  /**
   * @param {{
   *   hwThermal?: boolean,
   *   swThermal?: boolean,
   *   hwSlowdown?: boolean,
   *   powerCap?: boolean,
   *   smClockMHz?: number | null,
   *   smClockMaxMHz?: number | null,
   * }} flags
   */
  _buildThrottle(flags = {}) {
    const hwThermal = Boolean(flags.hwThermal);
    const swThermal = Boolean(flags.swThermal);
    const hwSlowdown = Boolean(flags.hwSlowdown);
    const powerCap = Boolean(flags.powerCap);
    const thermal = hwThermal || swThermal;
    const active = thermal || hwSlowdown || powerCap;
    /** @type {"ok" | "thermal" | "power" | "hw" | "unknown"} */
    let reason = "ok";
    if (thermal) reason = "thermal";
    else if (powerCap) reason = "power";
    else if (hwSlowdown) reason = "hw";

    const smClockMHz =
      flags.smClockMHz != null && Number.isFinite(flags.smClockMHz)
        ? Math.round(flags.smClockMHz)
        : null;
    const smClockMaxMHz =
      flags.smClockMaxMHz != null && Number.isFinite(flags.smClockMaxMHz)
        ? Math.round(flags.smClockMaxMHz)
        : null;
    const smClockPct =
      smClockMHz != null && smClockMaxMHz != null && smClockMaxMHz > 0
        ? Math.min(100, Math.round((smClockMHz / smClockMaxMHz) * 1000) / 10)
        : null;

    const details = [];
    if (hwThermal) details.push("HW thermal slowdown");
    if (swThermal) details.push("SW thermal slowdown");
    if (powerCap) details.push("SW power cap");
    if (hwSlowdown && !hwThermal) details.push("HW slowdown");

    return {
      thermal,
      hwSlowdown,
      powerCap,
      active,
      reason,
      smClockMHz,
      smClockMaxMHz,
      smClockPct,
      clockCapMHz: null,
      detail: details.length ? details.join(" · ") : "Clocks not limited",
    };
  }

  /** Stamp a `nvidia-smi -lgc` cap (MHz or null) onto each device's throttle. */
  _applyClockCap(devices, capMHz) {
    if (capMHz == null) return;
    for (const d of devices) {
      if (!d.throttle) continue;
      d.throttle.clockCapMHz = capMHz;
      const note = `Clock locked ≤ ${capMHz} MHz`;
      d.throttle.detail =
        d.throttle.detail === "Clocks not limited" ? note : `${d.throttle.detail} · ${note}`;
    }
  }

  /**
   * Local-host twin of CLOCK_CAP_CMD: read the marker and boot_id directly.
   * In Docker the marker lives on the host, so the host root mount is tried too.
   */
  async _readLocalClockCap({ root = HOST_PATHS.ROOT, own = true } = {}) {
    const home = process.env.HOME || "";
    const user = String(this.spark?.ssh?.user || "");
    const files = own ? CLOCK_CAP_FILES.map((f) => f.replace("$HOME", home)) : [];
    if (root) {
      files.push(path.join(root, "run/sparkdash/gpu-clock-cap"));
      if (/^[a-z_][a-z0-9_-]{0,31}$/i.test(user)) {
        files.push(path.join(root, "home", user, ".config/sparkdash/gpu-clock-cap"));
      }
    }
    let marker = "";
    for (const f of files) {
      try {
        marker = (await fs.promises.readFile(f, "utf8")).split("\n")[0];
        if (marker.trim()) break;
      } catch {}
    }
    if (!marker.trim()) return null;
    let boot = "";
    try {
      boot = await fs.promises.readFile("/proc/sys/kernel/random/boot_id", "utf8");
    } catch {}
    return parseClockCap(`${marker}\n${boot}`);
  }

  _defaultThrottle() {
    return this._buildThrottle();
  }

  _parseComputeApps(output) {
    const lines = output.trim().split("\n").filter(Boolean);
    return lines
      .map((line) => {
        const parts = line.split(",").map((s) => s.trim());
        // Format: pid,process_name,used_gpu_memory[,gpu_uuid]. The name may be a whole command line with
        // commas of its own (--enable-features=A,B), so the other fields are read from both ends.
        const gpuUuid = parts.length >= 4 && /^GPU-/i.test(parts[parts.length - 1]) ? parts[parts.length - 1] : null;
        const memIndex = parts.length - (gpuUuid ? 2 : 1);
        return {
          pid: parseInt(parts[0]) || 0,
          name: parts.slice(1, Math.max(memIndex, 2)).join(",") || "unknown",
          vramMB: memIndex >= 2 ? this._parseSmiNumber(parts[memIndex]) || 0 : 0,
          gpuUuid,
        };
      })
      .filter((a) => a.pid > 0);
  }

  _parseMemTotal(output) {
    const match = output.match(/MemTotal:\s+(\d+)\s+kB/);
    return match ? parseInt(match[1]) : 0;
  }

  /** OS-visible unified pool size + available, in MB (one read of /proc/meminfo). */
  async _readMeminfoMB() {
    try {
      const raw = await this._readHostFile("/proc/meminfo");
      const totalKB = this._parseMemTotal(raw);
      const availMatch = raw.match(/MemAvailable:\s+(\d+)\s+kB/);
      const availKB = availMatch ? parseInt(availMatch[1]) : 0;
      const result = {
        totalMB: totalKB > 0 ? Math.round(totalKB / 1024) : 0,
        availMB: availKB > 0 ? Math.round(availKB / 1024) : 0,
      };
      return result;
    } catch (err) {
      console.error(`[SystemCollector] Failed to read /proc/meminfo:`, String(err));
      return { totalMB: 0, availMB: 0 };
    }
  }

  // ─── CPU helpers ──────────────────────────────────────────
  async _getCPUUsage() {
    const raw = await this._readHostFile("/proc/stat");
    return this._parseCPUUsage(raw);
  }

  _parseCPUUsage(raw) {
    const lines = raw.split("\n");
    const cpuLine = lines.find((l) => l.startsWith("cpu "));
    if (!cpuLine) return { total: 0, used: 0 };
    const parts = cpuLine.split(/\s+/).slice(1).map(Number);
    const [user, nice, system, idle, iowait, irq, softirq, steal] = parts;
    const total = user + nice + system + idle + iowait + irq + softirq + steal;
    const used = total - idle - iowait;
    return { total, used };
  }

  /**
   * Sensor names that really are the CPU package, in preference order. Everything
   * else (acpitz and friends) is a board or SoC thermal zone: worth showing, not
   * worth calling "CPU" (#142).
   */
  _isCpuSensorName(name) {
    return ["coretemp", "k10temp", "zenpower", "x86_pkg_temp", "cpu-thermal", "cpu0-thermal"].includes(
      String(name || "").toLowerCase()
    );
  }

  /**
   * What to call a non-CPU sensor: `acpitz` on a GB10 is the ACPI SoC zone, and
   * saying "CPU" there is a ~15 °C lie. Unknown names label themselves.
   */
  _cpuTempSourceLabel(source) {
    const name = String(source || "").toLowerCase();
    if (!name) return null;
    if (this._isCpuSensorName(name)) return "CPU";
    if (name === "acpitz") return "ACPI";
    if (name === "soc_thermal" || name === "soc-thermal") return "SoC";
    return source;
  }

  /**
   * Pick the CPU temperature from named candidates, in order.
   *
   * A real CPU sensor always wins, wherever it appears in the order; otherwise
   * the first plausible reading is used with its own name as the label. The
   * reading is never dropped just because no CPU sensor exists — a board zone is
   * still a temperature, it just is not the CPU's.
   *
   * @param {Array<{ source: string | null, millidegrees: number }>} candidates
   * @returns {{ temperature: number, temperatureLabel: string | null, temperatureSource: string | null }}
   */
  _pickCpuTemperature(candidates) {
    const plausible = (candidates || []).filter(
      (c) => Number.isFinite(c?.millidegrees) && c.millidegrees > 0 && c.millidegrees < 200000
    );
    if (plausible.length === 0) {
      return { temperature: 0, temperatureLabel: null, temperatureSource: null };
    }
    const cpu = plausible.find((c) => this._isCpuSensorName(c.source));
    const chosen = cpu || plausible[0];
    return {
      temperature: Math.round((chosen.millidegrees / 1000) * 10) / 10,
      temperatureLabel: cpu ? "CPU" : this._cpuTempSourceLabel(chosen.source),
      temperatureSource: chosen.source || null,
    };
  }

  /** Local sensor candidates: hwmon chips by allowlist, then thermal zones. */
  _localCpuTempCandidates() {
    const candidates = [];
    try {
      const hwmonDir = path.join(HOST_PATHS.SYS, "class/hwmon");
      if (fs.existsSync(hwmonDir)) {
        for (const entry of fs.readdirSync(hwmonDir)) {
          const nameFile = path.join(hwmonDir, entry, "name");
          if (!fs.existsSync(nameFile)) continue;
          const name = fs.readFileSync(nameFile, "utf-8").trim();
          // GB10 also exposes nvme/mlx5 sensors; the allowlist keeps those out.
          if (!["coretemp", "k10temp", "zenpower", "acpitz", "soc_thermal"].includes(name)) continue;
          const dir = path.join(hwmonDir, entry);
          const tempFile = fs
            .readdirSync(dir)
            .filter((f) => f.startsWith("temp") && f.endsWith("_input"))
            .sort()[0];
          if (!tempFile) continue;
          const millidegrees = parseInt(fs.readFileSync(path.join(dir, tempFile), "utf-8").trim());
          candidates.push({ source: name, millidegrees });
        }
      }
    } catch {
      /* fall through to thermal zones */
    }
    try {
      const thermalDir = path.join(HOST_PATHS.SYS, "class/thermal");
      if (fs.existsSync(thermalDir)) {
        const zones = fs.readdirSync(thermalDir).filter((z) => z.startsWith("thermal_zone"));
        for (const zone of zones) {
          const dir = path.join(thermalDir, zone);
          const tempFile = path.join(dir, "temp");
          if (!fs.existsSync(tempFile)) continue;
          let type = null;
          try {
            type = fs.readFileSync(path.join(dir, "type"), "utf-8").trim() || null;
          } catch {
            /* type is optional */
          }
          candidates.push({
            source: type,
            millidegrees: parseInt(fs.readFileSync(tempFile, "utf-8").trim()),
          });
        }
      }
    } catch {
      /* nothing readable */
    }
    return candidates;
  }

  /** @returns {Promise<{ temperature: number, temperatureLabel: string | null, temperatureSource: string | null }>} */
  async _getCPUTemperatureReading() {
    return this._pickCpuTemperature(this._localCpuTempCandidates());
  }

  /** Backwards-compatible number-only view of the reading. */
  async _getCPUTemperature() {
    return (await this._getCPUTemperatureReading()).temperature;
  }

  /**
   * Resolve and cache whether this host reports an ARM/Neoverse-compatible
   * CPU. `/proc/cpuinfo` is static during a process lifetime, so we read it
   * once instead of on every poll (the previous implementation did a host
   * read on every `_getCPUPower` call — once per CPU poll per Spark).
   * @returns {Promise<boolean>}
   */
  async _isArm() {
    if (this._isArmCached !== null) return this._isArmCached;
    try {
      const cpuinfo = await this._readHostFile("/proc/cpuinfo");
      this._isArmCached = /CPU architecture:\s*[89]|aarch64|ARMv[89]|armv[89]/i.test(cpuinfo);
    } catch {
      this._isArmCached = false;
    }
    return this._isArmCached;
  }

  /**
   * Estimate CPU power draw from a usage fraction (0–1).
   *
   * `usageFraction` is the CPU usage measured at the caller's `/proc/stat` read
   * — compute it once and pass it here to avoid racing `lastCpuStat` (the
   * earlier implementation re-read `/proc/stat` in parallel with `collectCpu()`
   * and produced an idle reading on the first poll).
   *
   * ARM/Neoverse chips use the GB10 65W TDP. Non-ARM hosts fall back to the
   * generic 185W TDP — never 0/0, which previously rendered the panel as
   * "0W / 0W", indistinguishable from "no CPU present."
   *
   * @param {number} [usageFraction]  0–1 CPU usage fraction. Omitted == use the
   *   last measured percentage (used by GPU system-draw estimate).
   */
  async _getCPUPower(usageFraction) {
    const isArm = await this._isArm();
    const tdp = isArm ? 65 : HARDWARE_DEFAULTS.CPU_TDP_FALLBACK;
    let frac = typeof usageFraction === "number" ? usageFraction : this.lastCpuUsagePct / 100;
    if (!Number.isFinite(frac) || frac < 0) frac = 0;
    const idleWatts = tdp * 0.08;
    const draw = idleWatts + (tdp - idleWatts) * Math.min(frac, 1);
    return { draw: Math.round(draw * 10) / 10, tdp: Math.round(tdp) };
  }

  // ─── RAM helpers ─────────────────────────────────────────
  async _getRamUsage() {
    const raw = await this._readHostFile("/proc/meminfo");
    const totalKB = this._parseMemTotal(raw);
    const availMatch = raw.match(/MemAvailable:\s+(\d+)\s+kB/);
    const availKB = availMatch ? parseInt(availMatch[1]) : 0;
    const usedKB = totalKB - availKB;
    return {
      used: Math.round(usedKB / 1024),
      total: Math.round(totalKB / 1024),
      percentage: totalKB > 0 ? Math.round((usedKB / totalKB) * 100) : 0,
    };
  }

  // ─── Storage helpers ──────────────────────────────────────
  async _getDiskUsage() {
    // Prefer host mount namespace so lsblk returns real host paths (/, /mnt)
    // rather than container bind views (/host/root, /host/root/mnt).
    let output = "";
    try {
      output = await this._execOnHost("lsblk -P -no NAME,SIZE,MOUNTPOINT,FSTYPE 2>/dev/null");
    } catch {
      // Container lsblk fails outright (rootless /sys lacks /sys/dev/block),
      // so chroot into the bind-mounted host root — same mount table, so
      // /sys and /proc there are the host's and lsblk works.
      try {
        if (fs.existsSync(HOST_PATHS.ROOT)) {
          output = await this._exec(
            `chroot ${HOST_PATHS.ROOT} lsblk -P -no NAME,SIZE,MOUNTPOINT,FSTYPE 2>/dev/null`
          );
        }
      } catch {}
      if (!output.trim()) {
        output = await this._exec("lsblk -P -no NAME,SIZE,MOUNTPOINT,FSTYPE 2>/dev/null").catch(() => "");
      }
    }
    const lines = output.trim().split("\n").filter(Boolean);
    const disks = [];
    const disabledDevices = this.spark.disabledDevices || [];
    const PSEUDO = new Set(["tmpfs", "devtmpfs", "proc", "sysfs", "efivarfs", "squashfs", "overlay", "devpts", "cgroup", "cgroup2"]);

    for (const line of lines) {
      const nameMatch = line.match(/NAME="([^"]*)"/);
      const mountMatch = line.match(/MOUNTPOINT="([^"]*)"/);
      const fstypeMatch = line.match(/FSTYPE="([^"]*)"/);
      if (!nameMatch || !mountMatch) continue;
      const name = nameMatch[1];
      const mount = mountMatch[1];
      const fstype = (fstypeMatch?.[1] || "").toLowerCase();
      if (!mount) continue;
      if (/^loop|^sr/.test(name)) continue;
      if (mount.includes("/boot/efi") || mount.includes("/snap/")) continue;
      if (PSEUDO.has(fstype)) continue;

      const displayMount = this._displayMountLabel(mount);
      const isDisabled =
        disabledDevices.includes(name) ||
        disabledDevices.includes(mount) ||
        disabledDevices.includes(displayMount);

      try {
        const diskPath = this._resolveDiskPath(mount);
        const stat = await this._statfs(diskPath);
        const total = stat.blocks * stat.bsize;
        const used = (stat.blocks - stat.bfree) * stat.bsize;
        const available = stat.bavail * stat.bsize;
        const percentage = used + available > 0 ? Math.round((used / (used + available)) * 100) : 0;

        // Get disk I/O speeds from /sys/block/<dev>/stat
        const parentDev = this._blockParentDevice(name);
        const io = await this._getDiskIO(parentDev);

        disks.push({
          device: name,
          label: displayMount,
          used: Math.round(used / 1024 / 1024),
          total: Math.round(total / 1024 / 1024),
          available: Math.round(available / 1024 / 1024),
          percentage,
          readSpeed: io.readSpeed,
          writeSpeed: io.writeSpeed,
          disabled: isDisabled,
        });
      } catch (err) {
        console.warn(
          `[SystemCollector] statfs failed for ${this.spark.id} mount=${mount} path=${this._resolveDiskPath(mount)}: ${err.message}`
        );
      }
    }

    return disks;
  }

  /**
   * Map partition/device name to /sys/block parent.
   * nvme0n1p2 → nvme0n1; nvme0n1 → nvme0n1; sdb1 → sdb; mmcblk0p1 → mmcblk0
   */
  _blockParentDevice(name) {
    if (/^nvme\d+n\d+p\d+$/.test(name)) return name.replace(/p\d+$/, "");
    if (/^nvme\d+n\d+$/.test(name)) return name;
    if (/^mmcblk\d+p\d+$/.test(name)) return name.replace(/p\d+$/, "");
    if (/^mmcblk\d+$/.test(name)) return name;
    // SCSI / virtio / sd*: strip trailing partition digits
    if (/^[a-z]+[a-z0-9]*\d+$/i.test(name)) return name.replace(/\d+$/, "");
    return name;
  }

  /** Read host cron-written GPU memory file (path from config / env). */
  _readGpuMemoryFile() {
    return this._readGpuMemoryFileFull().used;
  }

  _readGpuMemoryFileFull() {
    try {
      if (fs.existsSync(GPU_MEMORY_JSON_PATH)) {
        const memData = JSON.parse(fs.readFileSync(GPU_MEMORY_JSON_PATH, "utf-8"));
        const used = this._parseSmiNumber(memData.used) || 0;
        const total = this._parseSmiNumber(memData.total) || 0;
        const processes = Array.isArray(memData.processes) ? memData.processes : [];
        return { used, total, processes };
      }
    } catch (err) {
      console.warn(`[SystemCollector] gpu-memory.json read failed: ${err.message}`);
    }
    return { used: 0, total: 0, processes: [] };
  }

  /** Map container-visible mount to a host path for statfs. */
  _resolveDiskPath(mount) {
    const root = HOST_PATHS.ROOT;
    const rootMounted = fs.existsSync(root);

    // Already under host root bind (e.g. /host/root or /host/root/mnt)
    if (rootMounted && (mount === root || mount.startsWith(root + "/"))) {
      return mount;
    }

    if (!rootMounted) return mount;

    // Host-style absolute path from nsenter lsblk
    if (mount === "/") return root;
    if (mount.startsWith("/")) return path.join(root, mount.slice(1));
    return path.join(root, mount);
  }

  /** Prefer host-style labels in the UI when mounts are under /host/root. */
  _displayMountLabel(mount) {
    const root = HOST_PATHS.ROOT;
    if (mount === root) return "/";
    if (mount.startsWith(root + "/")) {
      const rest = mount.slice(root.length);
      return rest || "/";
    }
    return mount;
  }

  /**
   * Bytes/s read and written by a block device since its previous sample, from cumulative
   * counters: sectors of 512 bytes from /sys/block/<dev>/stat, or bytes (`unit` 1) on Windows.
   * The first sample of a device has nothing to compare with and reads 0.
   */
  _diskRate(dev, sectorsRead, sectorsWritten, now = Date.now(), unit = 512) {
    const last = this.lastDiskIO.get(dev);
    // Several mounts on one disk are read back to back within a poll: a second sample a few
    // milliseconds after the first would show 0, so they share the first one's rate.
    if (last && now - last.time >= 0 && now - last.time < DISK_RATE_MIN_WINDOW_MS) return last.rate;
    let rate = { readSpeed: 0, writeSpeed: 0 };
    if (last && now > last.time) {
      const dtMs = now - last.time;
      const per = (cur, prev) => Math.max(0, Math.round((((cur - prev) * unit) / dtMs) * 1000));
      rate = {
        readSpeed: per(sectorsRead, last.sectorsRead),
        writeSpeed: per(sectorsWritten, last.sectorsWritten),
      };
    }
    this.lastDiskIO.set(dev, { sectorsRead, sectorsWritten, time: now, rate });
    return rate;
  }

  /** Get disk I/O speeds from /sys/block/<dev>/stat */
  async _getDiskIO(dev) {
    try {
      const sysPath = fs.existsSync(HOST_PATHS.SYS)
        ? path.join(HOST_PATHS.SYS, "block", dev, "stat")
        : path.join("/sys/block", dev, "stat");
      const raw = fs.readFileSync(sysPath, "utf-8").trim();
      const fields = raw.split(/\s+/);
      return this._diskRate(dev, parseInt(fields[2]) || 0, parseInt(fields[6]) || 0);
    } catch {
      return { readSpeed: 0, writeSpeed: 0 };
    }
  }

  // ─── Network helpers ─────────────────────────────────────
  async _getNetworkMetrics() {
    // /proc/net is netns-local; must use host netns inside Docker
    const raw = await this._readHostNetFile("dev");
    const lines = raw.split("\n").slice(2);
    const now = Date.now();
    const interfaces = [];

    // Collect IPs for all interfaces in one shot
    const ipMap = await this._getInterfaceIpMap();

    for (const line of lines) {
      const parts = line.trim().split(/[\s:]+/);
      if (parts.length < 17) continue;
      const iface = parts[0];
      if (this._isVirtualNetworkInterface(iface)) continue;
      const rxBytes = parseInt(parts[1]) || 0;
      const txBytes = parseInt(parts[9]) || 0;
      const last = this.lastNetworkStats.get(iface) || { rxBytes, txBytes, time: now };
      const dtSec = (now - last.time) / 1000;
      const rxSpeed = dtSec > 0 ? (rxBytes - last.rxBytes) / dtSec : 0;
      const txSpeed = dtSec > 0 ? (txBytes - last.txBytes) / dtSec : 0;
      this.lastNetworkStats.set(iface, { rxBytes, txBytes, time: now });
      interfaces.push({
        name: iface,
        rxSpeed: Math.max(0, Math.round(rxSpeed)),
        txSpeed: Math.max(0, Math.round(txSpeed)),
        ip: ipMap.get(iface) || null,
        operstate: await this._getInterfaceOperstate(iface),
        disabled: false,
      });
    }

    return interfaces;
  }

  /** Build a map of interface name → IPv4 address from `ip -4 addr show` in the host netns. */
  async _getInterfaceIpMap() {
    const map = new Map();
    try {
      const output = await this._execOnHostNet("ip -4 addr show 2>/dev/null");
      // Parse blocks like:
      // 2: enP7s7: <BROADCAST,MULTICAST,UP> mtu 1500
      //     inet 192.168.1.143/24 brd 192.168.1.255 scope global enP7s7
      const blocks = output.split(/\n(?=\d+:\s+)/);
      for (const block of blocks) {
        const first = block.split("\n")[0];
        const m = first.match(/^\d+:\s+(\S+):/);
        if (!m) continue;
        const iface = m[1];
        const ipMatch = block.match(/inet\s+([\d.]+)/);
        if (ipMatch) {
          map.set(iface, ipMatch[1]);
        }
      }
    } catch {
      // IP collection is optional
    }
    return map;
  }

  /** Run a command in the host mount + network namespaces so we see host interfaces and IPs. */
  _execOnHostNet(cmd, opts = {}) {
    return this._execHostNs(cmd, { ...opts, net: true });
  }

  /** Read operstate for an interface from sysfs. */
  async _getInterfaceOperstate(iface) {
    try {
      const raw = await this._readHostFile(`/sys/class/net/${iface}/operstate`);
      return raw.trim().toLowerCase();
    } catch {
      return "unknown";
    }
  }

  /**
   * MAC of the Spark LAN NIC used for Wake-on-LAN (enP7s7).
   * @returns {Promise<string | null>}
   */
  async _getWolInterfaceMac() {
    try {
      const raw = await this._readHostFile(`/sys/class/net/${WOL_INTERFACE}/address`);
      return normalizeMac(raw);
    } catch {
      return null;
    }
  }

  /** Mark interfaces listed in spark.disabledInterfaces (still returned for Settings). */
  _tagDisabledInterfaces(interfaces) {
    const disabled = this.spark.disabledInterfaces || [];
    return interfaces.map((iface) => ({
      ...iface,
      disabled: disabled.includes(iface.name),
    }));
  }

  _isVirtualNetworkInterface(name) {
    // Keep physical IB/Ethernet (ib0, ibp*, enP*, enp*); drop clear virtual prefixes only
    return /^(lo|docker|br-|veth|virbr|zt|tun|wg|tailscale)/.test(name);
  }

  async _getDefaultNetworkInterface() {
    try {
      const raw = await this._readHostNetFile("route");
      const lines = raw.split("\n");
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 11 && parts[1] === "00000000" && (parseInt(parts[3], 16) & 1)) {
          return parts[0];
        }
      }
    } catch {}
    // Fallback: first non-virtual
    try {
      const raw = await this._readHostNetFile("dev");
      const lines = raw.split("\n").slice(2);
      for (const line of lines) {
        const parts = line.trim().split(/[\s:]+/);
        if (parts.length >= 1 && !this._isVirtualNetworkInterface(parts[0])) {
          return parts[0];
        }
      }
    } catch {}
    return null;
  }

  async _getNetworkLinkSpeedMbps(iface) {
    try {
      const speedFile = path.join(HOST_PATHS.SYS, "class/net", iface, "speed");
      const raw = fs.readFileSync(speedFile, "utf-8").trim();
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }

  // ─── Unified memory helpers ───────────────────────────────
  async _getUnifiedMemory() {
    const raw = await this._readHostFile("/proc/meminfo");
    const totalKB = this._parseMemTotal(raw);
    const totalMB = Math.round(totalKB / 1024);

    // GPU-allocated memory: prefer live compute-apps cache (filled by GPU poll),
    // then host cron file as backup when the container cannot see host PIDs.
    let gpuUsedMB = 0;
    if (this.nvidiaComputeAppsCache.size > 0) {
      gpuUsedMB = Math.round(
        [...this.nvidiaComputeAppsCache.values()].reduce((a, b) => a + (b.vramMB || 0), 0)
      );
    }
    if (gpuUsedMB === 0) {
      gpuUsedMB = this._readGpuMemoryFile();
    }

    // CPU memory = total - available - GPU (since GPU is part of unified pool)
    const availMatch = raw.match(/MemAvailable:\s+(\d+)\s+kB/);
    const availKB = availMatch ? parseInt(availMatch[1]) : 0;
    const systemUsedKB = totalKB - availKB;
    const cpuUsedKB = Math.max(0, systemUsedKB - (gpuUsedMB * 1024));
    const cpuUsedMB = Math.round(cpuUsedKB / 1024);

    // Total used = GPU + CPU (but GPU is the main component)
    const usedMB = gpuUsedMB + cpuUsedMB;
    const percentage = totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : 0;
    const oomRisk = percentage > 85 ? "high" : percentage > 60 ? "medium" : "low";

    // Memory bandwidth (nvidia-smi dmon) — host namespaces when in Docker
    let bandwidth = { current: 0, peak: 400 };
    try {
      const dmonOut = await this._nvidiaSmi("dmon -c 1 -d 1 -s B");
      const dmonLines = dmonOut.trim().split("\n").filter((l) => !l.startsWith("#") && l.trim());
      if (dmonLines.length > 0) {
        const parts = dmonLines[dmonLines.length - 1].split(/\s+/);
        const readMBs = parseFloat(parts[2]) || 0;
        const writeMBs = parseFloat(parts[3]) || 0;
        const totalGBs = (readMBs + writeMBs) / 1024;
        bandwidth = { current: Math.round(totalGBs * 100) / 100, peak: 400 };
      }
    } catch {}

    return {
      total: totalMB,
      gpuUsed: gpuUsedMB,
      cpuUsed: usedMB - gpuUsedMB,
      used: usedMB,
      available: Math.round(availKB / 1024),
      percentage,
      oomRisk,
      bandwidth,
    };
  }

  // ─── Remote collection via SSH ────────────────────────────
  async _getRemoteGpu(executor = sshExec) {
    try {
      const vramRead = this._intelVram.stale;
      const cmd = [
        "if command -v nvidia-smi >/dev/null 2>&1; then printf '\\n__NVIDIA__\\n'; nvidia-smi --query-gpu=temperature.gpu,utilization.gpu,power.draw,power.limit,clocks.current.sm,clocks.max.sm,clocks_throttle_reasons.hw_thermal_slowdown,clocks_throttle_reasons.sw_thermal_slowdown,clocks_throttle_reasons.hw_slowdown,clocks_throttle_reasons.sw_power_cap,index,name,uuid --format=csv,noheader,nounits 2>/dev/null; printf '\\n__NVIDIA_VRAM__\\n'; nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null; printf '\\n__NVIDIA_APPS__\\n'; nvidia-smi --query-compute-apps=pid,process_name,used_gpu_memory,gpu_uuid --format=csv,noheader,nounits 2>/dev/null; fi",
        `${AMD_SMI_RESOLVER}; if [ -n "$amd_smi" ]; then printf '\\n__AMD__\\n'; "$amd_smi" metric -u -p -m -t --json 2>/dev/null; printf '\\n__AMD_LIMITS__\\n'; "$amd_smi" static -l --json 2>/dev/null; fi`,
        `printf '\\n__INTEL__\\n'; ${buildIntelProbeScript({ sudo: this._intelSudo.allowed && getSettings().intelVramSudo, vram: vramRead })}`,
        "printf '\\n__MEMINFO__\\n'; grep -E 'MemTotal|MemAvailable' /proc/meminfo 2>/dev/null",
        `printf '\\n__CLOCK_CAP__\\n'; ${CLOCK_CAP_CMD}`,
      ].join("; ");

      const output = await executor(this.spark, cmd);
      const sections = splitRemoteGpuSections(output);
      const section = (name) => sections[name] ?? "";
      const gpuOut = section("NVIDIA");
      const memFields = section("NVIDIA_VRAM");
      const computeOut = section("NVIDIA_APPS");
      const amdMetrics = section("AMD");
      const amdLimits = section("AMD_LIMITS");
      const intelOut = section("INTEL");
      const meminfoOut = section("MEMINFO");
      // Keep compatibility with existing injected executor fixtures and older command results.
      const legacy = !("MEMINFO" in sections);
      const legacySections = legacy ? String(output).split("---") : [];
      const resolvedMeminfo = legacy ? (legacySections[3] || "").trim() : meminfoOut;
      const clockCapOut = section("CLOCK_CAP");
      const cliDevices = this._parseGpuLines(legacy ? (legacySections[0] || "") : gpuOut, {
        source: this.isWindows ? "windows" : "nvidia",
      });
      this._applyClockCap(cliDevices, parseClockCap(clockCapOut));
      const perDeviceVram = this._parseVramLines(legacy ? (legacySections[1] || "") : memFields);
      const apps = this._parseComputeApps(legacy ? (legacySections[2] || "") : computeOut);
      const amdDevices = legacy ? [] : parseAmdSmiMetrics(amdMetrics, amdLimits)
        .map((device) => ({ ...device, index: AMD_GPU_INDEX_OFFSET + device.index }));
      // Probe output only exists in the section format; legacy fixtures carry no Intel data.
      const intelDevices = this._intelDevices(this._sampleIntel(legacy ? "" : intelOut, vramRead));
      const otherDevices = [...amdDevices, ...intelDevices];
      // The NVIDIA section is only printed when nvidia-smi is installed. Installed but no devices,
      // next to an Intel card, means a broken NVIDIA side, not an Intel-only host.
      const nvidiaFailed = !legacy && "NVIDIA" in sections && cliDevices.length === 0 && intelDevices.length > 0;
      const gpuDevices = [...cliDevices, ...otherDevices];
      const gpu = this._aggregateGpuDevices(gpuDevices);
      if (!gpuDevices.length) return this._defaultGpu();
      let { used: cliUsed, total: cliTotal } = this._sumVram(perDeviceVram);
      this.nvidiaComputeAppsCache.clear();
      let computeSum = 0;
      for (const app of apps) {
        this.nvidiaComputeAppsCache.set(this._computeAppKey(app), {
          pid: app.pid,
          name: app.name,
          vramMB: app.vramMB,
          gpuUuid: app.gpuUuid ?? null,
        });
        computeSum += app.vramMB;
      }
      if ((cliUsed == null || cliUsed === 0) && computeSum > 0) cliUsed = computeSum;

      const otherVram = this._sumDeviceVram(otherDevices);
      const cliVram = { used: cliUsed || 0, total: cliTotal || 0, available: Math.max(0, (cliTotal || 0) - (cliUsed || 0)) };
      const combinedVram = this._combineVram(cliVram, otherVram);

      // Unified-memory pool: prefer MemTotal (OS-visible) so VRAM and Unified
      // Memory panels share the same base. Available = MemAvailable (real free).
      const totalMatch = resolvedMeminfo.match(/MemTotal:\s+(\d+)\s+kB/);
      const availMatch = resolvedMeminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
      const memTotalMB = totalMatch ? Math.round(parseInt(totalMatch[1]) / 1024) : 0;
      let availableMB = availMatch ? Math.round(parseInt(availMatch[1]) / 1024) : 0;

      const usedMB = Math.round(combinedVram.used || 0);
      let totalMB = Math.round(combinedVram.total || 0);
      // GB10 shares its HBM pool with the OS. Resolve NVIDIA's N/A card memory
      // from that pool only; never fold AMD memory or host RAM into an unknown
      // discrete GPU capacity.
      let resolvedCliVram = cliVram;
      if (this.spark.kind !== "host" && cliDevices.length) {
        const resolvedTotal = memTotalMB || cliTotal || DGX_SPARK.MEMORY_HBM_SIZE_GB * 1024;
        resolvedCliVram = {
          used: Math.round(cliUsed || 0),
          total: resolvedTotal,
          available: availMatch ? availableMB : Math.max(0, resolvedTotal - Math.round(cliUsed || 0)),
        };
        totalMB = resolvedTotal + Math.round(otherVram.total || 0);
      }
      if (this.spark.kind === "host") {
        // Discrete GPU VRAM: trust vendor-reported memory. Unknown capacity
        // stays unknown instead of being replaced with system RAM or a spec.
        // Windows adapter counters include shared-memory use; when their driver
        // omits an adapter capacity, the OS-visible pool is the usable ceiling.
        if (this.isWindows && cliDevices.some((device) => device.vendor !== "nvidia") && totalMB <= 0 && memTotalMB > 0) {
          totalMB = memTotalMB;
          resolvedCliVram = { ...cliVram, total: totalMB, available: Math.max(0, totalMB - usedMB) };
        }
        availableMB = totalMB > 0 ? Math.max(0, totalMB - usedMB) : 0;
      } else {
        // GB10 shared HBM pool: prefer the OS-visible pool (MemTotal) as the total,
        // fall back to nvidia-smi, then the hardware spec (HBM) only if nothing known.
        if (cliDevices.length && memTotalMB > 0) totalMB = memTotalMB + Math.round(otherVram.total || 0);
        else if (cliDevices.length && totalMB <= 0) totalMB = DGX_SPARK.MEMORY_HBM_SIZE_GB * 1024;
        if (!cliDevices.length && otherDevices.length) availableMB = Math.round(otherVram.available || 0);
      }
      const percentage = totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : 0;

      if (this.isWindows) {
        cliDevices.forEach((device, i) => {
          device.metricAvailability = {
            ...device.metricAvailability,
            vramUsed: perDeviceVram[i]?.used != null,
            vramTotal: perDeviceVram[i]?.total > 0 || memTotalMB > 0,
          };
        });
      }

      // Rough system power estimate: GPU draw + 20W CX7/peripherals
      const systemDraw = Math.round(gpu.powerDraw + 20);

      // Top 5 GPU processes by VRAM usage (a PID spanning several GPUs is summed)
      const cachedApps = this._cachedApps();
      const processes = this._topProcesses(cachedApps);
      const vram = { used: usedMB, total: totalMB, percentage, available: availableMB };

      return markNvidiaSideFailed({
        temperature: gpu.temperature,
        usage: gpu.usage,
        power: { draw: gpu.powerDraw, limit: gpu.powerLimit, systemDraw },
        vram,
        processes,
        throttle: gpu.throttle,
        nvErrNoMemory: await this._nvErrNoMemory(),
        kernelErrors: await this._kernelErrors(),
        gpus: [
          ...this._buildGpuDevices(cliDevices, perDeviceVram, cachedApps, resolvedCliVram),
          ...otherDevices,
        ],
        vendors: [...new Set(gpuDevices.map((device) => device.vendor))],
        metricAvailability: {
          ...gpu.metricAvailability,
          vramUsed: gpuDevices.some((device) => device.metricAvailability?.vramUsed !== false),
          vramTotal: gpuDevices.some((device) => device.metricAvailability?.vramTotal !== false),
        },
      }, nvidiaFailed);
    } catch (err) {
      console.error(`[SystemCollector] Remote GPU error for ${this.spark.id}:`, err.message);
      return this._defaultGpu();
    }
  }

  /**
   * One SSH round trip: /proc/stat, CPU arch, then the same hwmon-then-thermal
   * sensor dump local `_getCPUTemperature()` uses. `|| true` on the thermal
   * glob keeps a missing zone from failing the whole CPU poll (sshExec treats
   * any non-zero exit as a hard error).
   */
  _buildRemoteCpuCommand() {
    return [
      "cat /proc/stat | head -1",
      "echo '---'",
      "cat /proc/cpuinfo | grep -E 'CPU architecture|aarch64' | head -1",
      "echo '---'",
      // GB10 also exposes nvme/mlx5 sensors; the name allowlist keeps those out.
      // Every line is "<name> <millidegrees>" so the reader can say which sensor
      // it used — an ACPI zone must not be reported as the CPU (#142).
      'for h in $(find /sys/class/hwmon -mindepth 1 -maxdepth 1 2>/dev/null | sort); do n=$(cat "$h/name" 2>/dev/null); case "$n" in coretemp|k10temp|zenpower|acpitz|soc_thermal) for t in $(find -L "$h" -mindepth 1 -maxdepth 1 -name \'temp*_input\' 2>/dev/null | sort); do v=$(cat "$t" 2>/dev/null); [ -n "$v" ] && echo "$n $v"; break; done;; esac; done',
      'for z in $(find /sys/class/thermal -maxdepth 1 -name \'thermal_zone*\' 2>/dev/null | sort); do n=$(cat "$z/type" 2>/dev/null); v=$(cat "$z/temp" 2>/dev/null); [ -n "$v" ] && echo "$n $v"; done || true',
    ].join("; ");
  }

  async _getRemoteCpu(collectionSequenceOrExecutor = null, executor = sshExec) {
    // Keep the injectable executor used by focused collector tests while also
    // accepting the lifecycle sequence supplied by collectCpu().
    const sshExecutor =
      typeof collectionSequenceOrExecutor === "function" ? collectionSequenceOrExecutor : executor;
    const attemptSequence = Number.isInteger(collectionSequenceOrExecutor)
      ? collectionSequenceOrExecutor
      : ++this._cpuCollectionSequence;
    try {
      const cmd = this._buildRemoteCpuCommand();

      const output = await sshExecutor(this.spark, cmd);
      const sections = output.split("---");
      const statOut = sections[0]?.trim() || "";
      const cpuinfoOut = sections[1]?.trim() || "";
      const tempOut = sections[2] || "";

      const cpuStat = this._parseCPUUsage(statOut);
      if (!this._isValidCpuStat(cpuStat)) {
        throw new Error("invalid remote /proc/stat CPU counters");
      }
      const totalDiff = cpuStat.total - (this.lastCpuStat?.total || cpuStat.total);
      const usedDiff = cpuStat.used - (this.lastCpuStat?.used || cpuStat.used);
      const usage = totalDiff > 0 ? Math.round((usedDiff / totalDiff) * 100) : 0;
      if (attemptSequence === this._cpuCollectionSequence) {
        this.lastCpuStat = cpuStat;
        this.lastCpuUsagePct = usage;
      }

      // ARM/Neoverse power estimation
      const isArm = /CPU architecture:\s*[89]|aarch64|ARMv[89]|armv[89]/i.test(cpuinfoOut);
      const tdp = isArm ? 65 : 185;
      const idleWatts = tdp * 0.08;
      const draw = idleWatts + (tdp - idleWatts) * Math.min(usage / 100, 1);

      const tempReading = this._pickCpuTemperature(this._parseSensorCandidates(tempOut));
      return {
        usage,
        temperature: tempReading.temperature,
        temperatureLabel: tempReading.temperatureLabel,
        temperatureSource: tempReading.temperatureSource,
        draw: Math.round(draw * 10) / 10,
        tdp: Math.round(tdp),
      };
    } catch (err) {
      console.error(`[SystemCollector] Remote CPU error for ${this.spark.id}:`, err.message);
      return this._defaultCpu();
    }
  }

  /**
   * Named sensor lines from the remote dump ("<name> <millidegrees>"), tolerating
   * a bare number from an older command shape.
   *
   * @param {string} raw
   * @returns {Array<{ source: string | null, millidegrees: number }>}
   */
  _parseSensorCandidates(raw) {
    const candidates = [];
    for (const line of String(raw).split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const pair = trimmed.match(/^(\S+)\s+(\d+)$/);
      if (pair) {
        candidates.push({ source: pair[1], millidegrees: parseInt(pair[2], 10) });
        continue;
      }
      const bare = parseInt(trimmed, 10);
      if (Number.isFinite(bare)) candidates.push({ source: null, millidegrees: bare });
    }
    return candidates;
  }

  /**
   * First plausible temperature from a bare millidegree dump (one per line,
   * highest priority first). Same accept range as local `_getCPUTemperature()`;
   * returns 0 when nothing is readable.
   *
   * @param {string} raw
   * @returns {number} degrees Celsius, or 0
   */
  _parseSensorTemp(raw) {
    for (const line of String(raw).split("\n")) {
      const millidegrees = parseInt(line.trim(), 10);
      if (Number.isFinite(millidegrees) && millidegrees > 0 && millidegrees < 200000) {
        return Math.round((millidegrees / 1000) * 10) / 10;
      }
    }
    return 0;
  }

  async _getRemoteRam() {
    try {
      const cmd = "grep -E 'MemTotal|MemAvailable' /proc/meminfo 2>/dev/null";
      const output = await sshExec(this.spark, cmd);
      const totalMatch = output.match(/MemTotal:\s+(\d+)\s+kB/);
      const availMatch = output.match(/MemAvailable:\s+(\d+)\s+kB/);
      const totalKB = totalMatch ? parseInt(totalMatch[1]) : 0;
      const availKB = availMatch ? parseInt(availMatch[1]) : 0;
      const usedKB = totalKB - availKB;
      return {
        used: Math.round(usedKB / 1024),
        total: Math.round(totalKB / 1024),
        percentage: totalKB > 0 ? Math.round((usedKB / totalKB) * 100) : 0,
      };
    } catch (err) {
      console.error(`[SystemCollector] Remote RAM error for ${this.spark.id}:`, err.message);
      return this._defaultRam();
    }
  }

  async _getRemoteStorage(execute = sshExec) {
    try {
      // Include root (/); exclude pseudo filesystems via -x and type filter. The block devices'
      // cumulative sector counters ride in the same round trip, after a marker line.
      const cmd =
        "df -l -B1 -T -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs -x proc -x sysfs -x devpts -x cgroup -x cgroup2 2>/dev/null; " +
        `echo ${REMOTE_IO_MARKER}; ` +
        'for d in $(find /sys/block -mindepth 1 -maxdepth 1 2>/dev/null | sort); do echo "${d##*/} $(cat "$d/stat" 2>/dev/null)"; done 2>/dev/null';
      const output = await execute(this.spark, cmd);
      return this._parseRemoteStorage(output);
    } catch (err) {
      console.error(`[SystemCollector] Remote Storage error for ${this.spark.id}:`, err.message);
      return [];
    }
  }

  /** Disks from `df` output, with read/write speed from the block-device counters that follow it. */
  _parseRemoteStorage(output, now = Date.now()) {
    const [dfText, ioText = ""] = String(output).split(REMOTE_IO_MARKER);
    const counters = new Map();
    for (const line of ioText.split("\n")) {
      const f = line.trim().split(/\s+/);
      // name, then the kernel's stat fields: sectors read is the 3rd, sectors written the 7th.
      if (f.length >= 8 && /^\d+$/.test(f[3]) && /^\d+$/.test(f[7])) {
        counters.set(f[0], { read: parseInt(f[3], 10), written: parseInt(f[7], 10) });
      }
    }
    const lines = dfText.trim().split("\n").slice(1); // Skip header
    const disks = [];
    const disabledDevices = this.spark.disabledDevices || [];
    const PSEUDO = new Set([
      "tmpfs",
      "devtmpfs",
      "proc",
      "sysfs",
      "efivarfs",
      "squashfs",
      "overlay",
      "devpts",
      "cgroup",
      "cgroup2",
    ]);

    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 7) continue;
      const [fsys, type, size, used, avail, pct, mount] = parts;

      if (mount === "/boot/efi" || mount.includes("/snap")) continue;
      if (PSEUDO.has((type || "").toLowerCase())) continue;

      const device = fsys.split("/").pop() || fsys;
      const isDisabled = disabledDevices.includes(device) || disabledDevices.includes(mount);

      const parent = this._blockParentDevice(device);
      const c = counters.get(parent);
      let io = { readSpeed: 0, writeSpeed: 0 };
      if (c) io = this._diskRate(parent, c.read, c.written, now);

      disks.push({
        device,
        label: mount,
        used: Math.round(parseInt(used) / 1024 / 1024),
        total: Math.round(parseInt(size) / 1024 / 1024),
        available: Math.round(parseInt(avail) / 1024 / 1024),
        percentage: parseInt(pct) || 0,
        readSpeed: io.readSpeed,
        writeSpeed: io.writeSpeed,
        disabled: isDisabled,
      });
    }

    return disks;
  }

  /**
   * macOS units (platform: "darwin"): /proc is absent, so Linux commands are
   * replaced with darwin equivalents. All other kinds are unaffected.
   */
  get isMac() {
    return this.spark.platform === "darwin";
  }

  // ─── macOS via macmon ────────────────────────────────────
  // macmon (github.com/vladkens/macmon) reads Apple Silicon CPU/GPU/power/temperature
  // without sudo. One sample feeds the GPU, CPU, RAM and unified-memory polls (cached
  // 1.5 s), so a Mac costs one SSH call per cycle. Without macmon on the host these
  // collectors fall back to defaults (RAM keeps the sysctl/memory_pressure reader).
  _macmonSample(executor = sshExec) {
    const now = Date.now();
    if (this._macmon && now - this._macmon.at < this._macmon.ttl) return this._macmon.promise;
    const promise = executor(this.spark, MACMON_CMD).then((out) => {
      const sample = parseMacmonSample(out);
      if (!sample) {
        // A Mac without macmon is re-checked once a minute (and logged once), not on every poll.
        if (/NO_MACMON/.test(String(out ?? ""))) {
          const err = new Error("macmon not found on host (install it, or set MACMON_PATH)");
          err.macmonMissing = true;
          throw err;
        }
        throw new Error("macmon returned no sample");
      }
      // Not a macmon field: the GPU's share of unified memory from the same SSH call (bytes, or null).
      sample.gpuInUseBytes = parseMacGpuMemory(out);
      return sample;
    });
    const entry = { at: now, promise, ttl: 1500 };
    this._macmon = entry;
    promise.catch((err) => {
      if (this._macmon !== entry) return;
      if (err?.macmonMissing) {
        entry.ttl = 60_000;
        console.error(`[SystemCollector] ${this.spark.id}: ${err.message}`);
      } else {
        this._macmon = null;
      }
    });
    return promise;
  }

  _logMacmonError(kind, err) {
    if (err?.macmonMissing) return;
    console.error(`[SystemCollector] macmon ${kind} error for ${this.spark.id}:`, err.message);
  }

  async _getRemoteGpuMac() {
    try {
      const j = await this._macmonSample();
      const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
      const temperature = r1(j.temp?.gpu_temp_avg);
      const usage = Math.round((Number(j.gpu_usage?.[1]) || 0) * 100);
      const draw = r1(j.gpu_power);
      const total = Math.round((Number(j.memory?.ram_total) || 0) / 1048576);
      const ramUsed = Math.round((Number(j.memory?.ram_usage) || 0) / 1048576);
      // The GPU's own share when the driver reports it, as on a Spark; otherwise the whole pool's use.
      const used = macGpuUsedMB(j, ramUsed) ?? ramUsed;
      const vram = {
        used,
        total,
        percentage: total > 0 ? Math.round((used / total) * 100) : 0,
        // The pool is shared: what is left for a new allocation is what the whole system has free.
        available: Math.max(0, total - ramUsed),
      };
      const metricAvailability = {
        temperature: temperature > 0,
        usage: true,
        powerDraw: true,
        powerLimit: false,
        vramUsed: total > 0,
        vramTotal: total > 0,
      };
      const throttle = this._defaultThrottle();
      const device = {
        vendor: "apple",
        index: 0,
        physicalIndex: 0,
        name: String(j.soc?.chip_name || "Apple GPU"),
        uuid: null,
        temperature,
        usage,
        power: { draw, limit: 0 },
        vram,
        throttle,
        processes: [],
        metricAvailability,
      };
      return {
        temperature,
        usage,
        power: { draw, limit: 0, systemDraw: Math.round(Number(j.sys_power) || 0) },
        vram,
        processes: [],
        throttle,
        nvErrNoMemory: 0,
        vendor: "apple",
        vendors: ["apple"],
        metricAvailability,
        gpus: [device],
      };
    } catch (err) {
      this._logMacmonError("GPU", err);
      return this._defaultGpu();
    }
  }

  async _getRemoteCpuMac() {
    try {
      const j = await this._macmonSample();
      return {
        usage: Math.round((Number(j.cpu_usage_pct) || 0) * 100),
        temperature: Math.round((Number(j.temp?.cpu_temp_avg) || 0) * 10) / 10,
        temperatureLabel: "CPU avg",
        temperatureSource: "macmon",
        draw: Math.round((Number(j.cpu_power) || 0) * 10) / 10,
        tdp: 0,
      };
    } catch (err) {
      this._logMacmonError("CPU", err);
      return this._defaultCpu();
    }
  }

  async _macmonRam() {
    try {
      const m = (await this._macmonSample()).memory || {};
      const total = Math.round((Number(m.ram_total) || 0) / 1048576);
      const used = Math.round((Number(m.ram_usage) || 0) / 1048576);
      if (!(total > 0)) return null;
      return { used, total, percentage: Math.round((used / total) * 100) };
    } catch {
      return null;
    }
  }

  async _getRemoteUnifiedMemoryMac() {
    const ram = await this._macmonRam();
    if (!ram) return this._defaultUnifiedMemory();
    let gpuUsed = 0;
    try {
      gpuUsed = macGpuUsedMB(await this._macmonSample(), ram.used) ?? 0;
    } catch {
      /* _macmonRam just read the same sample; a failure here keeps the pool unsplit */
    }
    return {
      total: ram.total,
      gpuUsed,
      cpuUsed: ram.used - gpuUsed,
      used: ram.used,
      available: Math.max(0, ram.total - ram.used),
      percentage: ram.percentage,
      oomRisk: ram.percentage > 85 ? "high" : ram.percentage > 60 ? "medium" : "low",
      bandwidth: { current: 0, peak: 0 },
    };
  }

  /** macOS network: BSD byte counters + ifconfig state + default route, one SSH call. */
  async _getRemoteNetworkMac() {
    try {
      const output = await sshExec(this.spark, MAC_NETWORK_CMD);
      const network = parseMacNetwork(output, this.lastNetworkStats);
      network.interfaces = this._tagDisabledInterfaces(network.interfaces);
      if (network.primaryInterface && (this.spark.disabledInterfaces || []).includes(network.primaryInterface)) {
        network.primaryInterface = network.interfaces.find((i) => !i.disabled)?.name ?? network.primaryInterface;
      }
      return network;
    } catch (err) {
      console.error(`[SystemCollector] macOS network error for ${this.spark.id}:`, err.message);
      return this._defaultNetwork();
    }
  }

  /** macOS RAM via sysctl + memory_pressure (one SSH round trip). */
  async _getRemoteRamMac() {
    try {
      const output = await sshExec(
        this.spark,
        "sysctl -n hw.memsize; memory_pressure -Q 2>/dev/null | grep -i 'memory free percentage' || vm_stat 2>/dev/null | head -4",
      );
      const lines = output.trim().split("\n");
      const totalBytes = parseInt(lines[0], 10) || 0;
      const totalMB = Math.round(totalBytes / 1024 / 1024);
      // Prefer the free-percentage line; fall back to vm_stat free pages.
      let availableMB = 0;
      const pctLine = lines.find((l) => /memory free percentage/i.test(l));
      const pctMatch = pctLine?.match(/([\d.]+)%/);
      if (pctMatch && totalMB > 0) {
        availableMB = Math.round((totalMB * parseFloat(pctMatch[1])) / 100);
      } else {
        const freeMatch = output.match(/free.*?:\s+(\d+)(?:\.\d+)?\s*\(?/i);
        const freePages = freeMatch ? parseInt(freeMatch[1], 10) : 0;
        availableMB = Math.round((freePages * 16384) / 1024 / 1024); // 16KiB pages (arm64)
      }
      const usedMB = totalMB > 0 ? Math.max(0, totalMB - availableMB) : 0;
      return {
        used: usedMB,
        total: totalMB,
        percentage: totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : 0,
      };
    } catch (err) {
      console.error(`[SystemCollector] Remote macOS RAM error for ${this.spark.id}:`, err.message);
      return this._defaultRam();
    }
  }

  /** macOS storage: BSD df has no -x excludes; filter by mount/type instead. */
  async _getRemoteStorageMac() {
    try {
      // One SSH round trip: capacity from df, aggregate read/write byte
      // counters from IOBlockStorageDriver. The latter covers every block
      // device, so the rate is attached to the root entry and documented as
      // aggregate rather than per-volume.
      const output = await sshExec(this.spark, MAC_STORAGE_CMD);
      const disks = parseMacDf(output, this.spark.disabledDevices || []);
      const io = parseMacIoregDiskStats(output);
      if (io) {
        const now = Date.now();
        const prev = this._macDiskIo;
        const dt = prev ? (now - prev.time) / 1000 : 0;
        const root = disks.find((d) => d.label === "/") ?? disks[0];
        if (root && prev && dt > 0) {
          root.readSpeed = Math.max(0, Math.round((io.readBytes - prev.readBytes) / dt));
          root.writeSpeed = Math.max(0, Math.round((io.writeBytes - prev.writeBytes) / dt));
        }
        this._macDiskIo = { ...io, time: now };
      }
      return disks;
    } catch (err) {
      console.error(`[SystemCollector] Remote macOS Storage error for ${this.spark.id}:`, err.message);
      return [];
    }
  }

  /**
   * macOS model inventory (presence only, no serving probe): ollama tags +
   * ~/models/* sizes. Enables the dashboard to show what a Mac host holds.
   */
  async collectMacModels(execute = sshExec) {
    if (!this.isMac || this.spark.isLocal) return null;
    try {
      const output = await execute(
        this.spark,
        "ollama list 2>/dev/null || $HOME/.ollama/bin/ollama list 2>/dev/null || /usr/local/bin/ollama list 2>/dev/null || /opt/homebrew/bin/ollama list 2>/dev/null; echo '---'; find \"$HOME/models\" -mindepth 1 -maxdepth 1 ! -name '.*' 2>/dev/null | sort | while IFS= read -r d; do du -sh \"$d\" 2>/dev/null; done",
      );
      const sections = output.split("---");
      const ollama = [];
      for (const line of (sections[0] || "").trim().split("\n").slice(1)) {
        const toks = line.trim().split(/\s+/);
        if (toks.length >= 4 && toks[0] !== "NAME" && !toks[0].startsWith("/")) {
          ollama.push({ tag: toks[0], size: toks[2] });
        }
      }
      const filesystem = [];
      for (const line of (sections[1] || "").trim().split("\n")) {
        const toks = line.trim().split(/\s+/);
        if (toks.length === 2 && toks[1].startsWith("/Users/")) {
          filesystem.push({ path: toks[1], size: toks[0] });
        }
      }
      return { ollama, filesystem };
    } catch (err) {
      console.error(`[SystemCollector] macOS model inventory error for ${this.spark.id}:`, err.message);
      return null;
    }
  }

  async _getRemoteNetwork(execute = sshExec) {
    try {
      const cmd = [
        "cat /proc/net/dev 2>/dev/null",
        "echo '---'",
        "cat /proc/net/route 2>/dev/null",
        "echo '---'",
        "ip -4 addr show 2>/dev/null",
        "echo '---'",
        // Collect operstate for all non-virtual interfaces in one go
        "for d in $(find -L /sys/class/net -mindepth 2 -maxdepth 2 -name operstate 2>/dev/null | sort); do echo \"$(basename $(dirname $d)):$(cat $d)\"; done",
        "echo '---'",
        // WoL MAC for the primary LAN NIC on DGX Spark
        `cat /sys/class/net/${WOL_INTERFACE}/address 2>/dev/null || true`,
        "echo '---'",
        // Link speed for every interface, not just the primary one: which
        // interface is primary only falls out of the route table above, and
        // fetching that one afterwards cost a second SSH login per poll.
        // Virtual interfaces have no `speed`; they just come back blank.
        "for d in $(find -L /sys/class/net -mindepth 2 -maxdepth 2 -name speed 2>/dev/null | sort); do echo \"$(basename $(dirname $d)):$(cat $d 2>/dev/null)\"; done 2>/dev/null || true",
      ].join("; ");

      const output = await execute(this.spark, cmd);
      const sections = output.split("---");
      const devOut = sections[0]?.trim() || "";
      const routeOut = sections[1]?.trim() || "";
      const ipOut = sections[2]?.trim() || "";
      const operstateOut = sections[3]?.trim() || "";
      const wolMac = normalizeMac(sections[4]?.trim() || "");
      const speedOut = sections[5]?.trim() || "";

      // Parse link speed lines ("enP7s7:10000"); blank values stay unknown.
      const speedMap = new Map();
      for (const line of speedOut.split("\n")) {
        const idx = line.indexOf(":");
        if (idx <= 0) continue;
        const mbps = parseInt(line.slice(idx + 1).trim(), 10);
        if (Number.isFinite(mbps) && mbps > 0) speedMap.set(line.slice(0, idx), mbps);
      }

      // Parse operstate lines ("enP7s7:up")
      const operstateMap = new Map();
      for (const line of operstateOut.split("\n")) {
        const idx = line.indexOf(":");
        if (idx > 0) {
          operstateMap.set(line.slice(0, idx), line.slice(idx + 1).trim().toLowerCase());
        }
      }

      // Parse IP addresses
      const ipMap = new Map();
      const ipBlocks = ipOut.split(/\n(?=\d+:\s+)/);
      for (const block of ipBlocks) {
        const first = block.split("\n")[0];
        const m = first.match(/^\d+:\s+(\S+):/);
        if (!m) continue;
        const iface = m[1];
        const ipMatch = block.match(/inet\s+([\d.]+)/);
        if (ipMatch) {
          ipMap.set(iface, ipMatch[1]);
        }
      }

      // Parse /proc/net/dev
      const lines = devOut.split("\n").slice(2);
      const now = Date.now();
      const interfaces = [];

      for (const line of lines) {
        const parts = line.trim().split(/[\s:]+/);
        if (parts.length < 17) continue;
        const iface = parts[0];
        if (this._isVirtualNetworkInterface(iface)) continue;
        const rxBytes = parseInt(parts[1]) || 0;
        const txBytes = parseInt(parts[9]) || 0;
        const last = this.lastNetworkStats.get(iface) || { rxBytes, txBytes, time: now };
        const dtSec = (now - last.time) / 1000;
        const rxSpeed = dtSec > 0 ? (rxBytes - last.rxBytes) / dtSec : 0;
        const txSpeed = dtSec > 0 ? (txBytes - last.txBytes) / dtSec : 0;
        this.lastNetworkStats.set(iface, { rxBytes, txBytes, time: now });
        interfaces.push({
          name: iface,
          rxSpeed: Math.max(0, Math.round(rxSpeed)),
          txSpeed: Math.max(0, Math.round(txSpeed)),
          ip: ipMap.get(iface) || null,
          operstate: operstateMap.get(iface) || "unknown",
          disabled: false,
        });
      }

      const tagged = this._tagDisabledInterfaces(interfaces);

      // Parse /proc/net/route for default interface
      let primaryInterface = null;
      const routeLines = routeOut.split("\n");
      for (const line of routeLines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 11 && parts[1] === "00000000" && (parseInt(parts[3], 16) & 1)) {
          primaryInterface = parts[0];
          break;
        }
      }

      if (primaryInterface && (this.spark.disabledInterfaces || []).includes(primaryInterface)) {
        const alt = tagged.find((i) => !i.disabled);
        primaryInterface = alt?.name ?? primaryInterface;
      }

      const linkSpeedMbps = (primaryInterface && speedMap.get(primaryInterface)) || null;

      return { primaryInterface, linkSpeedMbps, interfaces: tagged, wolMac };
    } catch (err) {
      console.error(`[SystemCollector] Remote Network error for ${this.spark.id}:`, err.message);
      return this._defaultNetwork();
    }
  }

  async _getRemoteUnifiedMemory() {
    try {
      const cmd = [
        "grep -E 'MemTotal|MemAvailable' /proc/meminfo 2>/dev/null",
        "echo '---'",
        "nvidia-smi --query-compute-apps=pid,process_name,used_gpu_memory --format=csv,noheader,nounits 2>/dev/null",
      ].join("; ");

      const output = await sshExec(this.spark, cmd);
      const sections = output.split("---");
      const memOut = sections[0]?.trim() || "";
      const computeOut = sections[1]?.trim() || "";

      const totalMatch = memOut.match(/MemTotal:\s+(\d+)\s+kB/);
      const availMatch = memOut.match(/MemAvailable:\s+(\d+)\s+kB/);
      const totalKB = totalMatch ? parseInt(totalMatch[1]) : 0;
      const availKB = availMatch ? parseInt(availMatch[1]) : 0;
      const totalMB = Math.round(totalKB / 1024);

      // GPU memory from nvidia-smi compute apps (pid,process_name,used_gpu_memory)
      let gpuUsedMB = 0;
      const computeApps = computeOut.trim().split("\n").filter(Boolean);
      for (const line of computeApps) {
        const parts = line.split(",").map((s) => s.trim());
        const vramMB = parseFloat(parts[2]) || 0;
        gpuUsedMB += vramMB;
      }
      gpuUsedMB = Math.round(gpuUsedMB);

      // CPU memory = total - available - GPU
      const systemUsedKB = totalKB - availKB;
      const cpuUsedKB = Math.max(0, systemUsedKB - (gpuUsedMB * 1024));
      const cpuUsedMB = Math.round(cpuUsedKB / 1024);

      const usedMB = gpuUsedMB + cpuUsedMB;
      const percentage = totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : 0;
      const oomRisk = percentage > 85 ? "high" : percentage > 60 ? "medium" : "low";

      return {
        total: totalMB,
        gpuUsed: gpuUsedMB,
        cpuUsed: cpuUsedMB,
        used: usedMB,
        available: Math.round(availKB / 1024),
        percentage,
        oomRisk,
        bandwidth: { current: 0, peak: 400 },
      };
    } catch (err) {
      console.error(`[SystemCollector] Remote Unified Memory error for ${this.spark.id}:`, err.message);
      return this._defaultUnifiedMemory();
    }
  }

  // ─── Windows units (platform: "windows") ──────────────────
  get isWindows() {
    return this.spark.platform === "windows";
  }

  /**
   * One PowerShell round trip per script, shared by every domain that asks for
   * it within ~1.2 s (the fast domains all poll on the same cadence).
   */
  _windowsRun(key, script) {
    const now = Date.now();
    this._windowsCache ??= new Map();
    const hit = this._windowsCache.get(key);
    // An unfinished call is always reused (PowerShell starts slowly; never stack them),
    // a finished one for ~1.2 s so every domain of one poll shares it.
    if (hit && (!hit.settled || now - hit.at < 1200)) return hit.promise;
    const entry = { at: now, settled: false, promise: null };
    entry.promise = sshExec(this.spark, script, { timeoutMs: 15000 });
    entry.promise.then(
      () => {
        entry.settled = true;
        entry.at = Date.now();
      },
      () => {
        entry.settled = true;
        if (this._windowsCache.get(key) === entry) this._windowsCache.delete(key);
      }
    );
    this._windowsCache.set(key, entry);
    return entry.promise;
  }

  /**
   * Under WDDM nvidia-smi lists graphics processes (dwm.exe, explorer.exe...) without
   * a memory figure. A process list of 0 MB entries says nothing, so keep only
   * processes that report memory.
   */
  _withoutUnmeteredProcesses(gpu) {
    if (Array.isArray(gpu?.processes)) gpu.processes = gpu.processes.filter((p) => p.vramMB > 0);
    return gpu;
  }

  async _windowsSystem() {
    return parseWindowsSystem(await this._windowsRun("system", WINDOWS_SYSTEM_SCRIPT));
  }

  /** Uptime in seconds (SparkMonitor reads /proc/uptime on Linux). */
  async readWindowsUptime() {
    return (await this._windowsSystem()).uptimeSec;
  }

  /** CPU model / logical CPUs / RAM and GPU names for the header summary. */
  async detectWindowsHardware() {
    const [system, gpuRaw] = await Promise.all([
      this._windowsSystem(),
      this._windowsRun("gpu", WINDOWS_GPU_SCRIPT),
    ]);
    const { names } = splitWindowsGpuOutput(gpuRaw);
    const { gpuChip, gpuCount, cudaDriver } = this._describeGpus(names);
    return {
      device: "Windows GPU host",
      cpuModel: system.cpuName,
      cpuCores: system.logicalCpus,
      totalMemoryGB: system.totalMB > 0 ? Math.max(1, Math.round(system.totalMB / 1024)) : null,
      gpuChip,
      gpuCount,
      cudaDriver,
      storageModel: null,
    };
  }

  async _getWindowsCpu(collectionSequence) {
    try {
      const system = await this._windowsSystem();
      if (system.cpuLoad == null) throw new Error("no CPU load from Win32_Processor");
      if (collectionSequence === this._cpuCollectionSequence) this.lastCpuUsagePct = system.cpuLoad;
      // Windows has no unprivileged CPU package sensor, and no TDP is reported:
      // power is an estimate on a generic 125 W desktop part.
      const tdp = 125;
      const idle = tdp * 0.08;
      const draw = idle + (tdp - idle) * Math.min(system.cpuLoad / 100, 1);
      return {
        usage: system.cpuLoad,
        temperature: 0,
        temperatureLabel: null,
        temperatureSource: null,
        draw: Math.round(draw * 10) / 10,
        tdp,
      };
    } catch (err) {
      console.error(`[SystemCollector] Windows CPU error for ${this.spark.id}:`, err.message);
      return this._defaultCpu();
    }
  }

  async _getWindowsRam() {
    try {
      const { totalMB, availableMB } = await this._windowsSystem();
      const used = Math.max(0, totalMB - availableMB);
      return { used, total: totalMB, percentage: totalMB > 0 ? Math.round((used / totalMB) * 100) : 0 };
    } catch (err) {
      console.error(`[SystemCollector] Windows RAM error for ${this.spark.id}:`, err.message);
      return this._defaultRam();
    }
  }

  async _getWindowsStorage() {
    try {
      const { disks, diskIo } = await this._windowsSystem();
      const disabledDevices = this.spark.disabledDevices || [];
      const MB = 1024 * 1024;
      return disks.map((d) => {
        const c = diskIo?.get(String(d.id).toUpperCase());
        const io = c ? this._diskRate(d.id, c.readBytes, c.writtenBytes, c.atMs, 1) : { readSpeed: 0, writeSpeed: 0 };
        const total = Math.round(d.totalBytes / MB);
        const available = Math.round(d.freeBytes / MB);
        const used = Math.max(0, total - available);
        return {
          device: d.id,
          label: d.label ? `${d.id} ${d.label}` : d.id,
          used,
          total,
          available,
          percentage: total > 0 ? Math.round((used / total) * 100) : 0,
          readSpeed: io.readSpeed,
          writeSpeed: io.writeSpeed,
          disabled: disabledDevices.includes(d.id),
        };
      });
    } catch (err) {
      console.error(`[SystemCollector] Windows storage error for ${this.spark.id}:`, err.message);
      return [];
    }
  }

  async _getWindowsNetwork() {
    try {
      const { adapters, defaultInterface } = await this._windowsSystem();
      const now = Date.now();
      const interfaces = [];
      for (const a of adapters) {
        if (a.virtual || a.rxBytes == null || a.txBytes == null) continue;
        const last = this.lastNetworkStats.get(a.name) || { rxBytes: a.rxBytes, txBytes: a.txBytes, time: now };
        const dt = (now - last.time) / 1000;
        const rx = dt > 0 ? (a.rxBytes - last.rxBytes) / dt : 0;
        const tx = dt > 0 ? (a.txBytes - last.txBytes) / dt : 0;
        this.lastNetworkStats.set(a.name, { rxBytes: a.rxBytes, txBytes: a.txBytes, time: now });
        interfaces.push({
          name: a.name,
          rxSpeed: Math.max(0, Math.round(rx)),
          txSpeed: Math.max(0, Math.round(tx)),
          ip: a.ip,
          operstate: /^up$/i.test(a.status) ? "up" : /disconnected|down/i.test(a.status) ? "down" : "unknown",
          disabled: false,
        });
      }
      const tagged = this._tagDisabledInterfaces(interfaces);
      let primaryInterface = tagged.some((i) => i.name === defaultInterface) ? defaultInterface : null;
      primaryInterface ??= tagged.find((i) => i.operstate === "up")?.name ?? null;
      if (primaryInterface && (this.spark.disabledInterfaces || []).includes(primaryInterface)) {
        primaryInterface = tagged.find((i) => !i.disabled)?.name ?? primaryInterface;
      }
      const bps = adapters.find((a) => a.name === primaryInterface)?.linkBps;
      const linkSpeedMbps = bps && bps > 0 ? Math.round(bps / 1e6) : null;
      return { primaryInterface, linkSpeedMbps, interfaces: tagged, wolMac: null };
    } catch (err) {
      console.error(`[SystemCollector] Windows network error for ${this.spark.id}:`, err.message);
      return this._defaultNetwork();
    }
  }

  /** Dedicated GPU host: system RAM plus the GPU memory in use, mirroring the Linux remote shape. */
  async _getWindowsUnifiedMemory() {
    try {
      const [system, gpuRaw] = await Promise.all([
        this._windowsSystem(),
        this._windowsRun("gpu", WINDOWS_GPU_SCRIPT),
      ]);
      const { memory } = splitWindowsGpuOutput(gpuRaw);
      const { used: gpuUsed } = this._sumVram(this._parseVramLines(memory));
      const gpuUsedMB = Math.round(gpuUsed || 0);
      const totalMB = system.totalMB;
      const systemUsed = Math.max(0, totalMB - system.availableMB);
      // Same arithmetic as the Linux remote path: the CPU share is what remains of
      // the used RAM after the GPU's share, so the two never add up past the RAM total
      // (a discrete card's VRAM is not system RAM).
      const cpuUsedMB = Math.max(0, systemUsed - gpuUsedMB);
      const usedMB = gpuUsedMB + cpuUsedMB;
      const percentage = totalMB > 0 ? Math.min(100, Math.round((usedMB / totalMB) * 100)) : 0;
      return {
        total: totalMB,
        gpuUsed: gpuUsedMB,
        cpuUsed: cpuUsedMB,
        used: usedMB,
        available: system.availableMB,
        percentage,
        oomRisk: percentage > 85 ? "high" : percentage > 60 ? "medium" : "low",
        bandwidth: { current: 0, peak: 400 },
      };
    } catch (err) {
      console.error(`[SystemCollector] Windows unified memory error for ${this.spark.id}:`, err.message);
      return this._defaultUnifiedMemory();
    }
  }

  // ─── Host namespace / Docker helpers ──────────────────────
  /**
   * True when host proc is bind-mounted (Docker local metrics path).
   * Host PID 1 namespaces live under /host/proc/1/ns/*.
   */
  _hasHostProc() {
    return fs.existsSync(path.join(HOST_PATHS.PROC, "1", "ns", "mnt"));
  }

  /**
   * Promisified execFile. Goes through the mutable child_process exports
   * object so tests can stub exec results with `t.mock.method`.
   */
  _execFileP(file, args, options) {
    return new Promise((resolve, reject) => {
      childProcess.execFile(file, args, options, (err, stdout) => {
        if (err) return reject(err);
        resolve(String(stdout ?? ""));
      });
    });
  }

  /**
   * Rootless Docker: nsenter cannot enter the host namespaces (EPERM on
   * /proc/1/ns/*). Classify once — log and remember — so later polls skip
   * the doomed nsenter entirely instead of re-failing on every call.
   */
  _markNsenterBroken(err) {
    if (this._nsenterBroken) return;
    this._nsenterBroken = true;
    console.warn(
      `[SystemCollector] nsenter cannot enter the host namespaces on ${this.spark.id} (${err?.message}); using in-container reads where allowed.`
    );
  }

  /**
   * Only the permission-shaped failure (rootless setns EPERM) may fall back.
   * Timeouts (hung commands) and missing binaries propagate so callers see
   * the real error instead of a silent, wrong container reading.
   */
  _isNsenterPermError(err) {
    if (err?.code === "EPERM") return true;
    if (err?.killed) return false; // timed out: never mask a hung nsenter
    return /EPERM|Operation not permitted|Permission denied/i.test(
      `${err?.stderr ?? ""}\n${err?.message ?? ""}`
    );
  }

  /**
   * True when this process's netns IS the host's (network_mode: host) —
   * only then does the container's own /proc/net mirror the host's.
   *
   * Rootless Docker may deny the host namespace symlink. In that case only
   * an explicit deployment declaration permits the fallback; a shared procfs
   * mount does not prove shared networking. Readable namespace IDs take
   * precedence, including a mismatch against the deployment declaration.
   */
  _containerNetnsIsHost() {
    if (this._containerNetnsShared !== null) return this._containerNetnsShared;
    try {
      const hostLink = fs.readlinkSync(path.join(HOST_PATHS.PROC, "1", "ns", "net"));
      const mineLink = fs.readlinkSync("/proc/self/ns/net");
      if (/^net:\[\d+\]$/.test(hostLink) && /^net:\[\d+\]$/.test(mineLink)) {
        this._containerNetnsShared = hostLink === mineLink;
        return this._containerNetnsShared;
      }
    } catch { /* Permission failure is inconclusive, not proof of equality. */ }
    this._containerNetnsShared = process.env.SPARKDASH_HOST_NETWORK === "1";
    return this._containerNetnsShared;
  }

  /**
   * Run a command in the host mount (optionally +network) namespaces so
   * tools like nvidia-smi and lsblk see host driver libs and mount table.
   *
   * On the rootless-Docker permission failure the command reruns inside the
   * container — valid where the compose file mounts the host's view
   * (nvidia-smi, /proc, /sys). Callers whose output would silently degrade
   * in the container (kernel journals, host-only sysfs) pass
   * `allowContainerFallback: false` and handle the throw as "unknown".
   * @returns {Promise<string>} trimmed stdout
   */
  async _execHostNs(cmd, { net = false, allowContainerFallback = true, maxBuffer = 1024 * 1024 } = {}) {
    if (!this._hasHostProc()) {
      return this._exec(cmd);
    }
    if (!this._nsenterBroken) {
      const args = ["--mount=" + path.join(HOST_PATHS.PROC, "1", "ns", "mnt")];
      if (net) args.push("--net=" + path.join(HOST_PATHS.PROC, "1", "ns", "net"));
      args.push("--", "sh", "-c", cmd);
      try {
        return (await this._execFileP("nsenter", args, { timeout: 8000, maxBuffer })).trim();
      } catch (err) {
        if (!this._isNsenterPermError(err)) throw err;
        this._markNsenterBroken(err);
      }
    }
    if (net && !this._containerNetnsIsHost()) {
      // A container netns that differs from the host's would serve the
      // wrong interfaces — report unknown instead.
      throw new Error(`host netns unreachable (nsenter failed, container netns differs): ${cmd}`);
    }
    if (!allowContainerFallback) {
      throw new Error(`host namespaces unreachable, container fallback disabled: ${cmd}`);
    }
    return this._exec(cmd);
  }

  /** Host mount ns only (nvidia-smi, lsblk). */
  _execOnHost(cmd, opts = {}) {
    return this._execHostNs(cmd, opts);
  }

  /** nvidia-smi via host namespaces when available (fixes missing libnvidia-ml in Docker). */
  async _nvidiaSmi(smiArgs) {
    const smi = this._nvidiaSmiPath || "nvidia-smi";
    const cmd = `${smi} ${smiArgs} 2>/dev/null`;
    return this._execOnHost(cmd);
  }

  /** amd-smi from the host namespace when available; AMD and NVIDIA are probed independently. */
  async _amdSmi(args) {
    const cmd = `${AMD_SMI_RESOLVER}; if [ -n "$amd_smi" ]; then "$amd_smi" ${args} 2>/dev/null; fi`;
    if (this._hasHostProc()) return this._execOnHost(cmd);
    return this._exec(cmd);
  }

  /**
   * One-shot real-hardware detection (GPU chip + driver, CPU model/cores, RAM).
   * Used for kind === "host" units (dedicated GPU Linux boxes) so the header
   * doesn't claim DGX Spark specs. Returns null on any failure → caller keeps
   * its static fallback summary.
   * @returns {Promise<object|null>}
   */
  async detectHardware() {
    try {
      let smiOut = "";
      let cpuinfo = "";
      let meminfo = "";
      let coresParsed = null;
      if (this.spark.isLocal) {
        const results = await Promise.all([
          this._nvidiaSmi(
            "--query-gpu=name,driver_version --format=csv,noheader,nounits 2>/dev/null"
          ).catch(() => ""),
          this._readHostFile("/proc/cpuinfo").catch(() => ""),
          this._readHostFile("/proc/meminfo").catch(() => ""),
        ]);
        smiOut = results[0];
        cpuinfo = results[1];
        meminfo = results[2];
        coresParsed = (cpuinfo.match(/processor\s*:/g) || []).length;
      } else {
        const out = await sshExec(this.spark, [
          "nvidia-smi --query-gpu=name,driver_version --format=csv,noheader,nounits 2>/dev/null",
          "echo '---'",
          "grep -E '^model name' /proc/cpuinfo | head -1",
          "echo '---'",
          "grep -E 'processor\\s*:' /proc/cpuinfo | wc -l",
          "echo '---'",
          "grep -E 'MemTotal' /proc/meminfo",
        ].join("; "));
        const parts = out.split("---");
        smiOut = parts[0]?.trim() || "";
        cpuinfo = parts[1]?.trim() || "";
        meminfo = parts[3]?.trim() || "";
        const n = parseInt(parts[2]?.trim() || "", 10);
        coresParsed = Number.isInteger(n) && n > 0 ? n : null;
      }

      const { gpuChip, gpuCount, cudaDriver } = this._describeGpus(smiOut);

      const modelMatch = cpuinfo.match(/model name\s*:\s*(.+)/i);
      const cpuModel = modelMatch ? modelMatch[1].trim() : null;
      const cpuCores = coresParsed !== null && coresParsed > 0 ? coresParsed : null;

      const memMatch = meminfo.match(/MemTotal:\s+(\d+)\s+kB/);
      const totalMemoryGB = memMatch
        ? Math.max(1, Math.round(parseInt(memMatch[1], 10) / 1024 / 1024))
        : null;

      return {
        device: "Linux GPU host",
        cpuModel,
        cpuCores,
        totalMemoryGB,
        gpuChip,
        gpuCount,
        cudaDriver,
        storageModel: null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Header label from `--query-gpu=name,driver_version` (one line per card):
   * one card → its name; identical cards → "2× NVIDIA GeForce RTX 5080";
   * mixed cards → "NVIDIA GeForce RTX 5080 + RTX 5060 Ti" (vendor prefix once).
   */
  _describeGpus(smiOut) {
    const rows = String(smiOut ?? "")
      .split("\n")
      .map((line) => line.split(",").map((s) => s.trim()))
      .filter((parts) => parts[0]);
    if (!rows.length) return { gpuChip: null, gpuCount: 0, cudaDriver: null };
    const names = rows.map((r) => r[0]);
    const cudaDriver = rows[0][1] || null;
    if (names.length === 1) return { gpuChip: names[0], gpuCount: 1, cudaDriver };
    if (names.every((n) => n === names[0])) {
      return { gpuChip: `${names.length}× ${names[0]}`, gpuCount: names.length, cudaDriver };
    }
    const prefix = /^NVIDIA\s+(GeForce\s+|RTX\s+(?=[A-Z]))?/i;
    const label = names
      .map((n, i) => (i === 0 ? n : n.replace(prefix, "")))
      .join(" + ");
    return { gpuChip: label, gpuCount: names.length, cudaDriver };
  }

  /**
   * Read host network files via host netns — /proc/net is netns-local even under
   * a bind-mounted /host/proc (self/net symlink semantics).
   */
  async _readHostNetFile(relPath) {
    // relPath e.g. "dev" or "route" under /proc/net/
    if (this._hasHostProc() && !this._nsenterBroken) {
      const netNs = path.join(HOST_PATHS.PROC, "1", "ns", "net");
      if (fs.existsSync(netNs)) {
        try {
          return await this._execFileP(
            "nsenter",
            ["--net=" + netNs, "--", "cat", `/proc/net/${relPath}`],
            { timeout: 5000 }
          );
        } catch (err) {
          if (!this._isNsenterPermError(err)) throw err;
          this._markNsenterBroken(err);
        }
      }
    }
    // Without a working nsenter, /proc/net here is the host's only when the
    // container shares the host netns (network_mode: host).
    if (this._hasHostProc() && !this._containerNetnsIsHost()) {
      throw new Error(`no host netns access for /proc/net/${relPath}`);
    }
    return fs.readFileSync(`/proc/net/${relPath}`, "utf-8");
  }

  /** Lightweight liveness for local Sparks. */
  async pingHost() {
    await this._readHostFile("/proc/meminfo");
    return true;
  }

  // ─── Internal exec is local (Phase 2) ────────────────────
  /** Execute shell command locally, return trimmed stdout */
  async _exec(cmd) {
    const { execFile } = await import("child_process");
    return new Promise((resolve, reject) => {
      execFile("sh", ["-c", cmd], { timeout: 5000 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(String(stdout).trim());
      });
    });
  }

  /**
   * Read file from host path (for Docker bind mounts).
   * Maps /proc/* → HOST_PATHS.PROC when the bind exists.
   * Do not use for /proc/net/* — use _readHostNetFile instead.
   */
  async _readHostFile(hostPath) {
    if (hostPath.startsWith("/proc/net/") || hostPath === "/proc/net") {
      const rel = hostPath.replace(/^\/proc\/net\/?/, "") || "dev";
      return this._readHostNetFile(rel);
    }
    if (hostPath.startsWith("/proc/")) {
      const mapped = path.join(HOST_PATHS.PROC, hostPath.slice("/proc/".length));
      if (fs.existsSync(mapped)) {
        return fs.readFileSync(mapped, "utf-8");
      }
    }
    if (hostPath.startsWith("/sys/")) {
      const mapped = path.join(HOST_PATHS.SYS, hostPath.slice("/sys/".length));
      if (fs.existsSync(mapped)) {
        return fs.readFileSync(mapped, "utf-8");
      }
    }
    return fs.readFileSync(hostPath, "utf-8");
  }

  /** statfs for disk usage */
  async _statfs(dir) {
    return fs.promises.statfs(dir);
  }

  /** Complete since-boot totals; null while backfilling or when unreadable. */
  async _kernelErrors() {
    if (this.isWindows) return null;
    const value = await this._kernelJournal.read();
    return value ? { xid: value.xid, oomKills: value.oomKills, lastXid: value.lastXid } : null;
  }

  async _nvErrNoMemory() {
    if (this.isWindows) return 0;
    return (await this._kernelJournal.read())?.nvErr ?? null;
  }

  // ─── Default metrics ─────────────────────────────────────
  _defaultGpu() {
    return {
      temperature: 0,
      usage: 0,
      power: { draw: 0, limit: 120, systemDraw: 0 },
      vram: { used: 0, total: 0, percentage: 0, available: 0 },
      processes: [],
      throttle: this._defaultThrottle(),
      nvErrNoMemory: 0,
      vendor: null,
      metricAvailability: Object.fromEntries(AMD_GPU_FIELDS.map((field) => [field, false])),
      gpus: [],
    };
  }

  _defaultCpu() {
    return {
      usage: 0,
      temperature: 0,
      temperatureLabel: null,
      temperatureSource: null,
      draw: 0,
      tdp: 0,
    };
  }

  _defaultRam() {
    return { used: 0, total: 0, percentage: 0 };
  }

  _defaultNetwork() {
    return { primaryInterface: null, linkSpeedMbps: null, interfaces: [], wolMac: null };
  }

  _defaultUnifiedMemory() {
    return {
      total: 0,
      gpuUsed: 0,
      cpuUsed: 0,
      used: 0,
      available: 0,
      percentage: 0,
      oomRisk: "low",
      bandwidth: { current: 0, peak: 0 },
    };
  }

  // resolve nvidia-smi path
  _resolveNvidiaSmiPath() {
    const candidates = ["/usr/bin/nvidia-smi", "/usr/local/nvidia/bin/nvidia-smi", "nvidia-smi"];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          this._nvidiaSmiPath = p;
          return p;
        }
      } catch {}
    }
    this._nvidiaSmiPath = "nvidia-smi";
    return this._nvidiaSmiPath;
  }
}
