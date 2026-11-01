import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { AMD_PROBE_SCRIPT, amdDevicesFromCards, amdMemoryPool, collectAmdSysfs, parseAmdProbe } from "../amdGpu.js";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

// A Strix Halo iGPU and a resizable-BAR discrete card, in the file formats the driver uses.
const PROBE = `@amd 0000:c6:00.0
id 0x1586
class 0x038000
busy 98
vram_used 235540480
vram_total 536870912
vis_used 235540480
vis_total 536870912
gtt_used 29132099584
gtt_total 122880000000
power 123241000
cap
capmax
fan
temp edge 68000
temp hotspot 81000
freq sclk 2872000000
sclk 0: 2900Mhz
sclk 1: 2872Mhz *
sclk 2: 2900Mhz
`;

const DISCRETE = `@amd 0000:03:00.0
id 0x744c
class 0x030000
busy 42
vram_used ${Math.round(4 * GB)}
vram_total ${Math.round(16 * GB)}
vis_used ${Math.round(4 * GB)}
vis_total ${Math.round(16 * GB)}
gtt_used ${Math.round(2 * GB)}
gtt_total ${Math.round(62 * GB)}
power 180500000
cap 200000000
capmax 250000000
fan 1450
temp junction 63000
freq sclk 2400000000
sclk 0: 1000Mhz
sclk 1: 2400Mhz *
`;

test("parseAmdProbe reads every field of a card", () => {
  const [card] = parseAmdProbe(PROBE);
  assert.equal(card.pci, "0000:c6:00.0");
  assert.equal(card.deviceId, "0x1586");
  assert.equal(card.displayClass, true);
  assert.equal(card.busy, 98);
  assert.equal(card.vramTotal, 536870912);
  assert.equal(card.gttUsed, 29132099584);
  assert.equal(card.tempMilli, 68000); // the edge sensor wins over the hotter hotspot
  assert.equal(card.powerUw, 123241000);
  assert.equal(card.powerCapUw, null); // an empty cap is no limit, not a zero-watt one
  assert.equal(card.sclkMHz, 2872); // hwmon hertz become the megahertz the panel uses
  assert.equal(card.sclkMaxMHz, 2900); // the ceiling only pp_dpm_sclk states
});

test("parseAmdProbe: empty, garbage and several cards", () => {
  assert.deepEqual(parseAmdProbe(""), []);
  assert.deepEqual(parseAmdProbe(null), []);
  assert.deepEqual(parseAmdProbe("busy 50\nnot a probe"), []);
  // A header that is not a PCI address opens nothing: the lines under it are ignored.
  assert.deepEqual(parseAmdProbe("@amd /tmp/nope\nbusy 50"), []);
  assert.equal(parseAmdProbe(PROBE + DISCRETE).length, 2);
});

test("parseAmdProbe tolerates empty values (missing sysfs files)", () => {
  const [card] = parseAmdProbe("@amd 0000:c6:00.0\nid \nclass \nbusy \npower \ncap \ntemp \nfreq x\n");
  assert.equal(card.deviceId, null);
  assert.equal(card.displayClass, false);
  assert.equal(card.busy, null);
  assert.equal(card.powerUw, null);
  assert.deepEqual(card.temps, []);
  assert.deepEqual(card.freqs, []);
  assert.equal(card.tempMilli, null);
});

test("an integrated card is shown as one pool: the carve-out and GTT together", () => {
  const [card] = parseAmdProbe(PROBE);
  const pool = amdMemoryPool(card);
  assert.equal(pool.source, "gtt");
  assert.equal(pool.total, 536870912 + 122880000000);
  assert.equal(pool.used, 235540480 + 29132099584);
});

test("a discrete card keeps its own VRAM; its GTT is never added to it", () => {
  const [card] = parseAmdProbe(DISCRETE);
  const pool = amdMemoryPool(card);
  assert.equal(pool.source, "sysfs");
  assert.equal(pool.total, 16 * GB);
  assert.equal(pool.used, 4 * GB);
});

test("a card with no VRAM at all is integrated even without the display class", () => {
  const card = parseAmdProbe("@amd 0000:00:01.0\nclass 0x030000\nvram_total 0\nvram_used 0\ngtt_total 34359738368\ngtt_used 1073741824")[0];
  const pool = amdMemoryPool(card);
  assert.equal(pool.source, "gtt");
  assert.equal(pool.total, 32 * GB);
  assert.equal(pool.used, 1 * GB);
});

