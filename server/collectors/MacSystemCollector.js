import { SystemCollector, tagCollectionResult } from "./SystemCollector.js";
import { sshExec } from "./ssh.js";

/**
 * MacSystemCollector — hardware metrics for an Apple Silicon Mac (unit kind
 * "mac"), always read over SSH with stock macOS tools. It returns the same
 * shapes as SystemCollector so poll loops and the UI need no new data paths.
 *
 * Non-privileged reads are batched into one SSH call per short window
 * (`_snapshot`). GPU activity and power come from `powermetrics`, which needs
 * passwordless `sudo -n`; when that is refused the GPU fields stay at their
 * defaults and the probe backs off instead of retrying every poll.
 */

const SNAPSHOT_TTL_MS = 1500;
const POWERMETRICS_BACKOFF_MS = 5 * 60 * 1000;
const MB = 1024 * 1024;

const SECTION = "__SPARKDASH_SECTION__";

/** Shell snippet run on the Mac; each section is prefixed with a sentinel line. */
const SNAPSHOT_CMD = [
  `echo ${SECTION}sysctl`,
  "sysctl hw.memsize hw.pagesize vm.swapusage kern.boottime 2>/dev/null",
  `echo ${SECTION}vm_stat`,
  "vm_stat 2>/dev/null",
  `echo ${SECTION}top`,
  "top -l 1 -n 0 -s 0 2>/dev/null | grep -E '^CPU usage'",
  `echo ${SECTION}df`,
  "df -k / /System/Volumes/Data 2>/dev/null",
  `echo ${SECTION}netstat`,
  "IF=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}'); [ -n \"$IF\" ] && netstat -ib -I \"$IF\" 2>/dev/null; [ -n \"$IF\" ] && echo \"ip $(ipconfig getifaddr \"$IF\" 2>/dev/null)\"",
].join("; ");

const POWERMETRICS_CMD =
  "sudo -n powermetrics -n 1 -i 500 --samplers gpu_power,cpu_power,thermal 2>/dev/null";

/** Split sentinel-delimited output into { name: text }. */
export function splitSections(output) {
  const sections = {};
  let current = null;
  for (const line of String(output || "").split("\n")) {
    if (line.startsWith(SECTION)) {
      current = line.slice(SECTION.length).trim();
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
    }
  }
  return Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.join("\n")]));
}

