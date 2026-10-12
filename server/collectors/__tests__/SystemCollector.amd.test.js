import { test } from "node:test";
import { strict as assert } from "node:assert";
import { SystemCollector, parseAmdSmiMetrics } from "../SystemCollector.js";

const amdMetrics = {
  gpu_data: [{
    gpu: 0,
    name: "Radeon AI Pro R9700",
    usage: { gfx_activity: { value: 17, unit: "%" } },
    power: { socket_power: { value: 96, unit: "W" } },
    temperature: { edge: { value: 58, unit: "C" } },
    mem_usage: {
      total_vram: { value: 32624, unit: "MB" },
      used_vram: { value: 24576, unit: "MB" },
      free_vram: { value: 8048, unit: "MB" },
    },
  }],
};
const amdLimits = {
  gpu_data: [{ limit: { ppt0: { socket_power_limit: { value: 300, unit: "W" } } } }],
};

test("parseAmdSmiMetrics maps ROCm values and marks missing metrics unavailable", () => {
  const [gpu] = parseAmdSmiMetrics(amdMetrics, amdLimits);
  assert.equal(gpu.vendor, "amd");
  assert.equal(gpu.name, "Radeon AI Pro R9700");
  assert.equal(gpu.physicalIndex, 0);
  assert.equal(gpu.usage, 17);
  assert.equal(gpu.temperature, 58);
  assert.equal(gpu.powerDraw, 96);
  assert.equal(gpu.powerLimit, 300);
  assert.deepEqual(gpu.power, { draw: 96, limit: 300 });
  assert.equal(gpu.vram.used, 24576);
  assert.equal(gpu.vram.total, 32624);
  const [partial] = parseAmdSmiMetrics({ gpu_data: [{ gpu: 0, usage: {}, power: {}, temperature: {}, mem_usage: {} }] });
  assert.equal(partial.metricAvailability.usage, false);
  assert.equal(partial.metricAvailability.powerLimit, false);
  assert.equal(partial.metricAvailability.vramTotal, false);
  assert.deepEqual(parseAmdSmiMetrics("not json"), []);
});

test("parseAmdSmiMetrics accepts array-root output and legacy static power-limit fields", () => {
  const row = amdMetrics.gpu_data[0];
  const [gpu] = parseAmdSmiMetrics([row], [{ socket_power_limit: { value: 275, unit: "W" } }]);
  assert.equal(gpu.usage, 17);
  assert.equal(gpu.powerLimit, 275);
  assert.equal(gpu.vram.total, 32624);
  const [wrapped] = parseAmdSmiMetrics({ gpu_data: [row] }, { gpu_data: [{ limit: { ppt0: { socket_power_limit: { value: 300 } } } }] });
  assert.equal(wrapped.powerLimit, 300);
});

test("remote collection detects NVIDIA and AMD independently and combines both device sets", async () => {
  const collector = new SystemCollector({ id: "mixed", kind: "host", isLocal: false });
  collector._nvErrNoMemory = async () => 0;
  collector._kernelErrors = async () => null;
  const nvidia = "51,12,110,250,1500,2500,0,0,0,0,0,NVIDIA RTX,GPU-AAA";
  const output = [
    "__NVIDIA__", nvidia,
    "__NVIDIA_VRAM__", "100,24576",
    "__NVIDIA_APPS__", "",
    "__AMD__", JSON.stringify(amdMetrics.gpu_data),
    "__AMD_LIMITS__", JSON.stringify([{ socket_power_limit: { value: 300, unit: "W" } }]),
    "__MEMINFO__", "MemTotal: 131072000 kB\nMemAvailable: 65536000 kB",
  ].join("\n");
  const gpu = await collector._getRemoteGpu(async (_spark, command) => {
    assert.match(command, /command -v nvidia-smi/);
    assert.match(command, /command -v amd-smi/);
    return output;
  });
  assert.deepEqual(gpu.vendors, ["nvidia", "amd"]);
  assert.equal(gpu.gpus.length, 2);
  assert.deepEqual(gpu.gpus.map((device) => device.vendor), ["nvidia", "amd"]);
  assert.deepEqual(gpu.gpus.map((device) => device.index), [0, 1000]);
  assert.equal(gpu.usage, 17);
  assert.equal(gpu.power.draw, 206);
  assert.equal(gpu.vram.used, 24676);
  assert.equal(gpu.vram.total, 57200);
  assert.equal(gpu.metricAvailability.temperature, true);
});

