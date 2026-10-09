import test from "node:test";
import assert from "node:assert/strict";
import { SystemCollector } from "../SystemCollector.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IntelSudoGate, IntelVramCache } from "../intelGpu.js";

const NVIDIA_LINES = [
  "33, 0, 9.14, 360.00, 180, 3090, Not Active, Not Active, Not Active, Not Active, 0, NVIDIA GeForce RTX 5080, GPU-00000000-0000-0000-0000-000000000001",
  "35, 0, 3.46, 180.00, 180, 3090, Not Active, Not Active, Not Active, Active, 1, NVIDIA GeForce RTX 5060 Ti, GPU-00000000-0000-0000-0000-000000000002",
].join("\n");
const NVIDIA_MEM = "13234, 16303\n8556, 16311";
const MEMINFO = "MemTotal:       65536000 kB\nMemAvailable:   40000000 kB";

// Fictional Intel card, same format as the probe script prints.
const probe = (up, energy, idle, extra = "") => `@xe 0000:3a:00.0
id 0xe223
up ${up}
cap 200000000
crit 400000000
fan 1500
energy card ${energy}
energy pkg 4000000000
temp pkg 60000
temp vram 70000
cur 2400
max 2800
idle ${idle}
res 0x0000003800000000 0x0000003fffffffff 0x000000000014220c
vram size: 34359738368
vram usage: 4294967296
${extra}`;

function remote(kind = "host") {
  const c = new SystemCollector({ id: "t", kind, host: "10.0.0.2", lanIp: "10.0.0.2" });
  c._nvErrNoMemory = async () => 0;
  c._kernelErrors = async () => null;
  return c;
}
const out = (nvidia, intel) =>
  [nvidia.gpu, nvidia.mem, "", MEMINFO, ...(intel == null ? [] : [intel])].join("\n---\n");
const NV = { gpu: NVIDIA_LINES, mem: NVIDIA_MEM };
const NONE = { gpu: "", mem: "" };

test("NVIDIA-only host: an empty Intel section changes nothing (regression)", async () => {
  const without = await remote()._getRemoteGpu(async () => out(NV));
  const empty = await remote()._getRemoteGpu(async () => out(NV, ""));
  assert.deepEqual(empty, without);
  assert.equal(without.gpus.length, 2);
  assert.deepEqual(without.gpus.map((g) => g.vendor), ["nvidia", "nvidia"]);
  assert.equal(without.temperature, 35);
  assert.equal(without.power.draw, 12.6);
  assert.equal(without.power.limit, 540);
  assert.deepEqual(without.vram, { used: 21790, total: 32614, percentage: 67, available: 10824 });
  assert.equal(without.gpus[1].throttle.reason, "power");
  assert.ok(!("fanRpm" in without.gpus[0]));
});

test("the Intel probe rides the existing single SSH round trip", async () => {
  let calls = 0;
  let cmd = "";
  await remote()._getRemoteGpu(async (_spark, c) => {
    calls += 1;
    cmd = c;
    return out(NV, "");
  });
  assert.equal(calls, 1);
  assert.match(cmd, /nvidia-smi/);
  assert.match(cmd, /@xe/);
});

test("Intel-only host: card reported, VRAM comes from the card not system RAM", async () => {
  const gpu = await remote()._getRemoteGpu(async () => out(NONE, probe("1000.00", 5000000000, 800000)));
  assert.equal(gpu.gpus.length, 1);
  const g = gpu.gpus[0];
  assert.equal(g.vendor, "intel");
  assert.equal(g.name, "Intel Arc Pro B70");
  assert.equal(g.uuid, null);
  assert.equal(g.index, 0);
  assert.equal(g.fanRpm, 1500);
  assert.equal(g.vramSource, "debugfs");
  assert.equal(g.throttle.smClockPct, 85.7);
  assert.equal(gpu.temperature, 60);
  assert.equal(gpu.power.limit, 200);
  assert.deepEqual(gpu.vram, { used: 4096, total: 32768, percentage: 13, available: 28672 });
  assert.deepEqual(g.vram, gpu.vram);
});

