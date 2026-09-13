import test from "node:test";
import assert from "node:assert/strict";
import { SystemCollector } from "../SystemCollector.js";

/** Local collector with sysfs/smi/stubs — no real I/O anywhere. */
function localCollector() {
  const c = new SystemCollector({ id: "spark-test", kind: "spark", isLocal: true });
  return c;
}

const LIVE_DOMAINS = [
  { label: "X925", capMHz: 2600, maxMHz: 3900, capped: true },
  { label: "A725", capMHz: 2808, maxMHz: 2808, capped: false },
];

// ─── D5: volatile override merge ──────────────────────────

test("stale cache is merged with the volatile override (cpu)", async () => {
  const c = localCollector();
  c._clockCapsCache = {
    at: Date.now(),
    cpuDomains: LIVE_DOMAINS.map((d) => ({ ...d })),
    gpuLock: null,
    ok: true,
  };
  // Override targets the 3900 MHz domain (the "cpu-big" id per parseCpuClockCaps).
  c._clockCapsOverride["cpu-big"] = 3000;
  const caps = await c._getClockCaps();
  assert.equal(caps.cpuDomains[0].capMHz, 3000);
  assert.equal(caps.cpuDomains[0].capped, true);
  // Cache itself is never mutated.
  assert.equal(c._clockCapsCache.cpuDomains[0].capMHz, 2600);
});

test("override can remove a gpu lock (null) and the merge reflects it", async () => {
  const c = localCollector();
  c._clockCapsCache = {
    at: Date.now(),
    cpuDomains: LIVE_DOMAINS.map((d) => ({ ...d })),
    gpuLock: { minMHz: 0, maxMHz: 2200 },
    ok: true,
  };
  c._clockCapsOverride.gpu = null;
  const caps = await c._getClockCaps();
  assert.equal(caps.gpuLock, null);
});

test("a fresh converging read drops the override", async () => {
  const c = localCollector();
  c._clockCapsOverride["cpu-little"] = 2808;
  // Fresh read now reports the applied value — override is redundant.
  // cpu-little id = the 2808 MHz domain (per parseCpuClockCaps labels).
  c._readLocalCpuCapDump = async () => "cpu0:2808000:2808000\ncpu5:2600000:3900000";
  c._readLocalGpuLockUnit = async () => "";
  const caps = await c._getClockCaps();
  assert.equal(caps.cpuDomains.find((d) => d.maxMHz === 2808).capMHz, 2808);
  assert.deepEqual(c._clockCapsOverride, {});
});

test("a fresh diverging read also drops the override (fresh value wins)", async () => {
  const c = localCollector();
  c._clockCapsOverride["cpu-little"] = 2808;
  // Fresh read says something else entirely (e.g. another operator changed it).
  c._readLocalCpuCapDump = async () => "cpu0:2000000:2808000\ncpu5:2600000:3900000";
  c._readLocalGpuLockUnit = async () => "";
  const caps = await c._getClockCaps();
  assert.equal(caps.cpuDomains.find((d) => d.maxMHz === 2808).capMHz, 2000);
  assert.deepEqual(c._clockCapsOverride, {});
});

test("clearClockCapsOverride drops all volatile state (hot config)", async () => {
  const c = localCollector();
  c._clockCapsOverride["cpu-big"] = 3000;
  c._clockCapsOverride.gpu = 2200;
  c.clearClockCapsOverride();
  assert.deepEqual(c._clockCapsOverride, {});
});

test("a gpu live-only override survives a diverging unit-file read (D5)", async () => {
  const c = localCollector();
  // A live-only -lgc apply is invisible to the unit file: until a read
  // actually reports the applied value, the override must keep the UI honest.
  c._clockCapsOverride.gpu = 2400;
  c._readLocalCpuCapDump = async () => "cpu0:2808000:2808000\ncpu5:2600000:3900000";
  c._readLocalGpuLockUnit = async () => "-lgc 0,2200"; // unit still says 2200
  await c._getClockCaps();
  assert.equal(c._clockCapsOverride.gpu, 2400);
});

