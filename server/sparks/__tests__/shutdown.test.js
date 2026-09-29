/**
 * Power-off command construction (#90): the local invocation has to reach the
 * host helper from inside the container, and the remote command string has to
 * be valid shell input with its authorization check in front of the
 * backgrounded shutdown.
 *
 * The remote cases run the generated string through a real /bin/sh with PATH
 * emptied and `test` / `sudo` / `nohup` / `sleep` replaced by inert functions,
 * so a privileged command can never be reached and the exit status and the
 * call order stay observable.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SHUTDOWN_BIN,
  hostMountNs,
  localShutdownCommand,
  remoteShutdownCommand,
  spawnLocalShutdown,
} from "../../shutdown.js";

const OLD_JOINED = [
  `test -x ${SHUTDOWN_BIN} || { echo "missing ${SHUTDOWN_BIN}" >&2; exit 127; }`,
  `nohup sudo -n ${SHUTDOWN_BIN} >/dev/null 2>&1 &`,
  `sleep 0.3`,
  `exit 0`,
].join("; ");

/**
 * Run the generated remote command under a stub shell.
 * @param {{ helperExists?: boolean, checkRc?: number, legacyRc?: number, command?: string }} [opts]
 */
function runRemote({ helperExists = true, checkRc = 0, legacyRc = 1, command = remoteShutdownCommand() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-shutdown-"));
  const marker = path.join(dir, "calls");
  fs.writeFileSync(marker, "");
  const runner = path.join(dir, "run.sh");
  fs.writeFileSync(
    runner,
    `#!/bin/sh
exec 9>>"$MARKER"
test() { return ${helperExists ? 0 : 1}; }
sudo() {
  case "$*" in
    *--check*) echo check >&9; return ${checkRc} ;;
    "-n true") echo legacy-true >&9; return ${legacyRc} ;;
    *) echo shutdown >&9; return 0 ;;
  esac
}
nohup() { "$@"; }
sleep() { :; }
${command}
`
  );
  const res = spawnSync("/bin/sh", [runner], {
    env: { ...process.env, PATH: "", MARKER: marker },
    encoding: "utf8",
  });
  return { status: res.status, stderr: res.stderr, marker, dir };
}

/** Stub spawn that records invocations and drives the child lifecycle. */
function fakeSpawn(calls, { error = null } = {}) {
  return (file, args, opts) => {
    calls.push({ file, args, opts });
    const child = { unref() {} };
    child.on = (event, cb) => {
      if (error && event === "error") setImmediate(() => cb(error));
      if (!error && event === "spawn") setImmediate(() => cb());
      return child;
    };
    return child;
  };
}

test("remote shutdown command is valid shell input", () => {
  const res = spawnSync("/bin/sh", ["-n", "-c", remoteShutdownCommand()], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
});

test("the previous '; '-joined command never parsed — the '&' met a ';'", () => {
  const res = spawnSync("/bin/sh", ["-n", "-c", OLD_JOINED], { encoding: "utf8" });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /syntax error/i);
});

test("remote shutdown: helper-only sudo authorization is enough", async () => {
  const { status, marker } = runRemote({ checkRc: 0, legacyRc: 1 });
  assert.equal(status, 0);
  await new Promise((r) => setTimeout(r, 250)); // let the backgrounded call land
  assert.equal(fs.readFileSync(marker, "utf8").trim().split("\n").join(","), "check,shutdown");
});

test("remote shutdown: no authorization check means no background shutdown", async () => {
  const { status, marker } = runRemote({ checkRc: 1, legacyRc: 1 });
  assert.equal(status, 126);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(fs.readFileSync(marker, "utf8").trim().split("\n").join(","), "check,legacy-true");
});

test("remote shutdown: broad NOPASSWD still works without --check support", async () => {
  const { status, marker } = runRemote({ checkRc: 1, legacyRc: 0 });
  assert.equal(status, 0);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(fs.readFileSync(marker, "utf8").trim().split("\n").join(","), "check,legacy-true,shutdown");
});

test("remote shutdown: a missing helper exits 127 before any sudo call", async () => {
  const { status, marker } = runRemote({ helperExists: false });
  assert.equal(status, 127);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(fs.readFileSync(marker, "utf8").trim(), "");
});

test("local shutdown enters the host mount namespace in a container", () => {
  assert.deepEqual(localShutdownCommand({ mntNs: "/host/proc/1/ns/mnt" }), {
    file: "nsenter",
    args: ["--mount=/host/proc/1/ns/mnt", "--", "sudo", "-n", SHUTDOWN_BIN],
  });
});

test("local shutdown calls sudo directly on a bare host", () => {
  assert.deepEqual(localShutdownCommand({ mntNs: null }), {
    file: "sudo",
    args: ["-n", SHUTDOWN_BIN],
  });
});

test("hostMountNs: the PID 1 namespace when the host proc mount exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-proc-"));
  fs.mkdirSync(path.join(dir, "1", "ns"), { recursive: true });
  fs.writeFileSync(path.join(dir, "1", "ns", "mnt"), "");
  assert.equal(hostMountNs(dir), path.join(dir, "1", "ns", "mnt"));
});

test("hostMountNs: null when there is no host proc mount", () => {
  assert.equal(hostMountNs(path.join(os.tmpdir(), "sparkdash-absent-proc")), null);
});

test("spawnLocalShutdown: detaches nsenter + sudo, resolves when spawned", async () => {
  const calls = [];
  const message = await spawnLocalShutdown({
    mntNs: "/host/proc/1/ns/mnt",
    spawnFn: fakeSpawn(calls),
  });
  assert.equal(message, "Shutdown initiated");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "nsenter");
  assert.deepEqual(calls[0].args, ["--mount=/host/proc/1/ns/mnt", "--", "sudo", "-n", SHUTDOWN_BIN]);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.stdio, "ignore");
});

test("spawnLocalShutdown: a missing binary rejects instead of logging success", async () => {
  const enoent = Object.assign(new Error("spawn nsenter ENOENT"), { code: "ENOENT" });
  await assert.rejects(
    spawnLocalShutdown({ mntNs: "/host/proc/1/ns/mnt", spawnFn: fakeSpawn([], { error: enoent }) }),
    /nsenter not found/
  );
});
