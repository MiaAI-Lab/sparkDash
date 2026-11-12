import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildApplyProgram,
  buildManualCommand,
  buildResetProgram,
  buildStatusProgram,
  buildUnit,
  parseCapRequest,
  parseProgramOutput,
  parseSudoPassword,
  MARKER_FILE,
  UNIT_NAME,
} from "../commands.js";
import { GpuClockManager, assertSupported, remoteCommand, remoteInput } from "../GpuClockManager.js";

/** A temp tree with fake nvidia-smi, systemctl, sudo and crontab; the programs run
 * unprivileged against it. `narrowSudo` stands in for a unit whose only
 * passwordless rule is the narrow nvidia-smi one, `cron` for a running cron,
 * `cronMangles` for a crontab tool that rewrites the clocks of what it stores. */
function sandbox({ hwMax = 3003, lgcFails = false, narrowSudo = false, cron = false, cronMangles = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gpuclock-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  for (const d of ["units", "run", "systemd", "user-home"]) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, "boot_id"), "11111111-2222-3333-4444-555555555555\n");
  if (cron) fs.writeFileSync(path.join(root, "cron_active"), "");
  const lock = path.join(root, "lock");
  const calls = path.join(root, "calls.log");
  const crontab = path.join(root, "crontab");
  fs.writeFileSync(
    path.join(bin, "nvidia-smi"),
    `#!/bin/sh
echo "nvidia-smi $* env=\${SPARKDASH_SUDO_PW-unset}" >> ${calls}
case "$1" in
  --query-gpu=clocks.max.gr) echo "${hwMax}" ;;
  -lgc) ${lgcFails ? 'echo "Setting GPU clocks is not supported" >&2; exit 4' : `echo "$2" > ${lock}`} ;;
  -rgc) rm -f ${lock} ;;
esac
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(bin, "systemctl"),
    `#!/bin/sh
echo "systemctl $*" >> ${calls}
case "$1" in
  stop|disable)
    if [ "$*" = "stop ${UNIT_NAME}" ] || [ "$*" = "disable --now ${UNIT_NAME}" ]; then
      # The unit's ExecStop resets clocks; ExecStopPost removes the cap marker.
      rm -f ${lock} ${root}/run/${MARKER_FILE}
    fi ;;
  restart) [ -f ${root}/restart_fails ] && exit 1 ;;
  is-enabled) [ -f ${root}/units/${UNIT_NAME} ] && echo enabled || echo disabled ;;
  is-active)
    if [ -f ${root}/cron_active ] && { [ "$2" = cron.service ] || [ "$2" = crond.service ]; }; then
      echo active
    elif [ -f ${root}/units/${UNIT_NAME} ]; then
      echo active
    else
      echo inactive
    fi ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  // `sudo -n` with only the rule the fleet actually grants: the nvidia-smi
  // commands, no root shell. Anything else demands a password.
  fs.writeFileSync(
    path.join(bin, "sudo"),
    `#!/bin/sh
echo "sudo $*" >> ${calls}
while [ "$1" = "-n" ] || [ "$1" = "-k" ]; do shift; done
if [ "$1" = "-l" ]; then
  shift
  [ "$2" = "-lgc" ] && exit 0
  exit 1
fi
case "$1" in
  ${bin}/nvidia-smi)
    case "$2" in -lgc | -rgc) exec "$@" ;; esac ;;
esac
echo "sudo: a password is required" >&2
exit 1
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(bin, "crontab"),
    `#!/bin/sh
echo "crontab $*" >> ${calls}
case "$1" in
  -l)
    # A read that fails for another reason (lock, spool, PAM): like the real
    # tool, it exits non-zero with something other than "no crontab for".
    [ -f ${path.join(root, "crontab.broken")} ] && { echo "crontab: cannot open spool" >&2; exit 1; }
    if [ -f ${crontab} ]; then cat ${crontab}; else echo "no crontab for $(id -un)" >&2; exit 1; fi ;;
  -r) [ -f ${path.join(root, "crontab.readonly")} ] && { echo "crontab: installing new crontab failed" >&2; exit 1; }
      [ -f ${crontab} ] || { echo "no crontab for $(id -un)" >&2; exit 1; }; rm -f ${crontab} ;;
  *) [ -f ${path.join(root, "crontab.readonly")} ] && { echo "crontab: installing new crontab failed" >&2; exit 1; }
     # Match Debian cron's command-field limit, rather than accepting a boot
     # hook that the target's real crontab would refuse to install.
     while IFS= read -r line; do
       case "$line" in
         "@reboot "*) command=\${line#@reboot }
           [ "\${#command}" -le 998 ] || { echo "command too long" >&2; exit 1; } ;;
       esac
     done < "$1"
     ${cronMangles ? `sed 's/-lgc [0-9,]*/-lgc 0,9/' "$1" > ${crontab}` : `cp "$1" ${crontab}`} ;;
esac
`,
    { mode: 0o755 }
  );
  // Boot-time failures go to `logger`; the sandbox records instead of writing to the host's journal.
  fs.writeFileSync(path.join(bin, "logger"), `#!/bin/sh\necho "logger $*" >> ${calls}\n`, { mode: 0o755 });
  const paths = {
    unitDir: path.join(root, "units"),
    runDir: path.join(root, "run"),
    bootIdFile: path.join(root, "boot_id"),
    systemdRunDir: path.join(root, "systemd"),
    nvsmi: [path.join(bin, "nvidia-smi")],
    systemctl: path.join(bin, "systemctl"),
    sandbox: true,
    sandboxSudo: narrowSudo ? path.join(bin, "sudo") : "",
  };
  const environment = (env = {}) => ({
    ...process.env,
    ...env,
    HOME: env.HOME?.startsWith(`${root}/`) ? env.HOME : path.join(root, "user-home"),
    PATH: env.PATH?.split(":").includes(bin) ? env.PATH : `${bin}:${env.PATH ?? process.env.PATH ?? ""}`,
  });
  const exec = (program, { shell = "sh", env, ...options } = {}) =>
    execFileSync(shell, ["-c", program], { encoding: "utf8", ...options, env: environment(env) });
  const run = (program, options) => parseProgramOutput(exec(program, options));
  /** Run a shell snippet as cron would, ignoring the program output protocol. */
  const shell = (program, env) => exec(program, { env });
  const read = (f) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), "utf8") : null);
  const write = (f, text) => fs.writeFileSync(path.join(root, f), text);
  return {
    root,
    paths,
    run,
    shell,
    exec,
    environment,
    read,
    write,
    bin,
    cronText: () => read("crontab") ?? "",
    lockText: () => (fs.existsSync(lock) ? fs.readFileSync(lock, "utf8").trim() : null),
    calls: () => read("calls.log") ?? "",
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("parseCapRequest accepts a normal cap and rejects everything else", () => {
  assert.deepEqual(parseCapRequest({ maxMHz: 2200 }), { minMHz: 0, maxMHz: 2200, persist: false });
  assert.deepEqual(parseCapRequest({ minMHz: 300, maxMHz: 1800, persist: true }), { minMHz: 300, maxMHz: 1800, persist: true });
  for (const bad of [
    null, {}, { maxMHz: "2200" }, { maxMHz: 2200.5 }, { maxMHz: 299 }, { maxMHz: 10001 },
    { maxMHz: -1 }, { maxMHz: "2200; rm -rf /" }, { maxMHz: 2200, minMHz: 2201 }, { maxMHz: 2200, minMHz: -1 },
    { maxMHz: 2200, persist: "yes" }, { maxMHz: 2200, minMHz: "0" }, { maxMHz: Infinity }, { maxMHz: NaN },
  ]) {
    assert.throws(() => parseCapRequest(bad), (e) => e.status === 400, JSON.stringify(bad));
  }
});

test("program text only carries integers and fixed paths", () => {
  const hostile = { minMHz: 0, maxMHz: 2200, persist: true };
  const p = buildApplyProgram(hostile);
  assert.throws(() => buildApplyProgram({ minMHz: 0, maxMHz: "2200;id", persist: true }), /maxMHz/);
  assert.throws(() => buildApplyProgram(hostile, { unitDir: "/etc/x; id" }), /unsafe path/);
  assert.throws(() => buildApplyProgram(hostile, { runDir: "/run/../etc" }), /unsafe path/);
  assert.match(p, /MIN=0; MAX=2200; PERSIST=1/);
  assert.doesNotMatch(p, /PATH=/);
});

test("every program is valid POSIX sh", () => {
  for (const prog of [
    buildStatusProgram(),
    buildResetProgram(),
    buildApplyProgram({ minMHz: 0, maxMHz: 2200, persist: false }),
    buildApplyProgram({ minMHz: 0, maxMHz: 2200, persist: true }),
  ]) {
    execFileSync("sh", ["-n", "-c", prog]);
  }
});

test("the unit escapes systemd's $ and keeps the marker in sync with the cap", () => {
  const unit = buildUnit({ minMHz: 0, maxMHz: 1800 });
  assert.match(unit, /^ExecStart=\/usr\/bin\/nvidia-smi -lgc 0,1800$/m);
  assert.match(unit, /^ExecStop=\/usr\/bin\/nvidia-smi -rgc$/m);
  assert.match(unit, /echo 1800 \$\$\(cat \/proc\/sys\/kernel\/random\/boot_id\) > \/run\/sparkdash\/gpu-clock-cap/);
  assert.match(unit, /^ExecStopPost=\/bin\/rm -f \/run\/sparkdash\/gpu-clock-cap$/m);
  assert.doesNotMatch(unit, /%s/);
});

test("apply without the service: caps the clock, writes the marker, installs no unit", () => {
  const sb = sandbox();
  try {
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 2200, persist: false }, sb.paths));
    assert.equal(res.RESULT, "ok");
    assert.equal(res.CAP, "2200");
    assert.equal(sb.read("lock").trim(), "0,2200");
    assert.equal(sb.read(`run/${MARKER_FILE}`).trim(), "2200 11111111-2222-3333-4444-555555555555");
    assert.equal(sb.read(`units/${UNIT_NAME}`), null);
    const status = sb.run(buildStatusProgram(sb.paths));
    assert.equal(status.CAP, "2200");
    assert.equal(status.HWMAX, "3003");
    assert.equal(status.SVC_INSTALLED, "0");
  } finally {
    sb.cleanup();
  }
});

