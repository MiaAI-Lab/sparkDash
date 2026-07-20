import fs from "fs";
import path from "path";
import { SystemCollector } from "../collectors/SystemCollector.js";
import { LlmProbe } from "../collectors/LlmProbe.js";
import { sshTest, sshExec } from "../collectors/ssh.js";
import {
  POLL_INTERVAL_GPU,
  POLL_INTERVAL_CPU,
  POLL_INTERVAL_NETWORK,
  POLL_INTERVAL_STORAGE,
  POLL_INTERVAL_LLM,
  POLL_INTERVAL_BANDWIDTH,
  POLL_INTERVAL_LIVENESS,
  LLM_PORT,
  HOST_PATHS,
} from "../config.js";

const ONLINE_GRACE_MS = 10000;

/**
 * SparkMonitor — one per Spark. Owns collectors + rate state + poll loop.
 * Exposes snapshot() for WebSocket pushed payload.
 */
export class SparkMonitor {
  constructor(spark) {
    this.spark = spark;
    this.collector = new SystemCollector(spark);

    // One LlmProbe per port — Map<port, LlmProbe>
    this.llmProbes = new Map();
    for (const port of this._llmPorts()) {
      this.llmProbes.set(port, new LlmProbe(spark, port));
    }

    // Online status from dedicated liveness checks (not metric poll success)
    this.online = false;
    this.lastOnlineOk = 0;

    // System uptime seconds (from /proc/uptime), null when offline
    this._uptimeSeconds = null;

    // Cached metrics per domain — never null objects for UI safety
    this._metrics = {
      gpu: this.collector._defaultGpu(),
      cpu: this.collector._defaultCpu(),
      ram: this.collector._defaultRam(),
      storage: [],
      network: this.collector._defaultNetwork(),
      unifiedMemory: this.collector._defaultUnifiedMemory(),
      llm: [],
    };
    this._lastUpdate = {};

    // Timers
    this._intervals = [];
    this._running = false;
    /** @type {Record<string, boolean>} in-flight domain guards */
    this._inflight = {};
  }

  /** Hot-update config without tearing down poll loops / rate baselines. */
  updateConfig(spark) {
    this.spark = spark;
    this.collector.spark = spark;

    // Rebuild LLM probe map — add new ports, remove stale ones, update existing
    const ports = this._llmPorts();
    const prevProbes = this.llmProbes;
    this.llmProbes = new Map();
    for (const port of ports) {
      const existing = prevProbes.get(port);
      if (existing) {
        existing.spark = spark;
        this.llmProbes.set(port, existing);
      } else {
        this.llmProbes.set(port, new LlmProbe(spark, port));
      }
    }
  }

  /** Returns array of LLM ports from spark config. */
  _llmPorts() {
    const raw = this.spark?.llmPorts;
    if (Array.isArray(raw)) {
      const ports = raw
        .map((v) => (typeof v === "string" ? parseInt(v, 10) : Number(v)))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
      return ports.length > 0 ? ports : [LLM_PORT];
    }
    // Legacy single port
    const n = Number(this.spark?.llmPort);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return [n];
    return [LLM_PORT];
  }

  /** Start background polling. */
  start() {
    if (this._running) return;
    this._running = true;
    this._poll();
    this._intervals.push(setInterval(() => this._pollDomain("gpu"), POLL_INTERVAL_GPU));
    this._intervals.push(setInterval(() => this._pollDomain("cpu"), POLL_INTERVAL_CPU));
    this._intervals.push(setInterval(() => this._pollDomain("network"), POLL_INTERVAL_NETWORK));
    this._intervals.push(setInterval(() => this._pollDomain("storage"), POLL_INTERVAL_STORAGE));
    this._intervals.push(setInterval(() => this._pollDomain("ram"), POLL_INTERVAL_CPU));
    this._intervals.push(setInterval(() => this._pollDomain("memory"), POLL_INTERVAL_BANDWIDTH));
    this._intervals.push(setInterval(() => this._pollDomain("llm"), POLL_INTERVAL_LLM));
    // Liveness on a slightly slower cadence
    this._intervals.push(setInterval(() => this._checkOnline(), POLL_INTERVAL_LIVENESS));
    console.log(`[SparkMonitor] ${this.spark.id} started`);
  }

  /** Stop background polling. */
  stop() {
    this._running = false;
    for (const id of this._intervals) clearInterval(id);
    this._intervals = [];
    this._inflight = {};
    console.log(`[SparkMonitor] ${this.spark.id} stopped`);
  }

  /** Return a full snapshot of this Spark's metrics. */
  snapshot() {
    const ports = this._llmPorts();
    return {
      id: this.spark.id,
      name: this.spark.name,
      online: this.online,
      uptime: this._uptimeSeconds,
      disabledDevices: this.spark.disabledDevices || [],
      disabledInterfaces: this.spark.disabledInterfaces || [],
      storagePollDisabled: Boolean(this.spark.storagePollDisabled),
      llmPort: ports[0] ?? LLM_PORT,
      llmPorts: ports,
      llmCluster: this.spark.llmCluster || null,
      hardware: this._getHardwareSummary(),
      metrics: {
        // NOTE: no `timestamp` here on purpose. The broadcast path skips
        // snapshots whose JSON is byte-identical to the previous one (see
        // startBroadcast); a per-snapshot Date.now() would defeat that cache,
        // forcing a broadcast + frontend re-render every tick even when all
        // measured values are unchanged. The frontend does not consume a
        // metrics timestamp; the WS receive time can serve if one is ever
        // needed.
        gpu: this._metrics.gpu,
        cpu: this._metrics.cpu,
        ram: this._metrics.ram,
        storage: this._metrics.storage,
        network: this._metrics.network,
        unifiedMemory: this._metrics.unifiedMemory,
        llm: this._metrics.llm,
      },
    };
  }

