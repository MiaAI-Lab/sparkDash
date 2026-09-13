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
  // Stub systemctl (the helper ends a persist with `daemon-reload`); the stub
  // dir rides on PATH like the scoped-sudo fixtures in clockControl.test.js.
  const stubDir = path.join(path.dirname(cpuRoot), "stub-bin");
  fs.mkdirSync(stubDir, { recursive: true });
  const systemctl = path.join(stubDir, "systemctl");
  if (!fs.existsSync(systemctl)) {
    fs.writeFileSync(systemctl, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(systemctl, 0o755);
  }
  const stdout = execFileSync("sh", [HELPER, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      SPARKDASH_CPU_SYS: cpuRoot,
      SPARKDASH_UNIT_DIR: unitDir,
    },
  });
  return { stdout };
}

// ─── The sibling must survive a single-domain persist ───────────────────────

test("a cpu-big persist preserves the sibling little domain's max_perf lines", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-helper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cpuRoot = makeSysfs(dir, {
    cpu0: { maxKhz: 2808000, perfKhz: 2808000 },
    cpu1: { maxKhz: 2808000, perfKhz: 2808000 },
    cpu5: { maxKhz: 3900000, perfKhz: 2600000 }, // curated sibling cap
    cpu6: { maxKhz: 3900000, perfKhz: 2600000 },
  });
  const unitDir = path.join(dir, "units");
  fs.mkdirSync(unitDir);

  runHelper(cpuRoot, ["--domain", "cpu-big", "--max-mhz", "2808", "--persist"]);

  const unit = fs.readFileSync(path.join(unitDir, "cpu-clock-cap.service"), "utf8");
  // Edited domain carries the requested value…
  assert.match(unit, /echo 2808000 > \S*cpu0\/cpufreq\/max_perf/);
  assert.match(unit, /echo 2808000 > \S*cpu1\/cpufreq\/max_perf/);
  // …and the sibling's current live cap is NOT deleted.
  assert.match(unit, /echo 2600000 > \S*cpu5\/cpufreq\/max_perf/);
  assert.match(unit, /echo 2600000 > \S*cpu6\/cpufreq\/max_perf/);
});

test("a cpu-big persist with unreadable sibling max_perf omits those cores (no guesses)", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-helper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cpuRoot = makeSysfs(dir, {
    cpu0: { maxKhz: 2808000, perfKhz: 2808000 },
    cpu5: { maxKhz: 3900000, perfKhz: null }, // unreadable sibling max_perf
  });
  const unitDir = path.join(dir, "units");
  fs.mkdirSync(unitDir);

  runHelper(cpuRoot, ["--domain", "cpu-big", "--max-mhz", "2600", "--persist"]);

  const unit = fs.readFileSync(path.join(unitDir, "cpu-clock-cap.service"), "utf8");
  assert.match(unit, /echo 2600000 > \S*cpu0\/cpufreq\/max_perf/);
  assert.doesNotMatch(unit, /cpu5\/cpufreq\/max_perf/);
});

test("a remove-cap (unlock) persist keeps the sibling and restores own hardware max", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-helper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cpuRoot = makeSysfs(dir, {
    cpu0: { maxKhz: 2808000, perfKhz: 2200000 },
    cpu5: { maxKhz: 3900000, perfKhz: 2600000 },
  });
  const unitDir = path.join(dir, "units");
  fs.mkdirSync(unitDir);

  runHelper(cpuRoot, ["--domain", "cpu-big", "--unlock", "--persist"]);

  const unit = fs.readFileSync(path.join(unitDir, "cpu-clock-cap.service"), "utf8");
  assert.match(unit, /cat \S*cpu0\/cpufreq\/cpuinfo_max_freq > \S*cpu0\/cpufreq\/max_perf/);
  assert.match(unit, /echo 2600000 > \S*cpu5\/cpufreq\/max_perf/);
});

test("the helper and the container persist path emit the same CPU ExecStart for one request", (t) => {
  // Same stub topology the SystemCollector persist tests use.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-helper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cpuRoot = makeSysfs(dir, {
    cpu0: { maxKhz: 2808000, perfKhz: 2808000 },
    cpu1: { maxKhz: 2808000, perfKhz: 2808000 },
    cpu10: { maxKhz: 2808000, perfKhz: 2808000 },
    cpu5: { maxKhz: 3900000, perfKhz: 2600000 },
    cpu6: { maxKhz: 3900000, perfKhz: 2600000 },
  });
  const unitDir = path.join(dir, "units");
  fs.mkdirSync(unitDir);

  // 1. Helper path: persist cpu-big 2808 while the sibling sits at 2600.
  runHelper(cpuRoot, ["--domain", "cpu-big", "--max-mhz", "2808", "--persist"]);
  const helperUnit = fs.readFileSync(path.join(unitDir, "cpu-clock-cap.service"), "utf8");
  const helperExec = helperUnit.match(/^ExecStart=(.+)$/m)[1];

  // 2. Container path: identical request, sibling values from live max_perf.
  //    Mirror the collector's own command construction (the captured payload's
  //    ExecStart) instead of stubbing node:fs module-wide.
  const sibling = ["cpu5", "cpu6"]; // numeric order, as _cpuDomainCores returns
  const parts = [
    `echo 2808000 > /sys/devices/system/cpu/cpu0/cpufreq/max_perf`,
    `echo 2808000 > /sys/devices/system/cpu/cpu1/cpufreq/max_perf`,
    `echo 2808000 > /sys/devices/system/cpu/cpu10/cpufreq/max_perf`,
    ...sibling.map((c) => `echo 2600000 > /sys/devices/system/cpu/${c}/cpufreq/max_perf`),
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
    cpu0: { maxKhz: 2808000, perfKhz: 2808000 },
    cpu5: { maxKhz: 3900000, perfKhz: 2600000 },
  });

  runHelper(cpuRoot, ["--domain", "cpu-little", "--max-mhz", "2400", "--no-persist"]);

  assert.equal(fs.readFileSync(path.join(cpuRoot, "cpu5", "cpufreq", "max_perf"), "utf8").trim(), "2400000");
  // Sibling untouched by the live apply.
  assert.equal(fs.readFileSync(path.join(cpuRoot, "cpu0", "cpufreq", "max_perf"), "utf8").trim(), "2808000");
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

  runHelper(cpuRoot, ["--domain", "gpu", "--max-mhz", "2200", "--persist"]);

  const unit = fs.readFileSync(path.join(unitDir, "gpu-clock-lock.service"), "utf8");
  assert.match(unit, /^ExecStart=\/usr\/bin\/nvidia-smi -lgc 0,2200$/m);
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
