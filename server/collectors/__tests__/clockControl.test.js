import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  CLOCK_DOMAIN_IDS,
  HELPER_PROBE_MISSING,
  HELPER_PROBE_OK,
  HELPER_PROBE_REFUSED,
  HELPER_REFUSED_SENTINEL,
  clampClockCap,
  buildClockCapDomains,
  buildClockHelperArgv,
  buildHelperProbeCommand,
  expandCpuToken,
  interpretHelperExit,
  interpretHelperProbe,
  parseCpuClockBounds,
  parseCpuCoreMaxKhz,
  parseCpuBootUnitDefaults,
  parseDefaultApplicationsGraphicsClock,
  validateClockCapRequest,
} from "../clockControl.js";

// ─── Fixtures: measured spark-1 values (trusting the orchestrator's probes) ──

/** Real sysfs dump shape: cpuN:min_freq:max_freq (cppc_cpufreq, 2 domains). */
const CPU_DUMP_BOUNDS = [
  "cpu0:338000:2808000",
  "cpu1:338000:2808000",
  "cpu2:338000:2808000",
  "cpu3:338000:2808000",
  "cpu4:338000:2808000",
  "cpu5:1378000:3900000",
  "cpu6:1378000:3900000",
  "cpu9:1378000:3900000",
  "cpu10:338000:2808000",
  "cpu15:1378000:3900000",
  "cpu19:1378000:3900000",
].join("\n");

/** Real `nvidia-smi -q -d CLOCK` transcript shape (GB10, driver 580.x). */
const SMI_Q_CLOCK = [
  "==============NVML Errors===============",
  "",
  "==============Device Keys===============",
  "",
  "==============Clocks==============",
  "",
  "    Clocks Event Reasons",
  "        HW Thermal Slowdown            : Not Active",
  "",
  "    Max Clocks",
  "        Graphics                       : 3003 MHz",
  "        SM                             : 3003 MHz",
  "",
  "    Default Applications Clock",
  "        Graphics                       : 3003 MHz",
  "",
  "    SM Clock",
  "        Graphics                       : 1500 MHz",
  "",
].join("\n");

test("parseCpuClockBounds groups cores into two hardware domains", () => {
  const bounds = parseCpuClockBounds(CPU_DUMP_BOUNDS);
  assert.equal(bounds.length, 2);
  // Sorted max desc: little domain (3900) first, then big (2808).
  assert.deepEqual(bounds[0], { minKhz: 1378000, maxKhz: 3900000 });
  assert.deepEqual(bounds[1], { minKhz: 338000, maxKhz: 2808000 });
});

test("parseCpuClockBounds keeps the strictest (largest) min floor per domain", () => {
  const bounds = parseCpuClockBounds("cpu0:338000:2808000\ncpu1:400000:2808000");
  assert.equal(bounds.length, 1);
  assert.equal(bounds[0].minKhz, 400000);
});

test("parseCpuClockBounds ignores malformed lines and empty input", () => {
  assert.deepEqual(parseCpuClockBounds("garbage\ncpu0:abc:3900000\n\n"), []);
  assert.deepEqual(parseCpuClockBounds(""), []);
  assert.deepEqual(parseCpuClockBounds(null), []);
});

test("parseDefaultApplicationsGraphicsClock reads the Graphics value from the Default Applications Clock block", () => {
  assert.equal(parseDefaultApplicationsGraphicsClock(SMI_Q_CLOCK), 3003);
});

test("parseDefaultApplicationsGraphicsClock is anchored to the Default Applications Clock block", () => {
  // "Max Clocks / Graphics 9999" must not win over the Default block.
  const t = [
    "    Max Clocks",
    "        Graphics                       : 9999 MHz",
    "",
    "    Default Applications Clock",
    "        Graphics                       : 3003 MHz",
  ].join("\n");
  assert.equal(parseDefaultApplicationsGraphicsClock(t), 3003);
});

test("parseDefaultApplicationsGraphicsClock returns null on missing/garbage transcript", () => {
  assert.equal(parseDefaultApplicationsGraphicsClock(""), null);
  assert.equal(parseDefaultApplicationsGraphicsClock("no clocks here"), null);
  assert.equal(parseDefaultApplicationsGraphicsClock(null), null);
  // [N/A] platform case (query-supported-clocks returns N/A; -q parse fails too)
  assert.equal(parseDefaultApplicationsGraphicsClock("Default Applications Clock\n        Graphics : N/A"), null);
});

