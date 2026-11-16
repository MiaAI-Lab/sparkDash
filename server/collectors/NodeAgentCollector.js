/**
 * NodeAgentCollector — a Linux unit read from its node agent (nodeAgent.js)
 * instead of SSH. The agent's snapshot is rendered into the exact text the SSH
 * commands print, and the inherited SystemCollector parsers do the rest, so an
 * agent unit and an SSH unit produce the same metrics by the same rules.
 *
 * There is no SSH fallback: when the agent cannot be read the unit goes
 * offline with the agent's error as the reason. Falling back would silently
 * bring back the SSH session churn the agent exists to remove.
 */
import { REMOTE_IO_MARKER, SystemCollector, tagCollectionResult } from "./SystemCollector.js";
import { RoceSampler, ROCE_FAST_SCRIPT } from "./roce.js";
import { WOL_INTERFACE } from "../wol.js";
import { NodeAgentClient } from "./nodeAgent.js";

const MIB = 1024 * 1024;
const DF_HEADER = "Filesystem Type 1B-blocks Used Available Use% Mounted";

const na = (v) => (v == null || !Number.isFinite(Number(v)) ? "[N/A]" : String(v));
const field = (v) => (v == null ? "" : String(v).replace(/[\r\n|]/g, " "));
const oneLine = (v) => String(v ?? "").replace(/[\r\n]+/g, " ").trim();
const active = (flag) => (flag ? "Active" : "Not Active");
const mib = (bytes) => (bytes == null ? null : bytes / MIB);

/** /proc/meminfo lines for the fields the agent read. */
export function meminfoText(memory) {
  const lines = [];
  if (memory?.totalKb != null) lines.push(`MemTotal: ${memory.totalKb} kB`);
  if (memory?.availableKb != null) lines.push(`MemAvailable: ${memory.availableKb} kB`);
  return lines.join("\n");
}

/** nvidia-smi `--query-compute-apps=pid,process_name,used_gpu_memory,gpu_uuid` rows. */
function computeAppsText(gpus, { withUuid }) {
  const rows = [];
  for (const gpu of gpus) {
    for (const p of gpu.processes ?? []) {
      const name = oneLine(p.name) || "unknown";
      // Only the uuid form is parsed from both ends; the short form splits on every comma.
      const cols = [p.pid, withUuid ? name : name.replace(/,/g, " "), na(mib(p.usedBytes))];
      if (withUuid && gpu.uuid) cols.push(gpu.uuid);
      rows.push(cols.join(", "));
    }
  }
  return rows.join("\n");
}

/** The sectioned output of SystemCollector's remote GPU command. */
export function gpuOutput(snap) {
  const gpus = Array.isArray(snap.gpus) ? snap.gpus : [];
  const out = [];
  if (gpus.length || !snap.gpuError) {
    out.push("__NVIDIA__");
    for (const g of gpus) {
      const t = g.throttle;
      out.push([
        na(g.tempC), na(g.utilPct), na(g.powerW), na(g.powerLimitW), na(g.smClockMhz), na(g.smClockMaxMhz),
        t ? active(t.hwThermal) : "[N/A]", t ? active(t.swThermal) : "[N/A]",
        t ? active(t.hwSlowdown) : "[N/A]", t ? active(t.swPowerCap) : "[N/A]",
        g.index, oneLine(g.name).replace(/,/g, " ") || "[N/A]", g.uuid || "[N/A]", na(g.fanPct),
        na(g.pcie?.gen), na(g.pcie?.genMax), na(g.pcie?.width), na(g.pcie?.widthMax),
      ].join(", "));
    }
    out.push("__NVIDIA_VRAM__");
    for (const g of gpus) out.push(`${na(mib(g.memUsedBytes))}, ${na(mib(g.memTotalBytes))}`);
    out.push("__NVIDIA_APPS__", computeAppsText(gpus, { withUuid: true }));
  }
  out.push("__MEMINFO__", meminfoText(snap.memory));
  out.push("__CLOCK_CAP__", oneLine(snap.gpuClockCapMarker), oneLine(snap.bootId));
  return out.join("\n");
}

/** /proc/stat aggregate line, CPU architecture, then "<sensor> <millidegrees>" lines. */
export function cpuOutput(snap) {
  const times = snap.cpu?.times;
  if (!Array.isArray(times) || times.length < 4) throw new Error("node agent sent no CPU counters");
  const sensors = (snap.cpu?.tempSensors ?? [])
    .filter((s) => Number.isInteger(s?.millidegrees) && s.millidegrees >= 0)
    .map((s) => `${String(s.source || "unknown").replace(/\s+/g, "_")} ${s.millidegrees}`);
  return [`cpu  ${times.join(" ")}`, "---", String(snap.arch ?? ""), "---", ...sensors].join("\n");
}

