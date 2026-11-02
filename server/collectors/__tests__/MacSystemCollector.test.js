import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MacSystemCollector,
  parseBootTime,
  parseDf,
  parseNetstatBytes,
  parsePowermetrics,
  parseSwapUsage,
  parseSysctl,
  parseTopCpu,
  parseVmStat,
  splitSections,
  unifiedMemoryFromVmStat,
  macGpuAvailability,
} from "../MacSystemCollector.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => fs.readFileSync(path.join(here, "fixtures", "mac", name), "utf8");

const SECTION = "__SPARKDASH_SECTION__";
const snapshotOutput = ({ netstat = fx("netstat.txt") } = {}) =>
  [
    `${SECTION}sysctl`,
    fx("sysctl.txt"),
    `${SECTION}vm_stat`,
    fx("vm_stat.txt"),
    `${SECTION}top`,
    fx("top.txt"),
    `${SECTION}df`,
    fx("df.txt"),
    `${SECTION}netstat`,
    netstat,
    "ip 192.168.1.50",
  ].join("\n");

const spark = { id: "mac-studio", kind: "mac", isLocal: false, ssh: { user: "macuser", host: "100.64.0.10" } };

function collectorWith(handler) {
  const calls = [];
  const exec = async (_spark, cmd, opts) => {
    calls.push(cmd);
    return handler(cmd, opts);
  };
  return { collector: new MacSystemCollector(spark, { exec }), calls };
}

test("vm_stat and memsize give unified memory in MB", () => {
  const vm = parseVmStat(fx("vm_stat.txt"));
  assert.equal(vm.pageSize, 16384);
  assert.equal(vm.wired, 11872134);
  assert.equal(vm.active, 676036);
  assert.equal(vm.compressed, 97740);
  assert.equal(vm.anonymous, 533845);
  const mem = unifiedMemoryFromVmStat(vm, parseSysctl(fx("sysctl.txt"))["hw.memsize"]);
  assert.equal(mem.total, 262144);
  assert.equal(mem.gpuUsed, 185502);
  assert.equal(mem.cpuUsed, 9802);
  assert.equal(mem.used, 195304);
  assert.equal(mem.available, 66840);
  assert.equal(mem.percentage, 75);
  assert.equal(mem.oomRisk, "medium");
});

test("an idle MLX model that macOS un-wired still counts as memory in use", () => {
  // Same loaded model, captured after the server went idle: the pages moved
  // from wired to anonymous app memory; nothing was freed.
  const vm = parseVmStat(fx("vm_stat-unwired.txt"));
  const mem = unifiedMemoryFromVmStat(vm, parseSysctl(fx("sysctl.txt"))["hw.memsize"]);
  assert.equal(mem.gpuUsed, 4585);
  assert.equal(mem.cpuUsed, 192794);
  assert.equal(mem.used, 197379);
  assert.equal(mem.available, 64765);
  assert.equal(mem.percentage, 75);
});

test("vm_stat without an Anonymous pages line falls back to active pages", () => {
  const vm = parseVmStat(fx("vm_stat.txt").replace(/^Anonymous pages:.*$/m, ""));
  assert.equal(vm.anonymous, 0);
  const mem = unifiedMemoryFromVmStat(vm, parseSysctl(fx("sysctl.txt"))["hw.memsize"]);
  assert.equal(mem.cpuUsed, 12090);
});

test("sysctl, boot time and swap parse", () => {
  const sys = parseSysctl(fx("sysctl.txt"));
  assert.equal(sys["machdep.cpu.brand_string"], "Apple M5 Ultra");
  assert.equal(parseBootTime(sys["kern.boottime"]), 1790650919);
  assert.deepEqual(parseSwapUsage(sys["vm.swapusage"]), { total: 1024, used: 78, free: 946 });
});