// ─── Clamping (D2) ────────────────────────────────────────

test("clampClockCap clamps above the hardware max and records a warning", () => {
  const warnings = [];
  const out = clampClockCap(4200, 1378, 3900, { warnings });
  assert.equal(out, 3900);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /above the hardware maximum/);
});

test("clampClockCap clamps below the hardware min and records a warning", () => {
  const warnings = [];
  const out = clampClockCap(100, 1378, 3900, { warnings });
  assert.equal(out, 1378);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /below the hardware minimum/);
});

test("clampClockCap passes null (remove cap) and in-range values through", () => {
  assert.equal(clampClockCap(null, 0, 3003), null);
  assert.equal(clampClockCap(2200, 0, 3003), 2200);
});

// ─── Request validation (D1/D2) ───────────────────────────

const DOMAINS = [
  { id: "cpu-big", hardMinMHz: 338, hardMaxMHz: 2808 },
  { id: "cpu-little", hardMinMHz: 1378, hardMaxMHz: 3900 },
  { id: "gpu", hardMinMHz: 0, hardMaxMHz: 3003 },
];

test("validateClockCapRequest accepts an in-range integer and normalizes persist", () => {
  const out = validateClockCapRequest({ domain: "gpu", maxMHz: 2200 }, DOMAINS);
  assert.deepEqual(out.value, { domain: "gpu", maxMHz: 2200, persist: false });
  const out2 = validateClockCapRequest({ domain: "gpu", maxMHz: 2200, persist: true }, DOMAINS);
  assert.equal(out2.value.persist, true);
});

test("validateClockCapRequest accepts maxMHz null as remove-the-cap", () => {
  const out = validateClockCapRequest({ domain: "cpu-big", maxMHz: null }, DOMAINS);
  assert.deepEqual(out.value, { domain: "cpu-big", maxMHz: null, persist: false });
});

test("validateClockCapRequest rejects out-of-range, float, string, and NaN maxMHz", () => {
  assert.equal(validateClockCapRequest({ domain: "gpu", maxMHz: 3500 }, DOMAINS).ok, false);
  assert.equal(validateClockCapRequest({ domain: "gpu", maxMHz: -1 }, DOMAINS).ok, false);
  assert.equal(validateClockCapRequest({ domain: "gpu", maxMHz: 2200.5 }, DOMAINS).ok, false);
  assert.equal(validateClockCapRequest({ domain: "gpu", maxMHz: "2200" }, DOMAINS).ok, false);
  assert.equal(validateClockCapRequest({ domain: "gpu", maxMHz: Number.NaN }, DOMAINS).ok, false);
});

test("validateClockCapRequest rejects unknown domains and non-boolean persist", () => {
  assert.equal(validateClockCapRequest({ domain: "mem", maxMHz: 100 }, DOMAINS).ok, false);
  assert.equal(validateClockCapRequest({ domain: 7, maxMHz: 100 }, DOMAINS).ok, false);
  assert.equal(validateClockCapRequest({ domain: "gpu", maxMHz: 100, persist: "yes" }, DOMAINS).ok, false);
  // Valid enum id but not exposed on this unit (no cpu-little present):
  const onlyBig = [{ id: "cpu-big", hardMinMHz: 338, hardMaxMHz: 2808 }];
  assert.equal(validateClockCapRequest({ domain: "cpu-little", maxMHz: 2000 }, onlyBig).ok, false);
});

test("validateClockCapRequest tolerates a missing/undefined body", () => {
  assert.equal(validateClockCapRequest(undefined, DOMAINS).ok, false);
  assert.equal(validateClockCapRequest(null, DOMAINS).ok, false);
});

// ─── Helper argv (D4) ─────────────────────────────────────
//
// The shipped sudoers grant is ONE argumentless command
// (`NOPASSWD: /usr/local/bin/sparkdash-set-clock`), so the chain must never
// gate on `sudo -n true` — no scoped sudoers file permits it.

