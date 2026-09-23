/**
 * cpu.js — CPU metrics from /proc/stat + /sys (thermal, powercap).
 *
 * Seam type: CpuMetrics (shared/types.ts). Usage is a delta against the
 * previous call's /proc/stat counters (first call → 0, no baseline).
 *
 * Power: sysfs avg_power (thermal zone0, then any hwmon power1_input) when
 * present; otherwise the usage-based estimate used by sparkDash
 * SystemCollector on ARM. TDP: /sys/class/powercap CPU entry (power_limit,
 * mW) when present, else the GB10 default 65W.
 */
import fs from "node:fs";
import { readTextFile } from "./util.js";

const GB10_TDP_W = 65;

/** Previous /proc/stat sample (module-level baseline). */
let lastStat = null;

/** Reset the usage baseline (test hook). */
export function resetCpuBaseline() {
  lastStat = null;
}

/**
 * Parse the aggregate "cpu " line of /proc/stat.
 * @param {string} raw
 * @returns {{total:number, used:number} | null}
 */
export function parseCpuStat(raw) {
  const lines = String(raw).split("\n");
  const cpuLine = lines.find((l) => l.startsWith("cpu "));
  if (!cpuLine) return null;
  const parts = cpuLine.split(/\s+/).slice(1).map((s) => Number(s) || 0);
  const [user, nice, system, idle, iowait, irq, softirq, steal] = parts;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  const used = total - idle - iowait;
  return { total, used };
}

/**
 * First plausible temperature: zone0, then any thermal zone (mirror of
 * SystemCollector._getCPUTemperature). Raw mC → Celsius. 0 when unreadable.
 * @param {(path: string) => Promise<string>} readFile
 * @returns {Promise<number>}
 */
async function readCpuTemp(readFile) {
  /** @type {string[]} */
  const zones = ["thermal_zone0"];
  try {
    for (const z of fs.readdirSync("/sys/class/thermal")) {
      if (z.startsWith("thermal_zone")) zones.push(z);
    }
  } catch {
    /* sysfs absent — zone0 attempt below still runs */
  }
  for (const z of new Set(zones)) {
    try {
      const raw = await readFile(`/sys/class/thermal/${z}/temp`);
      const t = parseInt(raw.trim(), 10);
      if (Number.isFinite(t) && t > 0 && t < 200000) {
        return Math.round((t / 1000) * 10) / 10;
      }
    } catch {
      /* next zone */
    }
  }
  return 0;
}

/**
 * TDP + power draw. TDP from powercap (name contains "cpu", power_limit mW),
 * else GB10 65W. Draw from zone0 power/avg_power or any hwmon power1_input
 * (mW); else idle+usage estimate (SystemCollector ARM formula).
 * @param {(path: string) => Promise<string>} readFile
 * @param {number} usageFraction 0–1
 * @returns {Promise<{draw:number, tdp:number}>}
 */
async function readCpuPower(readFile, usageFraction) {
  let tdp = GB10_TDP_W;
  try {
    for (const cap of fs.readdirSync("/sys/class/powercap")) {
      let name = "";
      try {
        name = (await readFile(`/sys/class/powercap/${cap}/name`)).trim().toLowerCase();
      } catch {
        continue;
      }
      if (!name.includes("cpu")) continue;
      try {
        const mW = parseInt((await readFile(`/sys/class/powercap/${cap}/power_limit`)).trim(), 10);
        if (Number.isFinite(mW) && mW > 0) {
          tdp = Math.round(mW / 1000);
          break;
        }
      } catch {
        /* no power_limit on this cap */
      }
    }
  } catch {
    /* powercap absent */
  }

  let draw = null;
  try {
    const mW = parseInt((await readFile("/sys/class/thermal/thermal_zone0/power/avg_power")).trim(), 10);
    if (Number.isFinite(mW) && mW > 0) draw = mW / 1000;
  } catch {
    /* fall through to hwmon */
  }
  if (draw == null) {
    try {
      for (const h of fs.readdirSync("/sys/class/hwmon")) {
        try {
          const mW = parseInt((await readFile(`/sys/class/hwmon/${h}/power1_input`)).trim(), 10);
          if (Number.isFinite(mW) && mW > 0) {
            draw = mW / 1000;
            break;
          }
        } catch {
          /* next sensor */
        }
      }
    } catch {
      /* hwmon absent */
    }
  }
  if (draw == null) {
    const frac = Number.isFinite(usageFraction) ? Math.min(1, Math.max(0, usageFraction)) : 0;
    const idleWatts = tdp * 0.08;
    draw = idleWatts + (tdp - idleWatts) * frac;
  }
  return { draw: Math.round(draw * 10) / 10, tdp };
}

/**
 * Collect CPU metrics.
 * @param {{ readFile?: (path: string) => Promise<string>, now?: () => number }} [deps]
 * @returns {Promise<{usage:number, temperature:number, draw:number, tdp:number} | null>}
 */
export async function collectCpu({ readFile = readTextFile, now = Date.now } = {}) {
  try {
    const raw = await readFile("/proc/stat");
    const cur = parseCpuStat(raw);
    if (!cur || !Number.isFinite(cur.total) || cur.total <= 0 || cur.used < 0 || cur.used > cur.total) {
      return null;
    }

    let usage = 0;
    let usageFraction = 0;
    if (lastStat && cur.total > lastStat.total) {
      const totalDiff = cur.total - lastStat.total;
      const usedDiff = cur.used - lastStat.used;
      usageFraction = usedDiff / totalDiff;
      usage = Math.min(100, Math.max(0, Math.round(usageFraction * 100)));
    }
    lastStat = { ...cur, time: now() };

    const [temperature, power] = await Promise.all([
      readCpuTemp(readFile),
      readCpuPower(readFile, usageFraction),
    ]);

    return { usage, temperature, draw: power.draw, tdp: power.tdp };
  } catch {
    return null;
  }
}
