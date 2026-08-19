import test from "node:test";
import assert from "node:assert/strict";
import { HermesProbe, chooseLocalInvocation, parseHostPasswd } from "../HermesProbe.js";

/** Build a probe whose `_run` returns a canned remote output. */
function probeReturning(out) {
  const probe = new HermesProbe({
    isLocal: false,
    lanIp: "10.0.0.5",
    ssh: { host: "10.0.0.5", user: "mia", auth: "key" },
  });
  probe._run = async () => out;
  return probe;
}

function probeThrowing(err) {
  const probe = new HermesProbe({
    isLocal: false,
    lanIp: "10.0.0.5",
    ssh: { host: "10.0.0.5", user: "mia", auth: "key" },
  });
  probe._run = async () => {
    throw err;
  };
  return probe;
}

test("HermesProbe reports the binary missing (not an error)", async () => {
  const res = await probeReturning("__HERMES_MISSING__").check();
  assert.equal(res.installed, false);
  assert.equal(res.version, null);
  assert.equal(res.updateAvailable, null);
  assert.equal(res.error, null);
});

test("HermesProbe parses an up-to-date check", async () => {
  const out = [
    "HERMES_BIN=/home/mia/.local/bin/hermes",
    "v0.20.0 (2026.8.3)",
    "__CHECK_PHASE__",
    "Checking for updates...",
    "Already up to date.",
    "__CHECK_EXIT__0",
  ].join("\n");
  const res = await probeReturning(out).check();
  assert.equal(res.installed, true);
  assert.equal(res.version, "0.20.0");
  assert.equal(res.updateAvailable, false);
  assert.equal(res.error, null);
});

test("HermesProbe does NOT report a phantom update when the fetch fails", async () => {
  // Regression: `hermes update --check` exits 1 both when an update is available
  // AND when the git fetch itself fails ("✗ Failed to fetch"). The exit code
  // alone must not be read as "update available".
  const out = [
    "HERMES_BIN=/home/zurih/.local/bin/hermes",
    "Hermes Agent v0.20.0 (2026.8.3)",
    "__CHECK_PHASE__",
    "→ Fetching from origin...",
    "✗ Failed to fetch.",
    "  fatal: detected dubious ownership in repository",
    "__CHECK_EXIT__1",
  ].join("\n");
  const res = await probeReturning(out).check();
  assert.equal(res.installed, true);
  assert.equal(res.updateAvailable, null);
  assert.ok(res.error);
  assert.match(res.error, /fetch/i);
});

test("HermesProbe parses an update-available check", async () => {
  const out = [
    "HERMES_BIN=/home/mia/.local/bin/hermes",
    "v0.19.1",
    "__CHECK_PHASE__",
    "Update available: 5 commits behind origin/main.",
    "__CHECK_EXIT__1",
  ].join("\n");
  const res = await probeReturning(out).check();
  assert.equal(res.installed, true);
  assert.equal(res.updateAvailable, true);
  assert.equal(res.behindCommits, 5);
  assert.equal(res.error, null);
});

test("HermesProbe detects an install whose --check flag is unsupported", async () => {
  const out = [
    "HERMES_BIN=/usr/local/bin/hermes",
    "v0.9.0",
    "__CHECK_PHASE__",
    "usage: hermes [options]",
    "unrecognized arguments: --check",
    "__CHECK_EXIT__2",
  ].join("\n");
  const res = await probeReturning(out).check();
  assert.equal(res.installed, true);
  assert.equal(res.updateAvailable, null);
  assert.match(res.error, /--check/);
});

test("HermesProbe surfaces SSH failures as an error, not a false 'no update'", async () => {
  const res = await probeThrowing(
    new Error("SSH to 10.0.0.5 failed: Connection timed out")
  ).check();
  assert.equal(res.installed, true);
  assert.equal(res.updateAvailable, null);
  assert.match(res.error, /timed out/);
});

test("HermesProbe update reports failure when the binary is missing", async () => {
  const res = await probeReturning("__HERMES_MISSING__").update();
  assert.equal(res.ok, false);
  assert.equal(res.installed, false);
  assert.match(res.error, /not found/);
});

test("parseHostPasswd resolves the host user identity", () => {
  const passwd =
    "root:x:0:0:root:/root:/bin/bash\n" +
    "zurih:x:1000:1000:zurih,,,:/home/zurih:/bin/bash\n";
  assert.deepEqual(parseHostPasswd(passwd, "zurih"), {
    uid: 1000,
    gid: 1000,
    home: "/home/zurih",
  });
  assert.equal(parseHostPasswd(passwd, "nobody"), null);
  assert.equal(parseHostPasswd("zurih:x:nope:also:/home/zurih:/bin/bash\n", "zurih"), null);
  assert.equal(parseHostPasswd(undefined, "zurih"), null);
  assert.equal(parseHostPasswd("", "zurih"), null);
});

test("local execution as root drops to the host user via setpriv (host mount ns)", () => {
  // Regression for the venv/ownership corruption: the local Spark runs hermes
  // through the container (root). It must run as the host user so git and uv
  // never write root-owned files into the user's tree, and inside the host
  // mount namespace so the host's git binary is visible.
  const inv = chooseLocalInvocation({
    mntNs: "/host/proc/1/ns/mnt",
    passwdText: "zurih:x:1000:1000:zurih,,,:/home/zurih:/bin/bash\n",
    currentUid: 0,
    user: "zurih",
    cmd: "echo hi",
  });
  assert.equal(inv.file, "nsenter");
  assert.deepEqual(inv.args.slice(0, 2), ["--mount=/host/proc/1/ns/mnt", "--"]);
  assert.equal(inv.args[2], "setpriv");
  assert.ok(inv.args.includes("--reuid=1000"));
  assert.ok(inv.args.includes("--regid=1000"));
  assert.ok(inv.args.includes("--init-groups"));
  const script = inv.args[inv.args.length - 1];
  assert.match(script, /^export HOME='\/home\/zurih'; /);
  assert.deepEqual(inv.repair, {
    home: "/home/zurih",
    uid: 1000,
    gid: 1000,
    mntNs: "/host/proc/1/ns/mnt",
  });
});

