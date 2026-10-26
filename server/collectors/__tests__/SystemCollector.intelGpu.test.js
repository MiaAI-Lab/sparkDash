import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IntelSudoGate, IntelVramCache, INTEL_PROBE_SCRIPT } from "../intelGpu.js";
import { spawnSync } from "node:child_process";

// The sudo debugfs read is opt-in; these tests run with it on (the off case is tested below).
const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-intel-settings-"));
process.env.SETTINGS_JSON_PATH = path.join(settingsDir, "settings.json");
const { SystemCollector, nvidiaSideFailed, collectionWasSuccessful } = await import("../SystemCollector.js");
const { loadSettings, updateSettings } = await import("../../settings.js");
loadSettings();
updateSettings({ intelVramSudo: true });

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
// Section format of the single remote GPU command (see splitRemoteGpuSections).
const out = (nvidia, intel) =>
  [
    nvidia.gpu || nvidia.mem ? `__NVIDIA__\n${nvidia.gpu}\n__NVIDIA_VRAM__\n${nvidia.mem}\n__NVIDIA_APPS__\n` : "",
    `__MEMINFO__\n${MEMINFO}`,
    intel == null ? "" : `__INTEL__\n${intel}`,
  ].join("\n");
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
  assert.equal(g.index, 2000, "Intel cards have their own index range");
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
  assert.equal(gpu.gpus[2].index, 2000);
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
  c._probeLocalAmd = async () => ({ devices: [] });
  c._readLocalClockCap = async () => null;
  c._queryNvidiaVram = async () => ({ used: 0, total: 65000, percentage: 0, available: 65000 });
  c._getCPUPower = async () => ({ draw: 10 });
  c._nvErrNoMemory = async () => 0;
  c._kernelErrors = async () => null;
  const gpu = await c._getGPUAll();
  assert.equal(gpu.gpus.length, 1);
  assert.equal(gpu.gpus[0].vendor, "intel");
  assert.equal(gpu.vram.total, 32768);
});