/** `df -B1 -T` rows plus the block-device counters, as the remote storage command prints them. */
export function storageOutput(snap) {
  const rows = [DF_HEADER];
  for (const d of snap.disks ?? []) {
    if (/\s/.test(d.device ?? "") || !d.mount) continue;
    const used = d.usedBytes ?? 0;
    const avail = d.availableBytes ?? 0;
    const pct = used + avail > 0 ? Math.ceil((used * 100) / (used + avail)) : 0;
    rows.push([d.device, d.fsType || "-", d.totalBytes ?? 0, used, avail, `${pct}%`, d.mount].join(" "));
  }
  const io = Object.entries(snap.blockStats ?? {}).map(
    ([name, s]) => `${name} 0 0 ${s?.sectorsRead ?? ""} 0 0 0 ${s?.sectorsWritten ?? ""}`
  );
  return [...rows, REMOTE_IO_MARKER, ...io].join("\n");
}

/** /proc/net/dev, /proc/net/route, `ip -4 addr`, operstate, WoL MAC and link speeds, "---" separated. */
export function networkOutput(snap) {
  const ifaces = (snap.network?.interfaces ?? []).filter((i) => /^[^\s:/]{1,64}$/.test(i?.name ?? ""));
  const dev = ["Inter-|   Receive", " face |bytes", ...ifaces.map(
    (i) => `${i.name}: ${i.rxBytes ?? 0} 0 0 0 0 0 0 0 ${i.txBytes ?? 0} 0 0 0 0 0 0 0`
  )];
  const def = snap.network?.defaultInterface;
  const route = ["Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT"];
  if (def) route.push(`${def}\t00000000\t00000000\t0003\t0\t0\t0\t00000000\t0\t0\t0`);
  const addr = ifaces.flatMap((i, n) => [
    `${n + 1}: ${i.name}: <>`,
    ...(i.ipv4 ?? []).map((ip) => `    inet ${ip}/32 scope global ${i.name}`),
  ]);
  const operstate = ifaces.map((i) => `${i.name}:${i.operstate || "unknown"}`);
  const wol = ifaces.find((i) => i.name === WOL_INTERFACE)?.mac ?? "";
  const speed = ifaces.filter((i) => i.speedMbps > 0).map((i) => `${i.name}:${i.speedMbps}`);
  return [dev.join("\n"), route.join("\n"), addr.join("\n"), operstate.join("\n"), wol, speed.join("\n")].join("\n---\n");
}

/** /proc/meminfo plus nvidia-smi compute apps, as the remote unified-memory command prints them. */
export function unifiedMemoryOutput(snap) {
  return [meminfoText(snap.memory), "---", computeAppsText(snap.gpus ?? [], { withUuid: false })].join("\n");
}

/** GPU names and driver, CPU model, core count and MemTotal, as the remote hardware command prints them. */
export function hardwareOutput(snap) {
  const smi = (snap.gpus ?? []).map((g) => `${oneLine(g.name).replace(/,/g, " ")}, ${snap.gpuDriver ?? ""}`);
  const model = snap.cpu?.model ? `model name\t: ${oneLine(snap.cpu.model)}` : "";
  return [smi.join("\n"), model, String(snap.cpu?.cores ?? ""), meminfoText(snap.memory)].join("\n---\n");
}

/** ROCE_FAST_SCRIPT output from the agent's RDMA readings. */
export function roceFastOutput(snap) {
  const lines = [];
  for (const d of snap.rdma?.devices ?? []) {
    const name = field(d.name);
    if (!name) continue;
    lines.push(["DEV", name, field(d.state), field(d.physState), field(d.rate), field(d.linkLayer), field(d.netdev)].join("|"));
    for (const [counter, value] of Object.entries(d.hwCounters ?? {})) lines.push(`CNT|${name}|${field(counter)}|${field(value)}`);
    lines.push(`DATA|${name}|${field(d.rxData)}|${field(d.txData)}`);
  }
  for (const n of snap.rdma?.netdevs ?? []) {
    lines.push(["NET", field(n.name), field(n.operstate), field(n.mtu), field(n.speed), field(n.rxBytes), field(n.txBytes),
      field(n.rxErrors), field(n.txErrors), field(n.rxDropped), field(n.txDropped)].join("|"));
  }
  return lines.join("\n");
}

export class NodeAgentCollector extends SystemCollector {
  /**
   * @param {object} spark
   * @param {{ client?: NodeAgentClient }} [options]
   */
  constructor(spark, { client } = {}) {
    super(spark, {
      exec: async () => {
        throw new Error("node agent units do not run metric commands over SSH");
      },
    });
    this.agent = client ?? new NodeAgentClient(spark.agent);
    /** Last result per domain, keyed by the snapshot it came from. */
    this._byDomain = new Map();
    /** Snapshot behind the GPU poll in progress (kernel counters ride on it). */
    this._gpuSnap = null;
  }