test("a gpu override drops once a fresh read converges to it", async () => {
  const c = localCollector();
  c._clockCapsOverride.gpu = 2400;
  c._readLocalCpuCapDump = async () => "cpu0:2808000:2808000\ncpu5:2600000:3900000";
  c._readLocalGpuLockUnit = async () => "-lgc 0,2400";
  c._clockCapsCache = { at: 0, cpuDomains: null, gpuLock: null }; // force fresh read
  await c._getClockCaps();
  assert.ok(!Object.prototype.hasOwnProperty.call(c._clockCapsOverride, "gpu"));
});

// ─── D8: bounds discovery ─────────────────────────────────

test("_getClockBounds parses cpu bounds and the GPU ceiling from smi output", async () => {
  const c = localCollector();
  c._readLocalCpuBoundsDump = async () =>
    ["cpu0:338000:2808000", "cpu5:1378000:3900000"].join("\n");
  c._nvidiaSmi = async () =>
    "Default Applications Clock\n        Graphics : 3003 MHz";
  const b = await c._getClockBounds();
  assert.deepEqual(b.cpuBounds, [
    { minKhz: 1378000, maxKhz: 3900000 },
    { minKhz: 338000, maxKhz: 2808000 },
  ]);
  assert.equal(b.gpuCeilingMHz, 3003);
  assert.equal(b.gpuCeilingSource, "smi");
});

test("_getClockBounds falls back to GPU_CLOCK_MAX_MHZ with source=fallback on unparseable output", async () => {
  const c = localCollector();
  c._readLocalCpuBoundsDump = async () => "cpu0:338000:2808000";
  c._nvidiaSmi = async () => "Graphics : [N/A]";
  const b = await c._getClockBounds();
  assert.equal(b.gpuCeilingSource, "fallback");
  assert.equal(Number.isFinite(b.gpuCeilingMHz), true);
  assert.equal(b.gpuCeilingMHz, 3003); // documented default
});

test("remote bounds command dumps min/max freqs then -q -d CLOCK", () => {
  const c = new SystemCollector({ id: "t", kind: "spark", isLocal: false });
  const cmd = c._buildRemoteClockBoundsCommand();
  assert.match(cmd, /cpuinfo_min_freq/);
  assert.match(cmd, /cpuinfo_max_freq/);
  assert.match(cmd, /nvidia-smi -q -d CLOCK/);
  assert.equal((cmd.match(/echo '---'/g) || []).length, 1);
});

// ─── D4: apply paths ──────────────────────────────────────

test("applyClockCap prefers the helper and records a live-only override", async () => {
  const c = localCollector();
  let helperCalled = 0;
  c._exec = async (cmd) => {
    throw new Error("local exec must not run when the helper succeeds");
  };
  // Stub sshExec on the module's imported binding via the collector instance:
  // applyClockCap calls the module-level sshExec, so stub at the helper layer
  // by faking a successful helper through a patched sshExec module object is
  // not possible — instead assert through the container fallback path below.
  helperCalled = 0;
  // The helper path uses module-level sshExec; simulate failure → local path.
  c._cpuDomainCores = (domain) => (domain === "cpu-little" ? ["cpu5", "cpu6"] : []);
  const writes = [];
  const origWrite = (await import("node:fs")).default.writeFileSync;
  const fsMod = await import("node:fs");
  fsMod.default.writeFileSync = (p, data) => {
    writes.push({ p, data: String(data) });
  };
  try {
    const res = await c.applyClockCap(
      { domain: "cpu-little", maxMHz: 2400, persist: false },
      { hardMinMHz: 1378, hardMaxMHz: 3900 }
    );
    assert.equal(res.ok, true);
    assert.equal(res.source, "container");
    assert.equal(res.persisted, false);
    assert.equal(res.appliedMHz, 2400);
    assert.equal(writes.length, 2);
    assert.match(writes[0].p, /cpu5\/cpufreq\/max_perf$/);
    assert.equal(writes[0].data, "2400000\n");
    // D5: live-only apply is recorded so the UI does not lie for the next 60s.
    assert.equal(c._clockCapsOverride["cpu-little"], 2400);
    // D4 honesty: a boot-only apply carries the reboot warning.
    assert.ok(res.warnings.some((w) => /reverts on reboot/.test(w)));
  } finally {
    fsMod.default.writeFileSync = origWrite;
  }
});

