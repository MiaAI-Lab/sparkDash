// Helper-behaviour tests for scripts/sparkdash-set-clock (Gate 3).
//
// The helper is exercised with a stubbed sysfs tree under a temp dir (via the
// SPARKDASH_CPU_SYS / SPARKDASH_UNIT_DIR test hooks; sudo's env reset means a
// real remote invocation always uses the real /sys and /etc). The script file
// is executed with `sh` — POSIX syntax only. Nothing here touches the real
// /sys, /etc, or /usr/local.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const HELPER = path.join(ROOT, "scripts", "sparkdash-set-clock");

/** Build a stub sysfs tree: cores → {maxKhz (cpuinfo_max_freq), perf (max_perf)}. */
function makeSysfs(root, cores) {
  const cpuRoot = path.join(root, "sys");
  for (const [cpuN, { maxKhz, perfKhz }] of Object.entries(cores)) {
    const dir = path.join(cpuRoot, cpuN, "cpufreq");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "cpuinfo_max_freq"), `${maxKhz}\n`);
    if (perfKhz != null) fs.writeFileSync(path.join(dir, "max_perf"), `${perfKhz}\n`);
  }
  return cpuRoot;
}

/**
 * Run the helper against a stubbed tree.
 * @param {string} cpuRoot stubbed sysfs cpu root
 * @param {string[]} args helper argv after the program name
 * @param {{ unitDir?: string }} [opts]
 * @returns {{ stdout: string }} throws on nonzero exit (execFileSync default)
 */
function runHelper(cpuRoot, args, opts = {}) {
  const unitDir = opts.unitDir ?? path.join(cpuRoot, "..", "units");
  // Stub systemctl (the helper ends a persist with `daemon-reload`) and
  // nvidia-smi (the GPU persist writes the unit before `gpu_apply` runs it);
  // both stubs ride on PATH like the scoped-sudo fixtures in
  // clockControl.test.js.
  const stubDir = path.join(path.dirname(cpuRoot), "stub-bin");
  fs.mkdirSync(stubDir, { recursive: true });
  for (const [name, body] of [
    ["systemctl", "#!/bin/sh\nexit 0\n"],
    ["nvidia-smi", "#!/bin/sh\nexit 0\n"],
  ]) {
    const p = path.join(stubDir, name);
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, body);
      fs.chmodSync(p, 0o755);
    }
  }
  const smiPath = path.join(stubDir, "nvidia-smi");
  const stdout = execFileSync("sh", [HELPER, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      SPARKDASH_CPU_SYS: cpuRoot,
      SPARKDASH_UNIT_DIR: unitDir,
      SPARKDASH_SMI: smiPath,
    },
  });
  return { stdout, smiPath, unitDir };
}

// ─── The sibling must survive a single-domain persist ───────────────────────
// Domain convention (inherited from parseCpuClockCaps, accepted in review):
// cores with cpuinfo_max_freq >= 3 MHz are "cpu-big" (the X925 group, whose
// curated boot cap is 2600000 kHz on spark-1); the 2808000 group is
// "cpu-little".

test("a cpu-little persist preserves the sibling big domain's max_perf lines", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-helper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cpuRoot = makeSysfs(dir, {
    cpu0: { maxKhz: 3900000, perfKhz: 2600000 }, // cpu-big, curated cap
    cpu1: { maxKhz: 3900000, perfKhz: 2600000 },
    cpu5: { maxKhz: 2808000, perfKhz: 2808000 }, // cpu-little, at own max
    cpu6: { maxKhz: 2808000, perfKhz: 2808000 },
  });
  const unitDir = path.join(dir, "units");
  fs.mkdirSync(unitDir);

  runHelper(cpuRoot, ["--domain", "cpu-little", "--max-mhz", "2400", "--persist"]);

  const unit = fs.readFileSync(path.join(unitDir, "cpu-clock-cap.service"), "utf8");
  // Edited domain carries the requested value…
  assert.match(unit, /echo 2400000 > \S*cpu5\/cpufreq\/max_perf/);
  assert.match(unit, /echo 2400000 > \S*cpu6\/cpufreq\/max_perf/);
  // …and the sibling's current live cap is NOT deleted.
  assert.match(unit, /echo 2600000 > \S*cpu0\/cpufreq\/max_perf/);
  assert.match(unit, /echo 2600000 > \S*cpu1\/cpufreq\/max_perf/);
});