test("top CPU line gives usage from idle", () => {
  assert.equal(parseTopCpu(fx("top.txt")), 4);
  assert.equal(parseTopCpu("CPU usage: 50.0% user, 25.0% sys, 25.0% idle"), 75);
  assert.equal(parseTopCpu(""), null);
});

test("df picks the data volume over the sealed system volume", () => {
  const disks = parseDf(fx("df.txt"));
  assert.equal(disks.length, 1);
  assert.equal(disks[0].label, "/System/Volumes/Data");
  assert.equal(disks[0].device, "disk3s5");
  assert.equal(disks[0].total, 948534);
  assert.equal(disks[0].used, 456405);
  assert.equal(disks[0].available, 450651);
  assert.equal(disks[0].percentage, 51);
});

test("netstat link row gives byte counters", () => {
  assert.deepEqual(parseNetstatBytes(fx("netstat.txt")), {
    name: "en1",
    rxBytes: 392966387598,
    txBytes: 7952987339,
  });
  assert.equal(parseNetstatBytes("garbage"), null);
});

test("powermetrics text parses busy and idle samples", () => {
  assert.deepEqual(parsePowermetrics(fx("powermetrics-busy.txt")), {
    gpuActivePct: 100,
    gpuFreqMHz: 1620,
    gpuW: 84.9,
    cpuW: 5.1,
    aneW: 0,
    combinedW: 90,
    thermalPressure: "Nominal",
  });
  const idle = parsePowermetrics(fx("powermetrics.txt"));
  assert.equal(idle.gpuActivePct, 3.34);
  assert.equal(idle.gpuFreqMHz, 596);
  assert.equal(idle.thermalPressure, "Nominal");
});

test("section splitting keeps each command's output", () => {
  const sections = splitSections(snapshotOutput());
  assert.deepEqual(Object.keys(sections), ["sysctl", "vm_stat", "top", "df", "netstat"]);
  assert.match(sections.netstat, /^ip 192\.168\.1\.50$/m);
});

test("collector batches non-sudo reads into one SSH call and maps shapes", async () => {
  const { collector, calls } = collectorWith((cmd) =>
    cmd.includes("powermetrics") ? fx("powermetrics-busy.txt") : snapshotOutput()
  );
  const [cpu, ram, um, storage, gpu] = await Promise.all([
    collector.collectCpu(),
    collector.collectRam(),
    collector.collectUnifiedMemory(),
    collector.collectStorage(),
    collector.collectGpu(),
  ]);
  assert.equal(calls.filter((c) => !c.includes("powermetrics")).length, 1);
  assert.equal(cpu.usage, 4);
  assert.equal(ram.total, 262144);
  assert.equal(ram.swap.used, 78);
  assert.equal(um.gpuUsed, 185502);
  assert.deepEqual(um.bandwidth, { current: 0, peak: 0 });
  assert.equal(storage[0].label, "/System/Volumes/Data");
  assert.equal(gpu.usage, 100);
  assert.equal(gpu.power.draw, 84.9);
  assert.equal(gpu.power.systemDraw, 90);
  assert.equal(gpu.vram.total, 262144);
  assert.equal(gpu.vram.used, um.used, "the GPU card shows all unified memory in use");
  assert.equal(gpu.throttle.smClockMHz, 1620);
  assert.equal(gpu.powermetricsAvailable, true);
  assert.equal((await collector.collectCpu()).draw, 5.1);
});

test("network speeds come from counter deltas between samples", async () => {
  let rx = 1000;
  const { collector } = collectorWith(() =>
    snapshotOutput({
      netstat: `Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll\nen1 1500 <Link#25> 7c:d6:2c:0d:6d:31 1 0 ${rx} 1 0 500 0`,
    })
  );
  const first = await collector.collectNetwork();
  assert.equal(first.primaryInterface, "en1");
  assert.equal(first.interfaces[0].rxSpeed, 0);
  assert.equal(first.interfaces[0].ip, "192.168.1.50");
  collector._snapshotCache = null;
  collector._lastNet.time -= 2000;
  rx = 5000;
  const second = await collector.collectNetwork();
  assert.ok(second.interfaces[0].rxSpeed >= 1900 && second.interfaces[0].rxSpeed <= 2100);
  assert.equal(second.interfaces[0].txSpeed, 0);
});