test("Intel-only host: second poll turns the energy counter into watts", async () => {
  const c = remote();
  await c._getRemoteGpu(async () => out(NONE, probe("1000.00", 5000000000, 800000)));
  const gpu = await c._getRemoteGpu(async () => out(NONE, probe("1010.00", 6500000000, 804000)));
  assert.equal(gpu.power.draw, 150);
  assert.equal(gpu.usage, 60);
  assert.equal(gpu.power.systemDraw, 170);
});

test("mixed host: Intel card joins the NVIDIA ones and the aggregates", async () => {
  const c = remote();
  await c._getRemoteGpu(async () => out(NV, probe("1000.00", 5000000000, 800000)));
  const gpu = await c._getRemoteGpu(async () => out(NV, probe("1010.00", 6500000000, 804000)));
  assert.equal(gpu.gpus.length, 3);
  assert.deepEqual(gpu.gpus.map((g) => g.vendor), ["nvidia", "nvidia", "intel"]);
  assert.equal(gpu.gpus[2].index, 2);
  assert.equal(gpu.gpus[0].vram.total, 16303); // NVIDIA cards keep their own numbers
  assert.equal(gpu.temperature, 60);
  assert.equal(gpu.usage, 60);
  assert.equal(gpu.power.draw, 162.6);
  assert.equal(gpu.power.limit, 740);
  assert.deepEqual(gpu.vram, { used: 25886, total: 65382, percentage: 40, available: 39496 });
});

test("a GB10 with no memory numbers keeps its pool when an Intel card is added", async () => {
  const gb10 = { gpu: "40, 5, 20.00, 100.00, 900, 2400, Not Active, Not Active, Not Active, Not Active, 0, NVIDIA GB10, GPU-00000000-0000-0000-0000-000000000003", mem: "[N/A], [N/A]" };
  const gpu = await remote("spark")._getRemoteGpu(async () => out(gb10, probe("1000.00", 5000000000, 800000)));
  assert.equal(gpu.gpus[0].vram.total, 64000); // MemTotal, not MemTotal + Intel
  assert.equal(gpu.gpus[1].vram.total, 32768);
});

test("garbage in the Intel section is ignored", async () => {
  const a = await remote()._getRemoteGpu(async () => out(NV));
  const b = await remote()._getRemoteGpu(async () => out(NV, "sudo: a password is required\nnot a probe"));
  assert.deepEqual(b, a);
});

test("local: Intel-only host (no nvidia-smi) still reports the card", async () => {
  const c = new SystemCollector({ id: "t", isLocal: true, kind: "host" });
  c._nvidiaSmi = async () => {
    throw new Error("nvidia-smi: not found");
  };
  c._probeIntelLocal = async () => probe("1000.00", 5000000000, 800000);
  c._queryNvidiaVram = async () => ({ used: 0, total: 65000, percentage: 0, available: 65000 });
  c._getCPUPower = async () => ({ draw: 10 });
  c._nvErrNoMemory = async () => 0;
  c._kernelErrors = async () => null;
  const gpu = await c._getGPUAll();
  assert.equal(gpu.gpus.length, 1);
  assert.equal(gpu.gpus[0].vendor, "intel");
  assert.equal(gpu.vram.total, 32768);
});

test("local: no nvidia-smi and no Intel card is still an error", async () => {
  const c = new SystemCollector({ id: "t", isLocal: true, kind: "host" });
  c._nvidiaSmi = async () => {
    throw new Error("nvidia-smi: not found");
  };
  c._probeIntelLocal = async () => "";
  await assert.rejects(() => c._getGPUAll(), /not found/);
});

test("a failed sudo read stops sudo in later probes until the TTL passes", async () => {
  let t = 5_000_000;
  const c = remote();
  c._intelSudo = new IntelSudoGate({ now: () => t, ttlMs: 600_000 });
  const cmds = [];
  const run = (extra) => c._getRemoteGpu(async (_s, cmd) => { cmds.push(cmd); return out(NV, probe("1000.00", 5000000000, 800000, extra)); });
  await run("sudofail 1");
  await run("");
  t += 599_000;
  await run("");
  t += 1_000;
  await run("");
  assert.deepEqual(cmds.map((x) => x.includes("INTEL_SUDO=0")), [false, true, true, false]);
});

