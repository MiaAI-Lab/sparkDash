import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProgramOutput } from "../commands.js";
import {
  buildPowerApplyProgram,
  buildPowerStatusProgram,
  parseBootLimits,
  parseCards,
  parsePowerRequest,
  POWER_UNIT_NAME,
} from "../powerCommands.js";
import { GpuClockManager, assertPowerSupported } from "../GpuClockManager.js";

const A = "GPU-aaaaaaaa-0000-0000-0000-000000000001";
const B = "GPU-bbbbbbbb-0000-0000-0000-000000000002";
const FIXED = "GPU-cccccccc-0000-0000-0000-000000000003";
const NAME = "NVIDIA RTX PRO 6000 Blackwell Workstation Edition";

/** A temp tree with a stateful fake nvidia-smi and systemctl; the programs run unprivileged against it. */
function sandbox({ fixedCard = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gpupower-"));
  const bin = path.join(root, "bin");
  for (const d of ["bin", "units", "systemd", "state"]) fs.mkdirSync(path.join(root, d));
  const rows = [`${A},150.00,600.00`, `${B},150.00,600.00`];
  fs.writeFileSync(path.join(root, "state", A), "300.00\n");
  fs.writeFileSync(path.join(root, "state", B), "300.00\n");
  if (fixedCard) {
    rows.push(`${FIXED},[N/A],[N/A]`);
    fs.writeFileSync(path.join(root, "state", FIXED), "[N/A]\n");
  }
  fs.writeFileSync(path.join(root, "cards"), `${rows.join("\n")}\n`);
  const calls = path.join(root, "calls.log");
  fs.writeFileSync(
    path.join(bin, "nvidia-smi"),
    `#!/bin/sh
echo "nvidia-smi $* env=\${SPARKDASH_SUDO_PW-unset}" >> ${calls}
case "$1" in
  --query-gpu=*)
    i=0
    while IFS=, read -r u min max; do
      l=$(cat "${root}/state/$u")
      echo "$i, $u, $l, $l, 600.00, $min, $max, ${NAME}"
      i=$((i + 1))
    done < "${root}/cards"
    ;;
  -i)
    [ -f "${root}/refuse-$2" ] && { echo "Changing power management limit is not supported for GPU: $2." >&2; exit 4; }
    [ -f "${root}/no-hold" ] || echo "$4" > "${root}/state/$2"
    ;;
esac
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(bin, "systemctl"),
    `#!/bin/sh
echo "systemctl $*" >> ${calls}
case "$1" in
  restart) [ -f ${root}/restart_fails ] && exit 1 ;;
  is-enabled) if [ -f "${root}/units/$2" ] && [ ! -f "${root}/disabled-$2" ]; then echo enabled; else echo disabled; fi ;;
  is-active) if [ -f "${root}/units/$2" ]; then echo active; else echo inactive; fi ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  const paths = {
    unitDir: path.join(root, "units"),
    runDir: path.join(root, "run"),
    bootIdFile: path.join(root, "boot_id"),
    systemdRunDir: path.join(root, "systemd"),
    nvsmi: [path.join(bin, "nvidia-smi")],
    systemctl: path.join(bin, "systemctl"),
    sandbox: true,
  };
  const run = (program, { shell = ["sh"], env } = {}) =>
    parseProgramOutput(execFileSync(shell[0], [...shell.slice(1), "-c", program], { encoding: "utf8", env: env ?? process.env }));
  const read = (f) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), "utf8") : null);
  const write = (f, text) => fs.writeFileSync(path.join(root, f), text);
  const limit = (uuid) => read(`state/${uuid}`).trim();
  const unit = () => read(`units/${POWER_UNIT_NAME}`);
  return { root, bin, paths, run, read, write, limit, unit, calls: () => read("calls.log") ?? "", cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const apply = (sb, limits, persist = false, extra = {}) =>
  sb.run(buildPowerApplyProgram({ limits, persist }, { ...sb.paths, ...extra.paths }), extra.run);
const setCalls = (sb) => sb.calls().split("\n").filter((l) => / -pl /.test(l));

test("parsePowerRequest accepts a normal request and rejects everything else", () => {
  assert.deepEqual(parsePowerRequest({ limits: [{ uuid: A, watts: 300 }], persist: false }), { limits: [{ uuid: A, watts: 300 }], persist: false });
  assert.deepEqual(parsePowerRequest({ limits: [], persist: true }), { limits: [], persist: true });
  const bad = [
    null, {}, { limits: [] }, { limits: "x", persist: true }, { limits: [], persist: "yes" },
    { limits: [{ uuid: A, watts: "300" }], persist: true },
    { limits: [{ uuid: A, watts: 300.5 }], persist: true },
    { limits: [{ uuid: A, watts: 0 }], persist: true },
    { limits: [{ uuid: A, watts: 5001 }], persist: true },
    { limits: [{ uuid: A, watts: 300 }, { uuid: A, watts: 310 }], persist: true },
    { limits: [{ uuid: "0", watts: 300 }], persist: true },
    { limits: [{ uuid: `${A}; id`, watts: 300 }], persist: true },
    { limits: [{ uuid: "GPU-$(id)", watts: 300 }], persist: true },
    { limits: [{ uuid: "GPU-aaaaaaaa' ; id", watts: 300 }], persist: true },
    { limits: [null], persist: true },
    { limits: Array.from({ length: 65 }, (_, i) => ({ uuid: `GPU-${String(i).padStart(8, "0")}`, watts: 300 })), persist: true },
  ];
  for (const b of bad) assert.throws(() => parsePowerRequest(b), (e) => e.status === 400, JSON.stringify(b));
});

test("program text only carries validated values and fixed paths, and is valid POSIX sh", () => {
  const req = { limits: [{ uuid: A, watts: 300 }], persist: true };
  const program = buildPowerApplyProgram(req);
  assert.match(program, new RegExp(`LIMITS='${A}=300'; PERSIST=1`));
  assert.throws(() => buildPowerApplyProgram({ limits: [{ uuid: "GPU-$(id)", watts: 300 }], persist: true }), /uuid/);
  assert.throws(() => buildPowerApplyProgram(req, { unitDir: "/etc/x; id" }), /unsafe path/);
  for (const p of [program, buildPowerStatusProgram(), buildPowerApplyProgram(req, { password: true })]) {
    execFileSync("dash", ["-n", "-c", p]);
    execFileSync("bash", ["--posix", "-n", "-c", p]);
  }
});

test("status: lists each card with its range, and an unknown value stays unknown", () => {
  const sb = sandbox({ fixedCard: true });
  try {
    const res = sb.run(buildPowerStatusProgram(sb.paths));
    assert.equal(res.RESULT, "ok");
    assert.ok(["yes", "root"].includes(res.SUDO));
    const cards = parseCards(res.CARD);
    assert.equal(cards.length, 3);
    assert.deepEqual(cards[0], { index: 0, uuid: A, name: NAME, limitW: 300, enforcedW: 300, defaultW: 600, minW: 150, maxW: 600, adjustable: true });
    assert.equal(cards[2].limitW, null);
    assert.equal(cards[2].minW, null);
    assert.equal(cards[2].adjustable, false);
    assert.equal(res.SVC_INSTALLED, undefined);
    assert.equal(res.OTHER_SVC, undefined);
  } finally {
    sb.cleanup();
  }
});

test("parseCards: what a current driver prints, fractions, and junk", () => {
  const cards = parseCards([
    `0,${A},300.00,300.00,600.00,150.00,600.00,${NAME}`,
    `1,${B},127.50,[Requested functionality has been deprecated],[N/A],100.25,450.75,Some, Card`,
    `2,${FIXED},300.00,300.00,300.00,300.00,300.00,Locked`,
    "Field power.limit is not a valid field to query.",
    "x,not-a-uuid,1,1,1,1,1,x",
  ]);
  assert.equal(cards.length, 3);
  assert.equal(cards[1].limitW, 127.5);
  assert.equal(cards[1].enforcedW, null);
  assert.equal(cards[1].defaultW, null);
  assert.equal(cards[1].name, "Some, Card");
  assert.equal(cards[2].adjustable, false, "a card whose minimum equals its maximum cannot be changed");
  assert.deepEqual([...parseBootLimits([`${A},300`, `${B},127.5`, "junk,1", `${FIXED},x`]).entries()], [[A, 300], [B, 127.5]]);
});

test("a limit changes only the card it names, by uuid, and installs nothing", () => {
  const sb = sandbox();
  try {
    const res = apply(sb, [{ uuid: B, watts: 275 }]);
    assert.equal(res.RESULT, "ok");
    assert.equal(res.PERSIST, "0");
    assert.equal(sb.limit(B), "275");
    assert.equal(sb.limit(A), "300.00");
    assert.equal(setCalls(sb).length, 1);
    assert.match(setCalls(sb)[0], new RegExp(`-i ${B} -pl 275`));
    assert.equal(sb.unit(), null);
    assert.equal(parseCards(res.CARD)[1].limitW, 275, "the answer carries what the card reports afterwards");
  } finally {
    sb.cleanup();
  }
});

test("every card is checked first: one bad value changes nothing at all", () => {
  const sb = sandbox({ fixedCard: true });
  try {
    for (const [limits, code, pattern] of [
      [[{ uuid: A, watts: 250 }, { uuid: B, watts: 700 }], "range", /700 W is outside .*150\.00 to 600\.00/],
      [[{ uuid: A, watts: 250 }, { uuid: B, watts: 149 }], "range", /149 W/],
      [[{ uuid: A, watts: 250 }, { uuid: "GPU-dddddddd-0000", watts: 300 }], "no-card", /not on this unit/],
      [[{ uuid: A, watts: 250 }, { uuid: FIXED, watts: 300 }], "not-adjustable", /does not allow/],
    ]) {
      const res = apply(sb, limits, true);
      assert.equal(res.RESULT, "error");
      assert.equal(res.CODE, code);
      assert.match(res.MSG, pattern);
      assert.equal(setCalls(sb).length, 0);
      assert.equal(sb.limit(A), "300.00");
      assert.equal(sb.unit(), null);
    }
    // The ends of the range are valid.
    assert.equal(apply(sb, [{ uuid: A, watts: 150 }, { uuid: B, watts: 600 }]).RESULT, "ok");
  } finally {
    sb.cleanup();
  }
});

test("when nvidia-smi refuses a later card the earlier ones are put back", () => {
  const sb = sandbox();
  try {
    sb.write(`refuse-${B}`, "");
    const res = apply(sb, [{ uuid: A, watts: 250 }, { uuid: B, watts: 250 }], true);
    assert.equal(res.CODE, "pl-failed");
    assert.match(res.MSG, /refused 250 W .*no card was changed/);
    assert.equal(sb.limit(A), "300.00");
    assert.match(setCalls(sb).at(-1), new RegExp(`-i ${A} -pl 300.00`));
    assert.equal(sb.unit(), null, "no service for limits that did not apply");
  } finally {
    sb.cleanup();
  }
});

test("a limit the card did not keep is an error, not a success", () => {
  const sb = sandbox();
  try {
    sb.write("no-hold", "");
    const res = apply(sb, [{ uuid: A, watts: 250 }]);
    assert.equal(res.RESULT, "error");
    assert.equal(res.CODE, "pl-not-held");
    assert.match(res.MSG, /did not keep 250 W.*persistence mode/);
  } finally {
    sb.cleanup();
  }
});

test("keep after reboot: the service carries every adjustable card's live limit, so changing one keeps the other", () => {
  const sb = sandbox({ fixedCard: true });
  try {
    assert.equal(apply(sb, [{ uuid: A, watts: 250 }], true).PERSIST, "1");
    const nv = sb.paths.nvsmi[0];
    assert.match(sb.unit(), new RegExp(`^ExecStart=${nv} -i ${A} -pl 250$`, "m"));
    assert.match(sb.unit(), new RegExp(`^ExecStart=${nv} -i ${B} -pl 300$`, "m"));
    assert.doesNotMatch(sb.unit(), new RegExp(FIXED), "a card that cannot be set is not in the service");
    assert.doesNotMatch(sb.unit(), /ExecStop/, "stopping the service must not change the limits");
    assert.match(sb.calls(), /systemctl enable spark-gpu-power-limit\.service/);
    assert.match(sb.calls(), /systemctl restart spark-gpu-power-limit\.service/);

    apply(sb, [{ uuid: B, watts: 280 }], true);
    assert.match(sb.unit(), new RegExp(` -i ${A} -pl 250$`, "m"));
    assert.match(sb.unit(), new RegExp(` -i ${B} -pl 280$`, "m"));

    const res = sb.run(buildPowerStatusProgram(sb.paths));
    assert.equal(res.SVC_INSTALLED, "1");
    assert.equal(res.SVC_ENABLED, "enabled");
    assert.equal(res.SVC_ACTIVE, "active");
    assert.deepEqual([...parseBootLimits(res.SVC_CARD).entries()], [[A, 250], [B, 280]]);
  } finally {
    sb.cleanup();
  }
});

test("a fractional limit survives into the service", () => {
  const sb = sandbox();
  try {
    sb.write(`state/${B}`, "127.50\n");
    apply(sb, [], true);
    assert.match(sb.unit(), new RegExp(` -i ${B} -pl 127\\.5$`, "m"));
    assert.deepEqual(parseBootLimits(sb.run(buildPowerStatusProgram(sb.paths)).SVC_CARD).get(B), 127.5);
  } finally {
    sb.cleanup();
  }
});

test("another enabled boot unit that sets a limit is reported, and our service runs after it", () => {
  const sb = sandbox();
  try {
    // The shape an administrator writes by hand, by index.
    const handmade = "[Service]\nType=oneshot\nExecStart=/usr/bin/nvidia-smi -i 0 -pl 300\nExecStart=/usr/bin/nvidia-smi -i 1 -pl 300\n";
    sb.write("units/nvidia-power-limit.service", handmade);
    sb.write("units/long-flag.service", "[Service]\nExecStart=/usr/bin/nvidia-smi --power-limit=300\n");
    sb.write("units/off.service", handmade);
    sb.write("disabled-off.service", "");
    sb.write("units/unrelated.service", "[Service]\nExecStart=/usr/bin/nvidia-smi -pm 1\n");
    sb.write("units/comment.service", "[Service]\n# ExecStart=/usr/bin/nvidia-smi -pl 300\nExecStart=/bin/true\n");
    sb.write("units/bad name'$(id).service", handmade);

    const status = sb.run(buildPowerStatusProgram(sb.paths));
    assert.deepEqual(status.OTHER_SVC.sort(), ["long-flag.service", "nvidia-power-limit.service"]);

    apply(sb, [{ uuid: A, watts: 250 }], true);
    const after = /^After=(.*)$/m.exec(sb.unit())[1].split(" ").sort();
    assert.deepEqual(after, ["long-flag.service", "nvidia-persistenced.service", "nvidia-power-limit.service"]);
    assert.equal(sb.read("units/nvidia-power-limit.service"), handmade, "another unit is never edited");
    assert.doesNotMatch(sb.calls(), /systemctl (disable|stop) nvidia-power-limit/);
    assert.deepEqual(sb.run(buildPowerStatusProgram(sb.paths)).OTHER_SVC.sort(), ["long-flag.service", "nvidia-power-limit.service"], "our own unit is not listed");
  } finally {
    sb.cleanup();
  }
});

test("switching keep-after-reboot off removes the service and leaves the live limits alone", () => {
  const sb = sandbox();
  try {
    apply(sb, [{ uuid: A, watts: 250 }], true);
    const before = setCalls(sb).length;
    const res = apply(sb, [], false);
    assert.equal(res.RESULT, "ok");
    assert.equal(sb.unit(), null);
    assert.equal(sb.limit(A), "250");
    assert.equal(setCalls(sb).length, before, "no card is touched");
    assert.match(sb.calls(), /systemctl disable --now spark-gpu-power-limit\.service/);
  } finally {
    sb.cleanup();
  }
});

test("a service that fails to start is rolled back and the answer says the limits still apply", () => {
  const sb = sandbox();
  try {
    sb.write("restart_fails", "");
    const first = apply(sb, [{ uuid: A, watts: 250 }], true);
    assert.equal(first.CODE, "service-failed");
    assert.match(first.MSG, /until the next reboot/);
    assert.equal(sb.unit(), null, "a first-time service that fails is removed again");
    assert.equal(sb.limit(A), "250");

    fs.rmSync(path.join(sb.root, "restart_fails"));
    apply(sb, [{ uuid: A, watts: 260 }], true);
    const good = sb.unit();
    sb.write("restart_fails", "");
    assert.equal(apply(sb, [{ uuid: A, watts: 270 }], true).CODE, "service-failed");
    assert.equal(sb.unit(), good, "the previous service is restored");
  } finally {
    sb.cleanup();
  }
});

test("no systemd: refused before any card changes", () => {
  const sb = sandbox();
  try {
    fs.rmdirSync(sb.paths.systemdRunDir);
    assert.equal(apply(sb, [{ uuid: A, watts: 250 }], true).CODE, "no-systemd");
    assert.equal(sb.limit(A), "300.00");
    assert.equal(apply(sb, [{ uuid: A, watts: 250 }], false).RESULT, "ok", "a limit until the next reboot does not need systemd");
  } finally {
    sb.cleanup();
  }
});

test("a host without nvidia-smi or without cards reports a clean error", () => {
  const sb = sandbox();
  try {
    const gone = { ...sb.paths, nvsmi: [path.join(sb.root, "missing")] };
    assert.equal(sb.run(buildPowerStatusProgram(gone)).CODE, "no-nvidia");
    assert.equal(sb.run(buildPowerApplyProgram({ limits: [], persist: false }, gone)).CODE, "no-nvidia");
    sb.write("cards", "");
    assert.equal(sb.run(buildPowerStatusProgram(sb.paths)).CODE, "no-gpu");
    assert.equal(apply(sb, [{ uuid: A, watts: 250 }]).CODE, "no-gpu");
  } finally {
    sb.cleanup();
  }
});

test("the same programs behave under dash and bash --posix", () => {
  for (const shell of [["dash"], ["bash", "--posix"]]) {
    const sb = sandbox();
    try {
      sb.write("units/nvidia-power-limit.service", "[Service]\nExecStart=/usr/bin/nvidia-smi -i 0 -pl 300\n");
      assert.equal(sb.run(buildPowerStatusProgram(sb.paths), { shell }).CARD.length, 2, shell[0]);
      const res = sb.run(buildPowerApplyProgram({ limits: [{ uuid: A, watts: 250 }], persist: true }, sb.paths), { shell });
      assert.equal(res.RESULT, "ok", shell[0]);
      assert.equal(sb.limit(A), "250", shell[0]);
      assert.match(sb.unit(), /^After=nvidia-persistenced\.service nvidia-power-limit\.service$/m, shell[0]);
      assert.equal(sb.run(buildPowerApplyProgram({ limits: [{ uuid: A, watts: 999 }], persist: true }, sb.paths), { shell }).CODE, "range", shell[0]);
    } finally {
      sb.cleanup();
    }
  }
});

/** `install -o root -g root` cannot succeed unprivileged: drop the ownership flags only. */
function installFakeInstall(sb) {
  fs.writeFileSync(path.join(sb.bin, "install"), `#!/bin/sh\nargs=""\nwhile [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) args="$args $1"; shift ;; esac; done\nexec /usr/bin/install $args\n`, { mode: 0o755 });
}

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
  installFakeInstall(sb);
  return log;
}