/** Parse `sysctl name: value` lines into a map. */
export function parseSysctl(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

/** Boot epoch seconds from `kern.boottime` ("{ sec = 1790650919, usec = ... } ..."). */
export function parseBootTime(value) {
  const m = String(value || "").match(/sec\s*=\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** Swap usage in MB from `vm.swapusage` ("total = 1024.00M  used = 77.94M ..."). */
export function parseSwapUsage(value) {
  const grab = (key) => {
    const m = String(value || "").match(new RegExp(`${key}\\s*=\\s*([\\d.]+)([KMG])`));
    if (!m) return 0;
    const n = parseFloat(m[1]);
    return Math.round(m[2] === "G" ? n * 1024 : m[2] === "K" ? n / 1024 : n);
  };
  return { total: grab("total"), used: grab("used"), free: grab("free") };
}

/** Parse `vm_stat` output into page counts plus the page size in bytes. */
export function parseVmStat(text) {
  const src = String(text || "");
  const pageSizeMatch = src.match(/page size of (\d+) bytes/);
  const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 16384;
  const pages = (label) => {
    const m = src.match(new RegExp(`${label}:\\s+(\\d+)`));
    return m ? parseInt(m[1], 10) : 0;
  };
  return {
    pageSize,
    free: pages("Pages free"),
    active: pages("Pages active"),
    inactive: pages("Pages inactive"),
    speculative: pages("Pages speculative"),
    wired: pages("Pages wired down"),
    compressed: pages("Pages occupied by compressor"),
    purgeable: pages("Pages purgeable"),
    anonymous: pages("Anonymous pages"),
    fileBacked: pages("File-backed pages"),
  };
}

/**
 * Unified memory in MB, counted like Activity Monitor's "Memory Used":
 * app memory (anonymous pages minus purgeable) + wired + compressor pages.
 * File-backed cache counts as available. Metal wires GPU allocations (MLX
 * weights, KV cache) while they are in use, but an idle MLX server's model can
 * be un-wired back into ordinary anonymous memory without being freed, so
 * wired alone is not "memory in use". `gpuUsed` is the currently wired share.
 */
export function unifiedMemoryFromVmStat(vm, memsizeBytes) {
  const toMB = (count) => Math.round((count * vm.pageSize) / MB);
  const total = Math.round((Number(memsizeBytes) || 0) / MB);
  // Older vm_stat builds without an "Anonymous pages" line: fall back to active.
  const appPages = vm.anonymous > 0 ? Math.max(0, vm.anonymous - vm.purgeable) : vm.active;
  const gpuUsed = toMB(vm.wired);
  const cpuUsed = toMB(appPages + vm.compressed);
  const used = Math.min(total || Infinity, gpuUsed + cpuUsed);
  const available = Math.max(0, total - used);
  const percentage = total > 0 ? Math.round((used / total) * 100) : 0;
  const oomRisk = percentage > 85 ? "high" : percentage > 60 ? "medium" : "low";
  return { total, gpuUsed, cpuUsed, used, available, percentage, oomRisk };
}

/** CPU usage percentage from top's "CPU usage: 2.0% user, 6.25% sys, 91.74% idle". */
export function parseTopCpu(text) {
  const m = String(text || "").match(/([\d.]+)%\s+idle/);
  if (!m) return null;
  return Math.max(0, Math.min(100, Math.round(100 - parseFloat(m[1]))));
}

/** Disks (MB, like SystemCollector) from `df -k`; the sealed system volume is skipped in favour of the data volume. */
export function parseDf(text, disabledDevices = []) {
  const disks = [];
  for (const line of String(text || "").split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const mount = parts.slice(8).join(" ") || parts[parts.length - 1];
    const [fsys, size, used, avail, pct] = parts;
    if (!mount.startsWith("/")) continue;
    if (mount === "/" && String(text).includes("/System/Volumes/Data")) continue;
    const device = fsys.split("/").pop() || fsys;
    disks.push({
      device,
      label: mount,
      used: Math.round(parseInt(used, 10) / 1024),
      total: Math.round(parseInt(size, 10) / 1024),
      available: Math.round(parseInt(avail, 10) / 1024),
      percentage: parseInt(pct, 10) || 0,
      readSpeed: 0,
      writeSpeed: 0,
      disabled: disabledDevices.includes(device) || disabledDevices.includes(mount),
    });
  }
  return disks;
}

/** Byte counters for the link-level row of `netstat -ib -I <iface>`. */
export function parseNetstatBytes(text) {
  for (const line of String(text || "").split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 11 && /^<Link#\d+>$/.test(parts[2])) {
      return { name: parts[0], rxBytes: parseInt(parts[6], 10) || 0, txBytes: parseInt(parts[9], 10) || 0 };
    }
  }
  return null;
}

/** GPU, CPU and thermal readings from `powermetrics` text output. */
export function parsePowermetrics(text) {
  const src = String(text || "");
  const num = (re) => {
    const m = src.match(re);
    return m ? parseFloat(m[1]) : null;
  };
  const mw = (re) => {
    const v = num(re);
    return v == null ? null : Math.round(v / 100) / 10; // mW -> W, one decimal
  };
  const pressure = src.match(/Current pressure level:\s*(\w+)/);
  return {
    gpuActivePct: num(/GPU HW active residency:\s*([\d.]+)%/),
    gpuFreqMHz: num(/GPU HW active frequency:\s*([\d.]+)\s*MHz/),
    gpuW: mw(/GPU Power:\s*([\d.]+)\s*mW/),
    cpuW: mw(/CPU Power:\s*([\d.]+)\s*mW/),
    aneW: mw(/ANE Power:\s*([\d.]+)\s*mW/),
    combinedW: mw(/Combined Power \(CPU \+ GPU \+ ANE\):\s*([\d.]+)\s*mW/),
    thermalPressure: pressure ? pressure[1] : null,
  };
}

/**
 * What a Mac GPU reading actually measured. The base collector's default marks
 * every field unavailable (no GPU found), which the UI renders as "—"; a Mac
 * always measures unified memory, and GPU busy/power only through powermetrics.
 * A Mac has no GPU power limit.
 */
export function macGpuAvailability({ powermetrics, temperature, usage, powerDraw, memory }) {
  return {
    temperature: temperature != null,
    usage: Boolean(powermetrics) && (usage === undefined || Number.isFinite(usage)),
    powerDraw: Boolean(powermetrics) && (powerDraw === undefined || Number.isFinite(powerDraw)),
    powerLimit: false,
    vramUsed: memory === undefined || memory > 0,
    vramTotal: memory === undefined || memory > 0,
  };
}

export class MacSystemCollector extends SystemCollector {
  /**
   * @param {object} spark
   * @param {{ exec?: typeof sshExec }} [options] exec is the SSH runner (a test seam).
   */
  constructor(spark, { exec = sshExec } = {}) {
    super(spark, { exec });
    /** @type {{ at: number, data: Record<string, string> } | null} */
    this._snapshotCache = null;
    /** @type {Promise<Record<string, string>> | null} */
    this._snapshotInflight = null;
    this._lastNet = null;
    this._lastPower = null;
    this._powermetricsBlockedUntil = 0;
  }

  _defaultGpu() {
    return { ...super._defaultGpu(), temperature: null, unavailable: [
      { metric: "gpu.temperature", reason: "temperature is not reported by this Mac" },
    ] };
  }

  _defaultCpu() {
    return { ...super._defaultCpu(), temperature: null, usageAvailable: false };
  }

  /** One batched SSH read shared by every collector call inside the TTL. */
  async _snapshot() {
    const now = Date.now();
    if (this._snapshotCache && now - this._snapshotCache.at < SNAPSHOT_TTL_MS) {
      return this._snapshotCache.data;
    }
    if (this._snapshotInflight) return this._snapshotInflight;
    // A Mac with no default route makes the trailing `[ -n "$IF" ] && ...`
    // guard exit nonzero even though every section printed. Keep the output.
    this._snapshotInflight = this._sshExec(this.spark, SNAPSHOT_CMD, { allowNonZeroExit: true })
      .then((out) => {
        const data = splitSections(out);
        this._snapshotCache = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        this._snapshotInflight = null;
      });
    return this._snapshotInflight;
  }

  async _powermetrics() {
    if (Date.now() < this._powermetricsBlockedUntil) return this._lastPower;
    try {
      const out = await this._sshExec(this.spark, POWERMETRICS_CMD, { timeoutMs: 8000 });
      const parsed = parsePowermetrics(out);
      if (parsed.gpuActivePct == null && parsed.combinedW == null) {
        // sudo refused or powermetrics unavailable: stop asking for a while.
        this._powermetricsBlockedUntil = Date.now() + POWERMETRICS_BACKOFF_MS;
        this._lastPower = null;
        return null;
      }
      this._lastPower = parsed;
      return parsed;
    } catch {
      this._powermetricsBlockedUntil = Date.now() + POWERMETRICS_BACKOFF_MS;
      this._lastPower = null;
      return null;
    }
  }

  async _unified(snap) {
    snap = snap ?? (await this._snapshot());
    const sys = parseSysctl(snap.sysctl);
    return unifiedMemoryFromVmStat(parseVmStat(snap.vm_stat), sys["hw.memsize"]);
  }

  async collectGpu() {
    try {
      const [power, mem] = await Promise.all([this._powermetrics(), this._unified()]);
      const base = this._defaultGpu();
      if (!power) {
        return tagCollectionResult({
          ...base,
          usage: null,
          power: { draw: null, limit: 0, systemDraw: null },
          vram: { used: mem.used, total: mem.total, percentage: mem.percentage, available: mem.available },
          powermetricsAvailable: false,
          metricAvailability: macGpuAvailability({ powermetrics: false, temperature: null }),
        }, mem.total > 0);
      }
      const thermal = power.thermalPressure && power.thermalPressure !== "Nominal";
      return tagCollectionResult({
        ...base,
        temperature: null,
        usage: Number.isFinite(power.gpuActivePct) ? Math.round(power.gpuActivePct) : null,
        power: {
          draw: Number.isFinite(power.gpuW) ? power.gpuW : null,
          limit: 0,
          systemDraw: Number.isFinite(power.combinedW) ? power.combinedW : null,
        },
        vram: { used: mem.used, total: mem.total, percentage: mem.percentage, available: mem.available },
        processes: [],
        throttle: this._buildThrottle({ swThermal: thermal, smClockMHz: power.gpuFreqMHz }),
        thermalPressure: power.thermalPressure,
        powermetricsAvailable: true,
        metricAvailability: macGpuAvailability({ powermetrics: true, temperature: null, usage: power.gpuActivePct, powerDraw: power.gpuW, memory: mem.total }),
      }, mem.total > 0);
    } catch (err) {
      console.error(`[MacSystemCollector] GPU error for ${this.spark.id}:`, err.message);
      return this._defaultGpu();
    }
  }

  async collectCpu() {
    try {
      const snap = await this._snapshot();
      const parsedUsage = parseTopCpu(snap.top);
      const valid = parsedUsage != null && Number.isFinite(parsedUsage);
      const usage = valid ? parsedUsage : null;
      this.lastCpuUsagePct = usage;
      const draw = Number.isFinite(this._lastPower?.cpuW) ? this._lastPower.cpuW : null;
      return tagCollectionResult({ usage, usageAvailable: valid, temperature: null, draw, tdp: 0 }, valid);
    } catch (err) {
      console.error(`[MacSystemCollector] CPU error for ${this.spark.id}:`, err.message);
      return this._defaultCpu();
    }
  }

  async collectRam() {
    try {
      const snap = await this._snapshot();
      const mem = await this._unified(snap);
      const swap = parseSwapUsage(parseSysctl(snap.sysctl)["vm.swapusage"]);
      return { used: mem.used, total: mem.total, percentage: mem.percentage, swap };
    } catch (err) {
      console.error(`[MacSystemCollector] RAM error for ${this.spark.id}:`, err.message);
      return this._defaultRam();
    }
  }

  async collectUnifiedMemory() {
    try {
      const mem = await this._unified();
      return { ...mem, bandwidth: { current: 0, peak: 0 } };
    } catch (err) {
      console.error(`[MacSystemCollector] Unified memory error for ${this.spark.id}:`, err.message);
      return this._defaultUnifiedMemory();
    }
  }

  async collectStorage() {
    try {
      const snap = await this._snapshot();
      return parseDf(snap.df, this.spark.disabledDevices || []);
    } catch (err) {
      console.error(`[MacSystemCollector] Storage error for ${this.spark.id}:`, err.message);
      return [];
    }
  }

  async collectNetwork() {
    try {
      const snap = await this._snapshot();
      const counters = parseNetstatBytes(snap.netstat);
      if (!counters) return this._defaultNetwork();
      const ipMatch = String(snap.netstat || "").match(/^ip\s+([\d.]+)/m);
      const now = Date.now();
      const last = this._lastNet && this._lastNet.name === counters.name ? this._lastNet : null;
      const dtSec = last ? (now - last.time) / 1000 : 0;
      const rxSpeed = dtSec > 0 ? (counters.rxBytes - last.rxBytes) / dtSec : 0;
      const txSpeed = dtSec > 0 ? (counters.txBytes - last.txBytes) / dtSec : 0;
      this._lastNet = { ...counters, time: now };
      const interfaces = this._tagDisabledInterfaces([
        {
          name: counters.name,
          rxSpeed: Math.max(0, Math.round(rxSpeed)),
          txSpeed: Math.max(0, Math.round(txSpeed)),
          ip: ipMatch ? ipMatch[1] : null,
          operstate: "up",
          disabled: false,
        },
      ]);
      return { primaryInterface: counters.name, linkSpeedMbps: null, interfaces, wolMac: null };
    } catch (err) {
      console.error(`[MacSystemCollector] Network error for ${this.spark.id}:`, err.message);
      return this._defaultNetwork();
    }
  }

  /** Boot epoch seconds, or null. Used for uptime. */
  async readBootTime() {
    const snap = await this._snapshot();
    return parseBootTime(parseSysctl(snap.sysctl)["kern.boottime"]);
  }

  async detectHardware() {
    try {
      const out = await this._sshExec(
        this.spark,
        "sysctl hw.model hw.ncpu hw.memsize hw.perflevel0.physicalcpu hw.perflevel1.physicalcpu machdep.cpu.brand_string 2>/dev/null"
      );
      const sys = parseSysctl(out);
      const chip = sys["machdep.cpu.brand_string"] || null;
      const cores = parseInt(sys["hw.ncpu"] || "", 10);
      const memBytes = Number(sys["hw.memsize"]) || 0;
      return {
        device: sys["hw.model"] ? `Mac (${sys["hw.model"]})` : "Apple Silicon Mac",
        cpuModel: chip,
        cpuCores: Number.isInteger(cores) && cores > 0 ? cores : null,
        totalMemoryGB: memBytes > 0 ? Math.round(memBytes / 1024 ** 3) : null,
        gpuChip: chip,
        cudaDriver: null,
      };
    } catch {
      return null;
    }
  }

  /** Mac units are always remote; liveness goes through the SSH test path. */
  async pingHost() {
    await this._sshExec(this.spark, "true");
    return true;
  }
}