test("apply with the service: installs and enables the unit, which carries the cap", () => {
  const sb = sandbox();
  try {
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    assert.equal(res.RESULT, "ok");
    assert.equal(res.PERSIST, "1");
    const unit = sb.read(`units/${UNIT_NAME}`);
    assert.match(unit, new RegExp(`ExecStart=${sb.paths.nvsmi[0].replace(/[/.]/g, "\\$&")} -lgc 0,1800`));
    assert.doesNotMatch(unit, /@@NV@@/);
    assert.match(sb.calls(), /systemctl enable spark-gpu-clock-limit.service/);
    assert.match(sb.calls(), /systemctl restart spark-gpu-clock-limit.service/);
    const status = sb.run(buildStatusProgram(sb.paths));
    assert.equal(status.SVC_INSTALLED, "1");
    assert.equal(status.SVC_CLOCKS, "0,1800");
    assert.equal(status.SVC_ENABLED, "enabled");
    assert.equal(status.CAP, "1800");
  } finally {
    sb.cleanup();
  }
});

test("switching to a root-owned cap removes the fallback marker before service stop", () => {
  const sb = sandbox();
  try {
    const home = path.join(sb.root, "home");
    fs.mkdirSync(path.join(home, ".config/sparkdash"), { recursive: true });
    const fallback = path.join(home, ".config/sparkdash/gpu-clock-cap");
    fs.writeFileSync(fallback, `2100 ${sb.read("boot_id").trim()}\n`);
    fs.writeFileSync(path.join(sb.bin, "id"), "#!/bin/sh\necho 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(sb.bin, "install"), '#!/bin/sh\nwhile [ "$1" = "-m" ] || [ "$1" = "-o" ] || [ "$1" = "-g" ]; do shift 2; done\ncp "$1" "$2"\n', { mode: 0o755 });
    const paths = { ...sb.paths, sandbox: false, systemctl: "systemctl" };
    const env = { ...process.env, HOME: home };
    assert.equal(sb.run(buildApplyProgram({ maxMHz: 1800, persist: true }, paths), { env }).RESULT, "ok");
    sb.shell(`systemctl stop ${UNIT_NAME}`, env);
    assert.equal(sb.lockText(), null);
    assert.equal(sb.run(buildStatusProgram(paths), { env }).CAP, "");
  } finally {
    sb.cleanup();
  }
});

test("switching the service off removes the unit and preserves the live cap in status after stop cleanup", () => {
  const sb = sandbox();
  try {
    sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 2000, persist: false }, sb.paths));
    assert.equal(res.RESULT, "ok");
    assert.equal(sb.read(`units/${UNIT_NAME}`), null);
    assert.match(sb.calls(), /systemctl disable --now spark-gpu-clock-limit.service/);
    assert.equal(sb.read("lock").trim(), "0,2000");
    const status = sb.run(buildStatusProgram(sb.paths));
    assert.equal(status.CAP, "2000");
    assert.equal(status.SVC_INSTALLED, "0");
    assert.equal(res.PERSIST, "0");
  } finally {
    sb.cleanup();
  }
});

test("a cap above the GPU maximum is refused and nothing changes", () => {
  const sb = sandbox({ hwMax: 2418 });
  try {
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 3000, persist: true }, sb.paths));
    assert.equal(res.RESULT, "error");
    assert.equal(res.CODE, "range");
    assert.equal(sb.read("lock"), null);
    assert.equal(sb.read(`run/${MARKER_FILE}`), null);
    assert.equal(sb.read(`units/${UNIT_NAME}`), null);
  } finally {
    sb.cleanup();
  }
});

test("when nvidia-smi refuses the cap no service or marker is written", () => {
  const sb = sandbox({ lgcFails: true });
  try {
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 2200, persist: true }, sb.paths));
    assert.equal(res.RESULT, "error");
    assert.equal(res.CODE, "lgc-failed");
    assert.match(res.MSG, /not supported/);
    assert.equal(sb.read(`units/${UNIT_NAME}`), null);
    assert.equal(sb.read(`run/${MARKER_FILE}`), null);
  } finally {
    sb.cleanup();
  }
});

test("a stale marker from an earlier boot is not reported as the current cap", () => {
  const sb = sandbox();
  try {
    fs.writeFileSync(path.join(sb.root, "run", MARKER_FILE), "1500 99999999-0000-0000-0000-000000000000\n");
    assert.equal(sb.run(buildStatusProgram(sb.paths)).CAP, "");
  } finally {
    sb.cleanup();
  }
});

test("reset removes the service, the lock and the marker", () => {
  const sb = sandbox();
  try {
    sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    const res = sb.run(buildResetProgram(sb.paths));
    assert.equal(res.RESULT, "ok");
    assert.equal(sb.read("lock"), null);
    assert.equal(sb.read(`run/${MARKER_FILE}`), null);
    assert.equal(sb.read(`units/${UNIT_NAME}`), null);
    assert.match(sb.calls(), /nvidia-smi -rgc/);
  } finally {
    sb.cleanup();
  }
});

test("a unit with no nvidia-smi reports a clean error instead of touching anything", () => {
  const sb = sandbox();
  try {
    const paths = { ...sb.paths, nvsmi: [path.join(sb.root, "bin", "missing")] };
    assert.equal(sb.run(buildStatusProgram(paths)).CODE, "no-nvidia");
    assert.equal(sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 2200, persist: true }, paths)).CODE, "no-nvidia");
  } finally {
    sb.cleanup();
  }
});

test("parseProgramOutput: junk or missing RESULT is an error, never ok", () => {
  assert.equal(parseProgramOutput("").RESULT, "error");
  assert.equal(parseProgramOutput("Welcome to Ubuntu\nCAP=2200").RESULT, "error");
  assert.equal(parseProgramOutput("motd\nRESULT=ok\nCAP=1800\nEVIL=1").EVIL, undefined);
});

test("only Linux Spark units are supported", () => {
  assert.throws(() => assertSupported({ id: "a", kind: "host" }), (e) => e.status === 400);
  assert.throws(() => assertSupported({ id: "a", kind: "spark", platform: "windows" }), (e) => e.status === 400);
  assert.throws(() => assertSupported({ id: "a", kind: "spark", platform: "darwin" }), (e) => e.status === 400);
  assert.throws(() => assertSupported(undefined), (e) => e.status === 404);
  assertSupported({ id: "a", kind: "spark" });
  assertSupported({ id: "a", kind: "spark", platform: "linux" });
});

test("GpuClockManager: a cap not kept never names a hook; a kept one without a kind is the service", async () => {
  const spark = { id: "s1", kind: "spark" };
  const answering = (out) => new GpuClockManager({ run: async () => out });
  // A stray kind on an apply that did not persist must not read as "kept by cron".
  const notKept = await answering("RESULT=ok\nCAP=1800\nPERSIST=0\nPERSIST_KIND=cron").apply(spark, { maxMHz: 1800, persist: true });
  assert.equal(notKept.persist, false);
  assert.equal(notKept.persistKind, "none");
  // An older unit program reports PERSIST=1 alone: only the service existed then.
  const kindless = await answering("RESULT=ok\nCAP=1800\nPERSIST=1").apply(spark, { maxMHz: 1800, persist: true });
  assert.equal(kindless.persist, true);
  assert.equal(kindless.persistKind, "unit");
});

test("GpuClockManager: maps program errors to statuses, serialises per unit, hides ssh detail", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const outputs = [];
  const m = new GpuClockManager({
    run: async (_spark, program) => {
      if (program.includes("MAX=2200")) await gate;
      return outputs.shift();
    },
  });
  const spark = { id: "s1", name: "S1", kind: "spark" };

  outputs.push("RESULT=error\nCODE=no-sudo\nMSG=passwordless sudo is required for the user that runs the change");
  await assert.rejects(m.apply(spark, { maxMHz: 1800 }), (e) => e.status === 409 && e.code === "no-sudo");

  outputs.push("RESULT=ok\nCAP=2200\nPERSIST=0");
  const first = m.apply(spark, { maxMHz: 2200 });
  await assert.rejects(m.apply(spark, { maxMHz: 1900 }), (e) => e.status === 409);
  release();
  assert.deepEqual(await first, { capMHz: 2200, persist: false, persistKind: "none", minMHz: 0 });

  // Which hook kept the cap comes from the unit, per unit: one Spark may take the
  // boot service where another falls back to the @reboot job.
  const kept = new GpuClockManager({ run: async () => "RESULT=ok\nCAP=1800\nPERSIST=1\nPERSIST_KIND=cron" });
  assert.equal((await kept.apply(spark, { maxMHz: 1800, persist: true })).persistKind, "cron");
  const unitKept = new GpuClockManager({ run: async () => "RESULT=ok\nCAP=1800\nPERSIST=1\nPERSIST_KIND=unit" });
  assert.equal((await unitKept.apply(spark, { maxMHz: 1800, persist: true })).persistKind, "unit");
  // A "kept" answer with no recognisable mechanism is the boot service, never cron.
  const bare = new GpuClockManager({ run: async () => "RESULT=ok\nCAP=1800\nPERSIST=1" });
  assert.equal((await bare.apply(spark, { maxMHz: 1800, persist: true })).persistKind, "unit");

  const down = new GpuClockManager({ run: async () => { throw new Error("SSH to 10.0.0.2:22 failed: refused"); } });
  await assert.rejects(down.reset(spark), (e) => e.status === 502);
  await assert.rejects(m.apply(spark, { maxMHz: "x" }), (e) => e.status === 400);
  await assert.rejects(m.status({ id: "h", kind: "host" }), (e) => e.status === 400);
});

