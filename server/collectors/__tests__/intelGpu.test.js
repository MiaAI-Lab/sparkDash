import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { INTEL_PROBE_SCRIPT, IntelSudoGate, IntelVramCache, buildIntelProbeScript, parseIntelProbe, sampleIntelCards } from "../intelGpu.js";

// Fictional card, real file formats (values are not from any real machine).
const PROBE = `@xe 0000:3a:00.0
id 0xe223
up 1000.00
cap 200000000
crit 400000000
fan 1500
energy card 5000000000
energy pkg 4000000000
temp pkg 60000
temp vram 70000
temp mctrl 50000
cur 2400
max 2800
idle 800000
res 0x0000004000000000 0x0000004000ffffff 0x000000000014220c
res 0x0000000000000000 0x0000000000000000 0x0000000000000000
res 0x0000003800000000 0x0000003fffffffff 0x000000000014220c
vram size: 34359738368
vram usage: 4294967296
`;

const withUp = (text, up, energy, idle) =>
  text
    .replace("up 1000.00", `up ${up}`)
    .replace("energy card 5000000000", `energy card ${energy}`)
    .replace("idle 800000", `idle ${idle}`);

test("parseIntelProbe reads every field of a card", () => {
  const [c] = parseIntelProbe(PROBE);
  assert.equal(c.pci, "0000:3a:00.0");
  assert.equal(c.deviceId, "0xe223");
  assert.equal(c.uptimeSec, 1000);
  assert.equal(c.capUw, 200000000);
  assert.equal(c.fanRpm, 1500);
  assert.deepEqual(c.energyUj, { card: 5000000000, pkg: 4000000000 });
  assert.deepEqual(c.temps, { pkg: 60000, vram: 70000, mctrl: 50000 });
  assert.equal(c.freqMHz, 2400);
  assert.equal(c.idleMs, 800000);
  assert.equal(c.vramSizeBytes, 34359738368);
  assert.equal(c.vramUsageBytes, 4294967296);
});

test("parseIntelProbe: empty, garbage and several cards", () => {
  assert.deepEqual(parseIntelProbe(""), []);
  assert.deepEqual(parseIntelProbe(null), []);
  assert.deepEqual(parseIntelProbe("fan 100\nnot a probe"), []);
  assert.equal(parseIntelProbe(PROBE + PROBE.replace("3a:00.0", "3b:00.0")).length, 2);
});

test("parseIntelProbe tolerates empty values (missing sysfs files)", () => {
  const [c] = parseIntelProbe("@xe 0000:3a:00.0\nid \ncap \nfan \nenergy card \ntemp pkg \nidle ");
  assert.equal(c.deviceId, null);
  assert.equal(c.capUw, null);
  assert.deepEqual(c.energyUj, {});
  assert.deepEqual(c.temps, {});
});

test("first sample: power and usage read 0, everything else is filled in", () => {
  const { devices, next } = sampleIntelCards(parseIntelProbe(PROBE));
  const d = devices[0];
  assert.equal(d.vendor, "intel");
  assert.equal(d.name, "Intel Arc Pro B70");
  assert.equal(d.temperature, 60);
  assert.equal(d.powerDraw, 0);
  assert.equal(d.usage, 0);
  assert.equal(d.powerLimit, 200);
  assert.equal(d.fanRpm, 1500);
  assert.equal(d.smClockMHz, 2400);
  assert.equal(d.vramTotalMB, 32768);
  assert.equal(d.vramUsedMB, 4096);
  assert.equal(d.vramSource, "debugfs");
  assert.equal(next.get("0000:3a:00.0").energy, 5000000000);
});

test("second sample: watts from the energy delta, usage from idle residency", () => {
  const first = sampleIntelCards(parseIntelProbe(PROBE));
  // 10 s later: +1.5 GJ (150 W) on the card counter, GT idle for 4 s of the 10 s.
  const text = withUp(PROBE, "1010.00", 6500000000, 804000);
  const { devices } = sampleIntelCards(parseIntelProbe(text), first.next);
  assert.equal(devices[0].powerDraw, 150);
  assert.equal(devices[0].usage, 60);
});

test("counter reset keeps the last good reading instead of dropping to 0", () => {
  let s = sampleIntelCards(parseIntelProbe(PROBE));
  s = sampleIntelCards(parseIntelProbe(withUp(PROBE, "1010.00", 6500000000, 804000)), s.next);
  s = sampleIntelCards(parseIntelProbe(withUp(PROBE, "1020.00", 1000, 10)), s.next);
  assert.equal(s.devices[0].powerDraw, 150);
  assert.equal(s.devices[0].usage, 60);
  // The reset sample becomes the new baseline.
  s = sampleIntelCards(parseIntelProbe(withUp(PROBE, "1030.00", 500001000, 4010)), s.next);
  assert.equal(s.devices[0].powerDraw, 50);
  assert.equal(s.devices[0].usage, 60);
});

