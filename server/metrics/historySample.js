import { finite, llmKey } from "./historyTiers.js";

/**
 * One history sample from a SparkMonitor snapshot: the values of the bucketed
 * series (see historyTiers.js), keyed by series. Anything the unit did not
 * really report — offline, a failed or stale collection, no sensor, an endpoint
 * down — is left out, so it becomes a gap instead of a fake zero.
 */

/** The all-zero result a failed GPU collection returns (see SystemCollector). */
function isDefaultGpu(gpu) {
  return (
    gpu?.temperature === 0 &&
    gpu?.usage === 0 &&
    gpu?.power?.draw === 0 &&
    gpu?.vram?.total === 0
  );
}

function isDefaultCpu(cpu) {
  return cpu?.usage === 0 && cpu?.temperature === 0 && cpu?.draw === 0 && cpu?.tdp === 0;
}

/**
 * Used and free memory in MB, with the semantics of computeVramBreakdown in
 * src/shared/vramBreakdown.ts (the browser-side headroom helper; the server has
 * no shared copy): a GB10 (`kind` spark) judges its unified pool — used is GPU
 * + CPU side, free is MemAvailable — falling back to the GPU's view when the
 * pool is unknown; a discrete card (`kind` host) judges its VRAM, free = total
 * − used (the host collector puts system RAM in `vram.available` while no GPU
 * process runs).
 */
export function memoryReading(snapshot, isFresh = () => true) {
  const m = snapshot?.metrics || {};
  const unified = snapshot?.kind !== "host";
  const um = m.unifiedMemory;
  if (unified && isFresh("memory") && finite(um?.total) && um.total > 0) {
    const used = Math.max(0, finite(um.gpuUsed) ? um.gpuUsed : 0) +
      Math.max(0, finite(um.cpuUsed) ? um.cpuUsed : 0);
    const free = finite(um.available) ? Math.max(0, um.available) : Math.max(0, um.total - used);
    return { usedMB: used, freeMB: free };
  }
  const vram = m.gpu?.vram;
  if (!isFresh("gpu") || isDefaultGpu(m.gpu) || !finite(vram?.total) || vram.total <= 0) {
    return null;
  }
  const used = Math.max(0, finite(vram.used) ? vram.used : 0);
  const free =
    unified && finite(vram.available)
      ? Math.max(0, vram.available)
      : Math.max(0, vram.total - used);
  return { usedMB: used, freeMB: free };
}

/** Primary interface's rates, or the sum over shown interfaces when it is unknown. */
export function networkRates(network) {
  const shown = Array.isArray(network?.interfaces)
    ? network.interfaces.filter((i) => i && !i.disabled && i.name !== "lo")
    : [];
  if (shown.length === 0) return null;
  const primary = network.primaryInterface
    ? shown.find((i) => i.name === network.primaryInterface)
    : null;
  const picked = primary ? [primary] : shown;
  let rx = 0;
  let tx = 0;
  let any = false;
  for (const i of picked) {
    if (finite(i.rxSpeed)) {
      rx += i.rxSpeed;
      any = true;
    }
    if (finite(i.txSpeed)) {
      tx += i.txSpeed;
      any = true;
    }
  }
  return any ? { rx, tx } : null;
}

/**
 * The sample's values, keyed by series, or null for an offline unit.
 * `isFresh(domain)` lets the caller drop domains whose last collection is stale
 * or failed (SparkMonitor keeps serving the previous value, and a failed GPU
 * read yields zeros).
 */
export function extractSample(snapshot, isFresh = () => true) {
  if (!snapshot || snapshot.online !== true) return null;
  const m = snapshot.metrics || {};
  const out = {};
  const set = (key, value) => {
    if (finite(value)) out[key] = value;
  };

  const gpu = m.gpu;
  if (gpu && isFresh("gpu") && !isDefaultGpu(gpu)) {
    const avail = gpu.metricAvailability || {};
    if (avail.usage !== false) set("gpuUtil", gpu.usage);
    // 0 °C is "no sensor", not a reading.
    if (avail.temperature !== false && gpu.temperature > 0) set("gpuTemp", gpu.temperature);
    if (avail.powerDraw !== false) set("gpuPower", gpu.power?.draw);
  }

  const mem = memoryReading(snapshot, isFresh);
  if (mem) {
    set("memUsedMB", mem.usedMB);
    set("memFreeMB", mem.freeMB);
  }

  const cpu = m.cpu;
  if (cpu && isFresh("cpu") && !isDefaultCpu(cpu)) {
    set("cpuUtil", cpu.usage);
    if (cpu.temperature > 0) set("cpuTemp", cpu.temperature);
  }

  if (snapshot.kind === "host" && isFresh("ram") && finite(m.ram?.total) && m.ram.total > 0) {
    set("ramUsedMB", m.ram.used);
  }

  const net = isFresh("network") ? networkRates(m.network) : null;
  if (net) {
    set("netRx", net.rx);
    set("netTx", net.tx);
  }

  if (Array.isArray(m.llm) && isFresh("llm")) {
    // Match an entry to its port by the port it carries. After a port is added, removed or
    // reordered, metrics.llm keeps its old order until the next LLM poll, so position alone
    // would record one endpoint's rates under another's port. Entries without a port fall back
    // to their position in llmPorts.
    const ports = Array.isArray(snapshot.llmPorts) ? snapshot.llmPorts : [];
    m.llm.forEach((entry, i) => {
      const port = Number.isInteger(entry?.port) ? entry.port : ports[i];
      if (!Number.isInteger(port) || !ports.includes(port) || entry?.available !== true) return;
      // The endpoint answered but its stats could not be read: a gap, not a zero rate.
      if (entry.measurementValid === false) return;
      set(llmKey(port, "genTps"), entry.generationTps);
      set(llmKey(port, "prefillTps"), entry.prefillTps);
      if (finite(entry.kvCacheUsage)) {
        set(llmKey(port, "kvUsage"), Math.min(1, Math.max(0, entry.kvCacheUsage)));
      }
    });
  }
  return out;
}