test("GpuClockManager.status: normal answer, and a unit without nvidia-smi is 'unsupported', not an error", async () => {
  const spark = { id: "s1", kind: "spark" };
  const ok = new GpuClockManager({
    run: async () =>
      "RESULT=ok\nHWMAX=3003\nSUDO=yes\nPERSIST_KIND=unit\nCAP=1800\nSVC_INSTALLED=1\nSVC_CLOCKS=0,1800\nSVC_ENABLED=enabled\nSVC_ACTIVE=active",
  });
  assert.deepEqual(await ok.status(spark), {
    supported: true, hwMaxMHz: 3003, capMHz: 1800, sudo: "yes", persistKind: "unit",
    service: { installed: true, clocks: "0,1800", enabled: "enabled", active: "active" },
    cron: { installed: false, clocks: null, failed: false },
  });
  // A unit whose rule only covers the nvidia-smi commands keeps the cap with its
  // own @reboot job: the row reports that mechanism, and a missing line means no
  // mechanism at all, never a permissive default.
  const narrow = new GpuClockManager({
    run: async () => "RESULT=ok\nHWMAX=3003\nSUDO=yes\nPERSIST_KIND=cron\nCRON_INSTALLED=1\nCRON_CLOCKS=0,1800\nCRON_FAILED=1\nCAP=1800",
  });
  const narrowStatus = await narrow.status(spark);
  assert.equal(narrowStatus.persistKind, "cron");
  assert.deepEqual(narrowStatus.cron, { installed: true, clocks: "0,1800", failed: true });
  const silent = new GpuClockManager({ run: async () => "RESULT=ok\nHWMAX=3003\nSUDO=yes\nCAP=1800" });
  assert.equal((await silent.status(spark)).persistKind, "none");
  // A junk mechanism is no mechanism, and an unknown hook is not "installed".
  const junk = new GpuClockManager({
    run: async () => "RESULT=ok\nHWMAX=3003\nSUDO=yes\nPERSIST_KIND=whatever\nCRON_INSTALLED=maybe\nCRON_CLOCKS=x",
  });
  const junkStatus = await junk.status(spark);
  assert.equal(junkStatus.persistKind, "none");
  assert.deepEqual(junkStatus.cron, { installed: false, clocks: null, failed: false });
  const none = new GpuClockManager({ run: async () => "RESULT=error\nCODE=no-nvidia\nMSG=nvidia-smi was not found on this unit" });
  assert.equal((await none.status(spark)).supported, false);
});

const OLD_UNIT = `[Unit]
Description=Limit NVIDIA GPU graphics clock (0,2200 MHz)

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/nvidia-smi -lgc 0,2200
ExecStop=/usr/bin/nvidia-smi -rgc

[Install]
WantedBy=multi-user.target
`;

test("status understands a unit installed by the standalone sparkLimiter script", () => {
  const sb = sandbox();
  try {
    sb.write(`units/${UNIT_NAME}`, OLD_UNIT);
    const status = sb.run(buildStatusProgram(sb.paths));
    assert.equal(status.SVC_INSTALLED, "1");
    assert.equal(status.SVC_CLOCKS, "0,2200");
    assert.equal(status.CAP, "");
  } finally {
    sb.cleanup();
  }
});

test("a refused cap leaves an existing service and its marker exactly as they were", () => {
  const sb = sandbox({ lgcFails: true });
  try {
    sb.write(`units/${UNIT_NAME}`, OLD_UNIT);
    sb.write(`run/${MARKER_FILE}`, "2200 11111111-2222-3333-4444-555555555555\n");
    for (const persist of [true, false]) {
      const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist }, sb.paths));
      assert.equal(res.CODE, "lgc-failed");
      assert.equal(sb.read(`units/${UNIT_NAME}`), OLD_UNIT);
      assert.equal(sb.read(`run/${MARKER_FILE}`).trim(), "2200 11111111-2222-3333-4444-555555555555");
    }
    assert.doesNotMatch(sb.calls(), /disable|restart/);
  } finally {
    sb.cleanup();
  }
});

test("a service that fails to start is rolled back: previous unit restored, cap and marker stay truthful", () => {
  const sb = sandbox();
  try {
    sb.write(`units/${UNIT_NAME}`, OLD_UNIT);
    sb.write("restart_fails", "1");
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    assert.equal(res.RESULT, "error");
    assert.equal(res.CODE, "service-failed");
    assert.match(res.MSG, /until the next reboot/);
    assert.equal(sb.read(`units/${UNIT_NAME}`), OLD_UNIT, "the previous service is back");
    assert.equal(sb.read("lock").trim(), "0,1800", "the live cap is still applied");
    assert.equal(sb.read(`run/${MARKER_FILE}`).trim(), "1800 11111111-2222-3333-4444-555555555555");
  } finally {
    sb.cleanup();
  }
});

test("a first-time service that fails to start is removed again", () => {
  const sb = sandbox();
  try {
    sb.write("restart_fails", "1");
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    assert.equal(res.CODE, "service-failed");
    assert.equal(sb.read(`units/${UNIT_NAME}`), null);
    assert.match(sb.calls(), /systemctl disable spark-gpu-clock-limit.service/);
    assert.equal(sb.read(`run/${MARKER_FILE}`).trim(), "1800 11111111-2222-3333-4444-555555555555");
  } finally {
    sb.cleanup();
  }
});

test("the same programs behave under dash and bash --posix", () => {
  for (const shell of ["dash", "bash"]) {
    try {
      execFileSync(shell, ["-c", "true"]);
    } catch {
      continue; // not installed here
    }
    const sb = sandbox();
    try {
      const opt = { shell, env: process.env };
      const wrap = (prog) => (shell === "bash" ? `set -o posix\n${prog}` : prog);
      assert.equal(sb.run(wrap(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths)), opt).RESULT, "ok", shell);
      assert.equal(sb.run(wrap(buildStatusProgram(sb.paths)), opt).CAP, "1800", shell);
      assert.equal(sb.run(wrap(buildResetProgram(sb.paths)), opt).RESULT, "ok", shell);
      assert.equal(sb.read(`units/${UNIT_NAME}`), null, shell);
    } finally {
      sb.cleanup();
    }
  }
});

test("as a normal user every privileged step goes through sudo -n (real privilege path, fake sudo)", () => {
  const sb = sandbox();
  try {
    const log = path.join(sb.root, "sudo.log");
    fs.writeFileSync(path.join(sb.bin, "sudo"), `#!/bin/sh\necho "sudo $*" >> ${log}\n[ "$1" = -n ] || exit 9\nshift\nexec "$@"\n`, { mode: 0o755 });
    // `install -o root -g root` cannot succeed unprivileged: drop the ownership flags only.
    fs.writeFileSync(path.join(sb.bin, "install"), `#!/bin/sh\nargs=""\nwhile [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) args="$args $1"; shift ;; esac; done\nexec /usr/bin/install $args\n`, { mode: 0o755 });
    const paths = { ...sb.paths, sandbox: false, systemctl: "systemctl" };
    const env = { ...process.env, PATH: `${sb.bin}:${process.env.PATH}` };
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, paths), { env });
    assert.equal(res.RESULT, "ok");
    const calls = fs.readFileSync(log, "utf8");
    assert.match(calls, /sudo -n true/);
    assert.match(calls, /sudo -n .*nvidia-smi -lgc 0,1800/);
    assert.match(calls, /sudo -n install -m 644 -o root -g root/);
    assert.match(calls, /sudo -n .*systemctl enable/);
    assert.match(calls, /sudo -n sh -c mkdir -p/);
    assert.equal(sb.read(`units/${UNIT_NAME}`).includes("-lgc 0,1800"), true);
    // Sudo that asks for a password changes nothing.
    fs.writeFileSync(path.join(sb.bin, "sudo"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    fs.rmSync(path.join(sb.root, "lock"));
    const denied = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1500, persist: true }, paths), { env });
    assert.equal(denied.CODE, "no-sudo");
    assert.equal(sb.read("lock"), null);
    assert.equal(sb.read(`units/${UNIT_NAME}`).includes("-lgc 0,1800"), true);
  } finally {
    sb.cleanup();
  }
});

test("a narrow NOPASSWD rule for the nvidia-smi commands is enough to cap, read back and unlock", () => {
  const sb = sandbox();
  const home = path.join(sb.root, "home");
  fs.mkdirSync(home);
  try {
    // NOPASSWD covers `nvidia-smi -lgc` and `-rgc` only, like the rule this
    // project's own README suggests: `sudo true` and `sudo sh -c ...` are
    // refused, and `sudo -l` reports the rule.
    fs.writeFileSync(
      path.join(sb.bin, "sudo"),
      `#!/bin/sh
case "$*" in
  "-n -l "*) exit 0 ;;
  "-n "*) ;;
  *) exit 1 ;;
esac
shift
case "$1" in
  */nvidia-smi) exec "$@" ;;
esac
exit 1
`,
      { mode: 0o755 }
    );
    const paths = { ...sb.paths, sandbox: false, systemctl: "systemctl" };
    const env = { ...process.env, HOME: home, PATH: `${sb.bin}:${process.env.PATH}` };
    const applied = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800 }, paths), { env });
    assert.equal(applied.RESULT, "ok");
    assert.equal(sb.read("lock").trim(), "0,1800");
    assert.equal(sb.read(`units/${UNIT_NAME}`), null);
    // The marker lands in the SSH user's own config dir, because root's is out of reach.
    const marker = path.join(home, ".config/sparkdash/gpu-clock-cap");
    assert.equal(fs.readFileSync(marker, "utf8"), `1800 ${sb.read("boot_id").trim()}\n`);
    const status = sb.run(buildStatusProgram(paths), { env });
    assert.equal(status.SUDO, "yes");
    assert.equal(status.CAP, "1800");
    const reset = sb.run(buildResetProgram(paths), { env });
    assert.equal(reset.RESULT, "ok");
    assert.equal(fs.existsSync(marker), false);
    assert.equal(sb.read("lock"), null);
    // Keeping the cap needs either a root shell (the systemd unit) or cron (an
    // @reboot line), and this unit offers neither: it must refuse before the GPU
    // is capped, leaving the clocks untouched.
    const persisted = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, paths), { env });
    assert.equal(persisted.CODE, "no-sudo");
    assert.equal(sb.read("lock"), null);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    sb.cleanup();
  }
});

/** sudo narrowed to the nvidia-smi commands: no root shell, no `sudo rm`. */
function narrowRootlessSudo(sb) {
  fs.writeFileSync(
    path.join(sb.bin, "sudo"),
    `#!/bin/sh
[ "$1" = "-n" ] && shift
case "$1" in
  -v | -l) exit 0 ;;
  */nvidia-smi) exec "$@" ;;
esac
exit 1
`,
    { mode: 0o755 }
  );
}

