/**
 * The in-UI shutdown-helper installer: the same guard chain as the spark-attic
 * installer, plus an end-to-end run of the pinned installer program against a
 * stubbed PATH (sudo fakes authorization; tee/chmod/mv/visudo run for real
 * inside a temp root, so nothing on the machine under test is touched).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHUTDOWN_HELPER_INSTALL_PROGRAM, registerShutdownHelperInstallRoute } from "../shutdownHelper.js";
import { SHUTDOWN_BIN } from "../shutdown.js";

function setup(run = async () => "", mode = () => "helper", spark = { id: "s1", isLocal: false, platform: "linux" }) {
  const handlers = { get: null, post: null };
  registerShutdownHelperInstallRoute(
    {
      get: (_path, fn) => { handlers.get = fn; },
      post: (_path, fn) => { handlers.post = fn; },
    },
    { registry: { getSpark: () => spark }, allowChange: () => true, rejectLimited() {}, run, mode }
  );
  const call = (handler) => async (body, headers = {}) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await handler({ body, params: { id: spark.id }, headers, socket: { remoteAddress: "127.0.0.1" } }, res);
    return res;
  };
  return { callPost: call(handlers.post), callGet: call(handlers.get), spark };
}

test("installation requires confirmation and a supported unit", async () => {
  let calls = 0;
  const { callPost } = setup(async () => { calls++; });
  assert.equal((await callPost({})).statusCode, 400);
  assert.equal(calls, 0);

  const { callPost: localPost } = setup(async () => { calls++; }, () => "direct", { id: "s1", isLocal: true, platform: "linux" });
  const localRes = await localPost({ confirm: true });
  assert.equal(localRes.statusCode, 400);
  assert.match(localRes.body.error, /powers off directly/);

  const { callPost: hostPost } = setup(async () => { calls++; }, () => "helper", { id: "s1", isLocal: true, platform: "linux" });
  assert.match((await hostPost({ confirm: true })).body.error, /installed on the host itself/);

  const { callPost: macPost } = setup(async () => { calls++; }, () => "helper", { id: "s1", isLocal: false, platform: "darwin" });
  assert.equal((await macPost({ confirm: true })).statusCode, 400);
  assert.equal(calls, 0);
});

test("confirmed install sends the password through the runner and pins the program's safety steps", async () => {
  let args;
  const { callPost } = setup(async (...a) => {
    args = a;
    return "spark-shutdown helper installed: passwordless sudo covers /usr/local/bin/spark-shutdown";
  });
  const res = await callPost({ confirm: true, sudoPassword: "secret" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.match(res.body.message, /passwordless sudo covers/);
  assert.equal(args[2].input, "secret");
  assert.ok(!args[1].includes("secret"));
  assert.match(SHUTDOWN_HELPER_INSTALL_PROGRAM, /visudo -cf/);
  assert.match(SHUTDOWN_HELPER_INSTALL_PROGRAM, /install -m 0440/);
  assert.match(SHUTDOWN_HELPER_INSTALL_PROGRAM, /NOPASSWD: %s "", %s --check/);
  assert.match(SHUTDOWN_HELPER_INSTALL_PROGRAM, /sudo password was rejected/);
  // Nothing is piped through sudo: its stdin is reserved for the password.
  assert.doesNotMatch(SHUTDOWN_HELPER_INSTALL_PROGRAM, /\| as_root /);
  // The sudoers rule is validated (and a failure cleans up) before it goes live.
  assert.ok(SHUTDOWN_HELPER_INSTALL_PROGRAM.indexOf("visudo -cf") < SHUTDOWN_HELPER_INSTALL_PROGRAM.indexOf('mv -f "$SUDOERS.tmp" "$SUDOERS"'));
});

test("refuses a password on a relayed HTTP connection", async () => {
  let calls = 0;
  const { callPost } = setup(async () => { calls++; });
  const res = await callPost({ confirm: true, sudoPassword: "secret" }, { "x-forwarded-for": "10.0.0.2" });
  assert.equal(res.statusCode, 400);
  assert.equal(calls, 0);
});

test("a rejected password is redacted and locks further attempts", async () => {
  let calls = 0;
  const { callPost } = setup(async () => {
    calls++;
    throw new Error("sudo password was rejected for secret-user");
  });
  const fail = await callPost({ confirm: true, sudoPassword: "secret-user" });
  assert.equal(fail.statusCode, 502);
  assert.ok(!fail.body.error.includes("secret-user"));
  assert.match(fail.body.error, /\[redacted\]/);
  // The guard locks after the configured number of wrong passwords.
  await callPost({ confirm: true, sudoPassword: "secret-user" });
  await callPost({ confirm: true, sudoPassword: "secret-user" });
  const locked = await callPost({ confirm: true, sudoPassword: "secret-user" });
  assert.equal(locked.statusCode, 429);
  assert.equal(calls, 3);
});

test("the policy endpoint reports password rules and direct power-off", async () => {
  const remote = setup();
  const remoteRes = await remote.callGet();
  assert.deepEqual(remoteRes.body, {
    passwordAllowed: true,
    plainPasswordAllowed: false,
    directPowerOff: false,
    installSupported: true,
  });
  const local = setup(() => {}, () => "direct", { id: "s1", isLocal: true, platform: "linux" });
  const body = (await local.callGet()).body;
  assert.equal(body.directPowerOff, true);
  assert.equal(body.installSupported, false);
});

test("the pinned installer program works end to end against a stubbed host", () => {
  const dir = mkdtempSync(join(tmpdir(), "shutdown-helper-"));
  try {
    const rootBin = join(dir, "root", "usr", "local", "bin", "spark-shutdown");
    const rootSudoers = join(dir, "root", "etc", "sudoers.d", "spark-shutdown");
    const calls = join(dir, "calls.log");
    mkdirSync(join(dir, "root", "usr", "local", "bin"), { recursive: true });
    mkdirSync(join(dir, "root", "etc", "sudoers.d"), { recursive: true });
    // sudo stub: records every call, fakes auth (-v), executes the rest for real.
    writeFileSync(
      join(dir, "sudo"),
      [
        "#!/bin/sh",
        'printf \'%s\\n\' "$*" >> "$CALLS"',
        '[ -f "$SUDO_FAIL" ] && { echo "sudo: 1 incorrect password attempt" >&2; exit 1; }',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        "    -S|-n) shift ;;",
        "    -p) shift; shift ;;",
        "    *) break ;;",
        "  esac",
        "done",
        '[ "$1" = "-v" ] && exit 0',
        'exec "$@"',
      ].join("\n"),
      { mode: 0o755 }
    );
    writeFileSync(
      join(dir, "visudo"),
      ['#!/bin/sh', 'printf \'%s\\n\' "$*" >> "$CALLS"', '[ -f "$VISUDO_FAIL" ] && exit 1', "exit 0"].join("\n"),
      { mode: 0o755 }
    );
    const program = SHUTDOWN_HELPER_INSTALL_PROGRAM.replaceAll(SHUTDOWN_BIN, rootBin).replaceAll("/etc/sudoers.d/spark-shutdown", rootSudoers);
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: calls, SPARKDASH_SUDO_PW: "s3cret" };

    // Success: the helper and the sudoers rule land with the right modes and the
    // final passwordless check passes.
    const ok = spawnSync("sh", ["-c", program], { env, encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr || ok.stdout);
    assert.match(ok.stdout, /passwordless sudo covers/);
    const helper = readFileSync(rootBin, "utf8");
    assert.match(helper, /#!\/bin\/sh/);
    assert.match(helper, /--check/);
    assert.match(helper, /exec \/usr\/sbin\/poweroff/);
    assert.equal(statSync(rootBin).mode & 0o777, 0o755);
    const sudoers = readFileSync(rootSudoers, "utf8").trim();
    assert.match(sudoers, / ALL=\(root\) NOPASSWD: /);
    assert.ok(sudoers.includes(rootBin));
    // The rule pins the helper's exact arguments: none and --check.
    assert.ok(sudoers.endsWith(` "", ${rootBin} --check`), sudoers);
    assert.equal(statSync(rootSudoers).mode & 0o777, 0o440);
    assert.match(readFileSync(calls, "utf8"), /visudo -cf/);

    // A second run is a no-op: the already-authorized helper short-circuits.
    const before = readFileSync(calls, "utf8");
    const again = spawnSync("sh", ["-c", program], { env, encoding: "utf8" });
    assert.equal(again.status, 0);
    assert.match(again.stdout, /already installed and authorized/);
    // The only new sudo traffic is the authorization pre-check itself.
    const newCalls = readFileSync(calls, "utf8").slice(before.length).trim().split("\n").filter(Boolean);
    assert.ok(newCalls.length > 0);
    assert.ok(newCalls.every((line) => line.includes("--check")));

    // A rejected sudo password fails the run with the contract message.
    writeFileSync(join(dir, "sudo-fail"), "");
    const denied = spawnSync("sh", ["-c", program], { env: { ...env, SUDO_FAIL: join(dir, "sudo-fail") }, encoding: "utf8" });
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /sudo password was rejected/);
    rmSync(join(dir, "sudo-fail"));

    // A differing helper on the host is refused, not replaced.
    writeFileSync(rootBin, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    const differs = spawnSync("sh", ["-c", program], { env, encoding: "utf8" });
    assert.notEqual(differs.status, 0);
    assert.match(differs.stderr, /refusing to replace it/);
    assert.match(readFileSync(rootBin, "utf8"), /exit 7/);

    // A differing sudoers rule is refused too (fresh host, so the pre-check
    // fails and the installer is reached).
    rmSync(rootBin);
    rmSync(rootSudoers);
    writeFileSync(rootSudoers, "# someone else's rule\n");
    const foreign = spawnSync("sh", ["-c", program], { env, encoding: "utf8" });
    assert.notEqual(foreign.status, 0);
    assert.match(foreign.stderr, /differs from the pinned rule/);
    assert.ok(!existsSync(rootBin));
    assert.match(readFileSync(rootSudoers, "utf8"), /someone else's rule/);

    // A sudoers rule that fails visudo validation is never moved into place.
    // Start from a fresh host: otherwise the authorized helper short-circuits
    // the run before the installer is reached at all.
    rmSync(rootBin, { force: true });
    rmSync(rootSudoers, { force: true });
    writeFileSync(join(dir, "visudo-fail"), "");
    const invalid = spawnSync("sh", ["-c", program], { env: { ...env, VISUDO_FAIL: join(dir, "visudo-fail") }, encoding: "utf8" });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /failed visudo validation/);
    assert.ok(!existsSync(rootSudoers));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
