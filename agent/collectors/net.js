/**
 * net.js — network metrics from /proc/net/dev + sysfs.
 *
 * Seam type: NetMetrics[] (shared/types.ts). rx/tx speeds (MB/s) are deltas
 * against the previous call's counters (first call → 0, no baseline).
 * Virtual interfaces (lo, docker*, br-*, veth*, ...) are excluded, same prefix
 * set as sparkDash SystemCollector._isVirtualNetworkInterface.
 */
import { runShell, readTextFile } from "./util.js";

const VIRTUAL_IFACE_RE = /^(lo|docker|br-|veth|virbr|zt|tun|wg|tailscale|ipsec|ip6tnl|gre|sit|dummy)/;

const MB = 1024 * 1024;

/** Previous per-iface byte counters (module-level baseline). */
let lastSample = new Map();

/** Reset the speed baseline (test hook). */
export function resetNetBaseline() {
  lastSample = new Map();
}

/**
 * Map iface → IPv4 address from `ip -4 addr show`. Empty when unavailable.
 * @param {(cmd: string) => Promise<string>} exec
 * @returns {Promise<Map<string, string>>}
 */
async function getInterfaceIpMap(exec) {
  const map = new Map();
  try {
    const out = await exec("ip -4 addr show 2>/dev/null");
    const blocks = out.split(/\n(?=\d+:\s+)/);
    for (const block of blocks) {
      const first = block.split("\n")[0];
      const m = first.match(/^\d+:\s+(\S+):/);
      if (!m) continue;
      const ipMatch = block.match(/inet\s+([\d.]+)/);
      if (ipMatch) map.set(m[1], ipMatch[1]);
    }
  } catch {
    /* ip tool optional */
  }
  return map;
}

/**
 * Link speed from /sys/class/net/<iface>/speed (Mbps). null when unknown.
 * @param {string} iface
 * @param {(path: string) => Promise<string>} readFile
 * @returns {Promise<number | null>}
 */
async function readLinkSpeed(iface, readFile) {
  try {
    const n = parseInt((await readFile(`/sys/class/net/${iface}/speed`)).trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Collect per-interface network metrics.
 * @param {{ exec?: (cmd: string) => Promise<string>, readFile?: (path: string) => Promise<string>, now?: () => number }} [deps]
 * @returns {Promise<Array<{iface:string, ip:string|null, rxSpeed:number, txSpeed:number, linkSpeedMbps:number|null}>>}
 */
export async function collectNet({ exec = runShell, readFile = readTextFile, now = Date.now } = {}) {
  try {
    const raw = await readFile("/proc/net/dev");
    const ipMap = await getInterfaceIpMap(exec);
    const t = now();
    /** @type {Array<{iface:string, ip:string|null, rxSpeed:number, txSpeed:number, linkSpeedMbps:number|null}>} */
    const out = [];

    for (const line of raw.split("\n").slice(2)) {
      const parts = line.trim().split(/[\s:]+/);
      if (parts.length < 17) continue;
      const iface = parts[0];
      if (VIRTUAL_IFACE_RE.test(iface)) continue;

      const rxBytes = parseInt(parts[1], 10) || 0;
      const txBytes = parseInt(parts[9], 10) || 0;
      const last = lastSample.get(iface);
      let rxSpeed = 0;
      let txSpeed = 0;
      if (last && t > last.time) {
        const dtSec = (t - last.time) / 1000;
        rxSpeed = (rxBytes - last.rxBytes) / dtSec;
        txSpeed = (txBytes - last.txBytes) / dtSec;
      }
      lastSample.set(iface, { rxBytes, txBytes, time: t });

      out.push({
        iface,
        ip: ipMap.get(iface) || null,
        rxSpeed: Math.max(0, Math.round((rxSpeed / MB) * 100) / 100),
        txSpeed: Math.max(0, Math.round((txSpeed / MB) * 100) / 100),
        linkSpeedMbps: await readLinkSpeed(iface, readFile),
      });
    }
    return out;
  } catch {
    return [];
  }
}
