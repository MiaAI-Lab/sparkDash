import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SystemCollector, splitRemoteGpuSections } from "../SystemCollector.js";

// One amdgpu card in the probe script's own format (a 128 GB Strix Halo iGPU).
const AMD_CARD = [
  "@amd 0000:c6:00.0",
  "id 0x1586",
  "class 0x038000",
  "busy 17",
  "vram_used 235540480",
  "vram_total 536870912",
  "vis_used 235540480",
  "vis_total 536870912",
  "gtt_used 29132099584",
  "gtt_total 122880000000",
  "power 96000000",
  "cap 300000000",
  "capmax",
  "fan",
  "temp edge 58000",
  "freq sclk 2800000000",
  "sclk 0: 2900Mhz",
  "sclk 1: 2800Mhz *",
].join("\n");

const NVIDIA = "51,12,110,250,1500,2500,0,0,0,0,0,NVIDIA RTX,GPU-AAA";
const MEMINFO = "MemTotal: 131072000 kB\nMemAvailable: 65536000 kB";

test("remote collection detects NVIDIA and AMD independently and combines both device sets", async () => {
  const collector = new SystemCollector({ id: "mixed", kind: "host", isLocal: false });
  collector._nvErrNoMemory = async () => 0;
  collector._kernelErrors = async () => null;
  const output = [
    "__NVIDIA__", NVIDIA,
    "__NVIDIA_VRAM__", "100,24576",
    "__NVIDIA_APPS__", "",
    "__AMD__", AMD_CARD,
    "__MEMINFO__", MEMINFO,
  ].join("\n");
  const gpu = await collector._getRemoteGpu(async (_spark, command) => {
    assert.match(command, /command -v nvidia-smi/);
    // No vendor tool on the node: the AMD section comes from the driver's own files.
    assert.doesNotMatch(command, /amd-smi/);
    assert.match(command, /gpu_busy_percent/);
    return output;
  });
  assert.deepEqual(gpu.vendors, ["nvidia", "amd"]);
  assert.deepEqual(gpu.gpus.map((device) => device.vendor), ["nvidia", "amd"]);
  assert.deepEqual(gpu.gpus.map((device) => device.index), [0, 1000]);
  assert.equal(gpu.usage, 17);
  assert.equal(gpu.power.draw, 110 + 96);
  assert.equal(gpu.metricAvailability.temperature, true);
});

test("AMD indexes stay in a stable vendor namespace when NVIDIA is absent", async () => {
  const collector = new SystemCollector({ id: "amd-only", kind: "host", isLocal: false });
  const gpu = await collector._getRemoteGpu(async () => ["__AMD__", AMD_CARD, "__MEMINFO__", MEMINFO].join("\n"));
  assert.equal(gpu.gpus.length, 1);
  assert.equal(gpu.gpus[0].index, 1000);
  assert.equal(gpu.gpus[0].physicalIndex, 0);
  assert.equal(gpu.gpus[0].vendor, "amd");
  assert.equal(gpu.gpus[0].temperature, 58);
  assert.equal(gpu.gpus[0].powerDraw, 96);
  assert.equal(gpu.gpus[0].powerLimit, 300);
  assert.equal(gpu.gpus[0].smClockMHz, 2800);
  assert.equal(gpu.gpus[0].throttle.smClockMaxMHz, 2900);
  // The APU pool is the carve-out and GTT together, not the 512 MB BAR window.
  assert.equal(gpu.gpus[0].vram.total, Math.round((536870912 + 122880000000) / 1048576));
  assert.equal(gpu.gpus[0].vram.used, Math.round((235540480 + 29132099584) / 1048576));
  assert.equal(gpu.vram.total, gpu.gpus[0].vram.total);
});

test("a host with no detected GPU returns the safe empty shape", async () => {
  const collector = new SystemCollector({ id: "cpu-only", kind: "host", isLocal: false });
  const gpu = await collector._getRemoteGpu(async () => `__MEMINFO__\n${MEMINFO}`);
  assert.deepEqual(gpu.gpus, []);
  assert.equal(gpu.metricAvailability.temperature, false);
  assert.equal(gpu.metricAvailability.usage, false);
});

test("an AMD section of nothing but noise is no devices", async () => {
  const collector = new SystemCollector({ id: "amd-noise", kind: "host", isLocal: false });
  const gpu = await collector._getRemoteGpu(async () => "__AMD__\nfind: no such directory\n__MEMINFO__\n" + MEMINFO);
  assert.deepEqual(gpu.gpus, []);
});

test("local collection reads AMD from sysfs next to nvidia-smi", async () => {
  const collector = new SystemCollector({ id: "mixed-local", kind: "host", isLocal: true });
  const probes = [];
  collector._nvidiaSmi = async (args) => {
    probes.push("nvidia-smi");
    return args.startsWith("--query-gpu=temperature") ? NVIDIA : "";
  };
  collector._readLocalClockCap = async () => null;
  collector._probeIntelLocal = async () => "";
  collector._amdLocalDevices = () => [
    {
      index: 1000, physicalIndex: 0, name: "AMD GPU", uuid: null, vendor: "amd",
      temperature: 58, usage: 17, powerDraw: 96, powerLimit: 300,
      power: { draw: 96, limit: 300 },
      vram: { used: 28007, total: 117700, percentage: 24, available: 89693 },
      metricAvailability: { temperature: true, usage: true, powerDraw: true, powerLimit: true, vramUsed: true, vramTotal: true },
      throttle: null, processes: [],
    },
  ];
  collector._queryNvidiaVram = async () => ({ used: 100, total: 24576, available: 24476 });
  collector._getCPUPower = async () => ({ draw: 20 });
  collector._cachedApps = () => [];
  collector._topProcesses = () => [];
  collector._nvErrNoMemory = async () => 0;
  collector._kernelErrors = async () => null;
  const gpu = await collector._getGPUAll();
  assert.deepEqual(probes, ["nvidia-smi"]);
  assert.deepEqual(gpu.vendors, ["nvidia", "amd"]);
  assert.equal(gpu.gpus.length, 2);
  assert.equal(gpu.power.draw, 206);
});