test("reboot (uptime went backwards) and stale baselines start over at 0", () => {
  const first = sampleIntelCards(parseIntelProbe(PROBE));
  const rebooted = sampleIntelCards(parseIntelProbe(withUp(PROBE, "5.00", 6000000000, 900000)), first.next);
  assert.equal(rebooted.devices[0].powerDraw, 0);
  const stale = sampleIntelCards(parseIntelProbe(withUp(PROBE, "5000.00", 9000000000, 900000)), first.next);
  assert.equal(stale.devices[0].powerDraw, 0);
});

test("a poll right after another keeps the baseline and the last reading", () => {
  let s = sampleIntelCards(parseIntelProbe(PROBE));
  s = sampleIntelCards(parseIntelProbe(withUp(PROBE, "1010.00", 6500000000, 804000)), s.next);
  const quick = sampleIntelCards(parseIntelProbe(withUp(PROBE, "1010.10", 6600000000, 804050)), s.next);
  assert.equal(quick.devices[0].powerDraw, 150);
  assert.equal(quick.next.get("0000:3a:00.0").t, 1010);
});

test("VRAM falls back to the largest PCI BAR when debugfs is unreadable", () => {
  const noDebugfs = PROBE.replace(/^vram .*\n/gm, "");
  const d = sampleIntelCards(parseIntelProbe(noDebugfs)).devices[0];
  assert.equal(d.vramTotalMB, 32768);
  assert.equal(d.vramUsedMB, 0);
  assert.equal(d.vramSource, "pci-bar");
});

test("missing hwmon: no power limit, no temperature, no crash; unknown id gets a generic name", () => {
  const bare = "@xe 0000:3a:00.0\nid 0xabcd\nup 50\n";
  const d = sampleIntelCards(parseIntelProbe(bare)).devices[0];
  assert.equal(d.name, "Intel GPU [abcd]");
  assert.equal(d.temperature, 0);
  assert.equal(d.powerLimit, 0);
  assert.equal(d.vramTotalMB, 0);
});

test("power limit falls back to the critical limit when the cap is 0 (unlimited)", () => {
  const d = sampleIntelCards(parseIntelProbe(PROBE.replace("cap 200000000", "cap 0"))).devices[0];
  assert.equal(d.powerLimit, 400);
});

// ── The shell probe itself, against a fixture sysfs tree ──────────────

function buildTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intel-probe-"));
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
  const dev = "sys/devices/pci/0000:3a:00.0";
  card(0, "0000:3a:00.0", "xe");
  card(1, "0000:00:02.0", "xe"); // integrated: skipped
  card(2, "0000:3b:00.0", "i915"); // other driver: skipped
  fs.mkdirSync(path.join(root, "sys/class/drm/card0-DP-1"), { recursive: true });
  w(`${dev}/device`, "0xe223\n");
  w(`${dev}/hwmon/hwmon3/name`, "xe\n");
  w(`${dev}/hwmon/hwmon3/power1_cap`, "200000000\n");
  w(`${dev}/hwmon/hwmon3/fan1_input`, "1500\n");
  w(`${dev}/hwmon/hwmon3/energy1_input`, "5000000000\n");
  w(`${dev}/hwmon/hwmon3/energy1_label`, "card\n");
  w(`${dev}/hwmon/hwmon3/temp2_input`, "60000\n");
  w(`${dev}/hwmon/hwmon3/temp2_label`, "pkg\n");
  w(`${dev}/hwmon/hwmon3/temp6_input`, "99000\n");
  w(`${dev}/hwmon/hwmon3/temp6_label`, "vram_ch_0\n");
  w(`${dev}/tile0/gt0/freq0/cur_freq`, "2400\n");
  w(`${dev}/tile0/gt0/gtidle/idle_residency_ms`, "800000\n");
  w(`${dev}/resource`, "0x0000003800000000 0x0000003fffffffff 0x000000000014220c\n");
  w("sys/kernel/debug/dri/0000:3a:00.0/tile0/vram_mm", "  use_type: 1\n  size: 8589934592\n  usage: 1073741824\nvisible_size: 8192MiB\n");
  w("proc/uptime", "1000.00 4000.00\n");
  return root;
}

const runProbe = (root) =>
  execFileSync("sh", ["-c", INTEL_PROBE_SCRIPT], { env: { ...process.env, INTEL_PROBE_ROOT: root }, encoding: "utf8" });