test("reset refuses before unlocking when a root-written marker is out of reach of a narrowed sudo", (t) => {
  // The root-owned /run/sparkdash is a directory this user cannot write; root ignores mode bits.
  if (process.getuid?.() === 0) return t.skip("needs a non-root user: root can write any directory");
  const sb = sandbox({ cron: true });
  const home = path.join(sb.root, "home");
  const runDir = path.join(sb.root, "run");
  fs.mkdirSync(home);
  try {
    narrowRootlessSudo(sb);
    const paths = { ...sb.paths, sandbox: false, systemctl: "systemctl" };
    const env = { ...process.env, HOME: home, PATH: `${sb.bin}:${process.env.PATH}` };
    const boot = sb.read("boot_id").trim();
    // Capped this boot while sudo still reached a root shell: the marker sits in
    // the root-owned run dir, and an @reboot job keeps the cap.
    sb.write("lock", "0,2100\n");
    sb.write(`run/${MARKER_FILE}`, `2100 ${boot}\n`);
    const cron = "0 4 * * * /usr/local/bin/backup.sh\n@reboot /usr/bin/sudo -n /usr/bin/nvidia-smi -lgc 0,2100 # sparkdash-gpu-clock-cap\n";
    sb.write("crontab", cron);
    fs.chmodSync(runDir, 0o555);
    const unchanged = (what) => {
      assert.equal(sb.lockText(), "0,2100", `${what}: the GPU is still capped`);
      assert.equal(sb.read(`run/${MARKER_FILE}`), `2100 ${boot}\n`, `${what}: the marker is still there`);
      assert.equal(sb.cronText(), cron, `${what}: the boot hook is untouched`);
      const status = sb.run(buildStatusProgram(paths), { env });
      assert.equal(status.CAP, "2100", `${what}: the status reads the cap that is in force`);
      assert.equal(status.CRON_INSTALLED, "1", what);
      assert.doesNotMatch(sb.calls(), /nvidia-smi -rgc|crontab (-r|\/)/, what);
    };
    unchanged("before");

    const res = sb.run(buildResetProgram(paths), { env });
    assert.equal(res.CODE, "marker-failed");
    // MSG is capped at 300 characters, and the sandbox paths are long.
    assert.match(res.MSG, /cannot be removed by this user .* nothing was changed\. Remove it as root/);
    unchanged("dashboard reset");

    let err;
    try {
      sb.exec(buildManualCommand("reset", {}, paths), { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      err = e;
    }
    assert.equal(err?.status, 1, "the manual command must fail");
    assert.match(err.stderr, /Error: the recorded cap .* cannot be removed by this user/);
    unchanged("manual reset");

    // Once the marker is within reach, the same reset clears the cap, its marker and its hook.
    fs.chmodSync(runDir, 0o755);
    assert.equal(sb.run(buildResetProgram(paths), { env }).RESULT, "ok");
    assert.equal(sb.lockText(), null);
    assert.equal(sb.read(`run/${MARKER_FILE}`), null);
    assert.equal(sb.cronText(), "0 4 * * * /usr/local/bin/backup.sh\n");
    const status = sb.run(buildStatusProgram(paths), { env });
    assert.equal(status.CAP, "");
    assert.equal(status.CRON_INSTALLED, "0");
  } finally {
    fs.chmodSync(runDir, 0o755);
    sb.cleanup();
  }
});

test("applying a new cap refuses before capping when a root-written marker is out of reach of a narrowed sudo", (t) => {
  // The root-owned /run/sparkdash is a directory this user cannot write; root ignores mode bits.
  if (process.getuid?.() === 0) return t.skip("needs a non-root user: root can write any directory");
  const sb = sandbox({ cron: true });
  const home = path.join(sb.root, "home");
  const runDir = path.join(sb.root, "run");
  const altMarker = path.join(home, ".config", "sparkdash", MARKER_FILE);
  fs.mkdirSync(home);
  try {
    narrowRootlessSudo(sb);
    const paths = { ...sb.paths, sandbox: false, systemctl: "systemctl" };
    const env = { ...process.env, HOME: home, PATH: `${sb.bin}:${process.env.PATH}` };
    const boot = sb.read("boot_id").trim();
    // Capped at 2100 this boot while sudo still reached a root shell; an @reboot job keeps it.
    sb.write("lock", "0,2100\n");
    sb.write(`run/${MARKER_FILE}`, `2100 ${boot}\n`);
    const cron = "0 4 * * * /usr/local/bin/backup.sh\n@reboot /usr/bin/sudo -n /usr/bin/nvidia-smi -lgc 0,2100 # sparkdash-gpu-clock-cap\n";
    sb.write("crontab", cron);
    fs.chmodSync(runDir, 0o555);
    const unchanged = (what) => {
      assert.equal(sb.lockText(), "0,2100", `${what}: the GPU keeps the cap in force`);
      assert.equal(sb.read(`run/${MARKER_FILE}`), `2100 ${boot}\n`, `${what}: the marker is still there`);
      assert.equal(fs.existsSync(altMarker), false, `${what}: no second marker was written`);
      assert.equal(sb.cronText(), cron, `${what}: the boot hook is untouched`);
      assert.equal(sb.run(buildStatusProgram(paths), { env }).CAP, "2100", `${what}: the status reads the cap that is in force`);
      assert.doesNotMatch(sb.calls(), /nvidia-smi -lgc 0,1800|crontab (-r|\/)/, what);
    };
    unchanged("before");

    for (const persist of [false, true]) {
      const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist }, paths), { env });
      assert.equal(res.CODE, "marker-failed", `persist=${persist}`);
      assert.match(res.MSG, /cannot be removed by this user .* nothing was changed\. Remove it as root/);
      unchanged(`apply persist=${persist}`);
    }

    // Once the marker is within reach, the new cap replaces it: the status reads what is in force.
    fs.chmodSync(runDir, 0o755);
    assert.equal(sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: false }, paths), { env }).RESULT, "ok");
    assert.equal(sb.lockText(), "0,1800");
    assert.equal(sb.read(`run/${MARKER_FILE}`), null, "the root-written marker is gone");
    assert.equal(fs.readFileSync(altMarker, "utf8"), `1800 ${boot}\n`);
    assert.equal(sb.cronText(), "0 4 * * * /usr/local/bin/backup.sh\n", "the stale @reboot job is dropped");
    assert.equal(sb.run(buildStatusProgram(paths), { env }).CAP, "1800");
  } finally {
    fs.chmodSync(runDir, 0o755);
    sb.cleanup();
  }
});

test("where only the narrow nvidia-smi rule is granted, keeping the cap installs an @reboot job", () => {
  const sb = sandbox({ narrowSudo: true, cron: true });
  try {
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    assert.equal(res.RESULT, "ok");
    assert.equal(res.PERSIST, "1");
    assert.equal(res.PERSIST_KIND, "cron");
    assert.equal(sb.read(`units/${UNIT_NAME}`), null, "a narrow rule cannot install the unit");
    assert.equal(sb.lockText(), "0,1800");
    const crontab = sb.cronText();
    assert.match(crontab, /^@reboot /);
    assert.match(crontab, /-lgc 0,1800/);
    assert.match(crontab, /# sparkdash-gpu-clock-cap/);
    assert.equal(sb.read(`run/${MARKER_FILE}`).trim(), "1800 11111111-2222-3333-4444-555555555555");

    const status = sb.run(buildStatusProgram(sb.paths));
    assert.equal(status.SUDO, "yes");
    assert.equal(status.PERSIST_KIND, "cron");
    assert.equal(status.CRON_INSTALLED, "1");
    assert.equal(status.CRON_CLOCKS, "0,1800");
    assert.equal(status.SVC_INSTALLED, "0");
    assert.equal(status.CAP, "1800");
  } finally {
    sb.cleanup();
  }
});

test("the @reboot job re-applies the cap at boot with no more privilege than the cap itself", () => {
  const sb = sandbox({ narrowSudo: true, cron: true });
  try {
    sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    // A reboot: the lock is gone, the boot id moved on, so the marker is stale.
    fs.rmSync(path.join(sb.root, "lock"));
    sb.write("boot_id", "22222222-3333-4444-5555-666666666666\n");
    const line = sb.cronText().split("\n").find((l) => l.startsWith("@reboot"));
    // The retry sleep only spaces attempts at boot; run the rest of the line verbatim.
    sb.shell(line.replace(/^@reboot /, "").replace(/\/bin\/sleep 20; /, ""));
    assert.equal(sb.lockText(), "0,1800");
    assert.equal(sb.read(`run/${MARKER_FILE}`).trim(), "1800 22222222-3333-4444-5555-666666666666");
    assert.equal(sb.run(buildStatusProgram(sb.paths)).CAP, "1800");
  } finally {
    sb.cleanup();
  }
});

test("with the narrow rule but no cron, keeping the cap is refused before anything is capped", () => {
  const sb = sandbox({ narrowSudo: true });
  try {
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    assert.equal(res.RESULT, "error");
    assert.equal(res.CODE, "no-sudo");
    assert.match(res.MSG, /@reboot/);
    assert.equal(sb.lockText(), null);
    assert.equal(sb.cronText(), "");
    assert.doesNotMatch(sb.calls(), /-lgc 0,1800/);
  } finally {
    sb.cleanup();
  }
});

test("switching keep-after-reboot off drops the @reboot job and leaves the user's other jobs alone", () => {
  const sb = sandbox({ narrowSudo: true, cron: true });
  try {
    sb.write("crontab", "0 4 * * * /usr/local/bin/backup.sh\n");
    sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 2000, persist: false }, sb.paths));
    assert.equal(res.RESULT, "ok");
    assert.equal(res.PERSIST_KIND, "none");
    assert.equal(sb.cronText(), "0 4 * * * /usr/local/bin/backup.sh\n");
    assert.equal(sb.lockText(), "0,2000");
  } finally {
    sb.cleanup();
  }
});

test("reset clears the @reboot job along with the cap and the marker", () => {
  const sb = sandbox({ narrowSudo: true, cron: true });
  try {
    sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    const res = sb.run(buildResetProgram(sb.paths));
    assert.equal(res.RESULT, "ok");
    assert.equal(sb.cronText(), "");
    assert.equal(sb.lockText(), null);
    assert.equal(sb.read(`run/${MARKER_FILE}`), null);
  } finally {
    sb.cleanup();
  }
});