test("local collection still probes amd-smi when nvidia-smi is present", async () => {
  const collector = new SystemCollector({ id: "mixed-local", kind: "host", isLocal: true });
  const probes = [];
  collector._nvidiaSmi = async (args) => {
    probes.push("nvidia-smi");
    return args.startsWith("--query-gpu=temperature")
      ? "51,12,110,250,1500,2500,0,0,0,0,0,NVIDIA RTX,GPU-AAA"
      : "";
  };
  collector._amdSmi = async (args) => {
    probes.push("amd-smi");
    return args.startsWith("metric") ? JSON.stringify(amdMetrics) : JSON.stringify(amdLimits);
  };
  collector._queryNvidiaVram = async () => ({ used: 100, total: 24576, available: 24476 });
  collector._getCPUPower = async () => ({ draw: 20 });
  collector._cachedApps = () => [];
  collector._topProcesses = () => [];
  collector._nvErrNoMemory = async () => 0;
  collector._kernelErrors = async () => null;
  const gpu = await collector._getGPUAll();
  assert.deepEqual(probes, ["nvidia-smi", "amd-smi", "amd-smi"]);
  assert.deepEqual(gpu.vendors, ["nvidia", "amd"]);
  assert.equal(gpu.gpus.length, 2);
  assert.equal(gpu.power.draw, 206);
});

test("amd-smi resolution checks configured ROCm locations when it is not on PATH", async () => {
  const collector = new SystemCollector({ id: "amd-path", kind: "host", isLocal: true });
  let command = "";
  collector._exec = async (value) => { command = value; return "{}"; };
  await collector._amdSmi("metric --json");
  assert.match(command, /AMD_SMI_PATH/);
  assert.match(command, /ROCM_PATH/);
  assert.match(command, /ROCM_HOME/);
  assert.match(command, /\/opt\/rocm\/bin\/amd-smi/);
  assert.match(command, /\/opt\/rocm\/core-\*\/bin\/amd-smi/);
  assert.match(command, /\/opt\/rocm-\*\/bin\/amd-smi/);
});

test("a host with no detected GPU returns the safe empty shape", async () => {
  const collector = new SystemCollector({ id: "cpu-only", kind: "host", isLocal: false });
  const gpu = await collector._getRemoteGpu(async () => "__MEMINFO__\nMemTotal: 64000000 kB\nMemAvailable: 32000000 kB");
  assert.deepEqual(gpu.gpus, []);
  assert.equal(gpu.metricAvailability.temperature, false);
  assert.equal(gpu.metricAvailability.usage, false);
});

test("AMD indexes stay in a stable vendor namespace when NVIDIA is absent", async () => {
  const collector = new SystemCollector({ id: "amd-only", kind: "host", isLocal: false });
  const output = ["__AMD__", JSON.stringify(amdMetrics), "__AMD_LIMITS__", JSON.stringify(amdLimits), "__MEMINFO__", "MemTotal: 64000000 kB\nMemAvailable: 32000000 kB"].join("\n");
  const gpu = await collector._getRemoteGpu(async () => output);
  assert.equal(gpu.gpus[0].index, 1000);
  assert.equal(gpu.vram.total, 32624);
  assert.equal(gpu.gpus[0].vram.total, 32624);
});

test("missing discrete AMD VRAM does not fall back to system RAM", async () => {
  const collector = new SystemCollector({ id: "partial-amd", kind: "host", isLocal: false });
  const metrics = { gpu_data: [{ gpu: 0, usage: { gfx_activity: { value: 12 } }, temperature: { edge: { value: 50 } }, power: {}, mem_usage: {} }] };
  const output = ["__AMD__", JSON.stringify(metrics), "__AMD_LIMITS__", "{}", "__MEMINFO__", "MemTotal: 64000000 kB\nMemAvailable: 32000000 kB"].join("\n");
  const gpu = await collector._getRemoteGpu(async () => output);
  assert.equal(gpu.vram.total, 0);
  assert.equal(gpu.gpus[0].vram.total, 0);
  assert.equal(gpu.metricAvailability.vramTotal, false);
});

test("GB10 NVIDIA per-card VRAM uses its shared OS memory pool", async () => {
  const collector = new SystemCollector({ id: "gb10", kind: "spark", isLocal: false });
  const output = ["__NVIDIA__", "43,0,8,120,1000,2000,0,0,0,0,0,NVIDIA GB10,GPU-GB10", "__NVIDIA_VRAM__", "[N/A], [N/A]", "__NVIDIA_APPS__", "", "__MEMINFO__", "MemTotal: 67108864 kB\nMemAvailable: 33554432 kB"].join("\n");
  const gpu = await collector._getRemoteGpu(async () => output);
  assert.equal(gpu.vram.total, 65536);
  assert.equal(gpu.gpus[0].vram.total, 65536);
  assert.equal(gpu.metricAvailability.vramTotal, true);
  assert.equal(gpu.gpus[0].metricAvailability.vramTotal, true);
});

test("legacy Windows collector output preserves the fourth meminfo section", async () => {
  const collector = new SystemCollector({ id: "windows-gpu", kind: "spark", isLocal: false });
  const output = ["43,0,8,120,1000,2000,0,0,0,0,0,NVIDIA GPU,GPU-WIN", "---", "[N/A], [N/A]", "---", "", "---", "MemTotal: 67108864 kB\nMemAvailable: 33554432 kB"].join("\n");
  const gpu = await collector._getRemoteGpu(async () => output);
  assert.equal(gpu.vram.total, 65536);
  assert.equal(gpu.gpus[0].vram.total, 65536);
});