test("a persist with unreadable sibling max_perf omits those cores (no guesses)", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-helper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cpuRoot = makeSysfs(dir, {
    cpu0: { maxKhz: 3900000, perfKhz: null }, // cpu-big sibling: unreadable
    cpu5: { maxKhz: 2808000, perfKhz: 2808000 },
  });
  const unitDir = path.join(dir, "units");
  fs.mkdirSync(unitDir);

  runHelper(cpuRoot, ["--domain", "cpu-little", "--max-mhz", "2600", "--persist"]);

  const unit = fs.readFileSync(path.join(unitDir, "cpu-clock-cap.service"), "utf8");
  assert.match(unit, /echo 2600000 > \S*cpu5\/cpufreq\/max_perf/);
  assert.doesNotMatch(unit, /cpu0\/cpufreq\/max_perf/);
});

test("a remove-cap (unlock) persist keeps the sibling and restores own hardware max", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-helper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cpuRoot = makeSysfs(dir, {
    cpu0: { maxKhz: 3900000, perfKhz: 2600000 }, // cpu-big, capped
    cpu5: { maxKhz: 2808000, perfKhz: 2200000 }, // cpu-little, capped
  });
  const unitDir = path.join(dir, "units");
  fs.mkdirSync(unitDir);

  runHelper(cpuRoot, ["--domain", "cpu-little", "--unlock", "--persist"]);

  const unit = fs.readFileSync(path.join(unitDir, "cpu-clock-cap.service"), "utf8");
  assert.match(unit, /cat \S*cpu5\/cpufreq\/cpuinfo_max_freq > \S*cpu5\/cpufreq\/max_perf/);
  assert.match(unit, /echo 2600000 > \S*cpu0\/cpufreq\/max_perf/);
});

