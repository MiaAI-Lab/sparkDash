/**
 * mem.js — memory metrics from /proc/meminfo.
 *
 * Seam type: MemMetrics (shared/types.ts). usedMB = totalMB − availableMB
 * (MemAvailable basis, same as sparkDash SystemCollector._getRamUsage).
 */
import { readTextFile } from "./util.js";

/**
 * Collect memory metrics.
 * @param {{ readFile?: (path: string) => Promise<string> }} [deps]
 * @returns {Promise<{usedMB:number, totalMB:number, availableMB:number, percentage:number} | null>}
 */
export async function collectMem({ readFile = readTextFile } = {}) {
  try {
    const raw = await readFile("/proc/meminfo");
    const totalM = raw.match(/MemTotal:\s+(\d+)\s+kB/);
    if (!totalM) return null;
    const availM = raw.match(/MemAvailable:\s+(\d+)\s+kB/);
    const freeM = raw.match(/MemFree:\s+(\d+)\s+kB/);
    const totalKB = parseInt(totalM[1], 10);
    if (!Number.isFinite(totalKB) || totalKB <= 0) return null;
    const availKB = availM ? parseInt(availM[1], 10) : 0;
    const freeKB = freeM ? parseInt(freeM[1], 10) : 0;

    const totalMB = Math.round(totalKB / 1024);
    const availableMB = Math.round(availKB / 1024);
    const usedMB = Math.max(0, totalMB - availableMB);
    const percentage = Math.min(100, Math.max(0, Math.round((usedMB / totalMB) * 100)));

    return { usedMB, totalMB, availableMB, percentage };
  } catch {
    return null;
  }
}