test("sudo refusal leaves GPU fields at defaults and backs off", async () => {
  const { collector, calls } = collectorWith((cmd) => (cmd.includes("powermetrics") ? "" : snapshotOutput()));
  const gpu = await collector.collectGpu();
  assert.equal(gpu.powermetricsAvailable, false);
  assert.equal(gpu.usage, null);
  assert.equal(gpu.power.draw, null);
  assert.equal(gpu.vram.total, 262144);
  collector._snapshotCache = null;
  await collector.collectGpu();
  assert.equal(calls.filter((c) => c.includes("powermetrics")).length, 1);
});

test("malformed or failing output returns default shapes without throwing", async () => {
  const { collector } = collectorWith(() => {
    throw new Error("ssh down");
  });
  assert.deepEqual(await collector.collectCpu(), collector._defaultCpu());
  assert.deepEqual(await collector.collectRam(), collector._defaultRam());
  assert.deepEqual(await collector.collectStorage(), []);
  assert.deepEqual(await collector.collectNetwork(), collector._defaultNetwork());
  assert.deepEqual(await collector.collectUnifiedMemory(), collector._defaultUnifiedMemory());
  const gpu = await collector.collectGpu();
  assert.equal(gpu.usage, 0);
  assert.equal(await collector.detectHardware(), null);
});

test("detectHardware names the real Mac", async () => {
  const { collector } = collectorWith(() => fx("sysctl.txt"));
  const hw = await collector.detectHardware();
  assert.equal(hw.device, "Mac (Mac17,15)");
  assert.equal(hw.cpuModel, "Apple M5 Ultra");
  assert.equal(hw.cpuCores, 30);
  assert.equal(hw.totalMemoryGB, 256);
  assert.equal(hw.cudaDriver, null);
});

test("mac snapshot keeps its output when the trailing route guard exits nonzero", async () => {
  const calls = [];
  const exec = async (_spark, cmd, options) => {
    calls.push({ cmd, options });
    return snapshotOutput();
  };
  const collector = new MacSystemCollector(spark, { exec });

  const data = await collector._snapshot();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.allowNonZeroExit, true);
  assert.match(data.df, /System\/Volumes\/Data/);
});

test("Mac GPU availability: memory always, busy and power only with powermetrics", () => {
  assert.deepEqual(macGpuAvailability({ powermetrics: true, temperature: null }), {
    temperature: false, usage: true, powerDraw: true, powerLimit: false, vramUsed: true, vramTotal: true,
  });
  assert.deepEqual(macGpuAvailability({ powermetrics: false, temperature: 61 }), {
    temperature: true, usage: false, powerDraw: false, powerLimit: false, vramUsed: true, vramTotal: true,
  });
});

test("successful SSH readings carry collection provenance and a failed power read expires", async () => {
  const { collectionWasSuccessful } = await import("../SystemCollector.js");
  let fail = false;
  const collector = new MacSystemCollector(spark, { exec: async (_spark, cmd) => {
    if (cmd.startsWith("sudo")) { if (fail) throw new Error("permission refused"); return fx("powermetrics.txt"); }
    return snapshotOutput();
  } });
  assert.equal(collectionWasSuccessful(await collector.collectCpu()), true);
  const first = await collector.collectGpu();
  assert.equal(collectionWasSuccessful(first), true);
  assert.equal(first.powermetricsAvailable, true);
  fail = true;
  const next = await collector.collectGpu();
  assert.equal(next.powermetricsAvailable, false);
  assert.equal(next.metricAvailability.powerDraw, false);
});