test("the helper and the container persist path emit the same CPU ExecStart for one request", (t) => {
  // Stub topology mirrors the SystemCollector persist fixtures (LIVE_DOMAINS):
  // cpu-big = the 3900000 group capped at 2600000; cpu-little = 2808000 group.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-helper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cpuRoot = makeSysfs(dir, {
    cpu0: { maxKhz: 3900000, perfKhz: 2600000 },
    cpu1: { maxKhz: 3900000, perfKhz: 2600000 },
    cpu10: { maxKhz: 3900000, perfKhz: 2600000 },
    cpu5: { maxKhz: 2808000, perfKhz: 2808000 },
    cpu6: { maxKhz: 2808000, perfKhz: 2808000 },
  });
  const unitDir = path.join(dir, "units");
  fs.mkdirSync(unitDir);

  // 1. Helper path: persist cpu-little 2808 while the sibling sits at 2600.
  runHelper(cpuRoot, ["--domain", "cpu-little", "--max-mhz", "2808", "--persist"]);
  const helperUnit = fs.readFileSync(path.join(unitDir, "cpu-clock-cap.service"), "utf8");
  const helperExec = helperUnit.match(/^ExecStart=(.+)$/m)[1];

  // 2. Container path: identical request, sibling values from live max_perf.
  //    Mirror the collector's own command construction (the captured payload's
  //    ExecStart) instead of stubbing node:fs module-wide. Cores in numeric
  //    order per domain, as _cpuDomainCores returns them. The sysfs root is
  //    substituted with the stub root: on a real host CPU_SYS defaults to
  //    /sys/devices/system/cpu (exactly what the container path writes), the
  //    test hook redirects only the root, so equality here means the command
  //    SHAPE — and the full unit byte-for-byte — is identical.
  const parts = [
    `echo 2808000 > ${cpuRoot}/cpu5/cpufreq/max_perf`,
    `echo 2808000 > ${cpuRoot}/cpu6/cpufreq/max_perf`,
    `echo 2600000 > ${cpuRoot}/cpu0/cpufreq/max_perf`,
    `echo 2600000 > ${cpuRoot}/cpu1/cpufreq/max_perf`,
    `echo 2600000 > ${cpuRoot}/cpu10/cpufreq/max_perf`,
  ];
  const containerExec = `/bin/sh -c '${parts.join("; ")}'`;
  assert.equal(helperExec, containerExec);

  // 3. And the FULL unit bodies are byte-identical (what the collector writes
  //    via its heredoc vs what the helper writes via its own heredoc).
  const containerUnit = [
    "[Unit]",
    "Description=sparkDash CPU clock cap (big + little domains)",
    "After=multi-user.target",
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=${containerExec}`,
    "RemainAfterExit=yes",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
  ].join("\n");
  assert.equal(helperUnit.trimEnd(), containerUnit);
});

test("cpu_apply writes max_perf for the edited domain only and returns success", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-helper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cpuRoot = makeSysfs(dir, {
    cpu0: { maxKhz: 3900000, perfKhz: 2600000 }, // cpu-big (edited)
    cpu5: { maxKhz: 2808000, perfKhz: 2808000 }, // cpu-little (sibling)
  });

  runHelper(cpuRoot, ["--domain", "cpu-big", "--max-mhz", "2400", "--no-persist"]);

  assert.equal(fs.readFileSync(path.join(cpuRoot, "cpu0", "cpufreq", "max_perf"), "utf8").trim(), "2400000");
  // Sibling untouched by the live apply.
  assert.equal(fs.readFileSync(path.join(cpuRoot, "cpu5", "cpufreq", "max_perf"), "utf8").trim(), "2808000");
});

test("an argumentless invocation prints its usage and exits 1 (the probe contract)", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-helper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cpuRoot = makeSysfs(dir, {});
  let err = null;
  try {
    runHelper(cpuRoot, []);
  } catch (e) {
    err = e;
  }
  assert.ok(err, "argumentless run must exit nonzero");
  assert.equal(err.status, 1);
  assert.match(String(err.stderr), /^usage: /m);
});

test("a GPU persist emits the real gpu-clock-lock.service body", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-helper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cpuRoot = makeSysfs(dir, { cpu0: { maxKhz: 2808000, perfKhz: 2808000 } });
  const unitDir = path.join(dir, "units");
  fs.mkdirSync(unitDir);

  const { smiPath } = runHelper(cpuRoot, ["--domain", "gpu", "--max-mhz", "2200", "--persist"]);

  const unit = fs.readFileSync(path.join(unitDir, "gpu-clock-lock.service"), "utf8");
  assert.match(unit, new RegExp(`^ExecStart=${smiPath.replace(/[/\\]/g, "\\$&")} -lgc 0,2200$`, "m"));
  assert.match(unit, /^Description=Lock NVIDIA GPU graphics clocks to user range$/m);
});

test("an unsupported domain exits 3 without writing any unit", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-helper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cpuRoot = makeSysfs(dir, { cpu0: { maxKhz: 2808000, perfKhz: 2808000 } });
  const unitDir = path.join(dir, "units");
  fs.mkdirSync(unitDir);
  let err = null;
  try {
    runHelper(cpuRoot, ["--domain", "mem", "--max-mhz", "2200", "--persist"]);
  } catch (e) {
    err = e;
  }
  assert.ok(err, "unsupported domain must exit nonzero");
  assert.equal(err.status, 3);
  assert.deepEqual(fs.readdirSync(unitDir), []);
});