  /** Rebuild one domain only from a snapshot it has not seen, so rates never compare a snapshot with itself. */
  async _fromAgent(domain, build) {
    const snap = await this.agent.snapshot();
    const prev = this._byDomain.get(domain);
    if (prev && prev.at === snap.collectedAtMs) return prev.value;
    const value = await build(snap);
    this._byDomain.set(domain, { at: snap.collectedAtMs, value });
    return value;
  }

  async collectGpu() {
    try {
      const gpu = await this._fromAgent("gpu", (snap) => {
        this._gpuSnap = snap;
        return this._getRemoteGpu(async () => gpuOutput(snap));
      });
      return tagCollectionResult(gpu, this._isSuccessfulGpuCollection(gpu));
    } catch (err) {
      console.error(`[NodeAgentCollector] GPU error for ${this.spark.id}:`, err.message);
      return tagCollectionResult(this._defaultGpu(), false);
    }
  }

  async collectCpu() {
    const sequence = ++this._cpuCollectionSequence;
    try {
      const cpu = await this._fromAgent("cpu", (snap) => this._getRemoteCpu(sequence, async () => cpuOutput(snap)));
      return tagCollectionResult(cpu, this._isSuccessfulCpuCollection(cpu));
    } catch (err) {
      console.error(`[NodeAgentCollector] CPU error for ${this.spark.id}:`, err.message);
      return tagCollectionResult(this._defaultCpu(), false);
    }
  }

  async collectRam() {
    try {
      return await this._fromAgent("ram", (snap) => this._getRemoteRam(async () => meminfoText(snap.memory)));
    } catch (err) {
      console.error(`[NodeAgentCollector] RAM error for ${this.spark.id}:`, err.message);
      return this._defaultRam();
    }
  }

  async collectStorage() {
    try {
      return await this._fromAgent("storage", (snap) =>
        this._parseRemoteStorage(storageOutput(snap), snap.collectedAtMs)
      );
    } catch (err) {
      console.error(`[NodeAgentCollector] Storage error for ${this.spark.id}:`, err.message);
      return [];
    }
  }

  async collectNetwork() {
    try {
      return await this._fromAgent("network", (snap) => this._getRemoteNetwork(async () => networkOutput(snap)));
    } catch (err) {
      console.error(`[NodeAgentCollector] Network error for ${this.spark.id}:`, err.message);
      return this._defaultNetwork();
    }
  }

  async collectUnifiedMemory() {
    try {
      return await this._fromAgent("memory", (snap) => this._getRemoteUnifiedMemory(async () => unifiedMemoryOutput(snap)));
    } catch (err) {
      console.error(`[NodeAgentCollector] Unified memory error for ${this.spark.id}:`, err.message);
      return this._defaultUnifiedMemory();
    }
  }

  /** RDMA link state and counters from the agent. Its ethtool/mlnx_qos details need a shell, so they stay empty. */
  async collectRoce() {
    this._roceSampler ??= new RoceSampler({
      run: async (script) => (script === ROCE_FAST_SCRIPT ? roceFastOutput(await this.agent.snapshot()) : ""),
    });
    try {
      return await this._roceSampler.sample();
    } catch (err) {
      console.error(`[NodeAgentCollector] RoCE error for ${this.spark.id}:`, err.message);
      return undefined;
    }
  }

  async detectHardware() {
    const snap = await this.agent.snapshot().catch(() => null);
    return snap ? super.detectHardware(async () => hardwareOutput(snap)) : null;
  }

  /** Seconds since boot; rejects when the agent cannot be read, which is this unit's liveness check. */
  async readUptime() {
    const snap = await this.agent.snapshot();
    return Number.isFinite(snap.uptimeS) ? Math.floor(snap.uptimeS) : null;
  }

  async pingHost() {
    await this.agent.snapshot();
    return true;
  }

  /** Resident vLLM discovery needs docker on the unit, which the agent does not expose. */
  async probeResidentModels() {
    return null;
  }

  /** Since-boot kernel counters from the agent's /dev/kmsg reader; null when it could not see the whole boot. */
  _kernelLog() {
    const log = this._gpuSnap?.kernelLog;
    return log && log.complete === true ? log : null;
  }

  async _kernelErrors() {
    const log = this._kernelLog();
    return log ? { xid: log.xid, oomKills: log.oomKills, lastXid: log.lastXid ?? null } : null;
  }

  async _nvErrNoMemory() {
    return this._kernelLog()?.nvErrNoMemory ?? null;
  }
}
