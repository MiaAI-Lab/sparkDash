import fs from "fs";
import path from "path";
import { HOST_PATHS, GPU_MEMORY_JSON_PATH, GPU_CLOCK_LOCK_UNIT, CPU_CLOCK_CAP_UNIT, DGX_SPARK, HARDWARE_DEFAULTS, POLL_INTERVAL_NVERR, SPARKDASH_CLOCK_BIN, GPU_CLOCK_MAX_MHZ } from "../config.js";
import { normalizeMac, WOL_INTERFACE } from "../wol.js";
import { sshExec } from "./ssh.js";
import {
  buildClockHelperArgv,
  buildHelperProbeCommand,
  clampClockCap,
  interpretHelperExit,
  interpretHelperProbe,
  parseCpuClockBounds,
  parseCpuCoreMaxKhz,
  parseCpuBootUnitDefaults,
  parseDefaultApplicationsGraphicsClock,
} from "./clockControl.js";

const NVERR_JOURNAL_CMD =
  'journalctl -k --no-pager -q --grep=NV_ERR_NO_MEMORY 2>/dev/null | grep -c NV_ERR_NO_MEMORY || true';

/**
 * Boot units each clock domain persists to (host paths). Both CPU domains
 * share one unit (cpu-clock-cap.service writes per-core values for both);
 * the GPU lock has its own.
 */
const CLOCK_DOMAIN_UNIT = {
  "cpu-big": "cpu-clock-cap.service",
  "cpu-little": "cpu-clock-cap.service",
  gpu: "gpu-clock-lock.service",
};

/** Single-quote a value for `sh -c` consumption (same idiom as the remote caps command). */
function shQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/**
 * Clock caps (CPU max_perf / GPU -lgc lock) change rarely, so cache the parsed
 * result for this long instead of re-reading sysfs / the unit file every poll.
 */
const CLOCK_CAPS_CACHE_TTL_MS = 60_000;

/**
 * Parse the CPU clock-cap sysfs dump (one `cpuN:max_perf:cpuinfo_max_freq`
 * line per core) into per-frequency-domain caps. A domain is "capped" when its
 * max_perf ceiling is below the hardware max (cpuinfo_max_freq).
 * Exported for tests.
 * @param {string} raw
 * @returns {Array<{label: string, capMHz: number, maxMHz: number, capped: boolean}>}
 */
export function parseCpuClockCaps(raw) {
  const domains = new Map();
  for (const line of String(raw ?? "").split("\n")) {
    const m = line.trim().match(/^cpu(\d+):(\d+):(\d+)$/);
    if (!m) continue;
    const capKhz = Number(m[2]);
    const maxKhz = Number(m[3]);
    if (!Number.isFinite(capKhz) || !Number.isFinite(maxKhz) || maxKhz <= 0) continue;
    if (!domains.has(maxKhz)) domains.set(maxKhz, { maxKhz, capKhz });
    else {
      // A domain's max_perf is uniform across its cores; keep the strictest.
      const d = domains.get(maxKhz);
      if (capKhz < d.capKhz) d.capKhz = capKhz;
    }
  }
  return [...domains.values()]
    .sort((a, b) => b.maxKhz - a.maxKhz)
    .map((d) => ({
      label: d.maxKhz >= 3_000_000 ? "X925" : d.maxKhz >= 2_000_000 ? "A725" : `${Math.round(d.maxKhz / 1000)} MHz`,
      capMHz: Math.round(d.capKhz / 1000),
      maxMHz: Math.round(d.maxKhz / 1000),
      capped: d.capKhz < d.maxKhz,
    }));
}

/**
 * Parse a `gpu-clock-lock.service` unit file (or raw text) for an
 * `nvidia-smi -lgc MIN,MAX` clock lock. Returns null when no lock is present.
 * Exported for tests.
 * @param {string} raw
 * @returns {{minMHz: number, maxMHz: number} | null}
 */