test("buildClockHelperArgv probes the granted binary argumentlessly with distinct 127/126 exits", () => {
  const cmd = buildClockHelperArgv({ domain: "gpu", maxMHz: 2200, persist: true });
  assert.match(cmd, /^test -x \/usr\/local\/bin\/sparkdash-set-clock \|\| \{ echo "missing/);
  assert.match(cmd, /exit 127; \}/);
  // Availability probe = the granted command itself, argumentless; a sudo
  // refusal (no usage line, nonzero rc) hits the sentinel + exit 126.
  assert.match(cmd, /out=\$\(sudo -n \/usr\/local\/bin\/sparkdash-set-clock 2>&1\); rc=\$\?/);
  assert.doesNotMatch(cmd, /sudo -n true/);
  assert.match(cmd, new RegExp(`echo "${HELPER_REFUSED_SENTINEL}: sudo -n refused`));
  assert.match(cmd, /exit 126; fi/);
  assert.match(cmd, /sudo -n \/usr\/local\/bin\/sparkdash-set-clock --domain 'gpu' --max-mhz 2200 --persist$/);
});

test("buildClockHelperArgv uses --unlock and --no-persist for a remove-cap request", () => {
  const cmd = buildClockHelperArgv({ domain: "cpu-big", maxMHz: null, persist: false });
  assert.match(cmd, /--domain 'cpu-big' --unlock --no-persist$/);
});

test("buildClockHelperArgv single-quotes the domain", () => {
  const cmd = buildClockHelperArgv({ domain: "cpu-big", maxMHz: 2808, persist: true });
  assert.match(cmd, /--domain 'cpu-big'/);
});

// ─── Availability probe (exercises exactly the scoped grant) ────────────────

/** Usage-printing stub with the real helper's argv semantics (lines 27-30). */
function makeFakeHelper(dir) {
  const p = path.join(dir, "sparkdash-set-clock");
  fs.writeFileSync(
    p,
    "#!/bin/sh\necho 'usage: sparkdash-set-clock --domain cpu-big|cpu-little|gpu (--max-mhz <int>|--unlock) (--persist|--no-persist)' >&2\nexit 1\n"
  );
  fs.chmodSync(p, 0o755);
  return p;
}

/** sudo stub enforcing the SCOPED grant: only `-n <bin>` with no args. */
function makeScopedSudo(dir, allowedBin, { alwaysRefuse = false } = {}) {
  const p = path.join(dir, "sudo");
  const body = alwaysRefuse
    ? `#!/bin/sh\necho "sudo: a password is required" >&2\nexit 1\n`
    : `#!/bin/sh
[ "\$1" = "-n" ] || { echo "sudo: a password is required" >&2; exit 1; }
[ "\$#" -eq 2 ] && [ "\$2" = "${allowedBin}" ] || { echo "sudo: a password is required" >&2; exit 1; }
exec "\$2"
`;
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
  return p;
}

function runProbe(probeCmd, dir) {
  return execFileSync("sh", ["-c", probeCmd], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
}

test("probe reports available under ONLY the scoped grant (no unrestricted NOPASSWD true)", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-probe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const helper = makeFakeHelper(dir);
  makeScopedSudo(dir, helper); // refuses everything except the argumentless helper
  const probeCmd = buildHelperProbeCommand({ helperBin: helper });
  assert.ok(!probeCmd.includes("sudo -n true"), "the probe must not depend on `sudo -n true`");
  assert.equal(runProbe(probeCmd, dir).trim(), HELPER_PROBE_OK);
  assert.deepEqual(interpretHelperProbe(HELPER_PROBE_OK), {
    available: true,
    checked: true,
  });
});

test("probe reports the provisioning hint when sudo refuses the granted command", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-probe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const helper = makeFakeHelper(dir);
  makeScopedSudo(dir, helper, { alwaysRefuse: true });
  const out = runProbe(buildHelperProbeCommand({ helperBin: helper }), dir).trim();
  assert.equal(out, HELPER_PROBE_REFUSED);
  const state = interpretHelperProbe(out);
  assert.equal(state.available, false);
  assert.match(state.reason, /passwordless sudo/);
  // ...and the apply-path classifier maps the refusal sentinel to the SAME cause.
  const interpreted = interpretHelperExit(
    new Error(`SSH to 1.2.3.4 failed: ${HELPER_REFUSED_SENTINEL}: sudo -n refused\nexit 126`)
  );
  assert.equal(interpreted.status, 423);
  assert.match(interpreted.reason, /passwordless sudo/);
});