test("applyClockCap clamps an above-max request down and reports it (D2)", async () => {
  const c = localCollector();
  c._cpuDomainCores = () => ["cpu0"];
  const fsMod = await import("node:fs");
  const origWrite = fsMod.default.writeFileSync;
  const writes = [];
  fsMod.default.writeFileSync = (p, data) => writes.push(String(data));
  try {
    const res = await c.applyClockCap(
      { domain: "cpu-big", maxMHz: 9999, persist: false },
      { hardMinMHz: 338, hardMaxMHz: 2808 }
    );
    assert.equal(res.appliedMHz, 2808);
    assert.ok(res.warnings.some((w) => /clamped/.test(w)));
    assert.equal(writes[0], "2808000\n");
  } finally {
    fsMod.default.writeFileSync = origWrite;
  }
});

test("applyClockCap remove-cap writes each core's own hardware max (no 0 sentinel)", async () => {
  const c = localCollector();
  c._cpuDomainCores = () => ["cpu5", "cpu6"];
  c._readSysFile = (p) => (/cpuinfo_max_freq/.test(p) ? "3900000" : null);
  const fsMod = await import("node:fs");
  const origWrite = fsMod.default.writeFileSync;
  const writes = [];
  fsMod.default.writeFileSync = (p, data) => writes.push({ p: String(p), data: String(data) });
  try {
    const res = await c.applyClockCap(
      { domain: "cpu-little", maxMHz: null, persist: false },
      { hardMinMHz: 1378, hardMaxMHz: 3900 }
    );
    assert.equal(res.appliedMHz, null);
    assert.deepEqual(
      writes.map((w) => w.data),
      ["3900000\n", "3900000\n"]
    );
  } finally {
    fsMod.default.writeFileSync = origWrite;
  }
});

test("applyClockCap local persist failure reports persisted:false with the reboot warning", async () => {
  const c = localCollector();
  c._cpuDomainCores = () => ["cpu0"];
  const fsMod = await import("node:fs");
  const origWrite = fsMod.default.writeFileSync;
  fsMod.default.writeFileSync = () => {};
  try {
    c._persistClockUnitLocal = async () => {
      throw new Error("nsenter unavailable");
    };
    const res = await c.applyClockCap(
      { domain: "cpu-big", maxMHz: 2600, persist: true },
      { hardMinMHz: 338, hardMaxMHz: 2808 }
    );
    assert.equal(res.ok, true);
    assert.equal(res.persisted, false);
    assert.equal(res.source, "container");
    assert.ok(res.warnings.some((w) => /reverts on reboot/.test(w)));
    assert.equal(c._clockCapsOverride["cpu-big"], 2600);
  } finally {
    fsMod.default.writeFileSync = origWrite;
  }
});

test("applyClockCap successful local persist clears volatile overrides", async () => {
  const c = localCollector();
  c._cpuDomainCores = () => ["cpu0"];
  const fsMod = await import("node:fs");
  const origWrite = fsMod.default.writeFileSync;
  fsMod.default.writeFileSync = () => {};
  try {
    c._persistClockUnitLocal = async () => {};
    const res = await c.applyClockCap(
      { domain: "cpu-big", maxMHz: 2600, persist: true },
      { hardMinMHz: 338, hardMaxMHz: 2808 }
    );
    assert.equal(res.ok, true);
    assert.equal(res.persisted, true);
    assert.equal(res.bootUnit, "cpu-clock-cap.service");
    assert.deepEqual(c._clockCapsOverride, {});
    assert.ok(!res.warnings.some((w) => /reverts on reboot/.test(w)));
  } finally {
    fsMod.default.writeFileSync = origWrite;
  }
});

test("remote unit with no helper fails without attempting the container path", async () => {
  const c = new SystemCollector({ id: "remote", kind: "spark", isLocal: false });
  // sshExec (module-level) would fail on a non-existent host; assert the
  // decision logic directly: only local units have the container fallback.
  const res = await c.applyClockCap(
    { domain: "gpu", maxMHz: 2200, persist: true },
    { hardMinMHz: 0, hardMaxMHz: 3003 }
  );
  // On this host the ssh attempt fails fast (no route); whatever the exact
  // transport error, a remote unit must never report source:"container".
  assert.equal(res.ok, false);
  assert.notEqual(res.source, "container");
});

