import { dashboardStatusTopic, unitMetricsTopic, unitStatusTopic } from "./topics.js";

const DEFAULT_DISCOVERY_PREFIX = "homeassistant";

/**
 * The dashboard's HA ids live outside the per-unit namespace (`sparkdash_{id}`),
 * so no Spark id — "dashboard" included — can collide with them.
 */
export const DASHBOARD_HA_ID = "sparkdash-dashboard";

/** Where the dashboard's own discovery config lives. */
export function dashboardDiscoveryTopic(discoveryPrefix) {
  return `${discoveryPrefix}/binary_sensor/${DASHBOARD_HA_ID}/connected/config`;
}

/**
 * Home Assistant MQTT discovery: the retained config messages that make HA
 * create the entities itself. Every metric entity reads the unit's metrics
 * topic with a guarded value_template (a reading sparkDash could not take
 * renders `None`, which HA shows as unknown, instead of a fake zero; HA ignores
 * an empty rendering and would keep the stale value), availability follows both the
 * dashboard's and the unit's own status topics, and all entities of a unit
 * group under one HA device. Structure-driven: one entity per GPU / LLM port /
 * interface / disk the fleet actually has.
 */

/** HA node/object ids allow letters, digits, underscore and dash. Empty means "no usable name". */
function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function availabilityTopics(prefix, id) {
  return [
    // The dashboard being down means everything is stale, not just one unit.
    { topic: dashboardStatusTopic(prefix), payload_available: "1", payload_not_available: "0" },
    { topic: unitStatusTopic(prefix, id), payload_available: "1", payload_not_available: "0" },
  ];
}

function deviceBlock(snap) {
  return {
    identifiers: [`sparkdash_${snap.id}`],
    name: snap.name || snap.id,
    manufacturer: "sparkDash",
    model: snap.kind === "host" ? "GPU host" : "DGX Spark",
    via_device: DASHBOARD_HA_ID,
  };
}

/** The unit's metrics topic: every value_template reads it. */
function sensorConfig(out, snap, ctx, component, object, label, extra, stateTopic) {
  out.push({
    topic: `${ctx.discoveryPrefix}/${component}/${nodeId(snap.id)}/${object}/config`,
    payload: JSON.stringify({
      name: `${snap.name || snap.id} ${label}`,
      unique_id: `sparkdash_${snap.id}_${object}`,
      state_topic: stateTopic || unitMetricsTopic(ctx.prefix, snap.id),
      availability: availabilityTopics(ctx.prefix, snap.id),
      // Available only while both the dashboard and the unit are up; HA's
      // default ("latest") would let whichever topic was written last decide.
      availability_mode: "all",
      device: deviceBlock(snap),
      ...extra,
    }),
  });
}

/** The HA node id a unit's discovery topics use: `{discovery}/{component}/{nodeId}/{object}/config`. */
export function nodeId(id) {
  return `sparkdash_${slug(id) || "unit"}`;
}

/** A template that picks one array entry by `field` and renders `expr` when the guard holds. */
function pickTemplate(list, guard, expr) {
  // Home Assistant ignores an empty rendering and keeps the last state; the
  // literal `None` is what makes the entity read unknown.
  return `{% for item in value_json.${list} | default([]) if ${guard} %}{{ ${expr} }}{% else %}None{% endfor %}`;
}

const GPU_RATIO = "(item.utilization_ratio * 100) | round(1)";
const TO_GB = "(item.memory_used_bytes / 1073741824) | round(2)";

/**
 * Discovery messages for one unit: the entities its structure implies. A
 * section sparkDash did not collect (no GPU read, LLM monitoring off) simply
 * contributes no entities; the value_templates guard the individual readings.
 * @param {{ id: string, name?: string, kind?: string, uptime?: number, metrics?: object, llmPorts?: number[] }} snap
 * @param {{ prefix: string, discoveryPrefix: string }} ctx
 * @returns {Array<{ topic: string, payload: string }>}
 */