test("status names the boot hook the unit can take: the service with root, cron without", () => {
  const root = sandbox();
  const narrow = sandbox({ narrowSudo: true, cron: true });
  try {
    assert.equal(root.run(buildStatusProgram(root.paths)).PERSIST_KIND, "unit");
    assert.equal(narrow.run(buildStatusProgram(narrow.paths)).PERSIST_KIND, "cron");
  } finally {
    root.cleanup();
    narrow.cleanup();
  }
});

test("a crontab that cannot be read is never written back empty: apply and reset refuse first", () => {
  const sb = sandbox({ narrowSudo: true, cron: true });
  try {
    const jobs = "0 4 * * * /usr/local/bin/backup.sh\n";
    sb.write("crontab", jobs);
    sb.write("crontab.broken", "");
    for (const persist of [true, false]) {
      const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist }, sb.paths));
      assert.equal(res.CODE, "cron-failed");
      assert.equal(sb.lockText(), null, "nothing is capped before the crontab is known");
    }
    assert.equal(sb.run(buildResetProgram(sb.paths)).CODE, "cron-failed");
    assert.equal(sb.cronText(), jobs);
    assert.doesNotMatch(sb.calls(), /crontab (-r|\/)/);
  } finally {
    sb.cleanup();
  }
});

test("with root but neither systemd nor cron, keeping the cap is refused before anything is capped", () => {
  const sb = sandbox();
  try {
    fs.rmSync(path.join(sb.root, "systemd"), { recursive: true });
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    assert.equal(res.RESULT, "error");
    assert.equal(res.CODE, "no-systemd");
    assert.equal(sb.lockText(), null);
    assert.doesNotMatch(sb.calls(), /-lgc 0,1800/);
    assert.equal(sb.read(`units/${UNIT_NAME}`), null);
    assert.equal(sb.cronText(), "");
  } finally {
    sb.cleanup();
  }
});

test("with only the narrow rule, a leftover boot service blocks the @reboot job before anything is capped", () => {
  const sb = sandbox({ narrowSudo: true, cron: true });
  try {
    const jobs = "0 4 * * * /usr/local/bin/backup.sh\n";
    sb.write("crontab", jobs);
    sb.write(`units/${UNIT_NAME}`, OLD_UNIT);
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    assert.equal(res.RESULT, "error");
    assert.equal(res.CODE, "service-failed");
    assert.match(res.MSG, /NOPASSWD: ALL/);
    assert.equal(sb.lockText(), null);
    assert.doesNotMatch(sb.calls(), /-lgc 0,1800/);
    assert.equal(sb.cronText(), jobs);
    assert.equal(sb.read(`units/${UNIT_NAME}`), OLD_UNIT);
  } finally {
    sb.cleanup();
  }
});

test("a crontab that stores the @reboot job with other clocks is reported as not installed and cleaned up", () => {
  const sb = sandbox({ narrowSudo: true, cron: true, cronMangles: true });
  try {
    const jobs = "0 4 * * * /usr/local/bin/backup.sh\n";
    sb.write("crontab", jobs);
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    assert.equal(res.RESULT, "error");
    assert.equal(res.CODE, "cron-failed");
    assert.match(res.MSG, /did not install/);
    // The message promises the cap holds until the next reboot: it does.
    assert.equal(sb.lockText(), "0,1800");
    assert.doesNotMatch(sb.cronText(), /sparkdash-gpu-clock-cap/);
    assert.equal(sb.cronText(), jobs);
  } finally {
    sb.cleanup();
  }
});

/** Run the installed @reboot line the way cron would after a reboot (minus the boot-time sleep). */
function runRebootLine(sb) {
  const line = sb.cronText().split("\n").find((l) => l.startsWith("@reboot"));
  return sb.shell(line.replace(/^@reboot /, "").replace(/\/bin\/sleep 20; /g, ""));
}

test("an @reboot job that cannot re-apply the cap at boot says so: failure marker, log line, status, cleared by the next good boot", () => {
  const sb = sandbox({ narrowSudo: true, cron: true });
  try {
    sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    assert.equal(sb.run(buildStatusProgram(sb.paths)).CRON_FAILED, "0");

    // A reboot, and sudo no longer lets nvidia-smi through.
    fs.rmSync(path.join(sb.root, "lock"));
    sb.write("boot_id", "22222222-3333-4444-5555-666666666666\n");
    fs.writeFileSync(path.join(sb.bin, "nvidia-smi"), '#!/bin/sh\necho "refused" >&2\nexit 4\n', { mode: 0o755 });
    runRebootLine(sb);
    assert.equal(sb.lockText(), null, "the cap was not re-applied");
    assert.equal(sb.read(`run/${MARKER_FILE}.failed`).trim(), "22222222-3333-4444-5555-666666666666");
    assert.match(sb.calls(), /^logger -t sparkdash GPU clock cap 1800 MHz was not applied at boot$/m);
    const failed = sb.run(buildStatusProgram(sb.paths));
    assert.equal(failed.CRON_INSTALLED, "1");
    assert.equal(failed.CRON_FAILED, "1");

    // The failure belongs to that boot: after the next one, with nothing run yet, it is stale.
    sb.write("boot_id", "33333333-4444-5555-6666-777777777777\n");
    assert.equal(sb.run(buildStatusProgram(sb.paths)).CRON_FAILED, "0");

    // A boot where the cap goes through clears it.
    fs.writeFileSync(path.join(sb.bin, "nvidia-smi"), '#!/bin/sh\ncase "$1" in -lgc) echo "$2" > ' + path.join(sb.root, "lock") + " ;; esac\n", {
      mode: 0o755,
    });
    sb.write("boot_id", "22222222-3333-4444-5555-666666666666\n");
    runRebootLine(sb);
    assert.equal(sb.lockText(), "0,1800");
    assert.equal(sb.read(`run/${MARKER_FILE}.failed`), null);
    assert.equal(sb.run(buildStatusProgram(sb.paths)).CRON_FAILED, "0");
  } finally {
    sb.cleanup();
  }
});

test("a failure marker is cleared by Apply and by Remove, and never reported without the job", () => {
  for (const second of ["apply", "reset"]) {
    const sb = sandbox({ narrowSudo: true, cron: true });
    try {
      sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
      sb.write(`run/${MARKER_FILE}.failed`, "11111111-2222-3333-4444-555555555555\n");
      assert.equal(sb.run(buildStatusProgram(sb.paths)).CRON_FAILED, "1");
      if (second === "apply") sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 2000, persist: true }, sb.paths));
      else sb.run(buildResetProgram(sb.paths));
      assert.equal(sb.read(`run/${MARKER_FILE}.failed`), null, second);
      assert.equal(sb.run(buildStatusProgram(sb.paths)).CRON_FAILED, "0", second);
    } finally {
      sb.cleanup();
    }
  }
  // A leftover marker with no job installed is not a failed job.
  const sb = sandbox({ narrowSudo: true, cron: true });
  try {
    sb.write(`run/${MARKER_FILE}.failed`, "11111111-2222-3333-4444-555555555555\n");
    assert.equal(sb.run(buildStatusProgram(sb.paths)).CRON_FAILED, "0");
  } finally {
    sb.cleanup();
  }
});

test("a sudo path with characters a crontab line cannot carry is refused before anything changes", () => {
  const sb = sandbox({ narrowSudo: true, cron: true });
  try {
    const jobs = "0 4 * * * /usr/local/bin/backup.sh\n";
    sb.write("crontab", jobs);
    // A `sudo` found first on PATH under a directory with a space and a `;`.
    const odd = path.join(sb.root, "odd dir;x");
    fs.mkdirSync(odd);
    fs.copyFileSync(path.join(sb.bin, "sudo"), path.join(odd, "sudo"));
    fs.chmodSync(path.join(odd, "sudo"), 0o755);
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths), {
      env: { PATH: `${odd}:${sb.bin}:${process.env.PATH}` },
    });
    assert.equal(res.RESULT, "error");
    assert.equal(res.CODE, "cron-failed");
    assert.match(res.MSG, /cannot be put in a crontab safely/);
    assert.equal(sb.lockText(), null, "the GPU was not touched");
    assert.equal(sb.cronText(), jobs);
    assert.doesNotMatch(sb.calls(), /-lgc 0,1800/);
  } finally {
    sb.cleanup();
  }
});

test("only the line that ends in our tag is ours: user lines that mention it are kept", () => {
  const sb = sandbox({ narrowSudo: true, cron: true });
  try {
    const jobs = [
      "0 4 * * * /usr/local/bin/backup.sh # sparkdash-gpu-clock-cap is not ours here",
      "@reboot /usr/local/bin/notify.sh # note about sparkdash-gpu-clock-cap",
      "# sparkdash-gpu-clock-cap",
      "",
    ].join("\n");
    sb.write("crontab", jobs);
    assert.equal(sb.run(buildStatusProgram(sb.paths)).CRON_INSTALLED, "0");
    sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    assert.equal(sb.run(buildStatusProgram(sb.paths)).CRON_INSTALLED, "1");
    sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 2000, persist: true }, sb.paths));
    assert.equal(sb.cronText().split("\n").filter((l) => l.startsWith("@reboot ") && l.includes("-lgc")).length, 1);
    sb.run(buildResetProgram(sb.paths));
    assert.equal(sb.cronText(), jobs);
  } finally {
    sb.cleanup();
  }
});

test("a cap without keep-after-reboot is recorded before old hooks go, and a hook that cannot be removed is named", () => {
  const sb = sandbox({ narrowSudo: true, cron: true });
  try {
    sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    // The crontab can no longer be written: the old @reboot job cannot be dropped.
    sb.write("crontab.readonly", "");
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 2000, persist: false }, sb.paths));
    assert.equal(res.RESULT, "error");
    assert.equal(res.CODE, "cron-failed");
    assert.match(res.MSG, /cap is applied until the next reboot, but the existing @reboot job could not be removed and will re-apply its own cap at boot/);
    assert.equal(sb.lockText(), "0,2000", "the cap that was asked for is in force");
    assert.equal(sb.run(buildStatusProgram(sb.paths)).CAP, "2000", "and the status reads it, not the stale one");
    assert.match(sb.cronText(), /-lgc 0,1800/, "the stale job is still there, as the error says");
  } finally {
    sb.cleanup();
  }
});