test("probe script: finds only the discrete xe card and yields parseable output", () => {
  const root = buildTree();
  try {
    const cards = parseIntelProbe(runProbe(root));
    assert.equal(cards.length, 1);
    const c = cards[0];
    assert.equal(c.pci, "0000:3a:00.0");
    assert.equal(c.uptimeSec, 1000);
    assert.equal(c.energyUj.card, 5000000000);
    assert.deepEqual(c.temps, { pkg: 60000 }); // vram_ch_N channels are left out
    assert.equal(c.freqMHz, 2400);
    assert.equal(c.vramSizeBytes, 8589934592); // "visible_size:" must not match
    assert.equal(c.vramUsageBytes, 1073741824);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("probe script: missing debugfs and hwmon still exit 0 with a usable card", () => {
  const root = buildTree();
  try {
    fs.rmSync(path.join(root, "sys/kernel/debug"), { recursive: true });
    fs.rmSync(path.join(root, "sys/devices/pci/0000:3a:00.0/hwmon"), { recursive: true });
    const [c] = parseIntelProbe(runProbe(root));
    assert.equal(c.vramSizeBytes, null);
    assert.equal(sampleIntelCards([c]).devices[0].vramSource, "pci-bar");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("probe script: a node with no GPU prints nothing and exits 0", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intel-probe-"));
  try {
    assert.equal(runProbe(root).trim(), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildIntelProbeScript: sudo off prefixes INTEL_SUDO=0, sudo on is the plain script", () => {
  assert.equal(buildIntelProbeScript(), INTEL_PROBE_SCRIPT);
  assert.equal(buildIntelProbeScript({ sudo: true }), INTEL_PROBE_SCRIPT);
  assert.ok(buildIntelProbeScript({ sudo: false }).startsWith("INTEL_SUDO=0\n"));
});

test("parseIntelProbe: a sudofail line marks the card", () => {
  const [a] = parseIntelProbe(PROBE + "sudofail 1\n");
  assert.equal(a.sudoFailed, true);
  const [b] = parseIntelProbe(PROBE);
  assert.equal(b.sudoFailed, false);
});

test("probe script: unreadable debugfs with INTEL_SUDO=0 skips sudo and stays exit 0", () => {
  const root = buildTree();
  try {
    fs.rmSync(path.join(root, "sys/kernel/debug"), { recursive: true });
    const run = (script) =>
      execFileSync("sh", ["-c", script], { env: { ...process.env, INTEL_PROBE_ROOT: root }, encoding: "utf8" });
    const off = run(buildIntelProbeScript({ sudo: false }));
    assert.ok(!off.includes("sudofail"));
    assert.equal(parseIntelProbe(off).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("IntelSudoGate: a failure blocks sudo for the TTL, then retries; no failure keeps it open", () => {
  let t = 1_000_000;
  const gate = new IntelSudoGate({ now: () => t, ttlMs: 600_000 });
  assert.equal(gate.allowed, true);
  gate.observe([{ sudoFailed: false }]);
  assert.equal(gate.allowed, true); // working sudo is used every poll
  gate.observe([{ sudoFailed: true }]);
  assert.equal(gate.allowed, false);
  t += 599_999;
  assert.equal(gate.allowed, false);
  t += 1;
  assert.equal(gate.allowed, true); // retry after the TTL
  gate.observe([{ sudoFailed: true }]);
  assert.equal(gate.allowed, false); // still failing: closes again
  gate.observe([]);
  assert.equal(gate.allowed, false); // a probe without sudo carries no news
});

test("buildIntelProbeScript: vram off prefixes INTEL_VRAM=0 and combines with sudo off", () => {
  assert.ok(buildIntelProbeScript({ vram: false }).startsWith("INTEL_VRAM=0\n"));
  const both = buildIntelProbeScript({ sudo: false, vram: false });
  assert.ok(both.startsWith("INTEL_VRAM=0\nINTEL_SUDO=0\n"));
  assert.equal(buildIntelProbeScript({ vram: true }), INTEL_PROBE_SCRIPT);
});

// A stand-in for sudo that logs each call, then runs the command as the current user.
function fakeSudoDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intel-sudo-"));
  fs.writeFileSync(path.join(dir, "sudo"), `#!/bin/sh\nprintf "%s\\n" "$*" >> "${dir}/calls"\nshift\nexec "$@"\n`, { mode: 0o755 });
  return dir;
}
const sudoCalls = (dir) => (fs.existsSync(path.join(dir, "calls")) ? fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n") : []);

test("probe script: INTEL_VRAM=0 never reads debugfs or calls sudo, other metrics still print", () => {
  const root = buildTree();
  const bin = fakeSudoDir();
  try {
    const dbg = path.join(root, "sys/kernel/debug");
    fs.chmodSync(path.join(dbg, "dri/0000:3a:00.0/tile0/vram_mm"), 0o000);
    const out = execFileSync("sh", ["-c", buildIntelProbeScript({ vram: false })], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, INTEL_PROBE_ROOT: root },
      encoding: "utf8",
    });
    const [c] = parseIntelProbe(out);
    assert.equal(c.vramSizeBytes, null);
    assert.equal(c.sudoFailed, false);
    assert.equal(c.freqMHz, 2400);
    assert.equal(c.energyUj.card, 5000000000);
    assert.deepEqual(sudoCalls(bin), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("probe script: vram_mm under another tile directory is found", () => {
  const root = buildTree();
  try {
    const d = path.join(root, "sys/kernel/debug/dri/0000:3a:00.0");
    fs.renameSync(path.join(d, "tile0"), path.join(d, "tile1"));
    const [c] = parseIntelProbe(runProbe(root));
    assert.equal(c.vramSizeBytes, 8589934592);
    assert.equal(c.vramUsageBytes, 1073741824);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("probe script: sudo reads a non-tile0 file in one call", () => {
  const root = buildTree();
  const bin = fakeSudoDir();
  try {
    const d = path.join(root, "sys/kernel/debug/dri/0000:3a:00.0");
    fs.renameSync(path.join(d, "tile0"), path.join(d, "tile2"));
    fs.chmodSync(path.join(d, "tile2/vram_mm"), 0o000); // plain read fails, sudo stand-in runs as us
    // the stand-in can not bypass modes, so only check the call shape and that sudo ran once
    const out = execFileSync("sh", ["-c", INTEL_PROBE_SCRIPT], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, INTEL_PROBE_ROOT: root },
      encoding: "utf8",
    });
    const calls = sudoCalls(bin);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^-n cat .*tile0\/vram_mm .*tile1\/vram_mm .*tile2\/vram_mm .*tile3\/vram_mm$/);
    assert.ok(typeof out === "string");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("probe script: a vram_mm without size/usage lines leaves the BAR fallback", () => {
  const root = buildTree();
  try {
    fs.writeFileSync(path.join(root, "sys/kernel/debug/dri/0000:3a:00.0/tile0/vram_mm"), "something: else\nvisible_size: 8192MiB\n");
    const [c] = parseIntelProbe(runProbe(root));
    assert.equal(c.vramSizeBytes, null);
    const d = sampleIntelCards([c]).devices[0];
    assert.equal(d.vramSource, "pci-bar");
    assert.equal(d.vramTotalMB, 32768);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("probe script: a host with only non-xe cards never calls sudo", () => {
  const root = buildTree();
  const bin = fakeSudoDir();
  try {
    fs.rmSync(path.join(root, "sys/class/drm/card0"), { recursive: true });
    fs.rmSync(path.join(root, "sys/class/drm/card1"), { recursive: true });
    const out = execFileSync("sh", ["-c", INTEL_PROBE_SCRIPT], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, INTEL_PROBE_ROOT: root },
      encoding: "utf8",
    });
    assert.equal(out.trim(), "");
    assert.deepEqual(sudoCalls(bin), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("IntelVramCache: one read per window, cached values fill skipped polls, expiry re-reads", () => {
  let t = 1_000_000;
  const cache = new IntelVramCache({ now: () => t });
  const card = () => ({ pci: "a", vramSizeBytes: null, vramUsageBytes: null });
  assert.equal(cache.stale, true);
  cache.apply([{ pci: "a", vramSizeBytes: 100, vramUsageBytes: 40 }], true);
  assert.equal(cache.stale, false);
  t += 44_000;
  assert.equal(cache.stale, false);
  const c = card();
  cache.apply([c], false);
  assert.deepEqual([c.vramSizeBytes, c.vramUsageBytes], [100, 40]);
  assert.equal(cache.stale, false);
  t += 1_000;
  assert.equal(cache.stale, true);
});

test("IntelVramCache: a read that returns nothing is not cached; a new card forces a read", () => {
  let t = 1_000_000;
  const cache = new IntelVramCache({ now: () => t });
  cache.apply([{ pci: "a", vramSizeBytes: null, vramUsageBytes: null }], true);
  assert.equal(cache.stale, true);
  cache.apply([{ pci: "a", vramSizeBytes: 100, vramUsageBytes: 40 }], true);
  assert.equal(cache.stale, false);
  const fresh = { pci: "b", vramSizeBytes: null, vramUsageBytes: null };
  cache.apply([{ pci: "a", vramSizeBytes: null, vramUsageBytes: null }, fresh], false);
  assert.equal(fresh.vramSizeBytes, null);
  assert.equal(cache.stale, true);
});