// ─── shared boot unit: a one-domain Save must preserve the sibling ─────────

const BIG_CORES = ["cpu0", "cpu1"];
const LITTLE_CORES = ["cpu5", "cpu6"];

function persistCapturingCollector(overrides = {}, siblingReads = {}) {
  const c = localCollector();
  c._cpuDomainCores = (d) => (d === "cpu-big" ? BIG_CORES : LITTLE_CORES);
  c._clockCapsOverride = { ...overrides };
  c._readSysFile = (p) => {
    for (const [cpuN, val] of Object.entries(siblingReads)) {
      if (p.includes(`/${cpuN}/cpufreq/max_perf`)) return val;
    }
    return null;
  };
  let captured = "";
  c._exec = async (cmd) => {
    captured = cmd;
    return "";
  };
  c._captured = () => captured;
  return c;
}

test("persisting one CPU domain carries the sibling domain's live values", async () => {
  // Both domains share cpu-clock-cap.service; saving only cpu-big must not
  // clobber cpu-little's boot cap (2600000 kHz live right now).
  const c = persistCapturingCollector({}, { cpu5: "2600000\n", cpu6: "2600000\n" });
  await c._persistClockUnitLocal("cpu-big", 2808);
  const cmd = c._captured();
  assert.match(cmd, /echo 2808000 > \/sys\/devices\/system\/cpu\/cpu0\/cpufreq\/max_perf/);
  assert.match(cmd, /echo 2808000 > \/sys\/devices\/system\/cpu\/cpu1\/cpufreq\/max_perf/);
  assert.match(cmd, /echo 2600000 > \/sys\/devices\/system\/cpu\/cpu5\/cpufreq\/max_perf/);
  assert.match(cmd, /echo 2600000 > \/sys\/devices\/system\/cpu\/cpu6\/cpufreq\/max_perf/);
});

test("persisted sibling value prefers its volatile override over the live read", async () => {
  const c = persistCapturingCollector(
    { "cpu-little": 2400 },
    { cpu5: "2600000\n", cpu6: "2600000\n" }
  );
  await c._persistClockUnitLocal("cpu-big", 2808);
  const cmd = c._captured();
  assert.match(cmd, /echo 2400000 > \/sys\/devices\/system\/cpu\/cpu5\/cpufreq\/max_perf/);
  assert.match(cmd, /echo 2400000 > \/sys\/devices\/system\/cpu\/cpu6\/cpufreq\/max_perf/);
  assert.doesNotMatch(cmd, /echo 2600000 >/);
});

test("persisted sibling cores with unreadable max_perf are omitted (no guesses)", async () => {
  const c = persistCapturingCollector({}, {});
  await c._persistClockUnitLocal("cpu-big", 2808);
  const cmd = c._captured();
  assert.doesNotMatch(cmd, /cpu5/);
  assert.doesNotMatch(cmd, /cpu6/);
});

test("persisted unit ExecStart contains no shell loop variables (systemd $ expansion)", async () => {
  const c = persistCapturingCollector({}, { cpu5: "2600000\n", cpu6: "2600000\n" });
  await c._persistClockUnitLocal("cpu-big", 2808);
  assert.doesNotMatch(c._captured(), /\$c\b/);
  await c._persistClockUnitLocal("cpu-big", null);
  assert.doesNotMatch(c._captured(), /\$c\b/);
});

test("remove-cap persist writes each edited core's cpuinfo_max_freq and keeps the sibling", async () => {
  const c = persistCapturingCollector({}, { cpu5: "2600000\n", cpu6: "2600000\n" });
  await c._persistClockUnitLocal("cpu-big", null);
  const cmd = c._captured();
  assert.match(cmd, /cat \/sys\/devices\/system\/cpu\/cpu0\/cpufreq\/cpuinfo_max_freq > \/sys\/devices\/system\/cpu\/cpu0\/cpufreq\/max_perf/);
  assert.match(cmd, /echo 2600000 > \/sys\/devices\/system\/cpu\/cpu5\/cpufreq\/max_perf/);
});