test("with root but no systemd, keeping the cap falls back to the @reboot job", () => {
  const sb = sandbox({ cron: true });
  try {
    fs.rmSync(path.join(sb.root, "systemd"), { recursive: true });
    assert.equal(sb.run(buildStatusProgram(sb.paths)).PERSIST_KIND, "cron");
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    assert.equal(res.RESULT, "ok");
    assert.equal(res.PERSIST_KIND, "cron");
    assert.match(sb.cronText(), /-lgc 0,1800/);
    assert.equal(sb.read(`units/${UNIT_NAME}`), null);
  } finally {
    sb.cleanup();
  }
});

test("installing the boot service removes an @reboot job left from a narrower rule", () => {
  const sb = sandbox({ narrowSudo: true, cron: true });
  try {
    sb.write("crontab", "0 4 * * * /usr/local/bin/backup.sh\n");
    sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    // The fleet is granted NOPASSWD: ALL: the next keep-after-reboot takes the service.
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 2000, persist: true }, { ...sb.paths, sandboxSudo: "" }));
    assert.equal(res.RESULT, "ok");
    assert.equal(res.PERSIST_KIND, "unit");
    assert.match(sb.read(`units/${UNIT_NAME}`), /-lgc 0,2000/);
    assert.equal(sb.cronText(), "0 4 * * * /usr/local/bin/backup.sh\n");
  } finally {
    sb.cleanup();
  }
});

test("a dropped connection keeps the unit busy for the hold time, then frees it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let n = 0;
  const m = new GpuClockManager({
    holdMs: 60,
    run: async () => { n += 1; if (n === 1) throw new Error("timeout"); return "RESULT=ok\nCAP=1800\nPERSIST=0"; },
  });
  const spark = { id: "s1", kind: "spark" };
  await assert.rejects(m.apply(spark, { maxMHz: 1800 }), (e) => e.status === 502);
  t.mock.timers.tick(59);
  await assert.rejects(m.apply(spark, { maxMHz: 1800 }), (e) => e.status === 409);
  t.mock.timers.tick(1);
  assert.equal((await m.apply(spark, { maxMHz: 1800 })).capMHz, 1800);
});

test("manual command: plain sudo that prompts, readable output, runs end to end", () => {
  const sb = sandbox();
  try {
    const cmd = buildManualCommand("apply", { maxMHz: 1800, persist: true }, sb.paths);
    sb.shell(cmd);
    assert.equal(sb.read("lock").trim(), "0,1800");
    assert.equal(sb.read(`run/${MARKER_FILE}`).trim().startsWith("1800 "), true);

    sb.shell(buildManualCommand("reset", {}, sb.paths));
    assert.equal(sb.read(`units/${UNIT_NAME}`), null);
  } finally {
    sb.cleanup();
  }
});

test("manual command: a refusal prints the reason and exits non-zero", () => {
  const sb = sandbox({ hwMax: 2418 });
  try {
    const cmd = buildManualCommand("apply", { maxMHz: 3000, persist: false }, sb.paths);
    let err;
    try {
      sb.exec(cmd, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "must fail");
    assert.equal(err.status, 1);
    assert.match(err.stderr, /Error: the cap is above this GPU's maximum clock \(2418 MHz\)/);
    assert.equal(sb.read("lock"), null);
  } finally {
    sb.cleanup();
  }
});

test("manual command: validated like the API, and the dashboard-side manager needs no access to the unit", () => {
  assert.throws(() => buildManualCommand("apply", { maxMHz: "1800; id" }), (e) => e.status === 400);
  assert.throws(() => buildManualCommand("apply", { maxMHz: 100 }), (e) => e.status === 400);
  assert.throws(() => buildManualCommand("explode", {}), (e) => e.status === 400);
  const m = new GpuClockManager({ run: async () => { throw new Error("must not touch the unit"); } });
  const spark = { id: "s1", kind: "spark" };
  assert.match(m.command(spark, { action: "apply", maxMHz: "1800", persist: "1" }).command, /MAX=1800; PERSIST=1/);
  assert.match(m.command(spark, { action: "reset" }).command, /Done: GPU clock cap removed/);
  for (const bad of [{}, { action: "apply" }, { action: "apply", maxMHz: "18x0" }, { action: "apply", maxMHz: "1800", minMHz: "-1" }, { action: "apply", maxMHz: ["1800"] }]) {
    assert.throws(() => m.command(spark, bad), (e) => e.status === 400, JSON.stringify(bad));
  }
  assert.throws(() => m.command({ id: "h", kind: "host" }, { action: "reset" }), (e) => e.status === 400);
});

/** Fake `sudo -S -p ''`: reads one line from stdin, accepts only the right password. */
function installFakeSudo(sb, secret = "s3cret") {
  const log = path.join(sb.root, "sudo.log");
  fs.writeFileSync(
    path.join(sb.bin, "sudo"),
    `#!/bin/sh
echo "sudo $*" >> ${log}
S=0
while [ $# -gt 0 ]; do case "$1" in -k) shift ;; -S) S=1; shift ;; -p) shift 2 ;; *) break ;; esac; done
pw=""; [ "$S" = 1 ] && read -r pw
[ "$pw" = "${secret}" ] || exit 1
exec "$@"
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(path.join(sb.bin, "install"), `#!/bin/sh\nargs=""\nwhile [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) args="$args $1"; shift ;; esac; done\nexec /usr/bin/install $args\n`, { mode: 0o755 });
  return log;
}

const pwPaths = (sb) => ({ ...sb.paths, sandbox: false, systemctl: "systemctl", password: true });
const pwEnv = (sb, pw) => ({ ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, SPARKDASH_SUDO_PW: pw });

test("with a sudo password: every privileged step pipes it to sudo -S, and nothing else ever sees it", () => {
  const sb = sandbox();
  try {
    const log = installFakeSudo(sb);
    const program = buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, pwPaths(sb));
    assert.doesNotMatch(program, /s3cret/);
    const res = sb.run(program, { env: pwEnv(sb, "s3cret") });
    assert.equal(res.RESULT, "ok");
    assert.equal(sb.read("lock").trim(), "0,1800");
    const calls = fs.readFileSync(log, "utf8");
    assert.doesNotMatch(calls, /s3cret/, "the password is never an argument");
    assert.match(calls, /sudo -S -p  .*nvidia-smi -lgc 0,1800|sudo -S -p .*nvidia-smi -lgc 0,1800/);
    assert.match(sb.calls(), /nvidia-smi -lgc 0,1800 env=unset/, "children do not inherit the password");
    assert.doesNotMatch(sb.calls(), /s3cret/);
    assert.equal(sb.read(`units/${UNIT_NAME}`).includes("-lgc 0,1800"), true);
  } finally {
    sb.cleanup();
  }
});

test("a wrong sudo password is reported as such and changes nothing", () => {
  const sb = sandbox();
  try {
    installFakeSudo(sb);
    for (const prog of [
      buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, pwPaths(sb)),
      buildResetProgram(pwPaths(sb)),
    ]) {
      const res = sb.run(prog, { env: pwEnv(sb, "nope") });
      assert.equal(res.CODE, "bad-password");
      assert.match(res.MSG, /password was not accepted/);
    }
    assert.equal(sb.read("lock"), null);
    assert.equal(sb.read(`units/${UNIT_NAME}`), null);
    assert.equal(sb.read(`run/${MARKER_FILE}`), null);
    // No password at all is also just "not accepted".
    const none = sb.run(buildResetProgram(pwPaths(sb)), { env: { ...pwEnv(sb, ""), SPARKDASH_SUDO_PW: "" } });
    assert.equal(none.CODE, "bad-password");
  } finally {
    sb.cleanup();
  }
});

test("the ssh wrapper reads the password from stdin into the program's environment, not from argv", () => {
  const program = 'printf "%s|" "${SPARKDASH_SUDO_PW-none}"';
  const withPw = remoteCommand(true);
  assert.doesNotMatch(withPw, /hunter2/);
  const out = execFileSync("sh", ["-c", withPw], { input: remoteInput(program, "hunter2"), encoding: "utf8" });
  assert.equal(out, "hunter2|");
  assert.equal(execFileSync("sh", ["-c", remoteCommand(false)], { encoding: "utf8", input: remoteInput(program) }), "none|");
  // A password with shell metacharacters stays data.
  const odd = "a b'c\"d$(id)`x`;&|\\%s";
  assert.equal(execFileSync("sh", ["-c", withPw], { input: remoteInput(program, odd), encoding: "utf8" }), `${odd}|`);
});

test("the ssh command line stays short however large the program: the program travels on stdin", () => {
  // A Windows host refuses a command line past ~32 K (spawn ENAMETOOLONG); the storage programs exceed it.
  const program = `printf '%s' ok; : '${"x".repeat(100_000)}'`;
  for (const withPw of [false, true]) {
    assert.ok(remoteCommand(withPw).length < 200);
    assert.doesNotMatch(remoteCommand(withPw), /x{100}/);
  }
  assert.equal(execFileSync("sh", ["-c", remoteCommand(false)], { input: remoteInput(program), encoding: "utf8" }), "ok");
  assert.equal(execFileSync("sh", ["-c", remoteCommand(true)], { input: remoteInput(program, "pw"), encoding: "utf8" }), "ok");
});

test("parseSudoPassword: a single line, bounded; anything else is a 400", () => {
  assert.equal(parseSudoPassword(undefined), null);
  assert.equal(parseSudoPassword(""), null);
  assert.equal(parseSudoPassword("p@ss w0rd 'x\""), "p@ss w0rd 'x\"");
  for (const bad of ["a\nb", "a\rb", "a\u0000b", "x".repeat(257), 12345, {}, ["a"], true]) {
    assert.throws(() => parseSudoPassword(bad), (e) => e.status === 400, JSON.stringify(bad));
  }
});

test("GpuClockManager: the password goes to the runner as input only, is redacted from errors, and repeated wrong ones lock the unit", async () => {
  let t = 1_000_000;
  const seen = [];
  let answer = "RESULT=error\nCODE=bad-password\nMSG=the sudo password was not accepted";
  const m = new GpuClockManager({
    now: () => t,
    run: async (_s, program, opts) => {
      seen.push({ program, input: opts.input });
      if (answer === "THROW") throw new Error("SSH to 10.0.0.2 failed: stdin said hunter2xyz");
      return answer;
    },
  });
  const spark = { id: "s1", name: "S1", kind: "spark" };

  await assert.rejects(m.apply(spark, { maxMHz: 1800, sudoPassword: "hunter2xyz" }), (e) => e.status === 403 && e.code === "bad-password");
  assert.equal(seen[0].input, "hunter2xyz");
  assert.doesNotMatch(seen[0].program, /hunter2xyz/);
  assert.match(seen[0].program, /spw_sudo/);

  await assert.rejects(m.reset(spark, { sudoPassword: "wrong2" }), (e) => e.status === 403);
  await assert.rejects(m.apply(spark, { maxMHz: 1800, sudoPassword: "wrong3" }), (e) => e.status === 403);
  const callsBefore = seen.length;
  await assert.rejects(m.apply(spark, { maxMHz: 1800, sudoPassword: "wrong4" }), (e) => e.status === 429 && e.code === "password-locked");
  assert.equal(seen.length, callsBefore, "a locked unit never reaches the unit");
  // Without a password it is not locked (that path has no password to guess).
  answer = "RESULT=ok\nCAP=1800\nPERSIST=0";
  assert.equal((await m.apply(spark, { maxMHz: 1800 })).capMHz, 1800);
  assert.doesNotMatch(seen.at(-1).program, /spw_sudo/);
  t += 5 * 60_000 + 1;
  assert.equal((await m.apply(spark, { maxMHz: 1800, sudoPassword: "right" })).capMHz, 1800);
  // Success clears the count.
  answer = "RESULT=error\nCODE=bad-password\nMSG=x";
  await assert.rejects(m.apply(spark, { maxMHz: 1800, sudoPassword: "w" }));
  await assert.rejects(m.apply(spark, { maxMHz: 1800, sudoPassword: "w" }));
  answer = "RESULT=ok\nCAP=1800\nPERSIST=0";
  await m.apply(spark, { maxMHz: 1800, sudoPassword: "right" });
  answer = "RESULT=error\nCODE=bad-password\nMSG=x";
  await assert.rejects(m.apply(spark, { maxMHz: 1800, sudoPassword: "w" }), (e) => e.status === 403);

  answer = "THROW";
  const e = await m.apply(spark, { maxMHz: 1800, sudoPassword: "hunter2xyz" }).catch((x) => x);
  assert.equal(e.status, 502);
  assert.doesNotMatch(e.message, /hunter2xyz/);
  assert.match(e.message, /\*\*\*/);
});

test("sudo refusals that are not a wrong password do not read as one", () => {
  const sb = sandbox();
  try {
    fs.writeFileSync(path.join(sb.bin, "sudo"), "#!/bin/sh\necho 'sudo: you must have a tty to run sudo' >&2\nexit 1\n", { mode: 0o755 });
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: false }, pwPaths(sb)), { env: pwEnv(sb, "whatever") });
    assert.equal(res.CODE, "no-sudo");
    assert.match(res.MSG, /sudo refused the request: sudo: you must have a tty to run sudo/);
    fs.writeFileSync(path.join(sb.bin, "sudo"), "#!/bin/sh\necho 'Sorry, try again.' >&2\nexit 1\n", { mode: 0o755 });
    const wrong = sb.run(buildResetProgram(pwPaths(sb)), { env: pwEnv(sb, "whatever") });
    assert.equal(wrong.CODE, "bad-password");
    assert.equal(sb.read("lock"), null);
  } finally {
    sb.cleanup();
  }
});

