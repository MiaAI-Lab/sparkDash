/**
 * gpu.js — GPU metrics via nvidia-smi (local, no SSH).
 *
 * Seam type: GpuMetrics (shared/types.ts). Returns null when nvidia-smi is
 * unavailable or reports no usable data (graceful degradation).
 *
 * GB10 note: on unified-memory GB10, nvidia-smi memory.used/memory.total are
 * often [N/A]. Mirrors sparkDash SystemCollector: vramTotal falls back to the
 * OS pool (MemTotal from /proc/meminfo), vramUsed to the compute-apps sum, and
 * vramAvailable to MemAvailable.
 *
 * NOTE: the per-process VRAM field is `used_gpu_memory` (the actual
 * nvidia-smi field; the task spec's "utilities.gpu.memory.usage" does not
 * exist in nvidia-smi).
 */
import { runShell, readTextFile, parseSmiNumber } from "./util.js";

const GPU_QUERY =
  "--query-gpu=temperature.gpu,utilization.gpu,power.draw,power.limit,memory.used,memory.total --format=csv,noheader,nounits";
const APPS_QUERY =
  "--query-compute-apps=pid,process_name,used_gpu_memory --format=csv,noheader,nounits";

/**
 * Collect GPU metrics.
 * @param {{ exec?: (cmd: string) => Promise<string>, readFile?: (path: string) => Promise<string>, smiPath?: string }} [deps]
 * @returns {Promise<{temperature:number, usage:number, powerDraw:number, powerLimit:number, vramUsedMB:number, vramTotalMB:number, vramPercentage:number, vramAvailableMB:number, processes:Array<{pid:number, name:string, vramMB:number}>} | null>}
 */
export async function collectGpu({ exec = runShell, readFile = readTextFile, smiPath = "nvidia-smi" } = {}) {
  try {
    const out = await exec(`${smiPath} ${GPU_QUERY} 2>/dev/null`);
    const line = out.split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
    const p = line.split(",").map((s) => s.trim());
    if (p.length < 6) return null;

    const temperature = parseSmiNumber(p[0]);
    const usage = parseSmiNumber(p[1]);
    if (temperature == null || usage == null) return null;

    const powerDraw = parseSmiNumber(p[2]) ?? 0;
    const powerLimit = parseSmiNumber(p[3]) ?? 0;
    const smiUsed = parseSmiNumber(p[4]);
    const smiTotal = parseSmiNumber(p[5]);

    // OS-visible pool (GB10 unified-memory fallback; also feeds available).
    let memTotalMB = 0;
    let memAvailMB = null;
    try {
      const raw = await readFile("/proc/meminfo");
      const total = raw.match(/MemTotal:\s+(\d+)\s+kB/);
      const avail = raw.match(/MemAvailable:\s+(\d+)\s+kB/);
      memTotalMB = total ? Math.round(parseInt(total[1], 10) / 1024) : 0;
      memAvailMB = avail ? Math.round(parseInt(avail[1], 10) / 1024) : null;
    } catch {
      /* optional */
    }

    // Compute apps: the reliable "used" path on GB10 + top processes.
    /** @type {Array<{pid:number, name:string, vramMB:number}>} */
    let processes = [];
    let appsSumMB = 0;
    try {
      const raw = await exec(`${smiPath} ${APPS_QUERY} 2>/dev/null`);
      for (const l of raw.split("\n")) {
        const parts = l.split(",").map((s) => s.trim());
        if (parts.length < 3) continue;
        const pid = parseInt(parts[0], 10);
        const vramMB = parseSmiNumber(parts[2]) ?? 0;
        if (!Number.isInteger(pid) || pid <= 0) continue;
        processes.push({ pid, name: parts[1] || "unknown", vramMB });
        appsSumMB += vramMB;
      }
      processes.sort((a, b) => b.vramMB - a.vramMB);
      processes = processes.slice(0, 5);
    } catch {
      processes = [];
      appsSumMB = 0;
    }

    const vramUsedMB = Math.round(smiUsed != null && smiUsed > 0 ? smiUsed : appsSumMB);
    const vramTotalMB = smiTotal != null && smiTotal > 0 ? Math.round(smiTotal) : memTotalMB;
    const vramAvailableMB =
      memAvailMB != null ? memAvailMB : Math.max(0, vramTotalMB - vramUsedMB);
    const vramPercentage =
      vramTotalMB > 0
        ? Math.min(100, Math.max(0, Math.round((vramUsedMB / vramTotalMB) * 100)))
        : 0;

    return {
      temperature,
      usage: Math.min(100, Math.max(0, usage)),
      powerDraw,
      powerLimit,
      vramUsedMB,
      vramTotalMB,
      vramPercentage,
      vramAvailableMB,
      processes,
    };
  } catch {
    return null;
  }
}
