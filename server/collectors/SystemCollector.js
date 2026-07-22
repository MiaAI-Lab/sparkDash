import fs from "fs";
import path from "path";
import { HOST_PATHS, GPU_MEMORY_JSON_PATH, DGX_SPARK, HARDWARE_DEFAULTS } from "../config.js";
import { normalizeMac, WOL_INTERFACE } from "../wol.js";
import { sshExec } from "./ssh.js";

/**
 * SystemCollector — collects hardware metrics for a Spark.
 * In Phase 2, this is the LOCAL path only (no SSH).
 * Remote path added in Phase 3.
 */
export class SystemCollector {
  constructor(spark) {
    this.spark = spark;
    this._nvidiaSmiPath = this._resolveNvidiaSmiPath();

    // Rate-tracking baselines
    this.lastNetworkStats = new Map();
    this.lastCpuStat = null;
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

    // Cached hardware info
    this._hardwareInfo = null;
  }

  /** Collect GPU metrics (temperature, usage, power, VRAM). */
  async collectGpu() {
    if (!this.spark.isLocal) return this._getRemoteGpu();
    try {
      const gpuData = await this._getGPUAll();
      return gpuData;
    } catch (err) {
      console.error(`[SystemCollector] GPU error for ${this.spark.id}:`, err.message);
      return this._defaultGpu();
    }
  }

  /** Collect CPU metrics (usage, temperature, power). */
  async collectCpu() {
    if (!this.spark.isLocal) return this._getRemoteCpu();
    try {
      // Read /proc/stat once and compute usage BEFORE estimating power.
      // Previously _getCPUPower re-read /proc/stat in parallel with _getCPUUsage,
      // racing on lastCpuStat and producing 0% (idle power) on the first poll.
      const usage = await this._getCPUUsage();
      const totalDiff = usage.total - (this.lastCpuStat?.total || usage.total);
      const usedDiff = usage.used - (this.lastCpuStat?.used || usage.used);
      const cpuPercentage = totalDiff > 0 ? Math.round((usedDiff / totalDiff) * 100) : 0;
      const usageFraction = totalDiff > 0 ? usedDiff / totalDiff : 0;
      this.lastCpuStat = usage;
      this.lastCpuUsagePct = cpuPercentage;

      // Temperature and power can run in parallel — power is now a pure
      // function of the usage fraction (no extra /proc/stat read).
      const [temp, power] = await Promise.all([
        this._getCPUTemperature(),
        this._getCPUPower(usageFraction),
      ]);
      return { usage: cpuPercentage, temperature: temp, ...power };
    } catch (err) {
      console.error(`[SystemCollector] CPU error for ${this.spark.id}:`, err.message);
      return this._defaultCpu();
    }
  }

  /** Collect RAM metrics. */
  async collectRam() {
    if (!this.spark.isLocal) return this._getRemoteRam();
    try {
      return await this._getRamUsage();
    } catch (err) {
      console.error(`[SystemCollector] RAM error for ${this.spark.id}:`, err.message);
      return this._defaultRam();
    }
  }

  /** Collect storage metrics per mount. */
  async collectStorage() {
    if (!this.spark.isLocal) return this._getRemoteStorage();
    try {
      return await this._getDiskUsage();
    } catch (err) {
      console.error(`[SystemCollector] Storage error for ${this.spark.id}:`, err.message);
      return [];
    }
  }