export function parseGpuClockLock(raw) {
  const m = String(raw ?? "").match(/-lgc\s+(\d+)\s*,\s*(\d+)/);
  if (!m) return null;
  const minMHz = Number(m[1]);
  const maxMHz = Number(m[2]);
  if (!Number.isFinite(minMHz) || !Number.isFinite(maxMHz) || maxMHz <= 0) return null;
  return { minMHz, maxMHz };
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

    // Cached hardware info
    this._hardwareInfo = null;
    /** Cached NVRM NV_ERR_NO_MEMORY count (slow journal scan). */
    this._nvErrCache = { count: 0, at: 0 };
    /** Cached clock caps (CPU max_perf domains + GPU -lgc lock). */
    this._clockCapsCache = { at: 0, cpuDomains: null, gpuLock: null };
    /** Cached bounds read (CPU min/max per domain + GPU Default Apps ceiling). */
    this._clockBoundsCache = {
      at: 0,
      cpuBounds: null,
      gpuCeilingMHz: null,
      cpuBootDefaults: null,
      gpuBootDefaultMHz: null,
    };
    /**
     * Volatile overrides (D5): live-only applies that a unit-file read cannot
     * see. Shape { 'cpu-big'?: number, 'cpu-little'?: number, gpu?: number|null }
     * (gpu null = lock removed). Merged over the read values in _getClockCaps;
     * dropped once a fresh read converges, or on hot config re-registration.
     */
    this._clockCapsOverride = {};
  }

  /** Collect GPU metrics (temperature, usage, power, VRAM). */
  async collectGpu() {
    try {
      const gpuData = this.spark.isLocal
        ? await this._getGPUAll()
        : await this._getRemoteGpu();
      return tagCollectionResult(gpuData, this._isSuccessfulGpuCollection(gpuData));
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
        const cpuData = await this._getRemoteCpu(collectionSequence);
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
      const [temp, power] = await Promise.all([
        this._getCPUTemperature(),
        this._getCPUPower(usageFraction),
      ]);
      if (collectionSequence === this._cpuCollectionSequence) {
        this.lastCpuStat = usage;
        this.lastCpuUsagePct = cpuPercentage;
      }
      const cpuData = { usage: cpuPercentage, temperature: temp, ...power };
      cpuData.clockCaps = (await this._getClockCaps()).cpuDomains;
      return tagCollectionResult(cpuData, this._isSuccessfulCpuCollection(cpuData));
    } catch (err) {
      console.error(`[SystemCollector] CPU error for ${this.spark.id}:`, err.message);
      return tagCollectionResult(this._defaultCpu(), false);
    }
  }

  /** Local: dump `cpuN:max_perf:cpuinfo_max_freq` for every core. */
  async _readLocalCpuCapDump() {
    const cpuDir = path.join(HOST_PATHS.SYS, "devices/system/cpu");
    let entries = [];
    try {
      entries = fs.readdirSync(cpuDir);
    } catch {
      return "";
    }
    const lines = [];
    for (const e of entries) {
      if (!/^cpu\d+$/.test(e)) continue;
      const cap = this._readSysFile(path.join(cpuDir, e, "cpufreq/max_perf"));
      const max = this._readSysFile(path.join(cpuDir, e, "cpufreq/cpuinfo_max_freq"));
      if (cap != null && max != null) lines.push(`${e}:${cap.trim()}:${max.trim()}`);
    }
    return lines.join("\n");
  }

  /**
   * Local: read the GPU clock-lock unit (source of the -lgc lock). The path is
   * configurable via GPU_CLOCK_LOCK_UNIT (default: the common
   * gpu-clock-lock.service convention) because nvidia-smi does not expose the
   * active lock range — the unit file is the only reliable source of the
   * intended value.
   */
  async _readLocalGpuLockUnit() {
    const p = path.join(HOST_PATHS.ROOT, GPU_CLOCK_LOCK_UNIT);
    try {
      return fs.readFileSync(p, "utf-8");
    } catch {
      return "";
    }
  }

  _readSysFile(p) {
    try {
      return fs.readFileSync(p, "utf-8");
    } catch {
      return null;
    }
  }

  /** Remote: one command that dumps CPU caps then the GPU lock unit. */
  _buildRemoteClockCapsCommand() {
    // GPU_CLOCK_LOCK_UNIT is an operator-supplied host path; single-quote it so
    // spaces/globs in the path don't break the remote shell.
    const unitPath = `'${String(GPU_CLOCK_LOCK_UNIT).replace(/'/g, "'\\''")}'`;
    return [
      // Command substitution strips sysfs trailing newlines so each core is one
      // `cpuN:max_perf:cpuinfo_max_freq` line (echo -n + cat splits them).
      "for d in /sys/devices/system/cpu/cpu*/cpufreq; do n=${d#/sys/devices/system/cpu/}; n=${n%/cpufreq}; echo \"$n:$(cat $d/max_perf 2>/dev/null):$(cat $d/cpuinfo_max_freq 2>/dev/null)\"; done",
      "echo '---'",
      `cat ${unitPath} 2>/dev/null || true`,
    ].join("; ");
  }

  // ─── Clock control (bounds, apply, volatile overrides) ────

  /** Hot config re-registration: forget live-only overrides (D5). */
  clearClockCapsOverride() {
    this._clockCapsOverride = {};
  }

  /**
   * Domain id for a parsed cap row (MHz values — same rule as
   * parseCpuClockCaps' labels, which test maxKhz ≥ 3,000,000; here maxMHz
   * ≥ 3000). The 3.9 GHz Cortex-X925 group is "cpu-big".
   */
  _cpuDomainId(maxMHz) {
    return maxMHz >= 3000 ? "cpu-big" : "cpu-little";
  }

  /**
   * Merge volatile overrides (D5) over a read result so a live-only apply is
   * not contradicted by the CLOCK_CAPS_CACHE_TTL_MS cache. Never mutates the
   * cache; the returned copy carries the override values.
   */
  _mergeClockCapsOverride(c) {
    const o = this._clockCapsOverride || {};
    const hasCpu = o["cpu-big"] != null || o["cpu-little"] != null;
    const hasGpu = Object.prototype.hasOwnProperty.call(o, "gpu");
    if (!hasCpu && !hasGpu) return c;
    const cpuDomains = c.cpuDomains ? c.cpuDomains.map((d) => ({ ...d })) : null;
    if (cpuDomains && hasCpu) {
      for (const d of cpuDomains) {
        const v = o[this._cpuDomainId(d.maxMHz)];
        if (v != null) {
          d.capMHz = v;
          d.capped = v < d.maxMHz;
        }
      }
    }
    let gpuLock = c.gpuLock ? { ...c.gpuLock } : null;
    if (hasGpu) {
      const v = o.gpu;
      gpuLock = v == null ? null : { minMHz: 0, maxMHz: v };
    }
    return { at: c.at, cpuDomains, gpuLock, ok: c.ok };
  }

  /**
   * Drop overrides that a fresh successful read makes redundant, per domain:
   * CPU live caps ARE the sysfs read itself, so any fresh CPU read (converged
   * or diverged) supersedes the override. GPU is different — the read source
   * is the boot unit file, which a live-only `-lgc` does not change — so a GPU
   * override survives until a read actually reports the overridden value
   * (converged). Dropping it earlier would make the UI lie after the cache
   * TTL expires (D5).
   */
  _dropConvergedOverrides(fresh) {
    const o = this._clockCapsOverride;
    if (!o || Object.keys(o).length === 0) return;
    if (fresh.ok && Array.isArray(fresh.cpuDomains)) {
      for (const d of fresh.cpuDomains) {
        delete o[this._cpuDomainId(d.maxMHz)];
      }
    }
    if (fresh.ok && Object.prototype.hasOwnProperty.call(o, "gpu")) {
      const want = o.gpu;
      const have = fresh.gpuLock ? fresh.gpuLock.maxMHz : null;
      if (want === have) delete o.gpu;
    }
  }

  /** Read the active clock caps, merging volatile overrides over the result. */
  async _getClockCaps() {
    const now = Date.now();
    const c = this._clockCapsCache;
    if (c.at && now - c.at < CLOCK_CAPS_CACHE_TTL_MS && (c.cpuDomains || c.gpuLock)) {
      return this._mergeClockCapsOverride(c);
    }
    if (this._clockCapsInFlight) return this._clockCapsInFlight;
    this._clockCapsInFlight = (async () => {
      let cpuDomains = null;
      let gpuLock = null;
      let ok = false;
      try {
        if (this.spark.isLocal) {
          cpuDomains = parseCpuClockCaps(await this._readLocalCpuCapDump());
          gpuLock = parseGpuClockLock(await this._readLocalGpuLockUnit());
        } else {
          const out = await sshExec(this.spark, this._buildRemoteClockCapsCommand());
          const [cpuDump, lockUnit] = out.split("---");
          cpuDomains = parseCpuClockCaps(cpuDump);
          gpuLock = parseGpuClockLock(lockUnit);
        }
        ok = true;
      } catch (err) {
        console.error(`[SystemCollector] clock caps error for ${this.spark.id}:`, err.message);
      }
      this._clockCapsCache = { at: Date.now(), cpuDomains, gpuLock, ok };
      this._dropConvergedOverrides(this._clockCapsCache);
      return this._mergeClockCapsOverride(this._clockCapsCache);
    })();
    try {
      return await this._clockCapsInFlight;
    } finally {
      this._clockCapsInFlight = null;
    }
  }

  /**
   * Discover hardware bounds (D8): CPU domains from cpuinfo_min/max_freq and
   * the GPU graphics ceiling from `nvidia-smi -q -d CLOCK` "Default
   * Applications Clock". Also reads the boot units for the D7 "Boot default"
   * presets (what the units actually install — never hardcoded). Cached with
   * the same TTL + in-flight guard idiom as _getClockCaps. Returns
   * { at, cpuBounds: [{minKhz,maxKhz}] | null, gpuCeilingMHz: number|null,
   * gpuCeilingSource: 'smi'|'fallback'|null, cpuBootDefaults:
   * {'cpu-big'?:number,'cpu-little'?:number}|null, gpuBootDefaultMHz: number|null }.
   */
  async _getClockBounds() {
    const now = Date.now();
    const c = this._clockBoundsCache;
    if (
      c.at &&
      now - c.at < CLOCK_CAPS_CACHE_TTL_MS &&
      (c.cpuBounds || c.gpuCeilingMHz != null)
    ) {
      return c;
    }
    if (this._clockBoundsInFlight) return this._clockBoundsInFlight;
    this._clockBoundsInFlight = (async () => {
      let cpuBounds = null;
      let gpuCeilingMHz = null;
      let gpuCeilingSource = null;
      let cpuBootDefaults = null;
      let gpuBootDefaultMHz = null;
      try {
        if (this.spark.isLocal) {
          // Reuse the caps dump: max_perf is column 2 in the read shape but
          // bounds come from cpuinfo_min/max_freq, so dump min:max explicitly.
          const boundsDump = await this._readLocalCpuBoundsDump();
          cpuBounds = parseCpuClockBounds(boundsDump);
          gpuCeilingMHz = parseDefaultApplicationsGraphicsClock(
            await this._nvidiaSmi("-q -d CLOCK")
          );
          // D7 boot-default presets: parse the installed boot units against
          // the discovered core→domain map. Read-path only; a missing unit
          // simply omits the preset.
          const coreMaxKhz = parseCpuCoreMaxKhz(boundsDump);
          cpuBootDefaults = parseCpuBootUnitDefaults(
            this._readLocalBootUnit(CPU_CLOCK_CAP_UNIT),
            coreMaxKhz
          );
          gpuBootDefaultMHz =
            parseGpuClockLock(this._readLocalBootUnit(GPU_CLOCK_LOCK_UNIT))?.maxMHz ?? null;
        } else {
          const out = await sshExec(
            this.spark,
            this._buildRemoteClockBoundsCommand(),
            { timeoutMs: 12000 }
          );
          const parts = out.split("---");
          cpuBounds = parseCpuClockBounds(parts[0] || "");
          gpuCeilingMHz = parseDefaultApplicationsGraphicsClock(parts[1] || "");
          const coreMaxKhz = parseCpuCoreMaxKhz(parts[0] || "");
          cpuBootDefaults = parseCpuBootUnitDefaults(parts[2] || "", coreMaxKhz);
          gpuBootDefaultMHz =
            parseGpuClockLock(parts[3] || "")?.maxMHz ?? null;
        }
        if (gpuCeilingMHz == null) {
          gpuCeilingMHz = GPU_CLOCK_MAX_MHZ;
          gpuCeilingSource = "fallback";
        } else {
          gpuCeilingSource = "smi";
        }
      } catch (err) {
        console.error(`[SystemCollector] clock bounds error for ${this.spark.id}:`, err.message);
      }
      const result = { at: Date.now(), cpuBounds, gpuCeilingMHz, gpuCeilingSource, cpuBootDefaults, gpuBootDefaultMHz };
      this._clockBoundsCache = result;
      return result;
    })();
    try {
      return await this._clockBoundsInFlight;
    } finally {
      this._clockBoundsInFlight = null;
    }
  }

  /** Read a boot unit through the container's host-root bind (read path). */
  _readLocalBootUnit(hostPath) {
    try {
      return fs.readFileSync(path.join(HOST_PATHS.ROOT, hostPath), "utf-8");
    } catch {
      return "";
    }
  }

  /** Local: dump `cpuN:cpuinfo_min_freq:cpuinfo_max_freq` for every core. */
  async _readLocalCpuBoundsDump() {
    const cpuDir = path.join(HOST_PATHS.SYS, "devices/system/cpu");
    let entries = [];
    try {
      entries = fs.readdirSync(cpuDir);
    } catch {
      return "";
    }
    const lines = [];
    for (const e of entries) {
      if (!/^cpu\d+$/.test(e)) continue;
      const min = this._readSysFile(path.join(cpuDir, e, "cpufreq/cpuinfo_min_freq"));
      const max = this._readSysFile(path.join(cpuDir, e, "cpufreq/cpuinfo_max_freq"));
      if (min != null && max != null) lines.push(`${e}:${min.trim()}:${max.trim()}`);
    }
    return lines.join("\n");
  }

  /** Remote: dump CPU min/max freqs, `-q -d CLOCK`, then both boot units. */
  _buildRemoteClockBoundsCommand() {
    const cpuUnit = `'${String(CPU_CLOCK_CAP_UNIT).replace(/'/g, "'\\''")}'`;
    const gpuUnit = `'${String(GPU_CLOCK_LOCK_UNIT).replace(/'/g, "'\\''")}'`;
    return [
      "for d in /sys/devices/system/cpu/cpu*/cpufreq; do n=${d#/sys/devices/system/cpu/}; n=${n%/cpufreq}; echo \"$n:$(cat $d/cpuinfo_min_freq 2>/dev/null):$(cat $d/cpuinfo_max_freq 2>/dev/null)\"; done",
      "echo '---'",
      "nvidia-smi -q -d CLOCK 2>/dev/null || true",
      "echo '---'",
      `cat ${cpuUnit} 2>/dev/null || true`,
      "echo '---'",
      `cat ${gpuUnit} 2>/dev/null || true`,
    ].join("; ");
  }

  /**
   * Which apply paths this Spark can use right now (D4). 'helper' = the
   * privileged host helper over SSH (all units); 'container' = the container's
   * own root path (local privileged container only). Null when neither applies.
   */
  _clockControlPaths() {
    const paths = [];
    if (this.spark.isLocal) paths.push("helper", "container");
    else paths.push("helper");
    return paths;
  }

  /**
   * Check whether the privileged helper is installed and allowed by sudo
   * (cheap SSH probe). The probe exercises EXACTLY the scoped grant shipped
   * by scripts/install-clock-helper.sh — an argumentless run of the helper
   * binary — never `sudo -n true`, which no scoped sudoers file permits.
   * Returns { available, checked, reason }.
   */
  async checkClockHelper() {
    if (this._clockHelperState && Date.now() - this._clockHelperState.at < 30_000) {
      return this._clockHelperState.state;
    }
    this._clockHelperState = { at: Date.now(), state: null }; // in-flight marker
    let state;
    try {
      const out = await sshExec(
        this.spark,
        buildHelperProbeCommand({ helperBin: SPARKDASH_CLOCK_BIN }),
        { timeoutMs: 8000 }
      );
      state = interpretHelperProbe(out);
    } catch (err) {
      state = {
        available: false,
        checked: true,
        reason: `unreachable over SSH: ${err.message || String(err)}`,
      };
    }
    this._clockHelperState = { at: Date.now(), state };
    return state;
  }

  /**
   * Apply a clock cap (D4). Tries the SSH helper first; for local units falls
   * back to the container's own root path. Returns the D1 response body:
   * { ok, domain, appliedMHz, persisted, bootUnit, source, warnings } or
   * { ok:false, status, reason } on failure. Never claims persistence it did
   * not perform.
   *
   * @param {{ domain: string, maxMHz: number | null, persist: boolean }} req
   * @param {{ hardMinMHz?: number, hardMaxMHz?: number }} [bounds] live bounds
   *        for clamping (server-side, mandatory — D2)
   */
  async applyClockCap(req, bounds = {}) {
    const warnings = [];
    const { domain, maxMHz, persist } = req;
    const appliedMHz =
      maxMHz == null ? null : clampClockCap(maxMHz, bounds.hardMinMHz, bounds.hardMaxMHz, { warnings });

    // Primary: privileged helper over SSH (mirrors the shutdown feature).
    const helperCmd = buildClockHelperArgv({ domain, maxMHz: appliedMHz, persist }, {
      helperBin: SPARKDASH_CLOCK_BIN,
    });
    try {
      await sshExec(this.spark, helperCmd, { timeoutMs: 12000 });
      if (persist) this._clockCapsOverride = {}; // persisted → drop all volatile state
      else if (domain === "gpu") this._clockCapsOverride.gpu = appliedMHz;
      else this._clockCapsOverride[domain] = appliedMHz;
      return {
        ok: true,
        domain,
        appliedMHz,
        persisted: Boolean(persist),
        bootUnit: persist ? CLOCK_DOMAIN_UNIT[domain] ?? null : null,
        source: "helper",
        warnings,
      };
    } catch (helperErr) {
      const interpreted = interpretHelperExit(helperErr);
      // Local fallback (D4 secondary): the container runs as root with a rw
      // /sys and nvidia-smi; live apply needs no sudo at all. Persistence goes
      // through nsenter into the host mount namespace.
      if (this.spark.isLocal && (interpreted.status === 423 || interpreted.status === 502)) {
        try {
          return await this._applyClockCapLocal(domain, appliedMHz, persist, warnings, helperErr);
        } catch (localErr) {
          return {
            ok: false,
            status: 502,
            reason: `helper failed (${interpreted.reason}); local fallback failed (${localErr.message || localErr})`,
          };
        }
      }
      return { ok: false, status: interpreted.status, reason: interpreted.reason };
    }
  }

  /**
   * Local container-root apply path (D4 secondary). Live: write max_perf /
   * nvidia-smi -lgc|-rgc through the container's own (rw, privileged) view —
   * the container's /sys is the host sysfs remounted rw, NOT the read-only
   * /host/sys bind. Persist: nsenter into the host mount namespace and
   * rewrite the boot unit there (no systemctl in the container).
   */
  async _applyClockCapLocal(domain, appliedMHz, persist, warnings, helperErr) {
    let bootUnit = null;
    if (domain === "gpu") {
      const smi = this._nvidiaSmiPath || "nvidia-smi";
      if (appliedMHz == null) {
        await this._exec(`${smi} -rgc`);
      } else {
        await this._exec(`${smi} -lgc 0,${appliedMHz}`);
      }
      bootUnit = CLOCK_DOMAIN_UNIT.gpu;
    } else {
      const cores = this._cpuDomainCores(domain);
      if (!cores.length) {
        throw new Error("no CPU cores discovered for this domain");
      }
      // Remove-cap = write each core's own hardware maximum (never a 0 sentinel).
      // Container /sys (rw) — not HOST_PATHS.SYS, which is the ro host bind.
      const cpuDir = "/sys/devices/system/cpu";
      for (const cpuN of cores) {
        const p = path.join(cpuDir, cpuN, "cpufreq/max_perf");
        try {
          if (appliedMHz == null) {
            const max = this._readSysFile(path.join(cpuDir, cpuN, "cpufreq/cpuinfo_max_freq"));
            if (max == null) throw new Error(`cannot read cpuinfo_max_freq for ${cpuN}`);
            fs.writeFileSync(p, `${max.trim()}\n`);
          } else {
            fs.writeFileSync(p, `${appliedMHz * 1000}\n`);
          }
        } catch (err) {
          throw new Error(`max_perf write failed for ${cpuN}: ${err.message}`);
        }
      }
      bootUnit = CLOCK_DOMAIN_UNIT[domain];
    }

    let persisted = false;
    if (persist) {
      try {
        await this._persistClockUnitLocal(domain, appliedMHz);
        persisted = true;
      } catch (err) {
        warnings.push(
          `applied live but could not persist the boot unit: ${err.message || err} — reverts on reboot`
        );
      }
    } else {
      warnings.push("applied this boot only — reverts on reboot");
    }

    // Record the volatile override so the UI shows the truth until a fresh
    // read converges (D5). Only for values the unit-file read cannot see.
    if (!persisted) {
      if (domain === "gpu") this._clockCapsOverride.gpu = appliedMHz;
      else this._clockCapsOverride[domain] = appliedMHz;
    } else {
      this._clockCapsOverride = {};
    }

    return {
      ok: true,
      domain,
      appliedMHz,
      persisted,
      bootUnit,
      source: "container",
      warnings,
    };
  }

  /**
   * Persist through nsenter into the host mount namespace (D4): rewrite the
   * boot unit's ExecStart for the requested value, then daemon-reload. The
   * script travels on the helper's stdin (`sh -s`), so it needs no remote
   * shell quoting — values are interpolated only as verified integers or
   * fixed unit paths.
   */
  async _persistClockUnitLocal(domain, appliedMHz) {
    const unit = CLOCK_DOMAIN_UNIT[domain] || CLOCK_DOMAIN_UNIT["cpu-big"];
    const smi = this._nvidiaSmiPath || "nvidia-smi";
    let execLine;
    if (domain === "gpu") {
      execLine = appliedMHz == null ? `${smi} -rgc` : `${smi} -lgc 0,${appliedMHz}`;
    } else {
      // Both CPU domains share ONE boot unit (cpu-clock-cap.service), so a
      // single-domain Save must carry the sibling domain too or it would
      // clobber the sibling's boot cap. The sibling keeps its current
      // effective value: its volatile override when a live-only apply is in
      // flight, else its live max_perf right now.
      //
      // Explicit per-core commands — NO shell loop variables. systemd expands
      // $VAR in ExecStart (unset → empty), so a unit file must never contain
      // a bare `$c` inside `sh -c`.
      const cores = this._cpuDomainCores(domain);
      if (!cores.length) throw new Error("no CPU cores discovered for this domain");
      const parts = [];
      for (const cpuN of cores) {
        const base = `/sys/devices/system/cpu/${cpuN}/cpufreq`;
        parts.push(
          appliedMHz == null
            ? `cat ${base}/cpuinfo_max_freq > ${base}/max_perf`
            : `echo ${appliedMHz * 1000} > ${base}/max_perf`
        );
      }
      const siblingId = domain === "cpu-big" ? "cpu-little" : "cpu-big";
      const siblingOverride = this._clockCapsOverride?.[siblingId];
      for (const cpuN of this._cpuDomainCores(siblingId)) {
        let khz = null;
        if (Number.isInteger(siblingOverride)) khz = siblingOverride * 1000;
        else {
          const raw = this._readSysFile(
            path.join(HOST_PATHS.SYS, "devices/system/cpu", cpuN, "cpufreq/max_perf")
          );
          if (raw != null && /^\d+$/.test(raw.trim())) khz = raw.trim();
        }
        // Unreadable sibling core → leave it out rather than guess a value.
        if (khz != null) {
          parts.push(`echo ${khz} > /sys/devices/system/cpu/${cpuN}/cpufreq/max_perf`);
        }
      }
      // The ExecStart list is shell syntax (redirections), so systemd must run
      // it through /bin/sh — byte-identical to the helper's persist path
      // (scripts/sparkdash-set-clock cpu_unit_body). No single quotes can ever
      // occur in these commands (echo/cat paths + integers only).
      execLine = `/bin/sh -c '${parts.join("; ")}'`;
    }
    const script = [
      "set -eu",
      `cat > /etc/systemd/system/${unit} <<'UNIT'`,
      "[Unit]",
      domain === "gpu"
        ? "Description=Lock NVIDIA GPU graphics clocks to user range"
        : "Description=sparkDash CPU clock cap (big + little domains)",
      domain === "gpu" ? "After=nvidia-persistenced.service" : "After=multi-user.target",
      "",
      "[Service]",
      "Type=oneshot",
      `ExecStart=${execLine}`,
      "RemainAfterExit=yes",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "UNIT",
      "systemctl daemon-reload",
    ].join("\n");
    await this._exec(
      `nsenter --mount=/host/proc/1/ns/mnt -- sh -s <<'SPARKDASH_UNIT_SCRIPT'\n${script}\nSPARKDASH_UNIT_SCRIPT`
    );
  }

  /**
   * Core names (cpuN) for a CPU domain, discovered from the bounds dump —
   * never hardcoded indices. Empty when nothing is readable.
   */
  _cpuDomainCores(domain) {
    const cpuDir = path.join(HOST_PATHS.SYS, "devices/system/cpu");
    let entries = [];
    try {
      entries = fs.readdirSync(cpuDir);
    } catch {
      return [];
    }
    const byDomain = new Map(); // maxKhz → [cpuN...]
    for (const e of entries) {
      if (!/^cpu\d+$/.test(e)) continue;
      const max = this._readSysFile(path.join(cpuDir, e, "cpufreq/cpuinfo_max_freq"));
      if (max == null) continue;
      const maxKhz = parseInt(max.trim(), 10);
      if (!Number.isFinite(maxKhz)) continue;
      const id = maxKhz >= 3_000_000 ? "cpu-big" : "cpu-little";
      if (!byDomain.has(id)) byDomain.set(id, []);
      byDomain.get(id).push(e);
    }
    const cores = byDomain.get(domain) || [];
    // cpu0 < cpu1 < … < cpu10 numeric order for a stable unit file.
    return cores.sort((a, b) => parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10));
  }

  _isSuccessfulGpuCollection(gpu) {
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
      if (this.isMac) return this._getRemoteRamMac();
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
      "--query-gpu=temperature.gpu,utilization.gpu,power.draw,power.limit,clocks.current.sm,clocks.max.sm,clocks_throttle_reasons.hw_thermal_slowdown,clocks_throttle_reasons.sw_thermal_slowdown,clocks_throttle_reasons.hw_slowdown,clocks_throttle_reasons.sw_power_cap,index,name,uuid --format=csv,noheader,nounits"
    );
    const devices = this._parseGpuLines(gpuOut);
    const gpu = this._aggregateGpuDevices(devices);
    this._lastVramPerDevice = [];
    const vram = await this._queryNvidiaVram();

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

    return {
      temperature: gpu.temperature,
      usage: gpu.usage,
      power: { draw: gpu.powerDraw, limit: gpu.powerLimit, systemDraw },
      vram,
      processes,
      throttle: gpu.throttle,
      nvErrNoMemory: await this._nvErrNoMemory(),
      gpus: this._buildGpuDevices(devices, this._lastVramPerDevice ?? [], apps, vram),
      clockLock: (await this._getClockCaps()).gpuLock,
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
      if (totalMB > 0 && usedMB > 0) availableMB = Math.max(0, totalMB - usedMB);
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
  _parseGpuLines(output) {
    const lines = String(output ?? "").trim().split("\n").filter(Boolean);
    return lines.map((line, i) => {
      const parts = line.split(",").map((s) => s.trim());
      const temperature = parseFloat(parts[0]) || 0;
      const usage = parseFloat(parts[1]) || 0;
      const powerDraw = parseFloat(parts[2]) || 0;
      const powerLimit = this._parseSmiNumber(parts[3]) ?? 120;
      const smClockMHz = this._parseSmiNumber(parts[4]);
      const smClockMaxMHz = this._parseSmiNumber(parts[5]);
      const hwThermal = this._parseSmiActive(parts[6]);
      const swThermal = this._parseSmiActive(parts[7]);
      const hwSlowdown = this._parseSmiActive(parts[8]);
      const powerCap = this._parseSmiActive(parts[9]);
      const index = this._parseSmiNumber(parts[10]) ?? i;
      const name = parts[11] && !/^\[?n\/a\]?$/i.test(parts[11]) ? parts[11] : null;
      const uuid = parts[12] && /^GPU-/i.test(parts[12]) ? parts[12] : null;
      return {
        index,
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
      };
    }
    const worst = devices.find((d) => d.throttle?.active) ?? devices[0];
    const round2 = (n) => Math.round(n * 100) / 100;
    return {
      temperature: Math.max(...devices.map((d) => d.temperature)),
      usage: Math.max(...devices.map((d) => d.usage)),
      powerDraw: round2(devices.reduce((sum, d) => sum + d.powerDraw, 0)),
      powerLimit: round2(devices.reduce((sum, d) => sum + d.powerLimit, 0)),
      throttle: worst.throttle,
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
        index: d.index,
        name: d.name,
        uuid: d.uuid,
        temperature: d.temperature,
        usage: d.usage,
        power: { draw: d.powerDraw, limit: d.powerLimit },
        vram,
        throttle: d.throttle,
        processes: this._topProcesses(own),
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
      detail: details.length ? details.join(" · ") : "Clocks not limited",
    };
  }

  _defaultThrottle() {
    return this._buildThrottle();
  }

  _parseComputeApps(output) {
    const lines = output.trim().split("\n").filter(Boolean);
    return lines
      .map((line) => {
        const parts = line.split(",").map((s) => s.trim());
        // Format: pid,process_name,used_gpu_memory[,gpu_uuid]
        const gpuUuid = parts[3] && /^GPU-/i.test(parts[3]) ? parts[3] : null;
        return {
          pid: parseInt(parts[0]) || 0,
          name: parts[1] || "unknown",
          vramMB: this._parseSmiNumber(parts[2]) || 0,
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
        "nvidia-smi --query-gpu=temperature.gpu,utilization.gpu,power.draw,power.limit,clocks.current.sm,clocks.max.sm,clocks_throttle_reasons.hw_thermal_slowdown,clocks_throttle_reasons.sw_thermal_slowdown,clocks_throttle_reasons.hw_slowdown,clocks_throttle_reasons.sw_power_cap,index,name,uuid --format=csv,noheader,nounits 2>/dev/null",
        "echo '---'",
        "nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null",
        "echo '---'",
        "nvidia-smi --query-compute-apps=pid,process_name,used_gpu_memory,gpu_uuid --format=csv,noheader,nounits 2>/dev/null",
        "echo '---'",
        "grep -E 'MemTotal|MemAvailable' /proc/meminfo 2>/dev/null",
      ].join("; ");

      const output = await sshExec(this.spark, cmd);
      const sections = output.split("---");
      const gpuOut = sections[0]?.trim() || "";
      const memFields = sections[1]?.trim() || "";
      const computeOut = sections[2]?.trim() || "";
      const meminfoOut = sections[3]?.trim() || "";

      const devices = this._parseGpuLines(gpuOut);
      const gpu = this._aggregateGpuDevices(devices);

      // Parse memory.used / memory.total from nvidia-smi, one line per GPU
      // (may be [N/A] on GB10); the aggregate is the sum across cards.
      const perDeviceVram = this._parseVramLines(memFields);
      let { used, total } = this._sumVram(perDeviceVram);

      const apps = this._parseComputeApps(computeOut);
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
      if ((used == null || used === 0) && computeSum > 0) used = computeSum;

      // Unified-memory pool: prefer MemTotal (OS-visible) so VRAM and Unified
      // Memory panels share the same base. Available = MemAvailable (real free).
      const totalMatch = meminfoOut.match(/MemTotal:\s+(\d+)\s+kB/);
      const availMatch = meminfoOut.match(/MemAvailable:\s+(\d+)\s+kB/);
      const memTotalMB = totalMatch ? Math.round(parseInt(totalMatch[1]) / 1024) : 0;
      let availableMB = availMatch ? Math.round(parseInt(availMatch[1]) / 1024) : 0;

      const usedMB = Math.round(used || 0);
      let totalMB = Math.round(total || 0);
      if (this.spark.kind === "host") {
        // Discrete GPU VRAM: trust nvidia-smi's memory.total; free VRAM = total − used.
        if (totalMB <= 0 && memTotalMB > 0) totalMB = memTotalMB;
        else if (totalMB <= 0) totalMB = DGX_SPARK.MEMORY_HBM_SIZE_GB * 1024; // Convert to MB
        if (totalMB > 0 && usedMB > 0) availableMB = Math.max(0, totalMB - usedMB);
      } else {
        // GB10 shared HBM pool: prefer the OS-visible pool (MemTotal) as the total,
        // fall back to nvidia-smi, then the hardware spec (HBM) only if nothing known.
        if (memTotalMB > 0) totalMB = memTotalMB;
        else if (totalMB <= 0) totalMB = DGX_SPARK.MEMORY_HBM_SIZE_GB * 1024; // Convert to MB
      }
      const percentage = totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : 0;

      // Rough system power estimate: GPU draw + 20W CX7/peripherals
      const systemDraw = Math.round(gpu.powerDraw + 20);

      // Top 5 GPU processes by VRAM usage (a PID spanning several GPUs is summed)
      const cachedApps = this._cachedApps();
      const processes = this._topProcesses(cachedApps);
      const vram = { used: usedMB, total: totalMB, percentage, available: availableMB };

      return {
        temperature: gpu.temperature,
        usage: gpu.usage,
        power: { draw: gpu.powerDraw, limit: gpu.powerLimit, systemDraw },
        vram,
        processes,
        throttle: gpu.throttle,
        nvErrNoMemory: await this._nvErrNoMemory(),
        gpus: this._buildGpuDevices(devices, perDeviceVram, cachedApps, vram),
        clockLock: (await this._getClockCaps()).gpuLock,
      };
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
      'for h in /sys/class/hwmon/*; do n=$(cat "$h/name" 2>/dev/null); case "$n" in coretemp|k10temp|zenpower|acpitz) for t in "$h"/temp*_input; do cat "$t" 2>/dev/null; break; done;; esac; done',
      "cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null || true",
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

      return {
        usage,
        temperature: this._parseSensorTemp(tempOut),
        draw: Math.round(draw * 10) / 10,
        tdp: Math.round(tdp),
        clockCaps: (await this._getClockCaps()).cpuDomains,
      };
    } catch (err) {
      console.error(`[SystemCollector] Remote CPU error for ${this.spark.id}:`, err.message);
      return this._defaultCpu();
    }
  }

  /**
   * First plausible temperature from a remote sensor dump (raw millidegrees,
   * one per line, highest priority first). Same accept range as local
   * `_getCPUTemperature()`; returns 0 when nothing is readable.
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

  /**
   * macOS units (platform: "darwin"): /proc is absent, so Linux commands are
   * replaced with darwin equivalents. All other kinds are unaffected.
   */
  get isMac() {
    return this.spark.platform === "darwin";
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
      const output = await sshExec(this.spark, "df -k 2>/dev/null");
      const lines = output.trim().split("\n").slice(1); // skip header
      const disks = [];
      const disabledDevices = this.spark.disabledDevices || [];
      const PSEUDO = new Set(["devfs", "autofs", "apfs", "tmpfs", "overlay"]);
      for (const line of lines) {
        const parts = line.split(/\s+/);
        // BSD df (no -T): Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted (9 cols)
        // GNU df -T: Filesystem Type 1024-blocks Used Available Capacity Mounted (7 cols)
        if (parts.length < 6) continue;
        const isTyped = /^[a-z]+$/.test(parts[1] || "");
        let fsys, type, size, used, avail, pct, mountRest;
        if (isTyped) {
          [fsys, type, size, used, avail, pct, ...mountRest] = parts;
        } else {
          // 9-col BSD: parts = fs,1024blocks,used,avail,cap,iused,ifree,%iused,mount
          if (parts.length < 9) continue;
          [fsys, size, used, avail, pct, , , , ...mountRest] = parts;
          type = "apfs";
        }
        const mount = mountRest.join(" ") || "/";
        if (PSEUDO.has((type || "").toLowerCase()) && type !== "apfs") continue;
        if (mount === "/boot/efi" || mount.includes("/snap") || /^\/System\/Volumes\//.test(mount)) continue;
        if (!mount.startsWith("/") || mount === "/dev") continue;
        const device = fsys.split("/").pop() || fsys;
        const isDisabled =
          disabledDevices.includes(device) || disabledDevices.includes(mount);
        disks.push({
          device,
          label: mount,
          used: Math.round(parseInt(used) / 1024),
          total: Math.round(parseInt(size) / 1024),
          available: Math.round(parseInt(avail) / 1024),
          percentage: parseInt(pct) || 0,
          readSpeed: 0,
          writeSpeed: 0,
          disabled: isDisabled,
        });
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
  async collectMacModels() {
    if (!this.isMac || this.spark.isLocal) return null;
    try {
      const output = await sshExec(
        this.spark,
        "ollama list 2>/dev/null || $HOME/.ollama/bin/ollama list 2>/dev/null || /usr/local/bin/ollama list 2>/dev/null || /opt/homebrew/bin/ollama list 2>/dev/null; echo '---'; du -sh $HOME/models/* 2>/dev/null",
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
        "echo '---'",
        // Link speed for every interface, not just the primary one: which
        // interface is primary only falls out of the route table above, and
        // fetching that one afterwards cost a second SSH login per poll.
        // Virtual interfaces have no `speed`; they just come back blank.
        "for d in /sys/class/net/*/speed; do echo \"$(basename $(dirname $d)):$(cat $d 2>/dev/null)\"; done 2>/dev/null || true",
      ].join("; ");

      const output = await sshExec(this.spark, cmd);
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

  /**
   * Count NVRM `NV_ERR_NO_MEMORY` lines in the kernel journal since boot.
   * Cached for POLL_INTERVAL_NVERR — never on the 2s GPU/memory loop uncached.
   * @returns {Promise<number>}
   */
  async _nvErrNoMemory() {
    const now = Date.now();
    if (this._nvErrCache.at > 0 && now - this._nvErrCache.at < POLL_INTERVAL_NVERR) {
      return this._nvErrCache.count;
    }
    try {
      let out;
      if (this.spark.isLocal) {
        out = this._hasHostProc()
          ? await this._execOnHost(NVERR_JOURNAL_CMD)
          : await this._exec(NVERR_JOURNAL_CMD);
      } else {
        out = await sshExec(this.spark, NVERR_JOURNAL_CMD, { timeoutMs: 8000 });
      }
      const count = parseNvErrNoMemoryCount(out);
      this._nvErrCache = { count, at: now };
      return count;
    } catch {
      this._nvErrCache.at = now;
      return this._nvErrCache.count;
    }
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
      gpus: [],
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
