/**
 * Prometheus text exposition (format 0.0.4) for GET /metrics.
 *
 * Pure: it takes the same per-unit snapshots the WebSocket pushes and returns
 * a string, so it can be tested without a server, a monitor or a Spark.
 *
 * Naming follows Prometheus practice and the node_exporter / DCGM-exporter
 * conventions people already have dashboards for: base units (bytes, seconds,
 * celsius, watts, 0–1 ratios), `_total` only on counters, one HELP and one
 * TYPE per family. Every series carries the unit's identity as labels
 * (`unit`, `unit_name`, `kind`, `role`); GPU series add `gpu` (the nvidia-smi
 * index) so multi-GPU hosts get one series per card.
 *
 * Unknown is not zero. The collectors return zero-filled defaults when a read
 * fails, so a sample is only written when its value was actually measured:
 * an offline unit exports `sparkdash_up 0` and nothing else, a GPU whose last
 * collection failed exports no GPU series, and a null field is left out.
 */

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

const MIB = 1024 * 1024;
const MIB_NOTE = "sparkDash collects MiB; converted to bytes.";

/**
 * Every family this exporter can write, in output order.
 * @type {Array<{ name: string, type: "gauge" | "counter", help: string }>}
 */
export const METRIC_FAMILIES = [
  {
    name: "sparkdash_up",
    type: "gauge",
    help: "1 when the unit answered its last liveness check, 0 when it is unreachable (no other series are exported for it then).",
  },
  { name: "sparkdash_uptime_seconds", type: "gauge", help: "Host uptime from /proc/uptime." },
  {
    name: "sparkdash_collector_last_success_timestamp_seconds",
    type: "gauge",
    help: "Unix time of the last poll of this collector (gpu, cpu, ram, memory, network, storage, llm, roce) that returned real data. A stuck collector stops advancing while sparkdash_up stays 1; alert on time() minus this. Absent until the first success.",
  },
  {
    name: "sparkdash_gpu_info",
    type: "gauge",
    help: "Always 1; carries the GPU's name and UUID as labels.",
  },
  {
    name: "sparkdash_gpu_utilization_ratio",
    type: "gauge",
    help: "GPU utilization reported by nvidia-smi (0-1).",
  },
  {
    name: "sparkdash_gpu_temperature_celsius",
    type: "gauge",
    help: "GPU die temperature in degrees Celsius.",
  },
  { name: "sparkdash_gpu_power_watts", type: "gauge", help: "GPU board power draw in watts." },
  { name: "sparkdash_gpu_power_limit_watts", type: "gauge", help: "GPU power limit in watts." },
  {
    name: "sparkdash_gpu_memory_used_bytes",
    type: "gauge",
    help: `GPU memory in use. On a GB10 this is the GPU's share of the unified pool. ${MIB_NOTE}`,
  },
  {
    name: "sparkdash_gpu_memory_total_bytes",
    type: "gauge",
    help: `GPU memory size. On a GB10 this is the OS-visible unified pool (MemTotal). ${MIB_NOTE}`,
  },
  {
    name: "sparkdash_gpu_throttled",
    type: "gauge",
    help: "1 while nvidia-smi reports clocks limited for this reason (thermal, power, hw), else 0.",
  },
  {
    name: "sparkdash_memory_available_bytes",
    type: "gauge",
    help: `Memory headroom for new GPU work: MemAvailable of the unified pool on a GB10, free VRAM on a discrete GPU host. ${MIB_NOTE}`,
  },
  {
    name: "sparkdash_cpu_utilization_ratio",
    type: "gauge",
    help: "CPU utilization across all cores (0-1).",
  },
  {
    name: "sparkdash_cpu_temperature_celsius",
    type: "gauge",
    help: "CPU temperature in degrees Celsius; `sensor` names the source (a board/ACPI zone on a GB10, which has no CPU package sensor).",
  },
  { name: "sparkdash_ram_used_bytes", type: "gauge", help: `System RAM in use. ${MIB_NOTE}` },
  { name: "sparkdash_ram_total_bytes", type: "gauge", help: `System RAM size. ${MIB_NOTE}` },
  {
    name: "sparkdash_network_receive_bytes_per_second",
    type: "gauge",
    help: "Receive rate per interface over the last poll interval. Interfaces hidden in sparkDash are not exported.",
  },
  {
    name: "sparkdash_network_transmit_bytes_per_second",
    type: "gauge",
    help: "Transmit rate per interface over the last poll interval. Interfaces hidden in sparkDash are not exported.",
  },
  {
    name: "sparkdash_disk_used_bytes",
    type: "gauge",
    help: `Filesystem space in use. Devices hidden in sparkDash are not exported. ${MIB_NOTE}`,
  },
  {
    name: "sparkdash_disk_available_bytes",
    type: "gauge",
    help: `Filesystem space available to unprivileged users. ${MIB_NOTE}`,
  },
  { name: "sparkdash_disk_total_bytes", type: "gauge", help: `Filesystem size. ${MIB_NOTE}` },
  {
    name: "sparkdash_llm_up",
    type: "gauge",
    help: "1 when the LLM endpoint answered its last probe, else 0.",
  },
  {
    name: "sparkdash_llm_generation_tokens_per_second",
    type: "gauge",
    help: "Decode throughput over the last poll interval, from the engine's token counters.",
  },
  {
    name: "sparkdash_llm_prefill_tokens_per_second",
    type: "gauge",
    help: "Prefill (prompt processing) throughput over the last poll interval.",
  },
  {
    name: "sparkdash_llm_kv_cache_usage_ratio",
    type: "gauge",
    help: "Share of the engine's KV cache pool held by requests (0-1), where the backend reports it.",
  },
  {
    name: "sparkdash_llm_requests_running",
    type: "gauge",
    help: "Requests the engine is currently running, where the backend reports it.",
  },
  {
    name: "sparkdash_llm_requests_waiting",
    type: "gauge",
    help: "Requests queued in the engine, where the backend reports it.",
  },
  {
    name: "sparkdash_llm_generated_tokens_total",
    type: "counter",
    help: "Output tokens generated, as counted by the engine since it last started (resets with the engine).",
  },
  {
    name: "sparkdash_llm_prompt_tokens_total",
    type: "counter",
    help: "Prompt tokens processed, as counted by the engine since it last started (resets with the engine).",
  },
  {
    name: "sparkdash_llm_cached_prompt_tokens_total",
    type: "counter",
    help: "Prompt tokens served from the prefix cache, as counted by the engine since it last started.",
  },
];

