const K = 1024;

/** Network and disk throughput. 1024.0 of a unit rolls into the next unit. */
export function formatBytesPerSec(bps: number): string {
  const kb = bps / K;
  const mb = kb / K;
  const gb = mb / K;
  if (bps >= K * K * K || mb.toFixed(1) === "1024.0") return `${gb.toFixed(1)} GB/s`;
  if (bps >= K * K || kb.toFixed(1) === "1024.0") return `${mb.toFixed(1)} MB/s`;
  if (bps >= K) return `${kb.toFixed(1)} KB/s`;
  return `${bps} B/s`;
}

/** RAM and GPU memory. 1024 MB rolls into 1.0 GB. */
export function formatMb(mb: number): string {
  if (mb >= K || Math.round(mb) >= K) return `${(mb / K).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/** Disk size. Whole gigabytes. 1024 MB rolls into 1 GB. */
export function formatGb(mb: number): string {
  if (mb >= K || Math.round(mb) >= K) return `${(mb / K).toFixed(0)} GB`;
  return `${Math.round(mb)} MB`;
}

/**
 * Disk size in the fewest characters that still carry a unit: whole MB, whole
 * GB below a terabyte, then TB to one decimal. Each side of a "used / total"
 * pair carries its own unit, so a 1.8 TB disk reads `816 GB / 1.8 TB` instead
 * of `816.4 / 1831.7 GB`, which no longer fits an Overview mini-stat.
 * 1024 GB rolls into 1.0 TB, the same way {@link formatMb} rolls MB into GB.
 */
export function formatDiskSize(mb: number): string {
  const gb = mb / K;
  if (Math.round(gb) >= K) return `${(gb / K).toFixed(1)} TB`;
  if (mb >= K || Math.round(mb) >= K) return `${Math.round(gb)} GB`;
  return `${Math.round(mb)} MB`;
}
