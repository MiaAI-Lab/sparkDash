import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { collectTelemetry, assembleSnapshot, buildVersions, AGENT_VERSION } from "./telemetry.js";

const SCHEMA = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("../shared/api.schema.json", import.meta.url)), "utf-8")
);

/**
 * Minimal JSON Schema (draft-07 subset) validator — the node agent has zero
 * dependencies, so this covers exactly the keywords api.schema.json uses:
 * type (string|array), required, properties, $ref (definitions), enum,
 * minimum, maximum, maxItems, items.
 */
function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function validate(instance, schema, defs, path = "$") {
  const errors = [];
  let s = schema;
  if (s.$ref) s = defs[String(s.$ref).replace(/^#\/definitions\//, "")];
  if (!s || typeof s !== "object") return errors;

  const types = s.type ? (Array.isArray(s.type) ? s.type : [s.type]) : null;
  if (types && !types.includes(typeOf(instance))) {
    errors.push(`${path}: expected ${types.join("|")}, got ${typeOf(instance)}`);
    return errors;
  }
  if (s.enum && !s.enum.includes(instance)) {
    errors.push(`${path}: ${JSON.stringify(instance)} not in enum ${JSON.stringify(s.enum)}`);
  }
  if (typeof instance === "number") {
    if (s.minimum != null && instance < s.minimum) {
      errors.push(`${path}: ${instance} < minimum ${s.minimum}`);
    }
    if (s.maximum != null && instance > s.maximum) {
      errors.push(`${path}: ${instance} > maximum ${s.maximum}`);
    }
  }
  if (typeOf(instance) === "array") {
    if (s.maxItems != null && instance.length > s.maxItems) {
      errors.push(`${path}: ${instance.length} items > maxItems ${s.maxItems}`);
    }
    if (s.items) {
      instance.forEach((item, i) => {
        errors.push(...validate(item, s.items, defs, `${path}[${i}]`));
      });
    }
  }
  if (typeOf(instance) === "object") {
    for (const req of s.required || []) {
      if (!(req in instance)) errors.push(`${path}: missing required '${req}'`);
    }
    for (const [k, v] of Object.entries(s.properties || {})) {
      if (k in instance) errors.push(...validate(instance[k], v, defs, `${path}.${k}`));
    }
  }
  return errors;
}

/** @returns {string[]} empty when valid */
function schemaErrors(instance) {
  return validate(instance, SCHEMA, SCHEMA.definitions || {});
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

const LLM_FIXTURE = [
  {
    port: 8080,
    backend: "vllm",
    version: null,
    modelId: "qwen3.8-27b",
    modelPath: "/models/qwen3.8-27b",
    contextLength: 131072,
    gpuMemoryUtilization: null,
    requestsRunning: 1,
    requestsWaiting: 0,
    kvCacheUsage: 0.42,
    preemptionsTotal: 0,
    prefixCacheHitRate: null,
    ttftP95Seconds: null,
    e2eP95Seconds: null,
    itlP95Seconds: null,
    mtpAcceptanceRate: null,
  },
];

const COMFY_FIXTURE = {
  port: 8188,
  version: "0.3.30",
  pytorchVersion: "2.5.1",
  deviceType: "CUDA",
  queueRunning: 0,
  queuePending: 0,
  activeJob: null,
  pendingJobs: [],
  lastJob: null,
  modelsInstalled: null,
};

const CONTAINERS_FIXTURE = [
  {
    name: "vllm",
    image: "lmsysorg/sglang:v1.2.0",
    imageDigest: "sha256:abc",
    status: "running",
    uptimeSeconds: 100,
    ports: ["8080:8080"],
    memUsedMB: 8192,
    memLimitMB: 131072,
    cpuPercent: 12.5,
  },
];

const GPU_FIXTURE = {
  temperature: 45,
  usage: 20,
  powerDraw: 30,
  powerLimit: 100,
  vramUsedMB: 10000,
  vramTotalMB: 128000,
  vramPercentage: 8,
  vramAvailableMB: 40000,
  processes: [],
};

const CPU_FIXTURE = { usage: 15, temperature: 45, draw: 14.2, tdp: 65 };
const MEM_FIXTURE = { usedMB: 97280, totalMB: 128000, availableMB: 30720, percentage: 76 };
const DISK_FIXTURE = [
  { device: "/dev/nvme0n1p2", mount: "/", usedMB: 100, totalMB: 200, availableMB: 60, percentage: 63 },
];
const NET_FIXTURE = [
  { iface: "eth0", ip: "192.168.50.150", rxSpeed: 0, txSpeed: 0, linkSpeedMbps: 25000 },
];
const SYSTEMD_FIXTURE = [{ name: "vllm.service", status: "running", uptimeSeconds: 400 }];

const FULL_INJECT = {
  gpu: async () => GPU_FIXTURE,
  cpu: async () => CPU_FIXTURE,
  mem: async () => MEM_FIXTURE,
  disk: async () => DISK_FIXTURE,
  net: async () => NET_FIXTURE,
  docker: async () => CONTAINERS_FIXTURE,
  systemd: async () => SYSTEMD_FIXTURE,
  llm: async () => LLM_FIXTURE,
  comfy: async () => COMFY_FIXTURE,
  uptime: async () => 12345,
};

// ─── Tests ────────────────────────────────────────────────────────────────

test("telemetry: full snapshot validates against shared/api.schema.json", async () => {
  const NOW = 1700000000000;
  const snap = await collectTelemetry(
    "narthex",
    "Narthex",
    "192.168.50.150",
    [8080],
    8188,
    { now: () => NOW, inject: FULL_INJECT }
  );

  const errors = schemaErrors(snap);
  assert.deepEqual(errors, [], `schema violations:\n${errors.join("\n")}`);

  // Identity + timing
  assert.equal(snap.nodeId, "narthex");
  assert.equal(snap.nodeName, "Narthex");
  assert.equal(snap.lanIp, "192.168.50.150");
  assert.equal(snap.polledAt, NOW);
  assert.equal(snap.uptimeSeconds, 12345);
  assert.equal(snap.online, true);
  assert.equal(snap.agentVersion, AGENT_VERSION);

  // Collector passthrough
  assert.deepEqual(snap.gpu, GPU_FIXTURE);
  assert.deepEqual(snap.cpu, CPU_FIXTURE);
  assert.deepEqual(snap.mem, MEM_FIXTURE);
  assert.deepEqual(snap.disk, DISK_FIXTURE);
  assert.deepEqual(snap.net, NET_FIXTURE);
  assert.deepEqual(snap.containers, CONTAINERS_FIXTURE);

  // Versions mapping (LlmMetrics + ComfyMetrics → VersionInfo[])
  assert.deepEqual(snap.versions.map((v) => v.serviceName), ["llm:8080", "comfyui:8188"]);
  const llmV = snap.versions[0];
  assert.equal(llmV.engine, "vllm");
  assert.equal(llmV.kind, "llm");
  assert.equal(llmV.modelId, "qwen3.8-27b");
  assert.equal(llmV.contextLength, 131072);
  assert.equal(llmV.port, 8080);
  assert.equal(llmV.state, "running");
  assert.equal(llmV.polledAt, NOW);
  const comfyV = snap.versions[1];
  assert.equal(comfyV.kind, "image");
  assert.equal(comfyV.engine, "comfyui");
  assert.equal(comfyV.engineVersion, "0.3.30");

  // Later-batch fields stay null/[] per seam contract
  assert.deepEqual(snap.requests, null);
  assert.deepEqual(snap.memory, null);
  assert.deepEqual(snap.topology, null);
  assert.deepEqual(snap.services, []);

  // Batch 1A extras (additive, schema-permitted)
  assert.deepEqual(snap.llm, LLM_FIXTURE);
  assert.deepEqual(snap.comfy, COMFY_FIXTURE);
  assert.deepEqual(snap.systemd, SYSTEMD_FIXTURE);
});

test("telemetry: all collectors failing still yields a schema-valid snapshot", async () => {
  const NOW = 1700000000000;
  const snap = await collectTelemetry("node", "node", "127.0.0.1", [], null, {
    now: () => NOW,
    inject: {
      gpu: async () => null,
      cpu: async () => null,
      mem: async () => null,
      disk: async () => [],
      net: async () => [],
      docker: async () => [],
      systemd: async () => [],
      llm: async () => [],
      comfy: async () => null,
      uptime: async () => null,
    },
  });

  const errors = schemaErrors(snap);
  assert.deepEqual(errors, [], `schema violations:\n${errors.join("\n")}`);
  assert.equal(snap.gpu, null);
  assert.equal(snap.mem, null);
  assert.equal(snap.uptimeSeconds, null);
  assert.deepEqual(snap.versions, []);
  assert.equal(snap.polledAt, NOW);
});

test("telemetry: unreachable LLM ports do not enter versions", async () => {
  const snap = await collectTelemetry("n", "n", "127.0.0.1", [9999], null, {
    now: () => 1,
    inject: {
      ...FULL_INJECT,
      llm: async () => [
        { port: 9999, backend: null, modelId: null, contextLength: null, gpuMemoryUtilization: null },
      ],
      comfy: async () => null,
    },
  });
  assert.deepEqual(snap.versions, []);
  assert.equal(snap.llm.length, 1); // raw data still attached
});

test("telemetry: quantization derived from model refs (NVFP4 ground truth)", async () => {
  const snap = assembleSnapshot({
    nodeId: "x",
    nodeName: "x",
    lanIp: "1.1.1.1",
    nowMs: 1,
    llm: [{ ...LLM_FIXTURE[0], modelPath: "RadixArk/Qwen3.8-27B-NVFP4" }],
  });
  assert.equal(snap.versions[0].quantization, "nvfp4");
});

test("telemetry: buildVersions skips null-backend entries", () => {
  assert.deepEqual(buildVersions([null, { port: 1, backend: null }], null, 5), []);
});

test("telemetry: real failing collector path (default collectGpu on a system without nvidia-smi) degrades to null", async () => {
  // Runs on the actual host: no injected gpu → real collectGpu() → null when
  // nvidia-smi is absent (Narthex) OR a real GpuMetrics when present.
  const snap = await collectTelemetry("n", "n", "127.0.0.1", [], null, {
    now: () => 3,
    inject: {
      cpu: FULL_INJECT.cpu,
      mem: FULL_INJECT.mem,
      disk: FULL_INJECT.disk,
      net: FULL_INJECT.net,
      docker: FULL_INJECT.docker,
      systemd: FULL_INJECT.systemd,
      llm: async () => [],
      comfy: async () => null,
      uptime: async () => null,
    },
  });
  const errors = schemaErrors(snap);
  assert.deepEqual(errors, [], `schema violations:\n${errors.join("\n")}`);
  if (snap.gpu != null) {
    assert.equal(typeof snap.gpu.temperature, "number");
    assert.equal(typeof snap.gpu.usage, "number");
  }
});