test("as a normal user every privileged step goes through sudo -n, and sudo that wants a password changes nothing", () => {
  const sb = sandbox();
  try {
    const log = path.join(sb.root, "sudo.log");
    fs.writeFileSync(path.join(sb.bin, "sudo"), `#!/bin/sh\necho "sudo $*" >> ${log}\n[ "$1" = -n ] || exit 9\nshift\nexec "$@"\n`, { mode: 0o755 });
    installFakeInstall(sb);
    const paths = { ...sb.paths, sandbox: false, systemctl: "systemctl" };
    const env = { ...process.env, PATH: `${sb.bin}:${process.env.PATH}` };
    const req = { limits: [{ uuid: A, watts: 250 }], persist: true };
    assert.equal(sb.run(buildPowerStatusProgram(paths), { env }).SUDO, "yes");
    assert.equal(sb.run(buildPowerApplyProgram(req, paths), { env }).RESULT, "ok");
    const calls = fs.readFileSync(log, "utf8");
    assert.match(calls, new RegExp(`sudo -n .*nvidia-smi -i ${A} -pl 250`));
    assert.match(calls, /sudo -n install -m 644 -o root -g root/);
    assert.match(calls, /sudo -n systemctl enable/);

    fs.writeFileSync(path.join(sb.bin, "sudo"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    assert.equal(sb.run(buildPowerStatusProgram(paths), { env }).SUDO, "no");
    const denied = sb.run(buildPowerApplyProgram({ limits: [{ uuid: A, watts: 200 }], persist: true }, paths), { env });
    assert.equal(denied.CODE, "no-sudo");
    assert.equal(sb.limit(A), "250");
  } finally {
    sb.cleanup();
  }
});

test("with a sudo password: it is piped to sudo -S, and neither an argument nor inherited by anything", () => {
  const sb = sandbox();
  try {
    const log = installFakeSudo(sb);
    const paths = { ...sb.paths, sandbox: false, systemctl: "systemctl", password: true };
    const env = { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, SPARKDASH_SUDO_PW: "s3cret" };
    const req = { limits: [{ uuid: A, watts: 250 }, { uuid: B, watts: 260 }], persist: true };
    const program = buildPowerApplyProgram(req, paths);
    assert.doesNotMatch(program, /s3cret/);
    assert.equal(sb.run(program, { env }).RESULT, "ok");
    assert.equal(sb.limit(A), "250");
    assert.equal(sb.limit(B), "260");
    const calls = fs.readFileSync(log, "utf8");
    assert.doesNotMatch(calls, /s3cret/);
    assert.match(calls, new RegExp(`sudo -S -p +.*nvidia-smi -i ${B} -pl 260`));
    assert.match(sb.calls(), /-pl 250 env=unset/, "children do not inherit the password");
    assert.doesNotMatch(sb.calls(), /s3cret/);
    assert.match(sb.unit(), new RegExp(` -i ${B} -pl 260$`, "m"));
  } finally {
    sb.cleanup();
  }
});

test("a wrong sudo password is reported as such and changes nothing", () => {
  const sb = sandbox();
  try {
    installFakeSudo(sb);
    const paths = { ...sb.paths, sandbox: false, systemctl: "systemctl", password: true };
    const env = { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, SPARKDASH_SUDO_PW: "wrong" };
    const res = sb.run(buildPowerApplyProgram({ limits: [{ uuid: A, watts: 250 }], persist: true }, paths), { env });
    assert.equal(res.CODE, "bad-password");
    assert.equal(sb.limit(A), "300.00");
    assert.equal(sb.unit(), null);
  } finally {
    sb.cleanup();
  }
});

test("only Linux GPU hosts are supported", () => {
  assert.throws(() => assertPowerSupported(null), (e) => e.status === 404);
  assert.throws(() => assertPowerSupported({ kind: "spark", platform: "linux" }), (e) => e.status === 400);
  assert.throws(() => assertPowerSupported({ kind: "host", platform: "windows" }), (e) => e.status === 400);
  assert.throws(() => assertPowerSupported({ kind: "host", platform: "darwin" }), (e) => e.status === 400);
  assert.doesNotThrow(() => assertPowerSupported({ kind: "host", platform: "linux" }));
  assert.doesNotThrow(() => assertPowerSupported({ kind: "host" }));
});

const host = { id: "h1", name: "H1", kind: "host", platform: "linux", ssh: { user: "u", host: "10.0.0.5" } };
const cardLine = `CARD=0,${A},300.00,300.00,600.00,150.00,600.00,${NAME}`;

test("GpuClockManager.powerStatus: cards, boot limits and other services; no nvidia-smi or no cards is 'unsupported'", async () => {
  const answer = (out) => new GpuClockManager({ run: async () => out }).powerStatus(host);
  const s = await answer(`RESULT=ok\nSUDO=no\n${cardLine}\nSVC_CARD=${A},280\nSVC_INSTALLED=1\nSVC_ENABLED=enabled\nSVC_ACTIVE=active\nOTHER_SVC=nvidia-power-limit.service`);
  assert.equal(s.supported, true);
  assert.equal(s.sudo, "no");
  assert.equal(s.cards[0].limitW, 300);
  assert.equal(s.cards[0].bootW, 280);
  assert.deepEqual(s.service, { installed: true, enabled: "enabled", active: "active" });
  assert.deepEqual(s.otherServices, ["nvidia-power-limit.service"]);

  const plain = await answer(`RESULT=ok\nSUDO=yes\n${cardLine}`);
  assert.equal(plain.cards[0].bootW, null);
  assert.deepEqual(plain.service, { installed: false, enabled: null, active: null });
  assert.deepEqual(plain.otherServices, []);

  assert.equal((await answer("RESULT=error\nCODE=no-nvidia\nMSG=nvidia-smi was not found on this unit")).supported, false);
  assert.equal((await answer("RESULT=error\nCODE=no-gpu\nMSG=could not read")).supported, false);
  assert.equal((await answer("RESULT=ok\nSUDO=yes\nCARD=Field is not valid")).supported, false);
  await assert.rejects(answer("garbage"), (e) => e.status === 502 && e.code === "bad-output");
});

test("GpuClockManager.setPower: validates before running, password goes in as input only, answers with card indexes", async () => {
  const seen = [];
  const run = async (_s, program, opts) => {
    seen.push({ program, input: opts.input });
    return `RESULT=ok\nPERSIST=1\n${cardLine}`;
  };
  const m = new GpuClockManager({ run });
  await assert.rejects(m.setPower(host, { limits: [{ uuid: "x", watts: 300 }], persist: true }), (e) => e.status === 400);
  await assert.rejects(m.setPower({ ...host, kind: "spark" }, { limits: [], persist: true }), (e) => e.status === 400);
  assert.equal(seen.length, 0);
  const out = await m.setPower(host, { limits: [{ uuid: A, watts: 250 }], persist: true, sudoPassword: "s3cret" });
  assert.deepEqual(out, { limits: [{ uuid: A, watts: 250, index: 0 }], persist: true });
  assert.equal(seen[0].input, "s3cret");
  assert.doesNotMatch(seen[0].program, /s3cret/);
  assert.match(seen[0].program, /sudo -S/);
});

test("wrong passwords count toward one lock with the clock cap, and one action runs at a time", async () => {
  const wrong = new GpuClockManager({ run: async () => "RESULT=error\nCODE=bad-password\nMSG=the sudo password was not accepted" });
  const body = { limits: [{ uuid: A, watts: 250 }], persist: false, sudoPassword: "nope" };
  for (let i = 0; i < 3; i += 1) await assert.rejects(wrong.setPower(host, body), (e) => e.status === 403 && e.code === "bad-password");
  await assert.rejects(wrong.setPower(host, body), (e) => e.status === 429 && e.code === "password-locked");
  await assert.rejects(wrong.apply({ ...host, kind: "spark" }, { maxMHz: 1800, sudoPassword: "nope" }), (e) => e.status === 429);

  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = new GpuClockManager({ run: async () => { await gate; return `RESULT=ok\nPERSIST=0\n${cardLine}`; } });
  const first = slow.setPower(host, { limits: [{ uuid: A, watts: 250 }], persist: false });
  await assert.rejects(slow.setPower(host, { limits: [{ uuid: A, watts: 260 }], persist: false }), (e) => e.status === 409 && /Another GPU action/.test(e.message));
  release();
  await first;
});

test("the program's failure codes reach the caller with their own status and message", async () => {
  for (const [code, status] of [["no-card", 409], ["not-adjustable", 409], ["range", 400], ["pl-failed", 422], ["pl-not-held", 422], ["service-failed", 422], ["no-sudo", 409]]) {
    const m = new GpuClockManager({ run: async () => `RESULT=error\nCODE=${code}\nMSG=what happened` });
    await assert.rejects(m.setPower(host, { limits: [{ uuid: A, watts: 250 }], persist: false }), (e) => e.status === status && e.code === code && e.message === "what happened", code);
  }
});
