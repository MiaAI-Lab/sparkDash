/**
 * MacAgentCollector — Apple Silicon vitals and runtime inventory, read from the
 * on-device agent (`agents/macos/sparkdash_mac_agent.py --serve`) instead of
 * per-metric SSH calls.
 *
 * It returns the same shapes as MacSystemCollector, so the poll loop and the UI
 * need no new data path, with two additions the SSH transport cannot provide:
 *   - `collectRuntimes()`: which model runtime, if any, is actually serving
 *     (name, model, port), straight from the agent's data-driven inventory;
 *   - `unavailable`: metrics this Mac could not read, so the dashboard renders
 *     "unavailable" instead of a convincing zero.
 *
 * While the agent is unreachable every read falls back to the SSH collector,
 * which keeps the node visible with the metrics SSH can still get. The agent's
 * absence is itself reported, never hidden.
 */

import { MacSystemCollector, macGpuAvailability } from "./MacSystemCollector.js";
import { tagCollectionResult } from "./SystemCollector.js";
import { isAllowedTargetHost, assertAllowedTarget } from "../validate.js";
import { llmProbeHost } from "./llmHost.js";

export const MAC_AGENT_DEFAULT_PORT = 8790;
const SNAPSHOT_TTL_MS = 1500;

/**
 * Warm `/metrics` budget. Metric polls keep this and fall back to SSH.
 * A cold agent does not answer inside it: the first collect after the agent
 * or its privileged collector starts takes 7–10s, and the agent joins that
 * collect for up to 12s before it will say "pending".
 */
export const FETCH_TIMEOUT_MS = 4000;

/**
 * First runtimes probe budget. Covers the observed 7–10s cold response and
 * the agent's 12s collect deadline, so that response is not aborted.
 */
export const COLD_FETCH_TIMEOUT_MS = 12_000;

/** In-call retries after the cold probe. Backoff doubles from the base and is capped. */
export const COLD_RETRY_MAX_ATTEMPTS = 4;
export const COLD_RETRY_BASE_MS = 1_000;
export const COLD_RETRY_MAX_BACKOFF_MS = 2_000;

/**
 * Runtimes has no monitor interval (SparkMonitor collects that domain once, at
 * start). A failed first collect keeps probing on this cadence, inside the
 * same call, so a cold miss self-heals without a container restart. Bounded
 * so a dead agent still reports unreachable.
 */
export const RUNTIMES_POLL_INTERVAL_MS = 5_000;
export const RUNTIMES_POLL_MAX_ATTEMPTS = 4;

const AGENT_SCHEMA = "sparkdash.mac-agent/1";

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function isPendingBody(data) {
  return Boolean(data)
    && typeof data === "object"
    && data.status === "pending"
    && data.schema !== AGENT_SCHEMA;
}

/**
 * Probe plan for one `collectRuntimes()` call.
 * Cold attempt first (long budget, no delay), then backoff retries, then the
 * runtimes poll. `delayBeforeMs` is the wait before that attempt.
 */
export function runtimesProbeSchedule() {
  const steps = [
    { phase: "cold", timeoutMs: COLD_FETCH_TIMEOUT_MS, delayBeforeMs: 0 },
  ];
  let backoff = COLD_RETRY_BASE_MS;
  for (let i = 1; i < COLD_RETRY_MAX_ATTEMPTS; i++) {
    steps.push({ phase: "retry", timeoutMs: FETCH_TIMEOUT_MS, delayBeforeMs: backoff });
    backoff = Math.min(backoff * 2, COLD_RETRY_MAX_BACKOFF_MS);
  }
  for (let i = 0; i < RUNTIMES_POLL_MAX_ATTEMPTS; i++) {
    steps.push({
      phase: "poll",
      timeoutMs: FETCH_TIMEOUT_MS,
      delayBeforeMs: RUNTIMES_POLL_INTERVAL_MS,
    });
  }
  return steps;
}

