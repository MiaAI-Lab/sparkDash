import { test } from "node:test";
import { strict as assert } from "node:assert";
import { SystemCollector } from "../SystemCollector.js";

// Real output from a two-card Linux host (RTX 5080 + RTX 5060 Ti) running one
// llama-server with a layer split — the same PID holds memory on both GPUs.
const GPU_LINES = [
  "33, 0, 9.14, 360.00, 180, 3090, Not Active, Not Active, Not Active, Not Active, 0, NVIDIA GeForce RTX 5080, GPU-7b79c927-4005-59ac-5c9f-a2f4ccacf658",
  "35, 0, 3.46, 180.00, 180, 3090, Not Active, Not Active, Not Active, Active, 1, NVIDIA GeForce RTX 5060 Ti, GPU-85368d24-8210-aa5a-7f43-a21d11524352",
].join("\n");
const MEM_LINES = "13234, 16303\n8556, 16311";
const APP_LINES = [
  "108912, /home/aibox/llm/llama.cpp/build/bin/llama-server, 13192, GPU-7b79c927-4005-59ac-5c9f-a2f4ccacf658",
  "108912, /home/aibox/llm/llama.cpp/build/bin/llama-server, 8546, GPU-85368d24-8210-aa5a-7f43-a21d11524352",
].join("\n");

function collector() {
  return new SystemCollector({ id: "t", isLocal: true, kind: "host" });
}

test("_parseGpuLines: one entry per card with index/name/uuid", () => {
  const devices = collector()._parseGpuLines(GPU_LINES);
  assert.equal(devices.length, 2);
  assert.equal(devices[0].index, 0);
  assert.equal(devices[0].name, "NVIDIA GeForce RTX 5080");
  assert.equal(devices[0].uuid, "GPU-7b79c927-4005-59ac-5c9f-a2f4ccacf658");
  assert.equal(devices[1].index, 1);
  assert.equal(devices[1].powerLimit, 180);
  assert.equal(devices[1].throttle.reason, "power");
});

test("_parseGpuLine (aggregate): max temp/usage, summed power, worst throttle", () => {
  const gpu = collector()._parseGpuLine(GPU_LINES);
  assert.equal(gpu.temperature, 35);
  assert.equal(gpu.powerDraw, 12.6);
  assert.equal(gpu.powerLimit, 540);
  assert.equal(gpu.throttle.reason, "power");
});

test("_parseGpuLine: single-GPU output is unchanged (DGX Spark path)", () => {
  const gpu = collector()._parseGpuLine(GPU_LINES.split("\n")[0]);
  assert.equal(gpu.temperature, 33);
  assert.equal(gpu.powerDraw, 9.14);
  assert.equal(gpu.powerLimit, 360);
  assert.equal(gpu.throttle.reason, "ok");
});

test("_parseGpuLine: empty output → safe defaults", () => {
  const gpu = collector()._parseGpuLine("");
  assert.equal(gpu.temperature, 0);
  assert.equal(gpu.powerLimit, 120);
});

test("_sumVram: sums across cards, null when every card says N/A", () => {
  const c = collector();
  assert.deepEqual(c._sumVram(c._parseVramLines(MEM_LINES)), { used: 21790, total: 32614 });
  assert.deepEqual(c._sumVram(c._parseVramLines("[N/A], [N/A]")), { used: null, total: null });
});

test("_topProcesses: one PID on two GPUs is summed, not overwritten", () => {
  const c = collector();
  const apps = c._parseComputeApps(APP_LINES);
  assert.equal(apps[0].gpuUuid, "GPU-7b79c927-4005-59ac-5c9f-a2f4ccacf658");
  assert.notEqual(c._computeAppKey(apps[0]), c._computeAppKey(apps[1]));
  const top = c._topProcesses(apps);
  assert.equal(top.length, 1);
  assert.equal(top[0].pid, 108912);
  assert.equal(top[0].vramMB, 13192 + 8546);
});

test("_buildGpuDevices: per-card VRAM and processes", () => {
  const c = collector();
  const devices = c._parseGpuLines(GPU_LINES);
  const apps = c._parseComputeApps(APP_LINES);
  const aggregate = { used: 21790, total: 32614, percentage: 67, available: 10824 };
  const gpus = c._buildGpuDevices(devices, c._parseVramLines(MEM_LINES), apps, aggregate);
  assert.equal(gpus.length, 2);
  assert.equal(gpus[0].vram.used, 13234);
  assert.equal(gpus[0].vram.total, 16303);
  assert.equal(gpus[0].vram.percentage, 81);
  assert.equal(gpus[1].vram.available, 16311 - 8556);
  assert.equal(gpus[0].processes.length, 1);
  assert.equal(gpus[0].processes[0].vramMB, 13192);
  assert.equal(gpus[1].processes[0].vramMB, 8546);
  assert.equal(gpus[1].power.limit, 180);
});

test("_buildGpuDevices: a lone GB10 (memory N/A) inherits the aggregate VRAM", () => {
  const c = collector();
  const devices = c._parseGpuLines(
    "60, 40, 55.5, 120.00, 1500, 1800, Not Active, Not Active, Not Active, Not Active, 0, NVIDIA GB10, GPU-abc"
  );
  const aggregate = { used: 90000, total: 122000, percentage: 74, available: 30000 };
  const gpus = c._buildGpuDevices(devices, c._parseVramLines("[N/A], [N/A]"), [], aggregate);
  assert.equal(gpus.length, 1);
  assert.deepEqual(gpus[0].vram, aggregate);
});

test("_describeGpus: header label for one, identical, and mixed cards", () => {
  const c = collector();
  assert.deepEqual(c._describeGpus("NVIDIA GeForce RTX 5080, 595.84"), {
    gpuChip: "NVIDIA GeForce RTX 5080",
    gpuCount: 1,
    cudaDriver: "595.84",
  });
  assert.equal(
    c._describeGpus("NVIDIA GeForce RTX 5080, 595.84\nNVIDIA GeForce RTX 5080, 595.84").gpuChip,
    "2× NVIDIA GeForce RTX 5080"
  );
  const mixed = c._describeGpus("NVIDIA GeForce RTX 5080, 595.84\nNVIDIA GeForce RTX 5060 Ti, 595.84");
  assert.equal(mixed.gpuChip, "NVIDIA GeForce RTX 5080 + RTX 5060 Ti");
  assert.equal(mixed.gpuCount, 2);
  assert.deepEqual(c._describeGpus(""), { gpuChip: null, gpuCount: 0, cudaDriver: null });
});