test("probe reports not-installed when the binary is absent", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-probe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  makeScopedSudo(dir, path.join(dir, "nope")); // sudo present, helper missing
  const out = runProbe(buildHelperProbeCommand({ helperBin: path.join(dir, "nope") }), dir).trim();
  assert.equal(out, HELPER_PROBE_MISSING);
  const state = interpretHelperProbe(out);
  assert.equal(state.available, false);
  assert.match(state.reason, /not installed/);
});

// ─── Exit-code interpretation (D4) ────────────────────────

test("interpretHelperExit maps the missing-binary sentinel to 423 with an install hint", () => {
  const out = interpretHelperExit(
    new Error("SSH to 1.2.3.4 failed: missing /usr/local/bin/sparkdash-set-clock\nexit 127")
  );
  assert.equal(out.status, 423);
  assert.match(out.reason, /install-clock-helper\.sh/);
});

test("interpretHelperExit anchors on sentinels, never on bare numbers in the message", () => {
  // A helper failure that merely MENTIONS 126/127 (a device id, a frequency)
  // must NOT be mislabelled as not-installed / not-provisioned.
  const noisy = new Error(
    "SSH to 1.2.3.4 failed: nvidia-smi: GPU 127 at 126 MHz failed; exited with code 1"
  );
  const out = interpretHelperExit(noisy);
  assert.equal(out.status, 502);
  assert.doesNotMatch(out.reason, /not installed|passwordless sudo/);
  // An external exit 126 with no sentinel is a generic 502, not a sudo claim.
  assert.equal(interpretHelperExit(new Error("cmd exited with code 126")).status, 502);
});

test("interpretHelperExit maps transport timeouts to 503 and anything else to 502", () => {
  assert.equal(interpretHelperExit(new Error("SSH timed out after 12000ms")).status, 503);
  assert.equal(interpretHelperExit(new Error("nvidia-smi refused")).status, 502);
  assert.equal(interpretHelperExit(new Error("connection refused")).status, 503);
});

// ─── Client-facing domain shape (D1/D7) ───────────────────

test("buildClockCapDomains exposes CPU bounds, GPU ceiling, presets, and writability", () => {
  const domains = buildClockCapDomains({
    cpuDomains: [
      { label: "X925", capMHz: 2600, maxMHz: 3900, capped: true },
      { label: "A725", capMHz: 2808, maxMHz: 2808, capped: false },
    ],
    gpuLock: { minMHz: 0, maxMHz: 2200 },
    cpuBounds: parseCpuClockBounds(CPU_DUMP_BOUNDS),
    gpuCeilingMHz: 3003,
    helperAvailable: true,
    helperChecked: true,
  });
  assert.deepEqual(
    domains.map((d) => d.id),
    // Existing convention (parseCpuClockCaps): the 3900 MHz group sorts first
    // and is the "big" id; 2808 is the second domain.
    ["cpu-big", "cpu-little", "gpu"]
  );
  const little = domains.find((d) => d.id === "cpu-little");
  assert.equal(little.currentMHz, 2808); // uncapped: cap == hardware max
  assert.equal(little.hardMinMHz, 338);
  assert.equal(little.hardMaxMHz, 2808);
  assert.deepEqual(little.presets, [{ label: "No cap", value: 2808 }]);
  assert.equal(little.unitPath, "/etc/systemd/system/cpu-clock-cap.service");
  assert.equal(little.writable, true);
  const big = domains.find((d) => d.id === "cpu-big");
  assert.equal(big.currentMHz, 2600); // capped below the 3900 hardware max
  assert.equal(big.hardMinMHz, 1378);
  assert.equal(big.hardMaxMHz, 3900);
  assert.equal(big.capped, undefined); // server shape, not the read shape
  const gpu = domains.find((d) => d.id === "gpu");
  assert.equal(gpu.currentMHz, 2200);
  assert.equal(gpu.hardMinMHz, 0);
  assert.equal(gpu.hardMaxMHz, 3003);
  assert.equal(gpu.unitPath, "/etc/systemd/system/gpu-clock-lock.service");
});