test("a resizable-BAR discrete card is not mistaken for an APU", () => {
  // Its BAR maps all of its VRAM, so visible equals total and GTT dwarfs both — the PCI
  // class is the only thing that keeps it discrete.
  const card = parseAmdProbe(`@amd 0000:03:00.0\nclass 0x030000\nvram_total ${8 * GB}\nvis_total ${8 * GB}\ngtt_total ${64 * GB}`)[0];
  assert.equal(amdMemoryPool(card).source, "sysfs");
  assert.equal(amdMemoryPool(card).total, 8 * GB);
});

test("amdDevicesFromCards shapes devices and marks what is unknown unavailable", () => {
  const [apu] = amdDevicesFromCards(parseAmdProbe(PROBE));
  assert.equal(apu.vendor, "amd");
  assert.equal(apu.pci, "0000:c6:00.0");
  assert.equal(apu.name, "Radeon 8060S"); // sysfs has no marketing name; the id map does
  assert.equal(apu.temperature, 68);
  assert.equal(apu.usage, 98);
  assert.equal(apu.powerDraw, 123.24);
  assert.deepEqual(apu.power, { draw: 123.24, limit: 0 });
  assert.equal(apu.vram.total, Math.round((536870912 + 122880000000) / MB));
  assert.equal(apu.vram.used, Math.round((235540480 + 29132099584) / MB));
  assert.equal(apu.vramSource, "gtt");
  assert.equal(apu.smClockMHz, 2872);
  assert.equal(apu.smClockMaxMHz, 2900);
  assert.deepEqual(apu.metricAvailability, {
    temperature: true, usage: true, powerDraw: true, powerLimit: false, vramUsed: true, vramTotal: true,
  });

  const [dgpu] = amdDevicesFromCards(parseAmdProbe(DISCRETE));
  assert.equal(dgpu.powerLimit, 200);
  assert.equal(dgpu.fanRpm, 1450);
  assert.equal(dgpu.vramSource, "sysfs");
  assert.equal(dgpu.metricAvailability.powerLimit, true);
});

test("a bare card reports unknown numbers instead of zeros", () => {
  const [bare] = amdDevicesFromCards(parseAmdProbe("@amd 0000:c6:00.0\nid 0xabcd\n"));
  assert.equal(bare.name, "AMD GPU [abcd]"); // an unknown id is at least lookable-up
  assert.equal(bare.temperature, 0);
  assert.equal(bare.usage, 0);
  assert.equal(bare.vram.total, 0);
  assert.equal(bare.vramSource, null);
  assert.deepEqual(bare.metricAvailability, {
    temperature: false, usage: false, powerDraw: false, powerLimit: false, vramUsed: false, vramTotal: false,
  });
});

test("the power cap falls back to power1_max, and 0 means unlimited", () => {
  const capped = parseAmdProbe("@amd 0000:c6:00.0\ncap 0\ncapmax 250000000")[0];
  assert.equal(capped.powerCapUw, 250000000);
  const unlimited = parseAmdProbe("@amd 0000:c6:00.0\ncap 0\ncapmax 0")[0];
  assert.equal(unlimited.powerCapUw, null);
});

test("with no sclk label the current pp_dpm_sclk step is the clock", () => {
  const card = parseAmdProbe("@amd 0000:c6:00.0\nfreq mclk 1000000000\nsclk 0: 500Mhz\nsclk 2: 2500Mhz *\n")[0];
  assert.equal(card.sclkMHz, 2500);
  assert.equal(card.sclkMaxMHz, 2500);
});

// ── The shell probe and the sysfs reader, against one fixture tree ──────

function buildTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amd-probe-"));
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const link = (rel, target) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.symlinkSync(target, path.join(root, rel));
  };
  const card = (n, pci, driver) => {
    link(`sys/class/drm/card${n}/device`, `../../../devices/pci/${pci}`);
    fs.mkdirSync(path.join(root, "sys/bus/pci/drivers", driver), { recursive: true });
    link(`sys/devices/pci/${pci}/driver`, `../../../bus/pci/drivers/${driver}`);
  };
  const apu = "sys/devices/pci/0000:c6:00.0";
  const dgpu = "sys/devices/pci/0000:03:00.0";
  const nv = "sys/devices/pci/0000:05:00.0";
  card(0, "0000:c6:00.0", "amdgpu");
  card(1, "0000:03:00.0", "amdgpu");
  card(2, "0000:05:00.0", "nvidia"); // other driver: skipped
  fs.mkdirSync(path.join(root, "sys/class/drm/card0-DP-1"), { recursive: true }); // connector: skipped

  w(`${apu}/device`, "0x1586\n");
  w(`${apu}/class`, "0x038000\n");
  w(`${apu}/gpu_busy_percent`, "98\n");
  w(`${apu}/mem_info_vram_used`, "235540480\n");
  w(`${apu}/mem_info_vram_total`, "536870912\n");
  w(`${apu}/mem_info_vis_vram_used`, "235540480\n");
  w(`${apu}/mem_info_vis_vram_total`, "536870912\n");
  w(`${apu}/mem_info_gtt_used`, "29132099584\n");
  w(`${apu}/mem_info_gtt_total`, "122880000000\n");
  w(`${apu}/pp_dpm_sclk`, "0: 2900Mhz \n1: 2872Mhz *\n2: 2900Mhz \n");
  w(`${apu}/hwmon/hwmon4/name`, "amdgpu\n");
  w(`${apu}/hwmon/hwmon4/temp1_input`, "68000\n");
  w(`${apu}/hwmon/hwmon4/temp1_label`, "edge\n");
  w(`${apu}/hwmon/hwmon4/power1_average`, "123241000\n");
  w(`${apu}/hwmon/hwmon4/freq1_input`, "2872000000\n");
  w(`${apu}/hwmon/hwmon4/freq1_label`, "sclk\n");

  w(`${dgpu}/device`, "0x744c\n");
  w(`${dgpu}/class`, "0x030000\n");
  w(`${dgpu}/gpu_busy_percent`, "42\n");
  w(`${dgpu}/mem_info_vram_used`, `${4 * GB}\n`);
  w(`${dgpu}/mem_info_vram_total`, `${16 * GB}\n`);
  w(`${dgpu}/mem_info_vis_vram_used`, `${4 * GB}\n`);
  w(`${dgpu}/mem_info_vis_vram_total`, `${16 * GB}\n`);
  w(`${dgpu}/mem_info_gtt_used`, `${2 * GB}\n`);
  w(`${dgpu}/mem_info_gtt_size`, `${62 * GB}\n`); // the older name
  w(`${dgpu}/hwmon/hwmon7/name`, "amdgpu\n");
  w(`${dgpu}/hwmon/hwmon7/temp1_input`, "63000\n");
  w(`${dgpu}/hwmon/hwmon7/temp1_label`, "junction\n");
  w(`${dgpu}/hwmon/hwmon7/power1_input`, "180500000\n"); // no power1_average on this one
  w(`${dgpu}/hwmon/hwmon7/power1_cap`, "0\n");
  w(`${dgpu}/hwmon/hwmon7/power1_max`, "250000000\n");
  w(`${dgpu}/hwmon/hwmon7/fan1_input`, "1450\n");
  w(`${dgpu}/hwmon/hwmon7/freq1_input`, "2400000000\n");
  w(`${dgpu}/hwmon/hwmon7/freq1_label`, "sclk\n");
  return root;
}

const runProbe = (root) =>
  execFileSync("sh", ["-c", AMD_PROBE_SCRIPT], { env: { ...process.env, AMD_PROBE_ROOT: root }, encoding: "utf8" });

test("the probe script finds only the amdgpu cards, in card order", () => {
  const root = buildTree();
  try {
    const cards = parseAmdProbe(runProbe(root));
    assert.deepEqual(cards.map((c) => c.pci), ["0000:c6:00.0", "0000:03:00.0"]);
    assert.equal(cards[0].sclkMaxMHz, 2900);
    assert.equal(cards[1].powerCapUw, 250000000); // power1_cap 0 fell through to power1_max
    assert.equal(cards[1].gttTotal, 62 * GB); // read through the older *_size name
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reading sysfs directly gives the same cards as the probe script", () => {
  const root = buildTree();
  try {
    const fromScript = amdDevicesFromCards(parseAmdProbe(runProbe(root)));
    const fromFs = amdDevicesFromCards(collectAmdSysfs({ root: path.join(root, "sys") }));
    assert.deepEqual(fromFs, fromScript);
    assert.equal(fromFs[0].vramSource, "gtt");
    assert.equal(fromFs[1].vramSource, "sysfs");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("collectAmdSysfs: no sysfs, no drm, no cards — never a throw", () => {
  assert.deepEqual(collectAmdSysfs({ root: "/does/not/exist" }), []);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "amd-empty-"));
  try {
    assert.deepEqual(collectAmdSysfs({ root: empty }), []);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("the probe has no unquoted glob (a zsh login shell aborts on an unmatched one)", { skip: spawnSync("zsh", ["-c", "true"]).error != null }, () => {
  const run = spawnSync("zsh", ["-c", AMD_PROBE_SCRIPT], { encoding: "utf8", env: { ...process.env, AMD_PROBE_ROOT: "/nonexistent" } });
  assert.doesNotMatch(run.stderr, /no matches found/);
  assert.equal(run.stdout.trim(), "");
});