test("the password is read before anything else runs", () => {
  const prog = buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: false }, { password: true });
  const lines = prog.split("\n");
  assert.equal(lines[0], "set -u");
  assert.match(lines[1], /^PW=\$\{SPARKDASH_SUDO_PW-\}$/);
  assert.equal(lines[2], "unset SPARKDASH_SUDO_PW");
  assert.ok(lines.findIndex((l) => l.includes("id -u")) > 2);
});

test("the password lock follows the account on the machine, not the registry entry, and has a global cap", async () => {
  let t = 5_000_000;
  const m = new GpuClockManager({
    now: () => t,
    run: async () => "RESULT=error\nCODE=bad-password\nMSG=x",
  });
  const mk = (id, extra = {}) => ({ id, name: id, kind: "spark", lanIp: "10.0.0.7", ssh: { user: "zurih", host: "10.0.0.7", port: 22 }, ...extra });
  const wrong = (sp) => m.apply(sp, { maxMHz: 1800, sudoPassword: "x" });
  for (let i = 0; i < 3; i++) await assert.rejects(wrong(mk("a")), (e) => e.status === 403);
  // A second entry for the same account is locked too: no fresh guesses by re-adding the unit.
  await assert.rejects(wrong(mk("b")), (e) => e.status === 429);
  await assert.rejects(wrong(mk("c", { ssh: { user: "ZURIH", host: "10.0.0.7", port: 22 } })), (e) => e.status === 429);
  // A different account is separate, until the global budget (9) is spent.
  const others = [mk("d", { ssh: { user: "u1", host: "10.0.0.8", port: 22 } }), mk("e", { ssh: { user: "u2", host: "10.0.0.9", port: 22 } })];
  for (const sp of others) for (let i = 0; i < 3; i++) await assert.rejects(wrong(sp), (e) => e.status === 403);
  await assert.rejects(wrong(mk("f", { ssh: { user: "u3", host: "10.0.0.10", port: 22 } })), (e) => e.status === 429, "global cap");
  t += 5 * 60_000 + 1;
  await assert.rejects(wrong(mk("f", { ssh: { user: "u3", host: "10.0.0.10", port: 22 } })), (e) => e.status === 403, "expired");
});

/** A reboot, then the installed @reboot line run with a fake sleep: before the job's
 * Nth attempt it runs `hooks[N]` — what the dashboard might do during the boot wait —
 * and logs `woke N`, so the calls the job itself makes afterwards can be told apart. */
function rebootWithSleeps(sb, hooks = {}) {
  fs.rmSync(path.join(sb.root, "lock"), { force: true });
  sb.write("boot_id", "22222222-3333-4444-5555-666666666666\n");
  for (const [n, program] of Object.entries(hooks)) sb.write(`onsleep${n}`, program);
  const sleep = path.join(sb.bin, "fake-sleep");
  fs.writeFileSync(
    sleep,
    `#!/bin/sh
n=$(cat ${sb.root}/sleeps 2>/dev/null || echo 0); n=$((n + 1)); echo $n > ${sb.root}/sleeps
[ -f ${sb.root}/onsleep$n ] && sh ${sb.root}/onsleep$n >/dev/null
echo "woke $n" >> ${sb.root}/calls.log
`,
    { mode: 0o755 }
  );
  const line = sb.cronText().split("\n").find((l) => l.startsWith("@reboot"));
  return sb.shell(line.replace(/^@reboot /, "").replaceAll("/bin/sleep 20", sleep));
}

test("an @reboot job whose line is dropped or replaced while it waits exits without touching the GPU or the markers", () => {
  const boot2 = "22222222-3333-4444-5555-666666666666";
  const cases = [
    ["remove", (sb) => buildResetProgram(sb.paths), null],
    ["apply without keep", (sb) => buildApplyProgram({ minMHz: 0, maxMHz: 2000, persist: false }, sb.paths), 2000],
    ["apply another cap", (sb) => buildApplyProgram({ minMHz: 0, maxMHz: 2000, persist: true }, sb.paths), 2000],
    // Same clocks, but a new install: the job that was waiting is still not the one in the crontab.
    ["re-apply the same cap", (sb) => buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths), 1800],
  ];
  for (const [what, second, cap] of cases) {
    const sb = sandbox({ narrowSudo: true, cron: true });
    try {
      sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
      const oldLine = sb.cronText();
      rebootWithSleeps(sb, { 1: second(sb) });
      assert.equal(sb.read("sleeps").trim(), "1", `${what}: the job stopped at its first wake`);
      const after = sb.calls().split("woke 1\n")[1];
      assert.doesNotMatch(after, /nvidia-smi|logger/, `${what}: the superseded job did not cap or log`);
      assert.equal(sb.lockText(), cap === null ? null : `0,${cap}`, what);
      assert.equal(sb.read(`run/${MARKER_FILE}`), cap === null ? null : `${cap} ${boot2}\n`, what);
      assert.equal(sb.read(`run/${MARKER_FILE}.failed`), null, what);
      assert.notEqual(sb.cronText(), oldLine, `${what}: the old line is gone`);
      const status = sb.run(buildStatusProgram(sb.paths));
      assert.equal(status.CAP, cap === null ? "" : String(cap), what);
      assert.equal(status.CRON_FAILED, "0", what);
    } finally {
      sb.cleanup();
    }
  }
});

test("sandbox manual and password programs cannot discover the caller's crontab or home marker", () => {
  const caller = fs.mkdtempSync(path.join(os.tmpdir(), "gpuclock-caller-"));
  const oldHome = process.env.HOME;
  const oldPath = process.env.PATH;
  let sb;
  try {
    fs.mkdirSync(path.join(caller, "bin"));
    fs.mkdirSync(path.join(caller, ".config", "sparkdash"), { recursive: true });
    const marker = path.join(caller, ".config", "sparkdash", MARKER_FILE);
    fs.writeFileSync(marker, "caller cap must survive\n");
    fs.writeFileSync(path.join(caller, "bin", "crontab"), `#!/bin/sh\necho invoked >> ${caller}/called\nexit 1\n`, { mode: 0o755 });
    process.env.HOME = caller;
    process.env.PATH = `${caller}/bin:${oldPath}`;
    sb = sandbox();
    sb.shell(buildManualCommand("apply", { maxMHz: 1800, persist: true }, sb.paths));
    sb.shell(buildManualCommand("reset", {}, sb.paths));
    installFakeSudo(sb);
    assert.equal(sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 2100, persist: true }, pwPaths(sb)), { env: pwEnv(sb, "s3cret") }).RESULT, "ok");
    assert.equal(sb.lockText(), "0,2100");
    assert.equal(fs.readFileSync(marker, "utf8"), "caller cap must survive\n");
    assert.equal(fs.existsSync(path.join(caller, "called")), false);
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    sb?.cleanup();
    fs.rmSync(caller, { recursive: true, force: true });
  }
});