test("_amdLocalDevices reads a sysfs tree and stamps the AMD index range on it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amd-sys-"));
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const link = (rel, target) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.symlinkSync(target, path.join(root, rel));
  };
  link("class/drm/card0/device", "../../../devices/0000:c6:00.0");
  fs.mkdirSync(path.join(root, "bus/pci/drivers/amdgpu"), { recursive: true });
  link("devices/0000:c6:00.0/driver", "../../bus/pci/drivers/amdgpu");
  w("devices/0000:c6:00.0/class", "0x038000\n");
  w("devices/0000:c6:00.0/gpu_busy_percent", "42\n");
  w("devices/0000:c6:00.0/mem_info_vram_total", "536870912\n");
  w("devices/0000:c6:00.0/mem_info_vis_vram_total", "536870912\n");
  w("devices/0000:c6:00.0/mem_info_gtt_total", "122880000000\n");
  w("devices/0000:c6:00.0/hwmon/hwmon2/name", "amdgpu\n");
  w("devices/0000:c6:00.0/hwmon/hwmon2/temp1_input", "61000\n");
  w("devices/0000:c6:00.0/hwmon/hwmon2/power1_average", "55000000\n");
  const collector = new SystemCollector({ id: "amd-local", kind: "host", isLocal: true });
  collector._sysRoots = () => [root];
  const [device] = collector._amdLocalDevices();
  assert.equal(device.index, 1000);
  assert.equal(device.vendor, "amd");
  assert.equal(device.usage, 42);
  assert.equal(device.temperature, 61);
  assert.equal(device.powerDraw, 55);
  assert.equal(device.metricAvailability.usage, true);
  assert.ok(device.vram.total > 100000, "the APU pool is carve-out + GTT");
  fs.rmSync(root, { recursive: true, force: true });
});

test("_amdLocalDevices is empty when there is no sysfs to read", () => {
  const collector = new SystemCollector({ id: "amd-none", kind: "host", isLocal: true });
  collector._sysRoots = () => ["/does/not/exist"];
  assert.deepEqual(collector._amdLocalDevices(), []);
});

test("remote sections survive a double underscore inside a GPU name and the AMD probe", async () => {
  const collector = new SystemCollector({ id: "dunder", kind: "host", isLocal: false });
  collector._nvErrNoMemory = async () => 0;
  collector._kernelErrors = async () => null;
  const output = [
    "", "__NVIDIA__", "51,12,110,250,1500,2500,0,0,0,0,0,NVIDIA__RTX__A6000,GPU-AAA",
    "", "__NVIDIA_VRAM__", "100,24576",
    "", "__NVIDIA_APPS__",
    "", "__AMD__", AMD_CARD.replace("0x1586", "AMD__Radeon__Strix"),
    "", "__MEMINFO__", MEMINFO,
  ].join("\n");
  const gpu = await collector._getRemoteGpu(async () => output);
  assert.deepEqual(gpu.gpus.map((d) => d.name), ["NVIDIA__RTX__A6000", "AMD GPU [AMD__Radeon__Strix]"]);
  assert.equal(gpu.gpus[1].power.limit, 300);
});

test("splitRemoteGpuSections only breaks on whole-line known markers", () => {
  const sections = splitRemoteGpuSections("noise\r\n__AMD__\r\nbusy 5\r\n__FOO__\r\n__MEMINFO__\r\nMemTotal: 1 kB\r\n");
  assert.deepEqual(Object.keys(sections), ["AMD", "MEMINFO"]);
  assert.equal(sections.AMD, "busy 5\n__FOO__");
});

test("the AMD index range no longer carries an amd-smi limits section", () => {
  const sections = splitRemoteGpuSections("__AMD__\nbusy 5\n__AMD_LIMITS__\n{}\n__MEMINFO__\nMemTotal: 1 kB\n");
  // The old section name is gone: its body stays part of the AMD section, harmlessly.
  assert.deepEqual(Object.keys(sections), ["AMD", "MEMINFO"]);
  assert.match(sections.AMD, /__AMD_LIMITS__\n\{\}/);
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

test("NVIDIA with an N/A power.limit keeps the 120 W default shown, as before AMD support", () => {
  const collector = new SystemCollector({ id: "gb10", isLocal: true });
  const [d] = collector._parseGpuLines("40,5,12.5,[N/A],1500,2500,0,0,0,0,0,NVIDIA GB10,GPU-AAA");
  assert.equal(d.powerLimit, 120);
  assert.equal(d.metricAvailability.powerLimit, true);
  const agg = collector._aggregateGpuDevices([d]);
  assert.equal(agg.powerLimit, 120);
  assert.equal(agg.metricAvailability.powerLimit, true);
});

test("the remote GPU probe runs to the end under a zsh login shell", { skip: spawnSync("zsh", ["-c", "true"]).error != null }, async () => {
  const collector = new SystemCollector({ id: "worker", isLocal: false, kind: "spark" });
  let command = "";
  await collector._getRemoteGpu(async (_spark, cmd) => { command = cmd; return ""; });
  // An unmatched glob aborts zsh before any section prints.
  const run = spawnSync("zsh", ["-c", command], { encoding: "utf8" });
  assert.doesNotMatch(run.stderr, /no matches found/);
  assert.match(run.stdout, /__MEMINFO__/);
});
