/**
 * disk.js — disk metrics via df (local, no SSH).
 *
 * Seam type: DiskMetrics[] (shared/types.ts). Real filesystems only: pseudo
 * types (tmpfs, overlay, ...) and loop/SRAM devices are filtered out, same
 * exclusion set as sparkDash SystemCollector._getDiskUsage.
 */
import { runShell } from "./util.js";

const PSEUDO_TYPES = new Set([
  "tmpfs", "devtmpfs", "proc", "sysfs", "efivarfs", "squashfs",
  "overlay", "devpts", "cgroup", "cgroup2", "iso9660", "zram",
]);

const MB = 1024 * 1024;

/**
 * Collect disk usage per mounted real filesystem.
 * @param {{ exec?: (cmd: string) => Promise<string> }} [deps]
 * @returns {Promise<Array<{device:string, mount:string, usedMB:number, totalMB:number, availableMB:number, percentage:number}>>}
 */
export async function collectDisk({ exec = runShell } = {}) {
  try {
    // -P: POSIX columns; -T: filesystem type; -B1: bytes (header still says
    // "1024-blocks" with -P, values are bytes).
    const out = await exec("df -B1 -T -P 2>/dev/null");
    const disks = [];
    for (const line of out.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 7) continue;
      const [device, type, sizeS, usedS, availS, , mount] = parts;
      if (PSEUDO_TYPES.has(String(type || "").toLowerCase())) continue;
      if (/^\/dev\/(loop|sr|zram|ram|dm-)/.test(device)) continue;
      if (device === "none" || device === "tmpfs" || !device) continue;
      if (!mount || mount === "/boot/efi" || mount.includes("/snap/")) continue;

      const total = parseInt(sizeS, 10);
      const used = parseInt(usedS, 10);
      const avail = parseInt(availS, 10);
      if (!Number.isFinite(total) || total <= 0) continue;

      const usedMB = Math.round((Number.isFinite(used) ? used : 0) / MB);
      const availableMB = Math.round((Number.isFinite(avail) ? avail : 0) / MB);
      const denom = (Number.isFinite(used) ? used : 0) + (Number.isFinite(avail) ? avail : 0);
      const percentage =
        denom > 0
          ? Math.min(100, Math.max(0, Math.round(((Number.isFinite(used) ? used : 0) / denom) * 100)))
          : 0;

      disks.push({
        device,
        mount,
        usedMB,
        totalMB: Math.round(total / MB),
        availableMB,
        percentage,
      });
    }
    return disks;
  } catch {
    return [];
  }
}
