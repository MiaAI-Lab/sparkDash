import test from "node:test";
import assert from "node:assert/strict";
import { SystemCollector } from "../SystemCollector.js";

// The remote probe prints named `__SECTION__` blocks; this one is the NVIDIA part only.
function probeOutput(smLines, vramLines) {
  return [
    "__NVIDIA__",
    smLines,
    "__NVIDIA_VRAM__",
    vramLines,
    "__NVIDIA_APPS__",
    "",
    "__MEMINFO__",
    "MemTotal:       32000000 kB\nMemAvailable:   20000000 kB",
    "__CLOCK_CAP__",
    "",
  ].join("\n");
}

function collector(spark = { id: "gpu-box", kind: "host", host: "10.0.0.2", lanIp: "10.0.0.2" }) {
  const c = new SystemCollector(spark);
  c._nvErrNoMemory = async () => 0;
  c._kernelErrors = async () => null;
  return c;
}

// An RTX 3090 at idle: fan 0 %, PCIe Gen 3 x16 of Gen 3 x16.
const RTX3090 =
  "47, 4, 76.40, 370.00, 1755, 2115, Not Active, Not Active, Not Active, Not Active, 0, NVIDIA GeForce RTX 3090, GPU-76136769-2778-6ec5-2a82-3d1f301d0ace, 0, 3, 3, 16, 16";
// An RTX 5090 under load: power cap active, fan 30 %, PCIe Gen 5 x16.
const RTX5090 =
  "54, 100, 575.00, 575.00, 2767, 3090, Not Active, Not Active, Not Active, Active, 0, NVIDIA GeForce RTX 5090, GPU-b531e74e-0ac5-0614-607e-1a6ab6dcfe97, 30, 5, 5, 16, 16";
// A GB10 (DGX Spark): no fan, no memory figures, a PCIe value that describes nothing.
const GB10 = "69, 96, 59.42, [N/A], 2177, 3003, Not Active, Not Active, Not Active, Not Active, 0, NVIDIA GB10, GPU-073a91fa-a8ff-df52-4b9a-45fb4d0613ff, [N/A], 1, 1, 1, 16";

test("the probe asks nvidia-smi for fan speed and the PCIe link, nothing else new", async () => {
  const c = collector();
  let cmd = "";
  await c._getRemoteGpu(async (_spark, command) => {
    cmd = command;
    return probeOutput(RTX3090, "1100, 24576");
  });
  const query = cmd.match(/nvidia-smi --query-gpu=(temperature[^ ]+) --format/)[1];
  assert.ok(
    query.endsWith(",index,name,uuid,fan.speed,pcie.link.gen.current,pcie.link.gen.max,pcie.link.width.current,pcie.link.width.max"),
    query,
  );
  assert.doesNotMatch(cmd, /nvidia-smi\s+(-pm|-pl|-lgc|-r|-e|--persistence|--power-limit|--gpu-reset)/);
});

test("_getRemoteGpu: an RTX 3090 reports name, fan, PCIe link, memory and no throttle", async () => {
  const gpu = await collector()._getRemoteGpu(async () => probeOutput(RTX3090, "1100, 24576"));
  const d = gpu.gpus[0];
  assert.equal(d.name, "NVIDIA GeForce RTX 3090");
  assert.equal(d.fanPct, 0);
  assert.deepEqual(d.pcie, { gen: 3, genMax: 3, width: 16, widthMax: 16 });
  assert.equal(d.temperature, 47);
  assert.deepEqual(d.power, { draw: 76.4, limit: 370 });
  assert.equal(d.vram.used, 1100);
  assert.equal(d.vram.total, 24576);
  assert.equal(d.throttle.active, false);
});

test("_getRemoteGpu: an active power cap shows in the throttle reasons", async () => {
  const gpu = await collector()._getRemoteGpu(async () => probeOutput(RTX5090, "30000, 32607"));
  const d = gpu.gpus[0];
  assert.equal(d.fanPct, 30);
  assert.equal(d.pcie.gen, 5);
  assert.equal(d.throttle.active, true);
  assert.equal(d.throttle.detail, "SW power cap");
});

test("_getRemoteGpu: a low idle PCIe link keeps the best link beside it", async () => {
  const idle = RTX5090.replace("30, 5, 5, 16, 16", "30, 1, 5, 16, 16");
  const gpu = await collector()._getRemoteGpu(async () => probeOutput(idle, "100, 32607"));
  assert.deepEqual(gpu.gpus[0].pcie, { gen: 1, genMax: 5, width: 16, widthMax: 16 });
});

test("_getRemoteGpu: a GB10 (no memory figures) carries no fan and no PCIe link", async () => {
  const c = collector({ id: "spark", kind: "spark", host: "10.0.0.3", lanIp: "10.0.0.3" });
  const gpu = await c._getRemoteGpu(async () => probeOutput(GB10, "[N/A], [N/A]"));
  const d = gpu.gpus[0];
  assert.equal(d.fanPct, null);
  assert.equal(d.pcie, null);
});

test("_getRemoteGpu: two cards keep their own fan and link", async () => {
  const two = `${RTX3090}\n${RTX5090.replace(", 0, NVIDIA", ", 1, NVIDIA").replace("GPU-b531", "GPU-c531")}`;
  const gpu = await collector()._getRemoteGpu(async () => probeOutput(two, "1100, 24576\n2000, 32607"));
  assert.equal(gpu.gpus.length, 2);
  assert.equal(gpu.gpus[0].fanPct, 0);
  assert.equal(gpu.gpus[1].fanPct, 30);
  assert.equal(gpu.gpus[1].pcie.gen, 5);
});

test("_parseGpuLines: lines from before the fan and PCIe fields still parse (fields stay null)", () => {
  const old = "52, 96, 60.1, 140, 1794, 3003, Not Active, Not Active, Not Active, Not Active, 0, NVIDIA GB10, GPU-abc";
  const [d] = collector()._parseGpuLines(old);
  assert.equal(d.fanPct, null);
  assert.equal(d.pcie, null);
  assert.equal(d.temperature, 52);
});