test("buildClockCapDomains reports unwritable with a reason when the helper is missing", () => {
  const domains = buildClockCapDomains({
    cpuDomains: null,
    gpuLock: null,
    cpuBounds: parseCpuClockBounds(CPU_DUMP_BOUNDS),
    gpuCeilingMHz: 3003,
    helperAvailable: false,
    helperChecked: true,
  });
  for (const d of domains) {
    assert.equal(d.writable, false);
    assert.match(d.reason, /helper not installed/);
  }
});

// ─── D7: boot-default presets, parsed from the real boot units ─────────────

test("expandCpuToken expands systemd brace ranges and passes single cores", () => {
  assert.deepEqual(expandCpuToken("cpu5"), ["cpu5"]);
  assert.deepEqual(expandCpuToken("cpu{5..9,15..19}"), [
    "cpu5",
    "cpu6",
    "cpu7",
    "cpu8",
    "cpu9",
    "cpu15",
    "cpu16",
    "cpu17",
    "cpu18",
    "cpu19",
  ]);
  assert.deepEqual(expandCpuToken("cpu{0..4,10..14}").length, 10);
  assert.deepEqual(expandCpuToken("garbage"), []);
  assert.deepEqual(expandCpuToken("cpu{20..5}"), []); // inverted range
  assert.deepEqual(expandCpuToken("cpu{0..99999}"), []); // absurd range rejected
});

test("parseCpuBootUnitDefaults maps the measured boot unit onto the discovered domains", () => {
  // The unit actually installed on spark-1 (brace ranges, kHz values).
  const unit = [
    "ExecStart=/bin/sh -c ' echo 2600000 > /sys/devices/system/cpu/cpu{5..9,15..19}/cpufreq/max_perf; echo 2808000 > /sys/devices/system/cpu/cpu{0..4,10..14}/cpufreq/max_perf'",
  ].join("\n");
  const defaults = parseCpuBootUnitDefaults(unit, parseCpuCoreMaxKhz(CPU_DUMP_BOUNDS));
  // Domain ids follow the existing convention (≥3 MHz group = cpu-big): the
  // 3900000 kHz cores (cpu5+) are cpu-big, the 2808000 kHz cores cpu-little.
  assert.equal(defaults["cpu-big"], 2600);
  assert.equal(defaults["cpu-little"], 2808);
});

test("parseCpuBootUnitDefaults also handles explicit per-core echoes and skips unknown cores", () => {
  const unit = [
    "ExecStart=/bin/sh -c 'echo 2600000 > /sys/devices/system/cpu/cpu5/cpufreq/max_perf; echo 2808000 > /sys/devices/system/cpu/cpu0/cpufreq/max_perf; echo 9999000 > /sys/devices/system/cpu/cpu42/cpufreq/max_perf'",
  ].join("\n");
  const defaults = parseCpuBootUnitDefaults(unit, parseCpuCoreMaxKhz(CPU_DUMP_BOUNDS));
  // cpu42 is not in the discovered map → skipped, not guessed.
  assert.deepEqual(defaults, { "cpu-big": 2600, "cpu-little": 2808 });
});

test("buildClockCapDomains exposes Boot default presets from the parsed units", () => {
  const domains = buildClockCapDomains({
    cpuDomains: [
      { label: "X925", capMHz: 2808, maxMHz: 3900, capped: true },
      { label: "A725", capMHz: 2600, maxMHz: 2808, capped: true },
    ],
    gpuLock: { minMHz: 0, maxMHz: 2200 },
    cpuBounds: parseCpuClockBounds(CPU_DUMP_BOUNDS),
    gpuCeilingMHz: 3003,
    helperAvailable: true,
    helperChecked: true,
    cpuBootDefaults: { "cpu-big": 2808, "cpu-little": 2600 },
    gpuBootDefaultMHz: 2200,
  });
  const big = domains.find((d) => d.id === "cpu-big");
  assert.deepEqual(big.presets, [
    { label: "Boot default", value: 2808 },
    { label: "No cap", value: 3900 },
  ]);
  const little = domains.find((d) => d.id === "cpu-little");
  assert.deepEqual(little.presets, [
    { label: "Boot default", value: 2600 },
    { label: "No cap", value: 2808 },
  ]);
  const gpu = domains.find((d) => d.id === "gpu");
  assert.deepEqual(gpu.presets, [
    { label: "Boot default", value: 2200 },
    { label: "No cap", value: null },
  ]);
});