const FAMILY_BY_NAME = new Map(METRIC_FAMILIES.map((f) => [f.name, f]));

/** Escape a label value: backslash, double quote and line feed. */
export function escapeLabelValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Escape HELP text: backslash and line feed. */
function escapeHelp(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/** Sample value as the exposition format spells it. */
export function formatValue(value) {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  return String(value);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** Round away float noise from percent → ratio conversions (59.7 / 100). */
function ratio(percent) {
  return Math.round((percent / 100) * 1e6) / 1e6;
}

function bytesFromMib(mib) {
  return Math.round(mib * MIB);
}

/** Label pairs → `{a="x",b="y"}`, dropping null/undefined/empty values. */
function formatLabels(labels) {
  const parts = [];
  for (const [key, value] of Object.entries(labels)) {
    if (value == null || value === "") continue;
    parts.push(`${key}="${escapeLabelValue(value)}"`);
  }
  return parts.length ? `{${parts.join(",")}}` : "";
}

/** Collected samples, grouped by family so each family's lines stay together. */
class SampleSet {
  constructor() {
    /** @type {Map<string, Map<string, string>>} family → labelString → value */
    this.families = new Map();
  }

  add(name, labels, value) {
    if (!FAMILY_BY_NAME.has(name)) throw new Error(`unknown metric family ${name}`);
    if (!finite(value)) return;
    let series = this.families.get(name);
    if (!series) {
      series = new Map();
      this.families.set(name, series);
    }
    const labelString = formatLabels(labels);
    // A duplicate series fails the whole scrape in Prometheus; keep the first.
    if (!series.has(labelString)) series.set(labelString, formatValue(value));
  }

  render() {
    const lines = [];
    for (const family of METRIC_FAMILIES) {
      const series = this.families.get(family.name);
      // sparkdash_up is always described, even for an empty fleet.
      if (!series && family.name !== "sparkdash_up") continue;
      lines.push(`# HELP ${family.name} ${escapeHelp(family.help)}`);
      lines.push(`# TYPE ${family.name} ${family.type}`);
      for (const [labelString, value] of series || []) {
        lines.push(`${family.name}${labelString} ${value}`);
      }
    }
    return lines.join("\n") + "\n";
  }
}

/** True for the zero-filled object the collector returns when a GPU read fails. */
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
 * Normalize an entry to `{ snapshot, collected }`. Accepts a bare snapshot, or
 * `{ snapshot, collected: { gpu, cpu } }` where `collected` is the monitor's
 * per-domain provenance (false = the last collection failed or never ran).
 */
function normalizeEntry(entry) {
  if (entry && typeof entry === "object" && entry.snapshot) {
    return { snapshot: entry.snapshot, collected: entry.collected || {}, collectedAt: entry.collectedAt || {} };
  }
  return { snapshot: entry, collected: {}, collectedAt: {} };
}

function addGpu(samples, base, gpu) {
  const devices =
    Array.isArray(gpu.gpus) && gpu.gpus.length > 0
      ? gpu.gpus
      : [{ ...gpu, index: 0, name: null, uuid: null }];
  for (const device of devices) {
    const index = finite(device?.index) ? device.index : devices.indexOf(device);
    const labels = { ...base, gpu: String(index) };
    if (device.name || device.uuid) {
      samples.add(
        "sparkdash_gpu_info",
        { ...labels, name: device.name ?? null, uuid: device.uuid ?? null },
        1
      );
    }
    if (finite(device.usage)) samples.add("sparkdash_gpu_utilization_ratio", labels, ratio(device.usage));
    samples.add("sparkdash_gpu_temperature_celsius", labels, device.temperature);
    samples.add("sparkdash_gpu_power_watts", labels, device.power?.draw);
    if (finite(device.power?.limit) && device.power.limit > 0) {
      samples.add("sparkdash_gpu_power_limit_watts", labels, device.power.limit);
    }
    const vram = device.vram;
    if (vram && finite(vram.total) && vram.total > 0) {
      if (finite(vram.used)) samples.add("sparkdash_gpu_memory_used_bytes", labels, bytesFromMib(vram.used));
      samples.add("sparkdash_gpu_memory_total_bytes", labels, bytesFromMib(vram.total));
    }
    const throttle = device.throttle;
    if (throttle && typeof throttle === "object" && throttle.reason !== "unknown") {
      samples.add("sparkdash_gpu_throttled", { ...labels, reason: "thermal" }, throttle.thermal ? 1 : 0);
      samples.add("sparkdash_gpu_throttled", { ...labels, reason: "power" }, throttle.powerCap ? 1 : 0);
      samples.add("sparkdash_gpu_throttled", { ...labels, reason: "hw" }, throttle.hwSlowdown ? 1 : 0);
    }
  }
}

function addLlm(samples, base, snapshot) {
  const entries = Array.isArray(snapshot.metrics?.llm) ? snapshot.metrics.llm : [];
  const ports = Array.isArray(snapshot.llmPorts) ? snapshot.llmPorts : [];
  entries.forEach((entry, i) => {
    if (!entry || typeof entry !== "object") return;
    // Probe results are in the same order as the snapshot's llmPorts.
    const port = finite(entry.port) ? entry.port : ports[i];
    if (!finite(port)) return;
    const labels = {
      ...base,
      port: String(port),
      backend: entry.backend ?? null,
      model: entry.modelId ?? null,
    };
    const reachable = entry.endpointReachable ?? entry.available;
    samples.add("sparkdash_llm_up", labels, reachable === true ? 1 : 0);
    if (entry.available !== true) return;
    if (entry.liveRatesAvailable !== false) {
      samples.add("sparkdash_llm_generation_tokens_per_second", labels, entry.generationTps);
      samples.add("sparkdash_llm_prefill_tokens_per_second", labels, entry.prefillTps);
    }
    samples.add("sparkdash_llm_kv_cache_usage_ratio", labels, entry.kvCacheUsage);
    samples.add("sparkdash_llm_requests_running", labels, entry.requestsRunning);
    samples.add("sparkdash_llm_requests_waiting", labels, entry.requestsWaiting);
    // Every backend fills totalOutputTokens, but one that publishes no counter
    // leaves it at 0 — a flat zero is not a measurement, so wait for the first
    // real count. Prompt and cached totals use null for "not exposed".
    if (finite(entry.totalOutputTokens) && entry.totalOutputTokens > 0) {
      samples.add("sparkdash_llm_generated_tokens_total", labels, entry.totalOutputTokens);
    }
    samples.add("sparkdash_llm_prompt_tokens_total", labels, entry.totalPromptTokens);
    samples.add("sparkdash_llm_cached_prompt_tokens_total", labels, entry.totalCachedTokens);
  });
}

function addUnit(samples, entry) {
  const { snapshot, collected, collectedAt } = normalizeEntry(entry);
  if (!snapshot || typeof snapshot !== "object" || !snapshot.id) return;
  const base = {
    unit: snapshot.id,
    unit_name: snapshot.name,
    kind: snapshot.kind || "spark",
    role: snapshot.role || (snapshot.workerNode ? "worker" : "standalone"),
  };
  samples.add("sparkdash_up", base, snapshot.online === true ? 1 : 0);
  if (snapshot.online !== true) return;

  samples.add("sparkdash_uptime_seconds", base, snapshot.uptime);
  for (const [collector, ms] of Object.entries(collectedAt)) {
    if (finite(ms) && ms > 0) {
      samples.add("sparkdash_collector_last_success_timestamp_seconds", { ...base, collector }, ms / 1000);
    }
  }

  const metrics = snapshot.metrics || {};
  const gpu = metrics.gpu;
  const gpuMeasured = gpu && collected.gpu !== false && !isDefaultGpu(gpu);
  if (gpuMeasured) addGpu(samples, base, gpu);

  // Headroom: the GB10 shares one pool, so MemAvailable is the real limit; a
  // discrete card is limited by its own free VRAM (system RAM does not help).
  if (snapshot.kind === "host") {
    if (gpuMeasured && finite(gpu.vram?.total) && gpu.vram.total > 0) {
      samples.add("sparkdash_memory_available_bytes", base, bytesFromMib(gpu.vram.available));
    }
  } else {
    const um = metrics.unifiedMemory;
    if (um && finite(um.total) && um.total > 0 && finite(um.available)) {
      samples.add("sparkdash_memory_available_bytes", base, bytesFromMib(um.available));
    }
  }

  const cpu = metrics.cpu;
  if (cpu && collected.cpu !== false && !isDefaultCpu(cpu)) {
    if (finite(cpu.usage)) samples.add("sparkdash_cpu_utilization_ratio", base, ratio(cpu.usage));
    // 0 °C is the collector's "no sensor" value, not a reading.
    if (finite(cpu.temperature) && cpu.temperature > 0) {
      samples.add(
        "sparkdash_cpu_temperature_celsius",
        { ...base, sensor: cpu.temperatureSource ?? null },
        cpu.temperature
      );
    }
  }

  const ram = metrics.ram;
  if (ram && finite(ram.total) && ram.total > 0) {
    samples.add("sparkdash_ram_used_bytes", base, bytesFromMib(ram.used));
    samples.add("sparkdash_ram_total_bytes", base, bytesFromMib(ram.total));
  }

  const interfaces = Array.isArray(metrics.network?.interfaces) ? metrics.network.interfaces : [];
  for (const iface of interfaces) {
    if (!iface?.name || iface.disabled) continue;
    const labels = { ...base, interface: iface.name };
    samples.add("sparkdash_network_receive_bytes_per_second", labels, iface.rxSpeed);
    samples.add("sparkdash_network_transmit_bytes_per_second", labels, iface.txSpeed);
  }

  const storage = Array.isArray(metrics.storage) ? metrics.storage : [];
  for (const disk of storage) {
    if (!disk || disk.disabled || !finite(disk.total) || disk.total <= 0) continue;
    const labels = { ...base, mount: disk.label || null, device: disk.device || null };
    samples.add("sparkdash_disk_used_bytes", labels, finite(disk.used) ? bytesFromMib(disk.used) : null);
    samples.add(
      "sparkdash_disk_available_bytes",
      labels,
      finite(disk.available) ? bytesFromMib(disk.available) : null
    );
    samples.add("sparkdash_disk_total_bytes", labels, bytesFromMib(disk.total));
  }

  addLlm(samples, base, snapshot);
}

/**
 * Render the fleet as Prometheus text exposition format 0.0.4.
 * @param {Array<object | { snapshot: object, collected?: { gpu?: boolean, cpu?: boolean }, collectedAt?: Record<string, number> }>} entries
 *   unit snapshots (SparkMonitor#snapshot()), optionally wrapped with provenance
 * @returns {string}
 */
export function renderPrometheusMetrics(entries) {
  const samples = new SampleSet();
  for (const entry of entries || []) addUnit(samples, entry);
  return samples.render();
}

/**
 * Entries for renderPrometheusMetrics from the running monitors: each unit's snapshot,
 * which collections were real measurements, and when each collector last succeeded.
 * @param {Iterable<any>} monitors SparkMonitor instances (null / undefined entries are skipped)
 */
export function metricsEntries(monitors) {
  return [...monitors]
    .filter(Boolean)
    .map((monitor) => ({
      snapshot: monitor.snapshot(),
      // Per-domain provenance: a failed GPU/CPU read is zero-filled, not real.
      collected: { ...monitor._metricCollectionSuccessful },
      collectedAt: monitor.lastSuccess(),
    }));
}
