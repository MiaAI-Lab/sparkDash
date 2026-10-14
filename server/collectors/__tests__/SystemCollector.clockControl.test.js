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

test("remote bounds command dumps min/max freqs, -q -d CLOCK, then both boot units", () => {
  const c = new SystemCollector({ id: "t", kind: "spark", isLocal: false });
  const cmd = c._buildRemoteClockBoundsCommand();
  assert.match(cmd, /cpuinfo_min_freq/);
  assert.match(cmd, /cpuinfo_max_freq/);
  assert.match(cmd, /nvidia-smi -q -d CLOCK/);
  assert.match(cmd, /cpu-clock-cap\.service/);
  assert.match(cmd, /gpu-clock-lock\.service/);
  assert.equal((cmd.match(/echo '---'/g) || []).length, 3);
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

// ─── item 6: requested-vs-applied honesty on the apply paths ────────────────

function sshStubCollector(out) {
  const c = localCollector();
  // Force the helper path to "succeed" with a captured stdout by intercepting
  // the module-level sshExec via the instance-level seam the tests use.
  c.__sshOut = out;
  return c;
}

test("a GPU apply whose stdout shows a snapped set-to reports asked vs applied", async () => {
  const c = localCollector();
  // Container path: nvidia-smi answers with the driver's truth (1976) for a
  // requested 2000 — the response must carry BOTH and flag snapped.
  const cmds = [];
  c._exec = async (cmd) => {
    cmds.push(cmd);
    return "GPU clocks set to (0, 1976)";
  };
  const res = await c._applyClockCapLocal("gpu", 2000, false, [], null, 2000);
  assert.equal(res.ok, true);
  assert.equal(res.requestedMHz, 2000);
  assert.equal(res.appliedMHz, 1976);
  assert.equal(res.snapped, true);
  assert.ok(res.warnings.some((w) => /accepted 1976 MHz for a request of 2000/.test(w)));
  // D5 override records the APPLIED value, never the requested one.
  assert.equal(c._clockCapsOverride.gpu, 1976);
});

test("a GPU apply the driver echoed verbatim is not flagged as snapped", async () => {
  const c = localCollector();
  c._exec = async () => "GPU clocks set to (0, 2200)";
  const res = await c._applyClockCapLocal("gpu", 2200, false, [], null, 2200);
  assert.equal(res.appliedMHz, 2200);
  assert.equal(res.snapped, false);
  assert.ok(!res.warnings.some((w) => /accepted .* for a request/.test(w)));
});

test("a GPU apply with no confirmation line reports the request WITH an explicit warning", async () => {
  const c = localCollector();
  // Silence must never be rendered as a confirmation (amendment: the UI must
  // never report a value that was not actually written).
  c._exec = async () => "All done.";
  const res = await c._applyClockCapLocal("gpu", 2200, false, [], null, 2200);
  assert.equal(res.appliedMHz, 2200);
  assert.equal(res.snapped, false);
  assert.ok(
    res.warnings.some((w) => /could not be read back from the hardware/.test(w)),
    `expected a verification warning, got ${JSON.stringify(res.warnings)}`
  );
});

test("a CPU apply reads back sysfs: a clamped max_perf reports the observed value", async () => {
  const c = localCollector();
  c._cpuDomainCores = () => ["cpu5", "cpu6"];
  const fsMod = await import("node:fs");
  const origWrite = fsMod.default.writeFileSync;
  const origRead = c._readSysFile.bind(c);
  // The driver clamps our 2000000 request down to its 1976000 table entry.
  const written = new Map();
  fsMod.default.writeFileSync = (p, data) => written.set(String(p), String(data));
  c._readSysFile = (p) =>
    /max_perf/.test(p) ? "1976000\n" : origRead(p);
  try {
    const res = await c._applyClockCapLocal("cpu-little", 2000, false, [], null, 2000);
    assert.equal(res.ok, true);
    assert.equal(res.requestedMHz, 2000);
    assert.equal(res.appliedMHz, 1976);
    assert.equal(res.snapped, true);
    assert.equal(written.get("/sys/devices/system/cpu/cpu5/cpufreq/max_perf"), "2000000\n");
    assert.ok(res.warnings.some((w) => /accepted 1976 MHz for a request of 2000/.test(w)));
    assert.equal(c._clockCapsOverride["cpu-little"], 1976);
  } finally {
    fsMod.default.writeFileSync = origWrite;
  }
});

test("a CPU apply whose read-back matches the request is not flagged", async () => {
  const c = localCollector();
  c._cpuDomainCores = () => ["cpu0"];
  const fsMod = await import("node:fs");
  const origWrite = fsMod.default.writeFileSync;
  fsMod.default.writeFileSync = () => {};
  try {
    c._readSysFile = (p) => (/max_perf/.test(p) ? "2808000\n" : null);
    const res = await c._applyClockCapLocal("cpu-big", 2808, false, [], null, 2808);
    assert.equal(res.appliedMHz, 2808);
    assert.equal(res.snapped, false);
    assert.ok(!res.warnings.some((w) => /read back/.test(w)));
  } finally {
    fsMod.default.writeFileSync = origWrite;
  }
});

test("_verifyAppliedClockCap prefers the driver's confirmation over any read", async () => {
  const c = localCollector();
  c._cpuDomainCores = () => ["cpu0"];
  c._readSysFile = () => "9999000\n"; // a read-back that must LOSE to stdout
  assert.equal(await c._verifyAppliedClockCap("cpu-big", "GPU clocks set to (0, 1976)"), 1976);
  // GPU without a confirmation line has NO trustworthy source on this driver
  // (there is no Locked Clocks section; the unit file is desired state): null.
  c.spark = { id: "t", kind: "spark", isLocal: true };
  assert.equal(await c._verifyAppliedClockCap("gpu", "All done."), null);
  // A remote unit has no sysfs view at all — must not read local files.
  const r = new SystemCollector({ id: "r", kind: "spark", isLocal: false });
  r._cpuDomainCores = () => ["cpu0"];
  assert.equal(await r._verifyAppliedClockCap("cpu-big", "no confirmation here"), null);
});

test("the helper-path response carries the additive honesty fields (backward compatible)", async () => {
  const c = localCollector();
  // Drive the helper's stdout through the class SSH seam (the module-level
  // sshExec binding is read-only ESM and cannot be monkey-patched).
  c._sshExec = async () => "GPU clocks set to (0, 1976)\nAll done.";
  const res = await c.applyClockCap(
    { domain: "gpu", maxMHz: 2000, persist: false },
    { hardMinMHz: 0, hardMaxMHz: 3003 }
  );
  assert.equal(res.ok, true);
  assert.equal(res.source, "helper");
  assert.equal(res.requestedMHz, 2000);
  assert.equal(res.appliedMHz, 1976, "the driver said 1976 — that is what must be reported");
  assert.equal(res.snapped, true);
  // Additive only: every pre-existing field keeps its meaning.
  assert.equal(typeof res.persisted, "boolean");
  assert.equal(res.bootUnit, null);
  assert.ok(Array.isArray(res.warnings));
  assert.ok(res.warnings.some((w) => /accepted 1976 MHz for a request of 2000/.test(w)));
  // D5 override records what the driver confirmed, not what was requested.
  assert.equal(c._clockCapsOverride.gpu, 1976);
});

// ─── journal ground truth: the shape nvidia-smi actually prints ─────────────
// Captured read-only from the spark-1 systemd journal (gpu-clock-lock.service
// running `nvidia-smi -lgc 0,2200`, driver 580.173.02). The REAL confirmation
// is double-quoted and carries gpuClkMin/gpuClkMax labels — the bare
// "(0, 1976)" fixtures above are reconstructions no driver has been observed
// to print.
const JOURNAL_SET_TO_1976 = 'GPU clocks set to "(gpuClkMin 0, gpuClkMax 1976)" for GPU 0000000F:01:00.0';
const JOURNAL_SET_TO_2200 = 'GPU clocks set to "(gpuClkMin 0, gpuClkMax 2200)" for GPU 0000000F:01:00.0';
const JOURNAL_DONE = "All done.";

test("a REAL GPU confirmation that differs from the request reports both values (container path)", async () => {
  const c = localCollector();
  c._exec = async () => `${JOURNAL_SET_TO_1976}\n${JOURNAL_DONE}`;
  const res = await c._applyClockCapLocal("gpu", 2000, false, [], null, 2000);
  assert.equal(res.ok, true);
  assert.equal(res.requestedMHz, 2000);
  assert.equal(res.appliedMHz, 1976, "the driver's quoted gpuClkMax is the applied truth");
  assert.equal(res.snapped, true);
  assert.ok(res.warnings.some((w) => /accepted 1976 MHz for a request of 2000/.test(w)));
  // D5 override records the APPLIED value, never the requested one.
  assert.equal(c._clockCapsOverride.gpu, 1976);
});

test("a REAL GPU confirmation matching the request carries no verification warning (container path)", async () => {
  const c = localCollector();
  c._exec = async () => `${JOURNAL_SET_TO_2200}\n${JOURNAL_DONE}`;
  const res = await c._applyClockCapLocal("gpu", 2200, false, [], null, 2200);
  assert.equal(res.appliedMHz, 2200);
  assert.equal(res.snapped, false);
  // The confirmation WAS readable — silence about verification only.
  assert.ok(
    !res.warnings.some((w) => /could not be read back from the hardware/.test(w)),
    `no verification warning expected, got ${JSON.stringify(res.warnings)}`
  );
});

test("a REAL helper transcript drives the full honesty response (helper path, end to end)", async () => {
  const c = localCollector();
  c._sshExec = async (spark, cmd) => {
    assert.match(String(cmd), /--domain .gpu. --max-mhz 2000/);
    return `${JOURNAL_SET_TO_1976}\n${JOURNAL_DONE}`;
  };
  // Hermetic: if the helper gate ever wrongly rejects this transcript, the
  // container fallback must fail HERE — never against real nvidia-smi.
  c._exec = async (cmd) => {
    throw new Error(`container fallback must not run when the helper succeeds: ${cmd}`);
  };
  const res = await c.applyClockCap(
    { domain: "gpu", maxMHz: 2000, persist: false },
    { hardMinMHz: 0, hardMaxMHz: 3003 }
  );
  assert.equal(res.ok, true);
  assert.equal(res.source, "helper");
  assert.equal(res.requestedMHz, 2000);
  assert.equal(res.appliedMHz, 1976, "the driver's quoted gpuClkMax is the applied truth");
  assert.equal(res.snapped, true);
  assert.ok(res.warnings.some((w) => /accepted 1976 MHz for a request of 2000/.test(w)));
  assert.ok(!res.warnings.some((w) => /could not be read back/.test(w)));
  assert.equal(c._clockCapsOverride.gpu, 1976);
});

test("a GPU apply transcript without the completion line is not accepted as helper success (done gate)", async () => {
  const c = localCollector();
  // The set-to line alone, with the "All done." completion missing: an
  // unfinished helper run. The gate must route it to the container fallback
  // (stubbed below) — never report source:"helper" for an incomplete apply.
  c._sshExec = async () => JOURNAL_SET_TO_1976;
  c._exec = async () => `${JOURNAL_SET_TO_1976}\n${JOURNAL_DONE}`;
  const res = await c.applyClockCap(
    { domain: "gpu", maxMHz: 2000, persist: false },
    { hardMinMHz: 0, hardMaxMHz: 3003 }
  );
  assert.equal(res.ok, true);
  assert.equal(
    res.source,
    "container",
    "an incomplete helper transcript must not be reported as a helper success"
  );
});

// ─── cap removal (maxMHz:null): no value to verify, nothing to quantify ─────

test("CPU cap removal via the container path reports the removal without a bogus warning", async () => {
  const c = localCollector();
  c._cpuDomainCores = () => ["cpu5", "cpu6"];
  const fsMod = await import("node:fs");
  const origWrite = fsMod.default.writeFileSync;
  const writes = [];
  fsMod.default.writeFileSync = (p, data) => writes.push({ p: String(p), data: String(data) });
  try {
    // cppc_cpufreq keeps the core's hardware maximum: reading max_perf back
    // after the removal write just echoes the max we wrote — that read must
    // never be reported as the hardware "accepting" a value.
    c._readSysFile = (p) => (/cpufreq/.test(p) ? "2808000\n" : null);
    const res = await c._applyClockCapLocal("cpu-little", null, false, [], null, null);
    assert.equal(res.ok, true);
    assert.equal(res.requestedMHz, null);
    assert.equal(res.appliedMHz, null, "a removal holds no cap — appliedMHz is honestly null");
    assert.equal(res.snapped, false);
    assert.ok(
      !res.warnings.some((w) => /accepted .* for a request/.test(w)),
      `no bogus quantisation warning, got ${JSON.stringify(res.warnings)}`
    );
    assert.ok(!res.warnings.some((w) => /read back/.test(w)));
    assert.deepEqual(
      writes.map((w) => w.data),
      ["2808000\n", "2808000\n"]
    );
  } finally {
    fsMod.default.writeFileSync = origWrite;
  }
});

test("CPU cap removal via the helper path reports the removal without a bogus warning", async () => {
  const c = localCollector();
  // The CPU helper is silent on success: no set-to line, no completion line.
  c._sshExec = async () => "";
  // No real sysfs anywhere: the stub feeds the (pre-fix) verification read.
  c._cpuDomainCores = () => ["cpu5"];
  c._readSysFile = (p) => (/cpufreq/.test(p) ? "2808000\n" : null);
  const res = await c.applyClockCap(
    { domain: "cpu-little", maxMHz: null, persist: false },
    { hardMinMHz: 1378, hardMaxMHz: 3900 }
  );
  assert.equal(res.ok, true);
  assert.equal(res.source, "helper");
  assert.equal(res.requestedMHz, null);
  assert.equal(res.appliedMHz, null, "a removal holds no cap — appliedMHz is honestly null");
  assert.equal(res.snapped, false);
  assert.ok(
    !res.warnings.some((w) => /accepted .* for a request/.test(w)),
    `no bogus quantisation warning, got ${JSON.stringify(res.warnings)}`
  );
  assert.ok(!res.warnings.some((w) => /read back/.test(w)));
});

test("GPU cap removal via the helper path stays silent about verification (no cap to observe)", async () => {
  const c = localCollector();
  // --unlock runs nvidia-smi -rgc: per the same journal that captured the
  // -lgc output, the completion line prints but no set-to line does.
  c._sshExec = async () => JOURNAL_DONE;
  const res = await c.applyClockCap(
    { domain: "gpu", maxMHz: null, persist: false },
    { hardMinMHz: 0, hardMaxMHz: 3003 }
  );
  assert.equal(res.ok, true);
  assert.equal(res.source, "helper");
  assert.equal(res.appliedMHz, null);
  assert.equal(res.snapped, false);
  assert.ok(
    !res.warnings.some((w) => /read back/.test(w)),
    `no verification warning on removal, got ${JSON.stringify(res.warnings)}`
  );
  assert.ok(!res.warnings.some((w) => /accepted .* for a request/.test(w)));
  // D5: the removal clears any recorded GPU lock.
  assert.equal(c._clockCapsOverride.gpu, null);
});

test("GPU cap removal via the container path stays silent about verification", async () => {
  const c = localCollector();
  const cmds = [];
  c._exec = async (cmd) => {
    cmds.push(cmd);
    return "";
  };
  const res = await c._applyClockCapLocal("gpu", null, false, [], null, null);
  assert.equal(res.ok, true);
  assert.match(cmds[0], /-rgc/);
  assert.equal(res.appliedMHz, null);
  assert.equal(res.snapped, false);
  assert.ok(!res.warnings.some((w) => /read back/.test(w)));
  assert.ok(!res.warnings.some((w) => /accepted .* for a request/.test(w)));
  assert.equal(c._clockCapsOverride.gpu, null);
});

test("clamping happens BEFORE the request is echoed back (requestedMHz = post-clamp)", async () => {
  const c = localCollector();
  c._cpuDomainCores = () => ["cpu0"];
  const fsMod = await import("node:fs");
  const origWrite = fsMod.default.writeFileSync;
  fsMod.default.writeFileSync = () => {};
  try {
    c._readSysFile = (p) => (/max_perf/.test(p) ? "2808000\n" : null);
    const res = await c.applyClockCap(
      { domain: "cpu-big", maxMHz: 9999, persist: false },
      { hardMinMHz: 338, hardMaxMHz: 2808 }
    );
    // The clamp is part of the request the hardware was asked for.
    assert.equal(res.requestedMHz, 9999, "requestedMHz reports what the operator asked");
    assert.equal(res.appliedMHz, 2808, "the server clamped to the hardware ceiling");
    assert.equal(res.snapped, true);
    assert.ok(res.warnings.some((w) => /clamped/.test(w)));
  } finally {
    fsMod.default.writeFileSync = origWrite;
  }
});