test("local execution without host namespace drops directly via setpriv", () => {
  const inv = chooseLocalInvocation({
    mntNs: null,
    passwdText: "zurih:x:1000:1000:zurih,,,:/home/zurih:/bin/bash\n",
    currentUid: 0,
    user: "zurih",
    cmd: "echo hi",
  });
  assert.equal(inv.file, "setpriv");
  assert.equal(inv.args[0], "setpriv");
  assert.ok(inv.args.includes("--reuid=1000"));
});

test("local fallback keeps safe.directory only when privilege drop is impossible", () => {
  // Non-root process (e.g. bare-host dev server not running as root): fall back
  // to running as-is, but keep git safe.directory so "dubious ownership" can't
  // block checks.
  const inv = chooseLocalInvocation({
    mntNs: "/host/proc/1/ns/mnt",
    passwdText: "zurih:x:1000:1000:zurih,,,:/home/zurih:/bin/bash\n",
    currentUid: 1000,
    user: "zurih",
    cmd: "echo hi",
  });
  assert.equal(inv.file, "nsenter");
  assert.equal(inv.repair, null);
  assert.match(inv.args[inv.args.length - 1], /GIT_CONFIG_VALUE_0='\*'/);
});

test("check() reports a broken hermes launcher instead of false 'no update'", async () => {
  const broken = [
    "HERMES_BIN=/home/zurih/.local/bin/hermes",
    "/home/zurih/.hermes/hermes-agent/venv/bin/hermes: No such file or directory",
    "__HERMES_LAUNCH_FAIL__",
    "__CHECK_PHASE__",
    "",
    "__CHECK_EXIT__127",
  ].join("\n");
  const probe = probeReturning(broken);
  const res = await probe.check();
  assert.equal(res.installed, true);
  assert.equal(res.updateAvailable, null);
  assert.match(res.error, /cannot launch/);
});

test("update() auto-repairs a broken launcher via uv pip install then retries", async () => {
  const broken = [
    "HERMES_BIN=/home/zurih/.local/bin/hermes",
    "venv/bin/hermes: No such file or directory",
    "__HERMES_LAUNCH_FAIL__",
    "__CHECK_PHASE__",
    "",
    "__CHECK_EXIT__127",
  ].join("\n");
  const ok = [
    "HERMES_BIN=/home/zurih/.local/bin/hermes",
    "Hermes Agent v0.20.0 (2026.8.3)",
    "__CHECK_PHASE__",
    "Already up to date.",
    "__CHECK_EXIT__0",
  ].join("\n");
  const probe = new HermesProbe({
    isLocal: false,
    lanIp: "10.0.0.5",
    ssh: { host: "10.0.0.5", user: "zurih", auth: "key" },
  });
  const calls = [];
  probe._run = async (cmd) => {
    calls.push(cmd);
    // 1 = initial update (broken), 2 = repair pip script, 3 = repair verify,
    // 4 = retried update (healed)
    if (calls.length === 1) return broken;
    if (calls.length === 2) return "";
    if (calls.length === 3) return "Hermes Agent v0.20.0";
    return ok;
  };
  const res = await probe.update();
  assert.equal(res.ok, true);
  assert.equal(res.version, "0.20.0");
  assert.equal(calls.length, 4);
  assert.match(calls[1], /pip install -e \./);
  assert.match(calls[1], /VIRTUAL_ENV='\/home\/zurih\/\.hermes\/hermes-agent\/venv'/);
});

test("pendingCommits() parses the git probe output", async () => {
  const probe = new HermesProbe({
    isLocal: false,
    lanIp: "10.0.0.5",
    ssh: { host: "10.0.0.5", user: "mia", auth: "key" },
  });
  probe._run = async () =>
    ["__COMMITS__", "abc123\tchore: bump", "__COUNT__", "1", "__HEAD__", "f00bad"].join("\n");
  const res = await probe.pendingCommits();
  assert.equal(res.count, 1);
  assert.equal(res.commits[0].sha, "abc123");
  assert.equal(res.headSha, "f00bad");
});

test("pendingCommits() returns null when git cannot run", async () => {
  const probe = new HermesProbe({
    isLocal: false,
    lanIp: "10.0.0.5",
    ssh: { host: "10.0.0.5", user: "mia", auth: "key" },
  });
  probe._run = async () => {
    throw new Error("spawn git ENOENT");
  };
  assert.equal(await probe.pendingCommits(), null);
});

test("remote execution command carries no GIT_CONFIG (runs as the real user)", async () => {
  const probe = new HermesProbe({
    isLocal: false,
    lanIp: "10.0.0.5",
    ssh: { host: "10.0.0.5", user: "mia", auth: "key" },
  });
  let sent = "";
  probe._run = async (cmd) => {
    sent = cmd;
    return "__HERMES_MISSING__";
  };
  await probe.check();
  assert.doesNotMatch(sent, /GIT_CONFIG/);
});