export function unitDiscoveryMessages(snap, ctx) {
  const out = [];
  if (!snap?.id) return out;
  const config = (component, object, label, extra, stateTopic) =>
    sensorConfig(out, snap, ctx, component, object, label, extra, stateTopic);

  // Online/offline IS the retained status topic — the dashboard alone gates its
  // availability, so the sensor reports OFF (not unavailable) when the unit is down.
  config("binary_sensor", "online", "online", {
    state_topic: unitStatusTopic(ctx.prefix, snap.id),
    payload_on: "1",
    payload_off: "0",
    device_class: "connectivity",
    availability: [{ topic: dashboardStatusTopic(ctx.prefix), payload_available: "1", payload_not_available: "0" }],
  });

  if (Number.isFinite(snap.uptime)) {
    config("sensor", "uptime", "last boot", {
      device_class: "timestamp",
      value_template:
        "{% if value_json.uptime_seconds is defined %}{{ (now() - timedelta(seconds=value_json.uptime_seconds)).isoformat() }}{% else %}None{% endif %}",
    });
  }

  const cpu = snap.metrics?.cpu;
  if (cpu && typeof cpu === "object") {
    config("sensor", "cpu_utilization", "CPU utilization", {
      unit_of_measurement: "%",
      state_class: "measurement",
      icon: "mdi:cpu-64-bit",
      value_template:
        "{% if value_json.cpu is defined and value_json.cpu.utilization_ratio is defined %}{{ (value_json.cpu.utilization_ratio * 100) | round(1) }}{% else %}None{% endif %}",
    });
    config("sensor", "cpu_temperature", "CPU temperature", {
      device_class: "temperature",
      unit_of_measurement: "°C",
      state_class: "measurement",
      value_template:
        "{% if value_json.cpu is defined and value_json.cpu.temperature_celsius is defined %}{{ value_json.cpu.temperature_celsius }}{% else %}None{% endif %}",
    });
  }

  const ram = snap.metrics?.ram;
  if (ram && typeof ram === "object") {
    config("sensor", "ram_used", "RAM used", {
      device_class: "data_size",
      unit_of_measurement: "GB",
      state_class: "measurement",
      value_template:
        "{% if value_json.ram is defined and value_json.ram.used_bytes is defined %}{{ (value_json.ram.used_bytes / 1073741824) | round(2) }}{% else %}None{% endif %}",
    });
  }

  // Same headroom rule as the Prometheus export: the unified pool on a GB10,
  // the GPU's own free VRAM on a discrete host.
  const gpuSection = snap.metrics?.gpu;
  const gpuMeasured = Boolean(
    gpuSection && Number.isFinite(gpuSection.vram?.total) && gpuSection.vram.total > 0
  );
  if (snap.kind === "host" ? gpuMeasured : snap.metrics?.unifiedMemory?.total > 0) {
    config("sensor", "memory_available", "memory available", {
      device_class: "data_size",
      unit_of_measurement: "GB",
      state_class: "measurement",
      icon: "mdi:memory",
      value_template:
        "{% if value_json.memory_available_bytes is defined %}{{ (value_json.memory_available_bytes / 1073741824) | round(2) }}{% else %}None{% endif %}",
    });
  }

  if (gpuSection && typeof gpuSection === "object") {
    const devices =
      Array.isArray(gpuSection.gpus) && gpuSection.gpus.length > 0
        ? gpuSection.gpus
        : [{ ...gpuSection, index: 0 }];
    for (const device of devices) {
      const index = Number.isFinite(device?.index) ? device.index : devices.indexOf(device);
      const byIndex = `item.index == ${JSON.stringify(index)} and `;
      config("sensor", `gpu_${index}_utilization`, `GPU ${index} utilization`, {
        unit_of_measurement: "%",
        state_class: "measurement",
        icon: "mdi:expansion-card",
        value_template: pickTemplate("gpu", byIndex + "item.utilization_ratio is defined", GPU_RATIO),
      });
      config("sensor", `gpu_${index}_temperature`, `GPU ${index} temperature`, {
        device_class: "temperature",
        unit_of_measurement: "°C",
        state_class: "measurement",
        value_template: pickTemplate("gpu", byIndex + "item.temperature_celsius is defined", "item.temperature_celsius"),
      });
      config("sensor", `gpu_${index}_power`, `GPU ${index} power`, {
        device_class: "power",
        unit_of_measurement: "W",
        state_class: "measurement",
        value_template: pickTemplate("gpu", byIndex + "item.power_watts is defined", "item.power_watts"),
      });
      config("sensor", `gpu_${index}_memory_used`, `GPU ${index} memory used`, {
        device_class: "data_size",
        unit_of_measurement: "GB",
        state_class: "measurement",
        value_template: pickTemplate("gpu", byIndex + "item.memory_used_bytes is defined", TO_GB),
      });
    }
    // Board draw across all cards, the number the energy estimates start from.
    config("sensor", "power", "power", {
      device_class: "power",
      unit_of_measurement: "W",
      state_class: "measurement",
      value_template:
        // Only when every card reported: a missing reading would be a measured-looking undercount.
        "{% set total = namespace(w=0, n=0) %}{% for d in value_json.gpu | default([]) if d.power_watts is defined %}{% set total.w = total.w + d.power_watts %}{% set total.n = total.n + 1 %}{% endfor %}{% if total.n > 0 and total.n == (value_json.gpu | length) %}{{ total.w | round(1) }}{% else %}None{% endif %}",
    });
  }

  // Probe results are in the same order as the snapshot's llmPorts.
  const llmEntries = Array.isArray(snap.metrics?.llm) ? snap.metrics.llm : [];
  const ports = Array.isArray(snap.llmPorts) ? snap.llmPorts : [];
  llmEntries.forEach((ll, i) => {
    if (!ll || typeof ll !== "object") return;
    const port = Number.isFinite(ll.port) ? ll.port : ports[i];
    if (!Number.isFinite(port)) return;
    const byPort = `item.port == ${JSON.stringify(port)} and `;
    config("binary_sensor", `llm_${port}_up`, `LLM :${port} up`, {
      value_template: pickTemplate("llm", byPort + "item.up is defined", "'ON' if item.up == 1 else 'OFF'"),
    });
    config("sensor", `llm_${port}_generation_tokens_per_second`, `LLM :${port} generation`, {
      unit_of_measurement: "tok/s",
      state_class: "measurement",
      icon: "mdi:speedometer",
      value_template: pickTemplate("llm", byPort + "item.generation_tokens_per_second is defined", "item.generation_tokens_per_second"),
    });
    config("sensor", `llm_${port}_prefill_tokens_per_second`, `LLM :${port} prefill`, {
      unit_of_measurement: "tok/s",
      state_class: "measurement",
      icon: "mdi:speedometer",
      value_template: pickTemplate("llm", byPort + "item.prefill_tokens_per_second is defined", "item.prefill_tokens_per_second"),
    });
    config("sensor", `llm_${port}_kv_cache`, `LLM :${port} KV cache`, {
      unit_of_measurement: "%",
      state_class: "measurement",
      icon: "mdi:database",
      value_template: pickTemplate("llm", byPort + "item.kv_cache_usage_ratio is defined", "(item.kv_cache_usage_ratio * 100) | round(1)"),
    });
    config("sensor", `llm_${port}_requests_running`, `LLM :${port} running requests`, {
      state_class: "measurement",
      icon: "mdi:swap-vertical",
      value_template: pickTemplate("llm", byPort + "item.requests_running is defined", "item.requests_running"),
    });
  });

  const interfaces = Array.isArray(snap.metrics?.network?.interfaces) ? snap.metrics.network.interfaces : [];
  for (const iface of interfaces) {
    if (!iface?.name || iface.disabled) continue;
    const byIface = `item.interface == ${JSON.stringify(iface.name)} and `;
    config("sensor", `net_${slug(iface.name)}_receive`, `${iface.name} receive`, {
      device_class: "data_rate",
      unit_of_measurement: "B/s",
      state_class: "measurement",
      value_template: pickTemplate("net", byIface + "item.receive_bytes_per_second is defined", "item.receive_bytes_per_second"),
    });
    config("sensor", `net_${slug(iface.name)}_transmit`, `${iface.name} transmit`, {
      device_class: "data_rate",
      unit_of_measurement: "B/s",
      state_class: "measurement",
      value_template: pickTemplate("net", byIface + "item.transmit_bytes_per_second is defined", "item.transmit_bytes_per_second"),
    });
  }

  const storage = Array.isArray(snap.metrics?.storage) ? snap.metrics.storage : [];
  for (const disk of storage) {
    if (!disk || disk.disabled || !Number.isFinite(disk.total) || disk.total <= 0) continue;
    const key = disk.label || disk.device;
    if (!key) continue;
    const field = disk.label ? "mount" : "device";
    const byDisk = `item.${field} == ${JSON.stringify(key)} and item.used_bytes is defined and item.total_bytes is defined and item.total_bytes > 0`;
    config("sensor", `disk_${slug(key) || "disk"}_used`, `${key} used`, {
      unit_of_measurement: "%",
      state_class: "measurement",
      icon: "mdi:harddisk",
      value_template: pickTemplate("disks", byDisk, "((item.used_bytes / item.total_bytes) * 100) | round(1)"),
    });
  }

  return out;
}

/**
 * The dashboard's own entity: connectivity from the retained status topic,
 * which the last-will flips to 0 if sparkDash dies uncleanly.
 */
export function dashboardDiscoveryMessages({ prefix, discoveryPrefix }) {
  return [
    {
      topic: dashboardDiscoveryTopic(discoveryPrefix),
      payload: JSON.stringify({
        name: "sparkDash dashboard",
        unique_id: `${DASHBOARD_HA_ID}_connected`,
        state_topic: dashboardStatusTopic(prefix),
        payload_on: "1",
        payload_off: "0",
        device_class: "connectivity",
        device: {
          identifiers: [DASHBOARD_HA_ID],
          name: "sparkDash",
          manufacturer: "sparkDash",
          model: "Monitoring dashboard",
        },
      }),
    },
  ];
}

export { DEFAULT_DISCOVERY_PREFIX };
