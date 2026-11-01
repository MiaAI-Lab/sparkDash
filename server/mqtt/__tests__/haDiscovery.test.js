/**
 * The discovery generator is pure: a snapshot in, retained config messages
 * out. These tests pin the topics, the value_template guards, and the fact
 * that structure (not values) drives the entity set.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { unitDiscoveryMessages, dashboardDiscoveryMessages } from "../haDiscovery.js";

const CTX = { prefix: "sparkdash", discoveryPrefix: "homeassistant" };

/** The same healthy snapshot shape the metricJson tests use. */
function snapshot(overrides = {}) {
  return {
    id: "alpha",
    name: "Alpha",
    kind: "spark",
    online: true,
    uptime: 3600,
    llmPorts: [8888],
    metrics: {
      gpu: {
        usage: 59.7,
        temperature: 45,
        power: { draw: 18.4, limit: 110 },
        vram: { used: 2048, total: 12288, available: 10240 },
        gpus: [
          {
            index: 0,
            name: "GB10",
            uuid: "GPU-1234",
            usage: 59.7,
            temperature: 45,
            power: { draw: 18.4, limit: 110 },
            vram: { used: 2048, total: 12288 },
          },
        ],
      },
      cpu: { usage: 23.5, temperature: 41, temperatureSource: "acpitz" },
      ram: { used: 8192, total: 32768 },
      unifiedMemory: { total: 12288, available: 10240 },
      network: { interfaces: [{ name: "enP7s7", rxSpeed: 1024, txSpeed: 2048 }] },
      storage: [{ label: "/", device: "/dev/nvme0n1p5", used: 102400, available: 204800, total: 307200 }],
      llm: [
        {
          port: 8888,
          backend: "llama.cpp",
          modelId: "qwen3-32b",
          available: true,
          generationTps: 41.5,
          prefillTps: 1200.25,
          kvCacheUsage: 0.25,
          requestsRunning: 2,
          requestsWaiting: 1,
          totalOutputTokens: 5000,
          totalPromptTokens: 12000,
          totalCachedTokens: 3000,
        },
      ],
    },
    ...overrides,
  };
}

function payloadOf(messages, object) {
  const m = messages.find((x) => x.topic.endsWith(`/${object}/config`));
  assert.ok(m, `no config for ${object}`);
  return JSON.parse(m.payload);
}

test("a full snapshot yields an entity per reading, grouped under one device", () => {
  const messages = unitDiscoveryMessages(snapshot(), CTX);
  const topics = messages.map((m) => m.topic);
  for (const object of [
    "online",
    "uptime",
    "cpu_utilization",
    "cpu_temperature",
    "ram_used",
    "memory_available",
    "power",
    "gpu_0_utilization",
    "gpu_0_temperature",
    "gpu_0_power",
    "gpu_0_memory_used",
    "llm_8888_up",
    "llm_8888_generation_tokens_per_second",
    "net_enp7s7_receive",
    "net_enp7s7_transmit",
    "disk_disk_used",
  ]) {
    assert.ok(topics.some((t) => t.endsWith(`/${object}/config`)), object);
  }
  // Every config targets the unit's metrics topic and carries the device block.
  const temp = payloadOf(messages, "gpu_0_temperature");
  assert.equal(temp.state_topic, "sparkdash/metrics/alpha");
  assert.equal(temp.device_class, "temperature");
  assert.equal(temp.unit_of_measurement, "°C");
  assert.equal(temp.device.identifiers[0], "sparkdash_alpha");
  assert.equal(temp.device.name, "Alpha");
  assert.equal(temp.device.via_device, "sparkdash-dashboard");
  // Availability: the dashboard must be up AND the unit reachable.
  assert.deepEqual(
    temp.availability.map((a) => a.topic),
    ["sparkdash/dashboard/status", "sparkdash/status/alpha"]
  );
  // Ratio → percent and bytes → GB conversions happen in the template.
  assert.match(payloadOf(messages, "gpu_0_utilization").value_template, /utilization_ratio \* 100/);
  assert.equal(payloadOf(messages, "gpu_0_utilization").unit_of_measurement, "%");
  assert.match(payloadOf(messages, "gpu_0_memory_used").value_template, /1073741824/);
  // The online sensor reads the status topic itself, gated only by the dashboard.
  const online = payloadOf(messages, "online");
  assert.equal(online.state_topic, "sparkdash/status/alpha");
  assert.deepEqual(
    online.availability.map((a) => a.topic),
    ["sparkdash/dashboard/status"]
  );
});