test("working sudo runs once per cache window; other metrics keep refreshing", async () => {
  let t = 9_000_000;
  const c = remote();
  c._intelVram = new IntelVramCache({ now: () => t, ttlMs: 45_000 });
  const cmds = [];
  // the skipped polls come back without vram lines, as the real script prints them
  const noVram = (x) => x.replace(/vram .*\n/g, "");
  const run = (up, energy, idle) =>
    c._getRemoteGpu(async (_s, cmd) => {
      cmds.push(cmd);
      const p = probe(up, energy, idle);
      return out(NV, cmd.includes("INTEL_VRAM=0") ? noVram(p) : p);
    });
  const first = await run("1000.00", 5000000000, 800000);
  t += 2_000;
  const second = await run("1002.00", 5300000000, 800400);
  t += 2_000;
  const third = await run("1004.00", 5900000000, 800600);
  assert.deepEqual(cmds.map((x) => x.includes("INTEL_VRAM=0")), [false, true, true]);
  assert.ok(cmds.every((x) => !x.includes("INTEL_SUDO=0")));
  // VRAM stays on the cached reading, the live metrics move
  for (const g of [second, third]) {
    assert.equal(g.gpus[2].vramSource, "debugfs");
    assert.equal(g.gpus[2].vram.total, 32768);
  }
  assert.equal(first.gpus[2].power.draw, 0);
  assert.equal(second.gpus[2].power.draw, 150);
  assert.equal(third.gpus[2].power.draw, 300);
  assert.equal(third.gpus[2].usage, 90);
  t += 45_000;
  await run("1050.00", 6000000000, 801000);
  assert.deepEqual(cmds.map((x) => x.includes("INTEL_VRAM=0")), [false, true, true, false]);
});

test("a hot-added Intel card is shown at once and read on the next poll", async () => {
  let t = 9_000_000;
  const c = remote();
  c._intelVram = new IntelVramCache({ now: () => t, ttlMs: 45_000 });
  const second = probe("1000.00", 5000000000, 800000).replace("@xe 0000:3a:00.0", "@xe 0000:3b:00.0");
  const noVram = (x) => x.replace(/vram .*\n/g, "");
  const cmds = [];
  const run = (body) => c._getRemoteGpu(async (_s, cmd) => { cmds.push(cmd); return out(NONE, body(cmd)); });
  await run(() => probe("1000.00", 5000000000, 800000));
  t += 2_000;
  const gpu = await run((cmd) => noVram(probe("1002.00", 5300000000, 800400)) + noVram(second));
  assert.equal(gpu.gpus.length, 2);
  assert.equal(gpu.gpus[1].vramSource, "pci-bar");
  t += 2_000;
  await run(() => probe("1004.00", 5900000000, 800600));
  assert.deepEqual(cmds.map((x) => x.includes("INTEL_VRAM=0")), [false, true, false]);
});

test("a missing vram file is retried each poll without sudo once sudo has failed", async () => {
  let t = 9_000_000;
  const c = remote();
  c._intelVram = new IntelVramCache({ now: () => t, ttlMs: 45_000 });
  c._intelSudo = new IntelSudoGate({ now: () => t, ttlMs: 600_000 });
  const noVram = (x) => x.replace(/vram .*\n/g, "");
  const cmds = [];
  for (let i = 0; i < 3; i++) {
    await c._getRemoteGpu(async (_s, cmd) => { cmds.push(cmd); return out(NONE, noVram(probe("1000.00", 5000000000, 800000, i === 0 ? "sudofail 1" : ""))); });
    t += 2_000;
  }
  assert.deepEqual(cmds.map((x) => x.includes("INTEL_SUDO=0")), [false, true, true]);
  assert.deepEqual(cmds.map((x) => x.includes("INTEL_VRAM=0")), [false, false, false]);
});

function sysTree(driver) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xe-detect-"));
  if (driver) {
    fs.mkdirSync(path.join(root, "class/drm/card0/device"), { recursive: true });
    fs.mkdirSync(path.join(root, "bus/pci/drivers", driver), { recursive: true });
    fs.symlinkSync(path.join(root, "bus/pci/drivers", driver), path.join(root, "class/drm/card0/device/driver"));
  }
  fs.mkdirSync(path.join(root, "class/drm/card0-DP-1"), { recursive: true });
  return root;
}

