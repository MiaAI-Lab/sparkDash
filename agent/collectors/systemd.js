/**
 * systemd.js — running systemd services via systemctl.
 *
 * SystemdUnit[] (Batch 1A working type; no NodeAgentSnapshot field yet —
 * surfaced as the extra `systemd` snapshot property and reused by Batch 1B
 * service catalog).
 *
 * Uptime: one `systemctl show -p ActiveEnterTimestampMonotonic` for all
 * running units (monotonic microseconds), deltaed against /proc/uptime —
 * timezone-independent, no per-unit exec.
 */
import { runShell, readTextFile, parseUptimeSeconds } from "./util.js";

/**
 * Collect running systemd services.
 * @param {{ exec?: (cmd: string) => Promise<string>, readFile?: (path: string) => Promise<string> }} [deps]
 * @returns {Promise<Array<{name:string, status:string, uptimeSeconds:number|null}>>}
 */
export async function collectSystemd({ exec = runShell, readFile = readTextFile } = {}) {
  try {
    const out = await exec(
      "systemctl list-units --type=service --state=running --no-pager --no-legend --plain 2>/dev/null"
    );
    /** @type {string[]} */
    const names = [];
    for (const line of out.split("\n")) {
      const m = line.match(/^(\S+\.service)\s/);
      if (m && !names.includes(m[1])) names.push(m[1]);
    }
    if (names.length === 0) return [];

    const upSec = parseUptimeSeconds(await readFile("/proc/uptime").catch(() => null));
    const enterUs = new Map();
    try {
      const tsOut = await exec(
        "systemctl show --type=service --state=running --no-pager --no-legend -p ActiveEnterTimestampMonotonic 2>/dev/null"
      );
      for (const line of String(tsOut).split("\n")) {
        const i = line.indexOf("=");
        if (i <= 0) continue;
        const name = line.slice(0, i).trim();
        const v = parseInt(line.slice(i + 1).trim(), 10);
        if (name && Number.isFinite(v) && v > 0) enterUs.set(name, v);
      }
    } catch {
      /* uptime stays null */
    }

    return names.map((name) => {
      let uptimeSeconds = null;
      const u = enterUs.get(name);
      if (u != null && upSec != null) {
        const s = Math.round((upSec * 1000000 - u) / 1000000);
        if (s >= 0) uptimeSeconds = s;
      }
      return { name, status: "running", uptimeSeconds };
    });
  } catch {
    return [];
  }
}