test("value templates guard missing readings instead of rendering a fake zero", () => {
  const snap = snapshot();
  snap.metrics.cpu = { usage: 23.5 }; // no sensor on this board
  const template = payloadOf(unitDiscoveryMessages(snap, CTX), "cpu_temperature").value_template;
  assert.match(template, /value_json\.cpu\.temperature_celsius is defined/);
});

test("a unit without sections yields only the always-present entities", () => {
  const messages = unitDiscoveryMessages({ id: "min", name: "Min", online: true }, CTX);
  assert.deepEqual(
    messages.map((m) => m.topic.split("/").at(-2)),
    ["online"]
  );
});

test("one entity set per GPU index and per LLM port", () => {
  const snap = snapshot();
  snap.metrics.gpu.gpus.push({
    index: 1,
    usage: 10,
    temperature: 50,
    power: { draw: 20, limit: 110 },
    vram: { used: 1, total: 8192 },
  });
  snap.llmPorts = [8888, 8889];
  snap.metrics.llm.push({ port: 8889, available: false });
  const messages = unitDiscoveryMessages(snap, CTX);
  const topics = messages.map((m) => m.topic);
  for (const object of ["gpu_0_utilization", "gpu_1_utilization", "llm_8888_up", "llm_8889_up"]) {
    assert.ok(topics.some((t) => t.endsWith(`/${object}/config`)), object);
  }
  // The offline endpoint still gets an entity; its template reports OFF.
  const up = payloadOf(messages, "llm_8889_up");
  assert.match(up.value_template, /item\.port == 8889/);
  assert.match(up.value_template, /'ON' if item\.up == 1 else 'OFF'/);
});

test("an AMD card's index (1000 + i) names its entities, like the Prometheus export", () => {
  const snap = snapshot();
  snap.metrics.gpu.gpus.push({ index: 1000, name: "Radeon", usage: 5, temperature: 40, power: { draw: 3 }, vram: { used: 1, total: 2 } });
  const topics = unitDiscoveryMessages(snap, CTX).map((m) => m.topic);
  assert.ok(topics.some((t) => t.endsWith("/gpu_1000_utilization/config")));
});

test("the dashboard announces its own connectivity sensor", () => {
  const [only] = dashboardDiscoveryMessages(CTX);
  assert.equal(only.topic, "homeassistant/binary_sensor/sparkdash-dashboard/connected/config");
  const cfg = JSON.parse(only.payload);
  assert.equal(cfg.state_topic, "sparkdash/dashboard/status");
  assert.equal(cfg.device_class, "connectivity");
  assert.equal(cfg.device.identifiers[0], "sparkdash-dashboard");
});

test("unit entities need both the dashboard and the unit to be available", () => {
  const messages = unitDiscoveryMessages(
    { id: "alpha", name: "Alpha", kind: "spark", online: true, uptime: 1, metrics: { cpu: { usage: 1 } } },
    { prefix: "sparkdash", discoveryPrefix: "homeassistant" }
  );
  const cpu = JSON.parse(messages.find((m) => m.topic.includes("/cpu_utilization/")).payload);
  assert.equal(cpu.availability_mode, "all");
  assert.equal(cpu.availability.length, 2);
});

test("a unit named \"dashboard\" cannot collide with the dashboard's own device", () => {
  const unit = unitDiscoveryMessages(
    { id: "dashboard", name: "Dashboard", kind: "spark", online: true, uptime: 1 },
    { prefix: "sparkdash", discoveryPrefix: "homeassistant" }
  );
  const [dash] = dashboardDiscoveryMessages({ prefix: "sparkdash", discoveryPrefix: "homeassistant" });
  const dashCfg = JSON.parse(dash.payload);
  for (const m of unit) {
    const cfg = JSON.parse(m.payload);
    assert.notEqual(m.topic, dash.topic);
    assert.notEqual(cfg.unique_id, dashCfg.unique_id);
    assert.notDeepEqual(cfg.device.identifiers, dashCfg.device.identifiers);
    assert.notEqual(cfg.state_topic, dashCfg.state_topic);
  }
});