test("local: no nvidia-smi and no Intel card is not a successful collection", async () => {
  const c = new SystemCollector({ id: "t", isLocal: true, kind: "host" });
  c._nvidiaSmi = async () => {
    throw new Error("nvidia-smi: not found");
  };
  c._probeIntelLocal = async () => "";
  c._probeLocalAmd = async () => ({ devices: [] });
  c._readLocalClockCap = async () => null;
  c._getCPUPower = async () => ({ draw: 10 });
  c._nvErrNoMemory = async () => 0;
  c._kernelErrors = async () => null;
  const gpu = await c._getGPUAll();
  assert.equal(gpu.gpus.length, 0);
  assert.equal(c._isSuccessfulGpuCollection(gpu), false);
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
    // Unlink the fixture symlink itself. Node 24.8 on Linux treats rmSync(link-to-dir) as EISDIR.
    fs.unlinkSync(path.join(root, "class/drm/card0/device/driver"));
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

test("an Intel card without a power cap has no power limit, and the collection still succeeds", async () => {
  const noCap = probe("1000.00", 5000000000, 800000).replace(/^cap .*\n/m, "cap \n").replace(/^crit .*\n/m, "crit \n");
  const c = remote();
  const gpu = await c._getRemoteGpu(async () => out(NONE, noCap));
  assert.equal(gpu.power.limit, 0);
  assert.equal(gpu.gpus[0].metricAvailability.powerLimit, false);
  assert.equal(gpu.gpus[0].metricAvailability.temperature, true);
  assert.equal(c._isSuccessfulGpuCollection(gpu), true);
});

test("Intel power limits add to the NVIDIA ones only where the card reports one", async () => {
  const noCap = probe("1000.00", 5000000000, 800000).replace(/^cap .*\n/m, "cap \n").replace(/^crit .*\n/m, "crit \n");
  const gpu = await remote()._getRemoteGpu(async () => out(NV, noCap));
  assert.equal(gpu.power.limit, 540);
});

test("a card whose VRAM use is unreadable reports its BAR size as total with usage unavailable", async () => {
  const noVram = probe("1000.00", 5000000000, 800000).replace(/vram .*\n/g, "");
  const gpu = await remote()._getRemoteGpu(async () => out(NONE, noVram));
  const g = gpu.gpus[0];
  assert.equal(g.vramSource, "pci-bar");
  assert.equal(g.metricAvailability.vramUsed, false);
  assert.equal(g.metricAvailability.vramTotal, true);
  assert.ok(g.vram.total > 0);
});

test("with intelVramSudo off (the default) the probe never uses sudo", async () => {
  updateSettings({ intelVramSudo: false });
  try {
    const c = remote();
    const cmds = [];
    await c._getRemoteGpu(async (_s, cmd) => { cmds.push(cmd); return out(NV, probe("1000.00", 5000000000, 800000)); });
    assert.ok(cmds.every((x) => x.includes("INTEL_SUDO=0")));
  } finally {
    updateSettings({ intelVramSudo: true });
  }
});

// nvidia-smi installed but returning nothing (broken driver) next to an Intel card must not look healthy.
const BROKEN_NVIDIA = "__NVIDIA__\n\n__NVIDIA_VRAM__\n\n__NVIDIA_APPS__\n";
const withBrokenNvidia = () =>
  `${BROKEN_NVIDIA}\n__MEMINFO__\n${MEMINFO}\n__INTEL__\n${probe("1000.00", 5000000000, 800000)}`;

// collectGpu() on a remote collector, with the SSH executor replaced.
const collectRemote = (c, output) => {
  const real = c._getRemoteGpu.bind(c);
  c._getRemoteGpu = () => real(async () => output);
  return c.collectGpu();
};

test("remote: nvidia-smi installed but empty next to an Intel card marks the collection failed", async () => {
  const gpu = await remote()._getRemoteGpu(async () => withBrokenNvidia());
  assert.equal(gpu.gpus.length, 1, "the Intel card is still shown");
  assert.equal(gpu.gpus[0].vendor, "intel");
  assert.equal(nvidiaSideFailed(gpu), true);
  assert.equal(collectionWasSuccessful(await collectRemote(remote(), withBrokenNvidia())), false);
});

test("remote: a host with no nvidia-smi at all and an Intel card is still Intel-only and healthy", async () => {
  const output = out(NONE, probe("1000.00", 5000000000, 800000));
  assert.equal(nvidiaSideFailed(await remote()._getRemoteGpu(async () => output)), false);
  assert.equal(collectionWasSuccessful(await collectRemote(remote(), output)), true);
});

function localIntel(smiInstalled) {
  const c = new SystemCollector({ id: "t", isLocal: true, kind: "host" });
  c._nvidiaSmi = async () => {
    throw new Error("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver");
  };
  c._nvidiaSmiInstalled = async () => smiInstalled;
  c._probeIntelLocal = async () => probe("1000.00", 5000000000, 800000);
  c._probeLocalAmd = async () => ({ devices: [] });
  c._readLocalClockCap = async () => null;
  c._getCPUPower = async () => ({ draw: 10 });
  c._nvErrNoMemory = async () => 0;
  c._kernelErrors = async () => null;
  return c;
}

test("local: nvidia-smi installed but failing next to an Intel card marks the collection failed", async () => {
  const gpu = await localIntel(true).collectGpu();
  assert.equal(gpu.gpus[0].vendor, "intel", "the Intel card is still shown");
  assert.equal(nvidiaSideFailed(gpu), true);
  assert.equal(collectionWasSuccessful(gpu), false);
});

test("local: no nvidia-smi on the host and an Intel card is still Intel-only and healthy", async () => {
  const gpu = await localIntel(false).collectGpu();
  assert.equal(nvidiaSideFailed(gpu), false);
  assert.equal(collectionWasSuccessful(gpu), true);
});

// ── The same probe under zsh: an unmatched glob must never abort the script ──

const zshAvailable = spawnSync("zsh", ["-c", "true"]).error == null;

function buildXeTree({ energy = true, temps = true, card = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intel-probe-zsh-"));
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  if (card) {
    const dev = "sys/devices/pci/0000:3a:00.0";
    fs.mkdirSync(path.join(root, "sys/bus/pci/drivers/xe"), { recursive: true });
    fs.mkdirSync(path.join(root, "sys/class/drm/card0"), { recursive: true });
    fs.mkdirSync(path.join(root, dev), { recursive: true });
    fs.symlinkSync("../../../devices/pci/0000:3a:00.0", path.join(root, "sys/class/drm/card0/device"));
    fs.symlinkSync("../../../bus/pci/drivers/xe", path.join(root, `${dev}/driver`));
    w(`${dev}/device`, "0xe223\n");
    w(`${dev}/hwmon/hwmon3/name`, "xe\n");
    w(`${dev}/hwmon/hwmon3/power1_cap`, "200000000\n");
    if (energy) {
      w(`${dev}/hwmon/hwmon3/energy1_input`, "5000000000\n");
      w(`${dev}/hwmon/hwmon3/energy1_label`, "card\n");
    }
    if (temps) {
      w(`${dev}/hwmon/hwmon3/temp2_input`, "60000\n");
      w(`${dev}/hwmon/hwmon3/temp2_label`, "pkg\n");
    }
    w(`${dev}/tile0/gt0/freq0/cur_freq`, "2400\n");
    w(`${dev}/tile0/gt0/gtidle/idle_residency_ms`, "800000\n");
    w("sys/kernel/debug/dri/0000:3a:00.0/tile0/vram_mm", "  size: 8589934592\n  usage: 1073741824\n");
    w("proc/uptime", "1000.00 4000.00\n");
  }
  return root;
}

const runZsh = (root) =>
  spawnSync("zsh", ["-c", INTEL_PROBE_SCRIPT], { env: { ...process.env, INTEL_PROBE_ROOT: root }, encoding: "utf8" });

test("zsh: a full xe fixture reads energy, temps and VRAM and runs to the end", { skip: !zshAvailable }, () => {
  const root = buildXeTree();
  try {
    const run = runZsh(root);
    assert.equal(run.status, 0);
    assert.doesNotMatch(run.stderr, /no matches found/);
    assert.match(run.stdout, /energy card 5000000000/);
    assert.match(run.stdout, /temp pkg 60000/);
    assert.match(run.stdout, /cur 2400/);
    assert.match(run.stdout, /idle 800000/);
    assert.match(run.stdout, /vram size: 8589934592/);
    assert.match(run.stdout, /vram usage: 1073741824/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("zsh: the hwmon start point itself is never treated as a sensor (mindepth)", { skip: !zshAvailable }, () => {
  const root = buildXeTree();
  try {
    // Give the parent hwmon dir an xe name and a cap: without -mindepth 1 the
    // find emits the parent first, the loop reads it, and the real hwmon3 is lost.
    const parent = "sys/devices/pci/0000:3a:00.0/hwmon";
    fs.writeFileSync(path.join(root, parent, "name"), "xe\n");
    fs.writeFileSync(path.join(root, parent, "power1_cap"), "111\n");
    fs.writeFileSync(path.join(root, "sys/devices/pci/0000:3a:00.0/hwmon/hwmon3/power1_cap"), "999\n");
    const run = runZsh(root);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /cap 999/);
    assert.doesNotMatch(run.stdout, /cap 111/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("zsh: multi-tile VRAM reads in sorted tile order (sort)", { skip: !zshAvailable }, () => {
  const root = buildXeTree();
  try {
    const v = "sys/kernel/debug/dri/0000:3a:00.0";
    // Create tile1 before tile0 so an unsorted readdir is likely to pick tile1.
    fs.mkdirSync(path.join(root, v, "tile1"), { recursive: true });
    fs.writeFileSync(path.join(root, v, "tile1/vram_mm"), "  size: 4294967296\n  usage: 0\n");
    fs.writeFileSync(path.join(root, v, "tile0/vram_mm"), "  size: 8589934592\n  usage: 1073741824\n");
    const run = runZsh(root);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /vram size: 8589934592/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("zsh: no card at all completes with exit 0", { skip: !zshAvailable }, () => {
  const root = buildXeTree({ card: false });
  try {
    const run = runZsh(root);
    assert.equal(run.status, 0);
    assert.doesNotMatch(run.stderr, /no matches found/);
    assert.equal(run.stdout.trim(), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("zsh: an xe hwmon with no energy or temp sensor files still runs to the end", { skip: !zshAvailable }, () => {
  const root = buildXeTree({ energy: false, temps: false });
  try {
    const run = runZsh(root);
    assert.equal(run.status, 0);
    assert.doesNotMatch(run.stderr, /no matches found/);
    // Sections after the energy/temp loops must survive: cap and the tile reads.
    assert.match(run.stdout, /cap 200000000/);
    assert.match(run.stdout, /cur 2400/);
    assert.match(run.stdout, /vram size: 8589934592/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