  // ─── Uptime helper ─────────────────────────────────────────
  /** Read system uptime from /proc/uptime (local or via SSH). */
  async _readUptime() {
    let content;
    if (this.spark.isLocal) {
      const mapped = path.join(HOST_PATHS.PROC, "uptime");
      content = fs.readFileSync(mapped, "utf8");
    } else {
      content = await sshExec(this.spark, "cat /proc/uptime");
    }
    const parts = content.trim().split(/\s+/);
    const secs = parseFloat(parts[0]);
    return Number.isFinite(secs) ? Math.floor(secs) : null;
  }

  // ─── Liveness ─────────────────────────────────────────────
  async _checkOnline() {
    if (!this._running || this._inflight.online) return;
    this._inflight.online = true;
    try {
      if (this.spark.isLocal) {
        await this.collector.pingHost();
      } else {
        const result = await sshTest(this.spark);
        // Re-check after the (up to 10s) SSH await — `stop()` may have fired
        // mid-flight (removeSpark / updateSpark). Bail before mutating state or
        // running into a stopped registry entry.
        if (!this._running) return;
        if (!result.ok) throw new Error(result.message);
      }
      if (!this._running) return;
      this.online = true;
      this.lastOnlineOk = Date.now();

      // Collect system uptime
      try {
        this._uptimeSeconds = await this._readUptime();
      } catch {
        // Non-fatal — uptime stays at previous value or null
      }
    } catch {
      if (!this._running) return;
      if (!this.lastOnlineOk || Date.now() - this.lastOnlineOk > ONLINE_GRACE_MS) {
        this.online = false;
        this._uptimeSeconds = null;
      }
    } finally {
      this._inflight.online = false;
    }
  }

  // ─── Polling ──────────────────────────────────────────────
  async _poll() {
    if (!this._running) return;
    await Promise.all([
      this._checkOnline(),
      this._pollDomain("gpu"),
      this._pollDomain("cpu"),
      this._pollDomain("network"),
      this._pollDomain("storage"),
      this._pollDomain("ram"),
      this._pollDomain("memory"),
      this._pollDomain("llm"),
    ]);
  }

  async _pollDomain(domain) {
    if (!this._running || this._inflight[domain]) return;
    // Skip storage auto-poll when disabled for this spark
    if (domain === "storage" && this.spark.storagePollDisabled) return;
    this._inflight[domain] = true;
    try {
      let result;
      switch (domain) {
        case "gpu":
          result = await this.collector.collectGpu();
          break;
        case "cpu":
          result = await this.collector.collectCpu();
          break;
        case "ram":
          result = await this.collector.collectRam();
          break;
        case "network":
          result = await this.collector.collectNetwork();
          break;
        case "storage":
          result = await this.collector.collectStorage();
          break;
        case "memory":
          result = await this.collector.collectUnifiedMemory();
          break;
        case "llm":
          // Probe all ports in parallel
          result = await Promise.all(
            Array.from(this.llmProbes.values()).map((probe) => probe.probe())
          );
          break;
      }
      // Re-check after the await — `stop()`/`updateSpark()` may have torn
      // this monitor down mid-flight. Writing `_metrics` on a dead monitor
      // isn't user-visible (monitors.delete already happened) but it's a
      // latent class of bug worth killing, and a replaced monitor could
      // otherwise race the tail-end await onto the wrong object.
      if (!this._running) return;
      switch (domain) {
        case "gpu":
          this._metrics.gpu = result;
          break;
        case "cpu":
          this._metrics.cpu = result;
          break;
        case "ram":
          this._metrics.ram = result;
          break;
        case "network":
          this._metrics.network = result;
          break;
        case "storage":
          this._metrics.storage = result;
          break;
        case "memory":
          this._metrics.unifiedMemory = result;
          break;
        case "llm":
          this._metrics.llm = result;
          break;
      }
      this._lastUpdate[domain] = Date.now();
    } catch (err) {
      console.error(`[SparkMonitor] ${this.spark.id} ${domain} poll error:`, err.message);
    } finally {
      this._inflight[domain] = false;
    }
  }

  /** Manually refresh a single domain, bypassing auto-poll guards. */
  async refreshDomain(domain) {
    if (this._inflight[domain]) return;
    this._inflight[domain] = true;
    try {
      let result;
      switch (domain) {
        case "storage":
          result = await this.collector.collectStorage();
          break;
        default:
          // Fall back to _pollDomain for other domains
          this._inflight[domain] = false;
          return this._pollDomain(domain);
      }
      if (!this._running) return;
      this._metrics.storage = result;
      this._lastUpdate[domain] = Date.now();
    } catch (err) {
      console.error(`[SparkMonitor] ${this.spark.id} ${domain} refresh error:`, err.message);
    } finally {
      this._inflight[domain] = false;
    }
  }

  // ─── Hardware summary (cached, computed once) ─────────────
  _getHardwareSummary() {
    return {
      device: "NVIDIA DGX Spark",
      cpuModel: "GB10",
      cpuCores: 20,
      totalMemoryGB: 128,
      gpuChip: "GB10",
      cudaDriver: null,
      storageModel: null,
    };
  }
}