/** Resolve where the agent lives for this unit. */
export function macAgentBaseUrl(spark) {
  const configured = String(spark?.agent?.url || "").trim();
  const host = String(spark?.agent?.host || "").trim() || llmProbeHost(spark) || "127.0.0.1";
  const port = Number(spark?.agent?.port) || MAC_AGENT_DEFAULT_PORT;
  const url = new URL(configured || `http://${host.includes(":") ? `[${host}]` : host}:${port}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/" || !isAllowedTargetHost(url.hostname.replace(/^\[|\]$/g, ""))) {
    throw new Error("Invalid Mac agent target: use an HTTP(S) base URL without credentials, query or path and an allowed host");
  }
  return url.origin;

}

/** Apply the same DNS/address policy as other administrator-configured targets. */
export async function assertMacAgentTarget(baseUrl, options) {
  const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  return assertAllowedTarget(host, [host], options);
}

/** True when a snapshot entry says this metric could not be read. */
export function isUnavailable(unavailable, metric) {
  return Array.isArray(unavailable) && unavailable.some((row) => row?.metric === metric);
}

function staleSnapshot(data) {
  return data?.sampleStale === true || (Number.isFinite(data?.sampleAgeSeconds) && data.sampleAgeSeconds > 30) || isUnavailable(data?.unavailable, "agent.sample");
}

function finiteTemperature(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function reasonFor(unavailable, metric, fallback) {
  const row = Array.isArray(unavailable) ? unavailable.find((r) => r?.metric === metric) : null;
  return row?.reason || fallback;
}

export class MacAgentCollector extends MacSystemCollector {
  /**
   * @param {object} spark
   * @param {{ fetchImpl?: typeof fetch, exec?: Function }} [options]
   */
  constructor(spark, {
    fetchImpl = globalThis.fetch,
    exec,
    sleep = delay,
    createTimeoutSignal = (ms) => AbortSignal.timeout(ms),
  } = {}) {
    super(spark, exec ? { exec } : {});
    this._fetch = fetchImpl;
    this._sleep = sleep;
    this._createTimeoutSignal = createTimeoutSignal;
    this.baseUrl = macAgentBaseUrl(spark);
    /** @type {{ at: number, data: object } | null} */
    this._agentCache = null;
    /** @type {Promise<object|null>|null} */
    this._inflight = null;
    /** @type {Promise<object>|null} */
    this._runtimesInflight = null;
    this._probeGeneration = 0;
    this._agentDown = false;
    this._lastNet = null;
  }

  invalidatePendingCollections() {
    super.invalidatePendingCollections();
    this._probeGeneration += 1;
  }

  /**
   * One agent snapshot, shared inside the TTL. Named apart from the parent's
   * SSH `_snapshot()` on purpose: with the same name, every SSH fallback the
   * parent implements would call back into the agent and never reach SSH.
   */
  async _agentSnapshot(force = false) {
    const now = Date.now();
    if (!force && this._agentCache && now - this._agentCache.at < SNAPSHOT_TTL_MS) {
      return this._agentCache.data;
    }
    if (this._inflight) return this._inflight;
    this._inflight = assertMacAgentTarget(this.baseUrl).then(() => this._fetch(`${this.baseUrl}/metrics`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "error",
    }))
      .then(async (response) => {
        if (!response.ok) throw new Error(`agent responded ${response.status}`);
        const data = await response.json();
        if (!data || typeof data !== "object" || data.schema !== AGENT_SCHEMA) {
          throw new Error("unexpected agent payload");
        }
        if (staleSnapshot(data)) throw new Error("stale agent sample");
        this._agentCache = { at: Date.now(), data };
        this._agentDown = false;
        return data;
      })
      .catch(() => {
        this._agentDown = true;
        return null;
      })
      .finally(() => {
        this._inflight = null;
      });
    return this._inflight;
  }

  _agentEntries(snapshot) {
    const entries = Array.isArray(snapshot?.unavailable) ? [...snapshot.unavailable] : [];
    const present = {
      "cpu.temperature": finiteTemperature(snapshot?.cpu?.temperature),
      "gpu.temperature": finiteTemperature(snapshot?.gpu?.temperature),
    };
    for (const metric of ["cpu.temperature", "gpu.temperature"]) {
      if (!present[metric] && !isUnavailable(entries, metric)) {
        entries.push({ metric, reason: "requires root for powermetrics" });
      }
    }
    return entries;
  }

  // ─── Metrics ──────────────────────────────────────────────

  async collectGpu() {
    const snapshot = await this._agentSnapshot();
    if (!snapshot) return super.collectGpu();
    const mem = snapshot.memory || {};
    const gpu = snapshot.gpu || {};
    const read = gpu.powermetrics === "ok";
    const base = this._defaultGpu();
    const thermal = gpu.thermalPressure && gpu.thermalPressure !== "Nominal";
    return tagCollectionResult({
      ...base,
      temperature: finiteTemperature(gpu.temperature) ? gpu.temperature : null,
      usage: read ? Math.round(gpu.activePercent ?? 0) : 0,
      power: {
        draw: read ? gpu.powerW ?? 0 : 0,
        limit: 0,
        systemDraw: read ? gpu.combinedPowerW ?? 0 : 0,
      },
      vram: {
        used: mem.used ?? 0,
        total: mem.total ?? 0,
        percentage: mem.percentage ?? 0,
        available: mem.available ?? 0,
      },
      processes: [],
      throttle: this._buildThrottle({ swThermal: Boolean(thermal), smClockMHz: gpu.freqMHz ?? null }),
      thermalPressure: snapshot.thermal?.pressureState ?? gpu.thermalPressure ?? null,
      thermal: snapshot.thermal ?? null,
      powermetricsAvailable: read,
      metricAvailability: macGpuAvailability({
        powermetrics: read,
        usage: gpu.activePercent ?? null,
        powerDraw: gpu.powerW ?? null,
        memory: mem.total ?? 0,
        temperature: finiteTemperature(gpu.temperature) ? gpu.temperature : null,
      }),
      unavailable: this._agentEntries(snapshot),
    }, Number(mem.total) > 0);
  }

  async collectCpu() {
    const snapshot = await this._agentSnapshot();
    if (!snapshot) return super.collectCpu();
    const value = snapshot.cpu?.usagePercent;
    const valid = typeof value === "number" && Number.isFinite(value) && !isUnavailable(snapshot.unavailable, "cpu.usage");
    const usage = valid ? value : 0;
    this.lastCpuUsagePct = usage;
    return tagCollectionResult({
      usage,
      usageAvailable: valid,
      temperature: finiteTemperature(snapshot.cpu?.temperature) ? snapshot.cpu.temperature : null,
      draw: snapshot.gpu?.powermetrics === "ok" ? snapshot.gpu?.cpuW ?? 0 : 0,
      tdp: 0,
    }, valid);
  }

  async collectRam() {
    const snapshot = await this._agentSnapshot();
    if (!snapshot) return super.collectRam();
    const mem = snapshot.memory || {};
    return {
      used: mem.used ?? 0,
      total: mem.total ?? 0,
      percentage: mem.percentage ?? 0,
      swap: mem.swap || { total: 0, used: 0, free: 0 },
    };
  }

  async collectUnifiedMemory() {
    const snapshot = await this._agentSnapshot();
    if (!snapshot) return super.collectUnifiedMemory();
    const mem = snapshot.memory || {};
    return {
      total: mem.total ?? 0,
      gpuUsed: mem.gpuUsed ?? 0,
      cpuUsed: mem.cpuUsed ?? 0,
      used: mem.used ?? 0,
      available: mem.available ?? 0,
      percentage: mem.percentage ?? 0,
      oomRisk: mem.oomRisk || "low",
      bandwidth: { current: 0, peak: 0 },
    };
  }

  async collectStorage() {
    const snapshot = await this._agentSnapshot();
    if (!snapshot) return super.collectStorage();
    const disabled = this.spark.disabledDevices || [];
    return (Array.isArray(snapshot.disks) ? snapshot.disks : []).map((disk) => ({
      device: disk.device,
      label: disk.label,
      used: disk.used ?? 0,
      total: disk.total ?? 0,
      available: disk.available ?? 0,
      percentage: disk.percentage ?? 0,
      readSpeed: 0,
      writeSpeed: 0,
      disabled: disabled.includes(disk.device) || disabled.includes(disk.label),
    }));
  }

  async collectNetwork() {
    const snapshot = await this._agentSnapshot();
    if (!snapshot) return super.collectNetwork();
    const network = snapshot.network;
    if (!network || !Array.isArray(network.interfaces) || network.interfaces.length === 0) {
      // The agent answered, and the answer is "no usable link" — say so rather
      // than showing an interface at zero.
      return {
        ...this._defaultNetwork(),
        unavailable: this._agentEntries(snapshot).filter((row) => row.metric === "network"),
      };
    }
    const iface = network.interfaces[0];
    const now = Date.now();
    const last = this._lastNet && this._lastNet.name === iface.name ? this._lastNet : null;
    const dtSec = last ? (now - last.time) / 1000 : 0;
    const rxSpeed = dtSec > 0 ? Math.max(0, ((iface.rxBytes ?? 0) - last.rxBytes) / dtSec) : 0;
    const txSpeed = dtSec > 0 ? Math.max(0, ((iface.txBytes ?? 0) - last.txBytes) / dtSec) : 0;
    this._lastNet = { name: iface.name, rxBytes: iface.rxBytes ?? 0, txBytes: iface.txBytes ?? 0, time: now };
    const interfaces = this._tagDisabledInterfaces([
      {
        name: iface.name,
        rxSpeed: Math.round(rxSpeed),
        txSpeed: Math.round(txSpeed),
        ip: iface.ip ?? null,
        operstate: iface.operstate || "up",
        disabled: false,
      },
    ]);
    return {
      primaryInterface: network.primaryInterface || iface.name,
      linkSpeedMbps: null,
      interfaces,
      wolMac: null,
      reachability: Array.isArray(network.reachability) ? network.reachability : undefined,
    };
  }

  /**
   * One `/metrics` read that does not join the warm in-flight fetch.
   * A parallel GPU poll uses the 4s budget; sharing that fetch would abort a
   * cold runtimes probe before the agent answered.
   * @returns {Promise<{ok: true, data: object} | {ok: false, retryable: boolean, reason: string}>}
   */
  async _probeAgentOnce(timeoutMs) {
    let response;
    try {
      await assertMacAgentTarget(this.baseUrl);
      response = await this._fetch(`${this.baseUrl}/metrics`, {
        signal: this._createTimeoutSignal(timeoutMs),
        redirect: "error",
      });
    } catch {
      return { ok: false, retryable: true, reason: "unreachable" };
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      return { ok: false, retryable: false, reason: "json" };
    }
    if (isPendingBody(data)) return { ok: false, retryable: true, reason: "pending" };
    if (!response.ok) return { ok: false, retryable: false, reason: "http" };
    if (!data || typeof data !== "object" || data.schema !== AGENT_SCHEMA) {
      return { ok: false, retryable: false, reason: "schema" };
    }
    if (staleSnapshot(data)) return { ok: false, retryable: true, reason: "stale" };
    this._agentCache = { at: Date.now(), data };
    this._agentDown = false;
    return { ok: true, data };
  }

  _offlineRuntimes() {
    this._agentDown = true;
    return {
      runtimes: [],
      agentOnline: false,
      unavailable: [
        {
          metric: "agent",
          reason: `mac agent unreachable at ${this.baseUrl} (system vitals are read over SSH instead)`,
        },
      ],
    };
  }

  _onlineRuntimes(snapshot) {
    return {
      runtimes: Array.isArray(snapshot.runtimes) ? snapshot.runtimes : [],
      agentOnline: true,
      agentVersion: snapshot.agentVersion ?? null,
      collectedAt: snapshot.collectedAt ?? null,
      unavailable: this._agentEntries(snapshot),
    };
  }

  async _collectRuntimes() {
    const generation = this._probeGeneration;
    let retryable = false;
    for (const step of runtimesProbeSchedule()) {
      if (this._probeGeneration !== generation) return this._offlineRuntimes();
      if (step.phase === "poll" && !retryable) break;
      if (step.delayBeforeMs > 0) await this._sleep(step.delayBeforeMs);
      if (this._probeGeneration !== generation) return this._offlineRuntimes();
      const probe = await this._probeAgentOnce(step.timeoutMs);
      if (probe.ok) return this._onlineRuntimes(probe.data);
      retryable = probe.retryable;
      if (!retryable) break;
    }
    return this._offlineRuntimes();
  }

  /**
   * Runtime inventory + honest availability for this Mac.
   * `agentOnline` is the latest probe in the bounded cold-start schedule, never
   * a stale first timeout. SparkMonitor collects this domain once, so the
   * retry and the runtimes poll both finish before this promise resolves.
   * @returns {Promise<{runtimes: object[], unavailable: object[], agentOnline: boolean}>}
   */
  async collectRuntimes() {
    if (this._runtimesInflight) return this._runtimesInflight;
    this._runtimesInflight = this._collectRuntimes().finally(() => {
      this._runtimesInflight = null;
    });
    return this._runtimesInflight;
  }

  /** Boot epoch seconds from the agent (SSH fallback via the parent class). */
  async readBootTime() {
    const snapshot = await this._agentSnapshot();
    const boot = Number(snapshot?.bootTime);
    if (snapshot) return Number.isFinite(boot) && boot > 0 ? boot : null;
    return super.readBootTime();
  }

  async detectHardware() {
    const snapshot = await this._agentSnapshot();
    const host = snapshot?.host;
    if (!snapshot) return super.detectHardware();
    if (!host) return null;
    const memMB = Number(host.totalMemoryMB) || 0;
    return {
      device: host.model ? `Mac (${host.model})` : "Apple Silicon Mac",
      cpuModel: host.chip ?? null,
      cpuCores: Number.isInteger(host.cpuCores) ? host.cpuCores : null,
      totalMemoryGB: memMB > 0 ? Math.round(memMB / 1024) : null,
      gpuChip: host.chip ?? null,
      cudaDriver: null,
    };
  }

  /** Liveness: the agent answering is the strongest signal available. */
  async pingHost() {
    const snapshot = await this._agentSnapshot(true);
    if (snapshot) return true;
    return super.pingHost();
  }
}