test("service-file removal failure restores the cap and marker, or reports the failed restoration", () => {
  for (const restoration of ["ok", "lgc-failed", "marker-failed"]) {
    const sb = sandbox();
    try {
      assert.equal(sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths)).RESULT, "ok");
      const denied = path.join(sb.root, "restoration-denied");
      fs.writeFileSync(path.join(sb.bin, "rm"), `#!/bin/sh\nfor p in "$@"; do [ "$p" != ${sb.paths.unitDir}/${UNIT_NAME} ] || { : > ${denied}; exit 1; }; done\nexec /bin/rm "$@"\n`, { mode: 0o755 });
      if (restoration === "lgc-failed") {
        fs.writeFileSync(path.join(sb.bin, "nvidia-smi"), `#!/bin/sh\ncase "$1" in --query-gpu=clocks.max.gr) echo 3003 ;; -lgc) [ ! -f ${denied} ] || { echo refused >&2; exit 4; }; echo "$2" > ${sb.root}/lock ;; -rgc) /bin/rm -f ${sb.root}/lock ;; esac\n`, { mode: 0o755 });
      }
      if (restoration === "marker-failed") {
        fs.writeFileSync(path.join(sb.bin, "chmod"), `#!/bin/sh\n[ ! -f ${denied} ] || exit 1\nexec /bin/chmod "$@"\n`, { mode: 0o755 });
      }
      const result = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 2000, persist: false }, sb.paths));
      assert.equal(result.RESULT, "error");
      assert.equal(result.CODE, restoration === "ok" ? "service-failed" : restoration);
      assert.notEqual(sb.read(`units/${UNIT_NAME}`), null);
      if (restoration === "ok") {
        assert.equal(sb.lockText(), "0,2000");
        assert.equal(sb.run(buildStatusProgram(sb.paths)).CAP, "2000");
      } else if (restoration === "lgc-failed") {
        assert.equal(sb.lockText(), null);
        assert.equal(sb.read(`run/${MARKER_FILE}`), null);
        assert.match(result.MSG, /restoring the live cap failed/);
      } else {
        assert.equal(sb.lockText(), "0,2000");
        assert.equal(sb.read(`run/${MARKER_FILE}`), null);
        assert.match(result.MSG, /marker could not be recorded/);
      }
    } finally {
      sb.cleanup();
    }
  }
});

test("an unreadable installed crontab fails status without hiding or modifying its hook", () => {
  const sb = sandbox({ narrowSudo: true, cron: true });
  try {
    assert.equal(sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths)).RESULT, "ok");
    const before = sb.cronText();
    sb.write("crontab.broken", "");
    const status = sb.run(buildStatusProgram(sb.paths));
    assert.equal(status.RESULT, "error");
    assert.equal(status.CODE, "cron-failed");
    assert.equal(sb.cronText(), before);
    assert.equal(sb.lockText(), "0,1800");
  } finally {
    sb.cleanup();
  }
});

test("a reboot job cannot change clocks or markers without verifying its installed token", () => {
  const sb = sandbox({ narrowSudo: true, cron: true });
  try {
    sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    const marker = sb.read(`run/${MARKER_FILE}`);
    rebootWithSleeps(sb, { 1: `: > ${sb.root}/crontab.broken` });
    assert.equal(sb.lockText(), null);
    assert.equal(sb.read(`run/${MARKER_FILE}`), marker);
    assert.equal(sb.read(`run/${MARKER_FILE}.failed`), null);
    assert.match(sb.calls(), /logger .*crontab could not be read/);
    assert.equal(sb.run(buildStatusProgram(sb.paths)).CODE, "cron-failed");
  } finally {
    sb.cleanup();
  }
});

test("cron persistence refuses password-only NVIDIA permission even with cached authentication", () => {
  const sb = sandbox({ cron: true });
  try {
    const allowed = path.join(sb.root, "nopasswd");
    const cached = path.join(sb.root, "cached");
    fs.writeFileSync(path.join(sb.bin, "sudo"), `#!/bin/sh
K=0; S=0
while [ $# -gt 0 ]; do case "$1" in -k) K=1; shift ;; -n) shift ;; -S) S=1; shift ;; -p) shift 2 ;; *) break ;; esac; done
if [ "$S" = 1 ]; then read -r pw; [ "$pw" = s3cret ] || exit 1; : > ${cached}; fi
case "$1" in
  true) [ "$S" = 1 ] && exit 0 ;;
  -l) exit 0 ;;
  ${sb.bin}/nvidia-smi)
    [ "$S" = 1 ] || [ -f ${allowed} ] || { [ "$K" = 0 ] && [ -f ${cached} ]; } || { echo 'sudo: a password is required' >&2; exit 1; }
    exec "$@" ;;
esac
exit 1
`, { mode: 0o755 });
    const paths = pwPaths(sb);
    const env = pwEnv(sb, "s3cret");
    assert.equal(sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 2100, persist: false }, paths), { env }).RESULT, "ok");
    const marker = sb.read(`user-home/.config/sparkdash/${MARKER_FILE}`);
    const denied = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, paths), { env });
    assert.equal(denied.CODE, "no-sudo");
    assert.equal(sb.lockText(), "0,2100");
    assert.equal(sb.read(`user-home/.config/sparkdash/${MARKER_FILE}`), marker);
    assert.equal(sb.cronText(), "");
    sb.write("nopasswd", "");
    assert.equal(sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, paths), { env }).PERSIST_KIND, "cron");
    fs.rmSync(cached);
    rebootWithSleeps(sb);
    assert.equal(sb.lockText(), "0,1800");
    assert.equal(sb.run(buildStatusProgram(paths), { env }).CAP, "1800");
  } finally {
    sb.cleanup();
  }
});

test("an authorized NVIDIA rejection on the cron path remains a clock error, not an authorization error", () => {
  const sb = sandbox({ narrowSudo: true, cron: true, lgcFails: true });
  try {
    const result = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    assert.equal(result.CODE, "lgc-failed");
    assert.equal(sb.lockText(), null);
    assert.equal(sb.cronText(), "");
    assert.equal(sb.read(`run/${MARKER_FILE}`), null);
  } finally {
    sb.cleanup();
  }
});

test("missing flock refuses Apply and Remove before changing an existing cap or hook", () => {
  const sb = sandbox({ narrowSudo: true, cron: true });
  try {
    sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    const hook = sb.cronText();
    for (const program of [
      buildApplyProgram({ minMHz: 0, maxMHz: 2000, persist: true }, { ...sb.paths, flock: [] }),
      buildResetProgram({ ...sb.paths, flock: [] }),
    ]) {
      assert.equal(sb.run(program).CODE, "lock-failed");
      assert.equal(sb.lockText(), "0,1800");
      assert.equal(sb.cronText(), hook);
      assert.equal(sb.run(buildStatusProgram(sb.paths)).CAP, "1800");
    }
  } finally {
    sb.cleanup();
  }
});

const waitForFile = async (file) => {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(file)) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("Reset and newer Apply wait for an in-flight reboot GPU command before replacing its state", { timeout: 20000 }, async () => {
  for (const next of [null, 2000, 1800]) {
    const sb = sandbox({ narrowSudo: true, cron: true });
    const children = [];
    try {
      const flock = path.join(sb.bin, "flock");
      fs.writeFileSync(flock, `#!/bin/sh\n[ "\${GPU_LOCK_ACTOR-}" != dashboard ] || : > ${sb.root}/dashboard-waiting\nexec /usr/bin/flock "$@"\n`, { mode: 0o755 });
      const paths = { ...sb.paths, flock: [flock] };
      assert.equal(sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, paths)).RESULT, "ok");
      fs.writeFileSync(path.join(sb.bin, "nvidia-smi"), `#!/bin/sh
case "$1" in
  --query-gpu=clocks.max.gr) echo 3003 ;;
  -lgc) : > ${sb.root}/gpu-started
        while [ ! -f ${sb.root}/gpu-release ]; do /bin/sleep 0.01; done
        echo "$2" > ${sb.root}/lock ;;
  -rgc) /bin/rm -f ${sb.root}/lock ;;
esac
`, { mode: 0o755 });
      sb.write("boot_id", "22222222-3333-4444-5555-666666666666\n");
      sb.write("lock", "0,2400\n");
      const start = (program, env) => {
        const child = spawn("sh", ["-c", program], { env: sb.environment(env) });
        children.push(child);
        let out = "";
        let err = "";
        child.stdout.on("data", (data) => { out += data; });
        child.stderr.on("data", (data) => { err += data; });
        return new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) => resolve({ code, out, err }));
        });
      };
      const job = sb.cronText().trim().replace(/^@reboot /, "").replaceAll("/bin/sleep 20", "/bin/sleep 0");
      const reboot = start(job);
      await waitForFile(path.join(sb.root, "gpu-started"));
      const dashboard = start(next === null ? buildResetProgram(paths) : buildApplyProgram({ minMHz: 0, maxMHz: next, persist: true }, paths), { GPU_LOCK_ACTOR: "dashboard" });
      await waitForFile(path.join(sb.root, "dashboard-waiting"));
      assert.equal(sb.lockText(), "0,2400", "the dashboard cannot mutate hardware while the reboot command holds the lock");
      sb.write("gpu-release", "");
      const [bootResult, result] = await Promise.all([reboot, dashboard]);
      assert.equal(bootResult.code, 0, bootResult.err);
      assert.equal(result.code, 0, result.err);
      assert.equal(parseProgramOutput(result.out).RESULT, "ok");
      assert.equal(sb.lockText(), next === null ? null : `0,${next}`);
      assert.equal(sb.run(buildStatusProgram(paths)).CAP, next === null ? "" : String(next));
      assert.equal(sb.read(`run/${MARKER_FILE}.failed`), null);
      if (next === null) assert.equal(sb.cronText(), "");
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
      sb.cleanup();
    }
  }
});