function localWith(root) {
  const c = new SystemCollector({ id: "t", isLocal: true, kind: "host" });
  c._sysRoots = () => [root];
  let spawns = 0;
  c._execOnHost = async () => { spawns += 1; return ""; };
  return { c, spawns: () => spawns };
}

test("local: no xe card means the probe is never spawned, however often we poll", async () => {
  if (process.platform !== "linux") return;
  const root = sysTree("nvidia");
  try {
    const { c, spawns } = localWith(root);
    for (let i = 0; i < 5; i++) assert.equal(await c._probeIntelLocal(), "");
    assert.equal(spawns(), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local: an xe card is probed; absence is re-checked after 10 minutes", async () => {
  if (process.platform !== "linux") return;
  const root = sysTree("nvidia");
  try {
    const { c, spawns } = localWith(root);
    await c._probeIntelLocal();
    assert.equal(spawns(), 0);
    // hot-add: the cached "none" holds until it is 10 minutes old
    fs.rmSync(path.join(root, "class/drm/card0/device/driver"));
    fs.mkdirSync(path.join(root, "bus/pci/drivers/xe"), { recursive: true });
    fs.symlinkSync(path.join(root, "bus/pci/drivers/xe"), path.join(root, "class/drm/card0/device/driver"));
    await c._probeIntelLocal();
    assert.equal(spawns(), 0);
    c._intelPresent.at -= 10 * 60 * 1000 + 1;
    await c._probeIntelLocal();
    assert.equal(spawns(), 1);
    await c._probeIntelLocal(); // now cached as present
    assert.equal(spawns(), 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local: an unreadable sysfs falls back to probing and is not cached", async () => {
  if (process.platform !== "linux") return;
  const { c, spawns } = localWith("/nonexistent-sys-root");
  c._sysRoots = () => {
    throw new Error("boom");
  };
  await c._probeIntelLocal();
  assert.equal(spawns(), 1);
  assert.equal(c._intelPresent.value, null);
});

test("remote: a host without an xe card costs no extra SSH round trip and adds no sudo", async () => {
  let calls = 0;
  let cmd = "";
  const gpu = await remote()._getRemoteGpu(async (_s, c) => { calls += 1; cmd = c; return out(NV, ""); });
  assert.equal(calls, 1);
  assert.equal(gpu.gpus.length, 2);
  // sudo only appears inside the per-xe-card loop of the script
  assert.ok(cmd.indexOf("sudo -n") > cmd.indexOf('echo "@xe $pci"'));
});

test("_isSuccessfulGpuCollection: Intel card without a power cap does not fail the collection", () => {
  const c = remote();
  const base = { temperature: 60, usage: 10, power: { draw: 25, limit: 0 } };
  assert.equal(c._isSuccessfulGpuCollection({ ...base, gpus: [{ vendor: "intel" }] }), true);
  assert.equal(c._isSuccessfulGpuCollection({ ...base, gpus: [{ vendor: "intel" }, { vendor: "intel" }] }), true);
});

test("_isSuccessfulGpuCollection: NVIDIA still needs a positive power limit", () => {
  const c = remote();
  const base = { temperature: 60, usage: 10, power: { draw: 25, limit: 0 } };
  assert.equal(c._isSuccessfulGpuCollection({ ...base, gpus: [{ vendor: "nvidia" }] }), false);
  assert.equal(c._isSuccessfulGpuCollection({ ...base, gpus: [{ vendor: "nvidia" }, { vendor: "intel" }] }), false);
  assert.equal(c._isSuccessfulGpuCollection({ ...base }), false);
  assert.equal(c._isSuccessfulGpuCollection({ ...base, power: { draw: 25, limit: 300 }, gpus: [{ vendor: "nvidia" }, { vendor: "intel" }] }), true);
  assert.equal(c._isSuccessfulGpuCollection({ ...base, power: { draw: 25, limit: NaN }, gpus: [{ vendor: "intel" }] }), false);
});
