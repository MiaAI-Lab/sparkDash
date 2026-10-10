import { test } from "node:test";
import { strict as assert } from "node:assert";
import { SystemCollector } from "../SystemCollector.js";
import {
  WINDOWS_GPU_SCRIPT,
  WINDOWS_SYSTEM_SCRIPT,
  parseWindowsSystem,
  powershellCommand,
  windowsGpuAsLinuxOutput,
} from "../windowsMetrics.js";
import { SparkRegistry } from "../../sparks/SparkRegistry.js";

const GPU_OUT = [
  "62, 35, 120.50, 320.00, 2100, 2640, Not Active, Not Active, Not Active, Not Active, 0, NVIDIA GeForce RTX 4090, GPU-abc",
  "---",
  "2048, 24564",
  "---",
  "1234, C:\\Windows\\explorer.exe, [N/A], GPU-abc",
  "---",
  "NVIDIA GeForce RTX 4090, 560.94",
].join("\r\n");

const SYSTEM_OUT = [
  "33449080|18874368|93784",
  "---",
  "17|AMD Ryzen 9 7950X 16-Core Processor|32",
  "---",
  "C:|Windows|1000000000000|400000000000",
  "D:||2000000000000|1500000000000",
  "---",
  "Ethernet",
  "---",
  "Ethernet|Up|1000000000|5000000|3000000|192.168.1.122|False",
  "Wi-Fi|Disconnected|0|0|0||False",
  "vEthernet (WSL)|Up|10000000000|9|9|172.20.0.1|True",
].join("\r\n");

function windowsCollector() {
  const collector = new SystemCollector({ id: "desktop", platform: "windows", kind: "host", isLocal: false, ssh: { host: "192.168.1.122", user: "me" } });
  collector._windowsRun = async (key) => (key === "gpu" ? GPU_OUT : SYSTEM_OUT);
  return collector;
}

test("commands are sent as an encoded PowerShell command that fits cmd.exe's line limit", () => {
  for (const script of [WINDOWS_GPU_SCRIPT, WINDOWS_SYSTEM_SCRIPT]) {
    const cmd = powershellCommand(script);
    assert.ok(cmd.length < 8000, `${cmd.length} chars`);
    assert.match(cmd, /^powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/);
    const encoded = cmd.split(" ").pop();
    assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), script);
  }
});

test("parseWindowsSystem reads memory, load, disks and adapters", () => {
  const s = parseWindowsSystem(SYSTEM_OUT);
  assert.equal(s.totalMB, 32665);
  assert.equal(s.availableMB, 18432);
  assert.equal(s.uptimeSec, 93784);
  assert.equal(s.cpuLoad, 17);
  assert.equal(s.cpuName, "AMD Ryzen 9 7950X 16-Core Processor");
  assert.equal(s.logicalCpus, 32);
  assert.equal(s.disks.length, 2);
  assert.equal(s.defaultInterface, "Ethernet");
  assert.equal(s.adapters.length, 3);
  assert.equal(s.adapters[2].virtual, true);
});

test("parseWindowsSystem tolerates empty and partial output", () => {
  const s = parseWindowsSystem("");
  assert.equal(s.totalMB, 0);
  assert.equal(s.cpuLoad, null);
  assert.deepEqual(s.disks, []);
  assert.deepEqual(s.adapters, []);
});

test("GPU output is reshaped into the sections the shared Linux parser reads", () => {
  const out = windowsGpuAsLinuxOutput(GPU_OUT);
  assert.equal(out.split("---").length, 4);
});

test("collectGpu on a Windows unit parses nvidia-smi and skips the Linux kernel-journal reads", async () => {
  const gpu = await windowsCollector().collectGpu();
  assert.equal(gpu.temperature, 62);
  assert.equal(gpu.usage, 35);
  assert.equal(gpu.power.draw, 120.5);
  assert.equal(gpu.vram.total, 24564);
  assert.equal(gpu.vram.used, 2048);
  assert.equal(gpu.vram.available, 24564 - 2048);
  assert.equal(gpu.kernelErrors, null);
  assert.equal(gpu.nvErrNoMemory, 0);
  assert.equal(gpu.gpus.length, 1);
});

test("CPU, RAM, storage, network and memory on a Windows unit", async () => {
  const c = windowsCollector();
  const cpu = await c.collectCpu();
  assert.equal(cpu.usage, 17);
  assert.ok(cpu.draw > 0 && cpu.tdp > 0);

  const ram = await c.collectRam();
  assert.equal(ram.total, 32665);
  assert.equal(ram.used, 32665 - 18432);

  const disks = await c.collectStorage();
  assert.deepEqual(disks.map((d) => d.device), ["C:", "D:"]);
  assert.equal(disks[0].total, 953674);
  assert.equal(disks[0].percentage, 60);

  const net = await c.collectNetwork();
  assert.equal(net.primaryInterface, "Ethernet");
  assert.equal(net.linkSpeedMbps, 1000);
  assert.deepEqual(net.interfaces.map((i) => i.name), ["Ethernet", "Wi-Fi"]); // virtual adapter dropped
  assert.equal(net.interfaces[1].operstate, "down");

  const mem = await c.collectUnifiedMemory();
  assert.equal(mem.total, 32665);
  assert.equal(mem.gpuUsed, 2048);

  assert.equal(await c.readWindowsUptime(), 93784);
});

test("network speeds come from the byte-counter delta between polls", async () => {
  const c = windowsCollector();
  await c.collectNetwork();
  const before = c.lastNetworkStats.get("Ethernet");
  c.lastNetworkStats.set("Ethernet", { ...before, time: before.time - 2000 });
  c._windowsRun = async (key) =>
    key === "gpu" ? GPU_OUT : SYSTEM_OUT.replace("Ethernet|Up|1000000000|5000000|3000000", "Ethernet|Up|1000000000|5002000|3001000");
  const net = await c.collectNetwork();
  const eth = net.interfaces.find((i) => i.name === "Ethernet");
  assert.equal(eth.rxSpeed, 1000);
  assert.equal(eth.txSpeed, 500);
});

test("a failing PowerShell call degrades to defaults instead of throwing", async () => {
  const c = windowsCollector();
  c._windowsRun = async () => {
    throw new Error("SSH to 192.168.1.122:22 failed: timed out");
  };
  assert.equal((await c.collectRam()).total, 0);
  assert.deepEqual(await c.collectStorage(), []);
  assert.equal((await c.collectCpu()).usage, 0);
});

test("the registry keeps platform windows, forces a host unit and drops bash-only probes", () => {
  const registry = Object.create(SparkRegistry.prototype);
  const spark = registry._normalizeConfig({
    id: "desktop",
    name: "Desktop",
    platform: "windows",
    kind: "spark",
    lanIp: "192.168.1.122",
    hermesMonitoring: true,
    tailscaleMonitoring: true,
  });
  assert.equal(spark.platform, "windows");
  assert.equal(spark.kind, "host");
  assert.equal(spark.hermesMonitoring, false);
  assert.equal(spark.tailscaleMonitoring, false);
  assert.equal(registry._normalizeConfig({ id: "x", lanIp: "10.0.0.1" }).platform, "linux");
});