  /** Collect network metrics (interfaces, speeds). */
  async collectNetwork() {
    if (!this.spark.isLocal) return this._getRemoteNetwork();
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

  /** Collect unified memory metrics. */
  async collectUnifiedMemory() {
    if (!this.spark.isLocal) return this._getRemoteUnifiedMemory();
    try {
      return await this._getUnifiedMemory();
    } catch (err) {
      console.error(`[SystemCollector] Unified memory error for ${this.spark.id}:`, err.message);
      return this._defaultUnifiedMemory();
    }
  }

  // ─── GPU helpers ─────────────────────────────────────────
  async _getGPUAll() {
    const gpuOut = await this._nvidiaSmi(
      "--query-gpu=temperature.gpu,utilization.gpu,power.draw,power.limit --format=csv,noheader,nounits"
    );
    const gpu = this._parseGpuLine(gpuOut);
    const vram = await this._queryNvidiaVram();

    // Estimate total system power: GPU draw + CPU draw + ~20W CX7/peripherals
    let systemDraw = gpu.powerDraw;
    try {
      const cpuPower = await this._getCPUPower();
      systemDraw += cpuPower.draw;
    } catch {}
    systemDraw += 20; // CX7 NIC + peripherals estimate
    systemDraw = Math.round(systemDraw);

    // Top 5 GPU processes by VRAM usage
    const processes = Array.from(this.nvidiaComputeAppsCache.entries())
      .map(([pid, info]) => ({ pid, name: info.name, vramMB: info.vramMB }))
      .sort((a, b) => b.vramMB - a.vramMB)
      .slice(0, 5);

    return {
      temperature: gpu.temperature,
      usage: gpu.usage,
      power: { draw: gpu.powerDraw, limit: gpu.powerLimit, systemDraw },
      vram,
      processes,
    };
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
      const line = memOut.trim().split("\n").filter(Boolean)[0] || "";
      const parts = line.split(",").map((s) => s.trim());
      used = this._parseSmiNumber(parts[0]);
      total = this._parseSmiNumber(parts[1]);
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
              "--query-compute-apps=pid,process_name,used_gpu_memory --format=csv,noheader,nounits"
            );
      const apps = this._parseComputeApps(raw);
      this.nvidiaComputeAppsCache.clear();
      for (const app of apps) {
        this.nvidiaComputeAppsCache.set(app.pid, { name: app.name, vramMB: app.vramMB });
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
          this.nvidiaComputeAppsCache.set(pid, { name, vramMB });
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

    // Prefer the OS-visible pool (MemTotal) as the total; fall back to the nvidia-smi
    // value, then the hardware spec (HBM) only if nothing else is known.
    if (memTotalMB > 0) {
      total = memTotalMB;
    } else if (total == null || total === 0) {
      total = DGX_SPARK.MEMORY_HBM_SIZE_GB * 1024; // Convert to MB
    }

    const usedMB = Math.round(used || 0);
    const totalMB = Math.round(total || 0);
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

  _parseGpuLine(output) {
    const lines = output.trim().split("\n").filter(Boolean);
    if (!lines[0]) return { temperature: 0, usage: 0, powerDraw: 0, powerLimit: 120 };
    const parts = lines[0].split(",").map((s) => s.trim());
    const temperature = parseFloat(parts[0]) || 0;
    const usage = parseFloat(parts[1]) || 0;
    const powerDraw = parseFloat(parts[2]) || 0;
    const powerLimit = parseFloat(parts[3]) || 120;
    return { temperature, usage, powerDraw, powerLimit };
  }

  _parseComputeApps(output) {
    const lines = output.trim().split("\n").filter(Boolean);
    return lines
      .map((line) => {
        const parts = line.split(",").map((s) => s.trim());
        // Format: pid,process_name,used_gpu_memory
        return {
          pid: parseInt(parts[0]) || 0,
          name: parts[1] || "unknown",
          vramMB: this._parseSmiNumber(parts[2]) || 0,
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

  async _getCPUTemperature() {
    // Try hwmon sysfs first
    try {
      const hwmonDir = path.join(HOST_PATHS.SYS, "class/hwmon");
      if (fs.existsSync(hwmonDir)) {
        const entries = fs.readdirSync(hwmonDir);
        for (const entry of entries) {
          const nameFile = path.join(hwmonDir, entry, "name");
          if (fs.existsSync(nameFile)) {
            const name = fs.readFileSync(nameFile, "utf-8").trim();
            if (["coretemp", "k10temp", "zenpower", "acpitz"].includes(name)) {
              const tempFiles = fs.readdirSync(path.join(hwmonDir, entry)).filter((f) => f.startsWith("temp") && f.endsWith("_input"));
              if (tempFiles.length > 0) {
                const tempRaw = parseInt(fs.readFileSync(path.join(hwmonDir, entry, tempFiles[0]), "utf-8").trim());
                if (tempRaw > 0 && tempRaw < 200000) return tempRaw / 1000;
              }
            }
          }
        }
      }
    } catch {}

    // Try thermal zones
    try {
      const thermalDir = path.join(HOST_PATHS.SYS, "class/thermal");
      if (fs.existsSync(thermalDir)) {
        const zones = fs.readdirSync(thermalDir).filter((z) => z.startsWith("thermal_zone"));
        for (const zone of zones) {
          const tempFile = path.join(thermalDir, zone, "temp");
          if (fs.existsSync(tempFile)) {
            const temp = parseInt(fs.readFileSync(tempFile, "utf-8").trim());
            if (temp > 0 && temp < 200000) return temp / 1000;
          }
        }
      }
    } catch {}

    return 0;
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
      output = await this._exec("lsblk -P -no NAME,SIZE,MOUNTPOINT,FSTYPE 2>/dev/null");
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

  /** Get disk I/O speeds from /sys/block/<dev>/stat */
  async _getDiskIO(dev) {
    try {
      const sysPath = fs.existsSync(HOST_PATHS.SYS)
        ? path.join(HOST_PATHS.SYS, "block", dev, "stat")
        : path.join("/sys/block", dev, "stat");
      const raw = fs.readFileSync(sysPath, "utf-8").trim();
      const fields = raw.split(/\s+/);
      const sectorsRead = parseInt(fields[2]) || 0;
      const sectorsWritten = parseInt(fields[6]) || 0;
      const now = Date.now();

      const last = this.lastDiskIO.get(dev);
      this.lastDiskIO.set(dev, { sectorsRead, sectorsWritten, time: now });

      if (!last) return { readSpeed: 0, writeSpeed: 0 };

      const dtMs = now - last.time;
      if (dtMs <= 0) return { readSpeed: 0, writeSpeed: 0 };

      const readSpeed = Math.round(((sectorsRead - last.sectorsRead) * 512 / dtMs) * 1000);
      const writeSpeed = Math.round(((sectorsWritten - last.sectorsWritten) * 512 / dtMs) * 1000);

      return {
        readSpeed: Math.max(0, readSpeed),
        writeSpeed: Math.max(0, writeSpeed),
      };
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
  async _execOnHostNet(cmd) {
    if (!this._hasHostProc()) {
      return this._exec(cmd);
    }
    const mntNs = path.join(HOST_PATHS.PROC, "1", "ns", "mnt");
    const netNs = path.join(HOST_PATHS.PROC, "1", "ns", "net");
    const { execFile } = await import("child_process");
    const args = ["--mount=" + mntNs, "--net=" + netNs, "--", "sh", "-c", cmd];
    return new Promise((resolve, reject) => {
      execFile("nsenter", args, { timeout: 8000 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(String(stdout).trim());
      });
    });
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
  async _getRemoteGpu() {
    try {
      const cmd = [
        "nvidia-smi --query-gpu=temperature.gpu,utilization.gpu,power.draw,power.limit --format=csv,noheader,nounits 2>/dev/null",
        "echo '---'",
        "nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null",
        "echo '---'",
        "nvidia-smi --query-compute-apps=pid,process_name,used_gpu_memory --format=csv,noheader,nounits 2>/dev/null",
        "echo '---'",
        "grep -E 'MemTotal|MemAvailable' /proc/meminfo 2>/dev/null",
      ].join("; ");

      const output = await sshExec(this.spark, cmd);
      const sections = output.split("---");
      const gpuOut = sections[0]?.trim() || "";
      const memFields = sections[1]?.trim() || "";
      const computeOut = sections[2]?.trim() || "";
      const meminfoOut = sections[3]?.trim() || "";

      const gpu = this._parseGpuLine(gpuOut);

      // Parse memory.used / memory.total from nvidia-smi (may be [N/A] on GB10)
      let used = null;
      let total = null;
      const memLine = memFields.split("\n").filter(Boolean)[0] || "";
      const memParts = memLine.split(",").map((s) => s.trim());
      used = this._parseSmiNumber(memParts[0]);
      total = this._parseSmiNumber(memParts[1]);

      const apps = this._parseComputeApps(computeOut);
      this.nvidiaComputeAppsCache.clear();
      let computeSum = 0;
      for (const app of apps) {
        this.nvidiaComputeAppsCache.set(app.pid, { name: app.name, vramMB: app.vramMB });
        computeSum += app.vramMB;
      }
      if ((used == null || used === 0) && computeSum > 0) used = computeSum;

      // Unified-memory pool: prefer MemTotal (OS-visible) so VRAM and Unified
      // Memory panels share the same base. Available = MemAvailable (real free).
      const totalMatch = meminfoOut.match(/MemTotal:\s+(\d+)\s+kB/);
      const availMatch = meminfoOut.match(/MemAvailable:\s+(\d+)\s+kB/);
      const memTotalMB = totalMatch ? Math.round(parseInt(totalMatch[1]) / 1024) : 0;
      const availableMB = availMatch ? Math.round(parseInt(availMatch[1]) / 1024) : 0;

      if (memTotalMB > 0) {
        total = memTotalMB;
      } else if (total == null || total === 0) {
        total = DGX_SPARK.MEMORY_HBM_SIZE_GB * 1024; // Convert to MB
      }

      const usedMB = Math.round(used || 0);
      const totalMB = Math.round(total || 0);
      const percentage = totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : 0;

      // Rough system power estimate: GPU draw + 20W CX7/peripherals
      const systemDraw = Math.round(gpu.powerDraw + 20);

      // Top 5 GPU processes by VRAM usage
      const processes = Array.from(this.nvidiaComputeAppsCache.entries())
        .map(([pid, info]) => ({ pid, name: info.name, vramMB: info.vramMB }))
        .sort((a, b) => b.vramMB - a.vramMB)
        .slice(0, 5);

      return {
        temperature: gpu.temperature,
        usage: gpu.usage,
        power: { draw: gpu.powerDraw, limit: gpu.powerLimit, systemDraw },
        vram: { used: usedMB, total: totalMB, percentage, available: availableMB },
        processes,
      };
    } catch (err) {
      console.error(`[SystemCollector] Remote GPU error for ${this.spark.id}:`, err.message);
      return this._defaultGpu();
    }
  }

  async _getRemoteCpu() {
    try {
      const cmd = [
        "cat /proc/stat | head -1",
        "echo '---'",
        "cat /proc/cpuinfo | grep -E 'CPU architecture|aarch64' | head -1",
      ].join("; ");

      const output = await sshExec(this.spark, cmd);
      const sections = output.split("---");
      const statOut = sections[0]?.trim() || "";
      const cpuinfoOut = sections[1]?.trim() || "";

      const cpuStat = this._parseCPUUsage(statOut);
      const totalDiff = cpuStat.total - (this.lastCpuStat?.total || cpuStat.total);
      const usedDiff = cpuStat.used - (this.lastCpuStat?.used || cpuStat.used);
      const usage = totalDiff > 0 ? Math.round((usedDiff / totalDiff) * 100) : 0;
      this.lastCpuStat = cpuStat;

      // ARM/Neoverse power estimation
      const isArm = /CPU architecture:\s*[89]|aarch64|ARMv[89]|armv[89]/i.test(cpuinfoOut);
      const tdp = isArm ? 65 : 185;
      const idleWatts = tdp * 0.08;
      const draw = idleWatts + (tdp - idleWatts) * Math.min(usage / 100, 1);

      return { usage, temperature: 0, draw: Math.round(draw * 10) / 10, tdp: Math.round(tdp) };
    } catch (err) {
      console.error(`[SystemCollector] Remote CPU error for ${this.spark.id}:`, err.message);
      return this._defaultCpu();
    }
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

  async _getRemoteStorage() {
    try {
      // Include root (/); exclude pseudo filesystems via -x and type filter
      const cmd =
        "df -l -B1 -T -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs -x proc -x sysfs -x devpts -x cgroup -x cgroup2 2>/dev/null";
      const output = await sshExec(this.spark, cmd);
      const lines = output.trim().split("\n").slice(1); // Skip header
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
        const isDisabled =
          disabledDevices.includes(device) || disabledDevices.includes(mount);

        disks.push({
          device,
          label: mount,
          used: Math.round(parseInt(used) / 1024 / 1024),
          total: Math.round(parseInt(size) / 1024 / 1024),
          available: Math.round(parseInt(avail) / 1024 / 1024),
          percentage: parseInt(pct) || 0,
          readSpeed: 0,
          writeSpeed: 0,
          disabled: isDisabled,
        });
      }

      return disks;
    } catch (err) {
      console.error(`[SystemCollector] Remote Storage error for ${this.spark.id}:`, err.message);
      return [];
    }
  }

  async _getRemoteNetwork() {
    try {
      const cmd = [
        "cat /proc/net/dev 2>/dev/null",
        "echo '---'",
        "cat /proc/net/route 2>/dev/null",
        "echo '---'",
        "ip -4 addr show 2>/dev/null",
        "echo '---'",
        // Collect operstate for all non-virtual interfaces in one go
        "for d in /sys/class/net/*/operstate; do echo \"$(basename $(dirname $d)):$(cat $d)\"; done",
        "echo '---'",
        // WoL MAC for the primary LAN NIC on DGX Spark
        `cat /sys/class/net/${WOL_INTERFACE}/address 2>/dev/null || true`,
      ].join("; ");

      const output = await sshExec(this.spark, cmd);
      const sections = output.split("---");
      const devOut = sections[0]?.trim() || "";
      const routeOut = sections[1]?.trim() || "";
      const ipOut = sections[2]?.trim() || "";
      const operstateOut = sections[3]?.trim() || "";
      const wolMac = normalizeMac(sections[4]?.trim() || "");

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

      let linkSpeedMbps = null;
      if (primaryInterface) {
        try {
          // Interface name is from the kernel; still keep it to safe chars
          if (/^[a-zA-Z0-9._-]+$/.test(primaryInterface)) {
            const speedRaw = await sshExec(
              this.spark,
              `cat /sys/class/net/${primaryInterface}/speed 2>/dev/null || true`
            );
            const n = parseInt(String(speedRaw).trim(), 10);
            if (Number.isFinite(n) && n > 0) linkSpeedMbps = n;
          }
        } catch {
          /* link speed optional */
        }
      }

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

  // ─── Host namespace / Docker helpers ──────────────────────
  /**
   * True when host proc is bind-mounted (Docker local metrics path).
   * Host PID 1 namespaces live under /host/proc/1/ns/*.
   */
  _hasHostProc() {
    return fs.existsSync(path.join(HOST_PATHS.PROC, "1", "ns", "mnt"));
  }

  /**
   * Run a command in the host mount (+pid) namespaces so tools like
   * nvidia-smi and lsblk see host driver libs and mount table.
   */
  async _execOnHost(cmd) {
    if (!this._hasHostProc()) {
      return this._exec(cmd);
    }
    const mntNs = path.join(HOST_PATHS.PROC, "1", "ns", "mnt");
    const { execFile } = await import("child_process");
    const args = ["--mount=" + mntNs];
    args.push("--", "sh", "-c", cmd);
    return new Promise((resolve, reject) => {
      execFile("nsenter", args, { timeout: 8000 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(String(stdout).trim());
      });
    });
  }

  /** nvidia-smi via host namespaces when available (fixes missing libnvidia-ml in Docker). */
  async _nvidiaSmi(smiArgs) {
    const smi = this._nvidiaSmiPath || "nvidia-smi";
    const cmd = `${smi} ${smiArgs} 2>/dev/null`;
    if (this._hasHostProc()) {
      return this._execOnHost(cmd);
    }
    return this._exec(cmd);
  }

  /**
   * Read host network files via host netns — /proc/net is netns-local even under
   * a bind-mounted /host/proc (self/net symlink semantics).
   */
  async _readHostNetFile(relPath) {
    // relPath e.g. "dev" or "route" under /proc/net/
    if (this._hasHostProc()) {
      const netNs = path.join(HOST_PATHS.PROC, "1", "ns", "net");
      if (fs.existsSync(netNs)) {
        const { execFile } = await import("child_process");
        return new Promise((resolve, reject) => {
          execFile(
            "nsenter",
            ["--net=" + netNs, "--", "cat", `/proc/net/${relPath}`],
            { timeout: 5000 },
            (err, stdout) => {
              if (err) return reject(err);
              resolve(String(stdout));
            }
          );
        });
      }
    }
    return this._readHostFile(`/proc/net/${relPath}`);
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

  // ─── Default metrics ─────────────────────────────────────
  _defaultGpu() {
    return {
      temperature: 0,
      usage: 0,
      power: { draw: 0, limit: 120, systemDraw: 0 },
      vram: { used: 0, total: 0, percentage: 0, available: 0 },
      processes: [],
    };
  }

  _defaultCpu() {
    return { usage: 0, temperature: 0, draw: 0, tdp: 0 };
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