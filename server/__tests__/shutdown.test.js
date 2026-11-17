/**
 * Local shutdown helper checks (#379): a missing or unauthorized helper must be
 * reported as a failure, not answered with success while the host stays up.
 * The settle paths run on the child's events, so the tests drive them with a
 * fake spawn.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import {
  POWEROFF_BIN,
  SHUTDOWN_BIN,
  checkLocalDirectPowerOff,
  checkLocalPowerOff,
  checkLocalShutdown,
  directPowerOffCheckCommand,
  directPowerOffCommand,
  localPowerOffMode,
  localShutdownCheckCommand,
  localShutdownCommand,
  spawnLocalDirectPowerOff,
  spawnLocalPowerOff,
  spawnLocalShutdown,
} from "../shutdown.js";

/** A fake child that emits the events a real spawn would, on demand. */
function fakeChild() {
  const child = new EventEmitter();
  child.unref = () => {};
  return child;
}

test("localShutdownCommand: a container enters the host mount namespace; a bare host calls sudo directly", () => {
  const inContainer = localShutdownCommand({ mntNs: "/host/proc/1/ns/mnt" });
  assert.equal(inContainer.file, "nsenter");
  assert.deepEqual(inContainer.args.slice(0, 3), ["--mount=/host/proc/1/ns/mnt", "--", "sudo"]);
  assert.deepEqual(inContainer.args.slice(3), ["-n", SHUTDOWN_BIN]);

  const bare = localShutdownCommand({ mntNs: null });
  assert.equal(bare.file, "sudo");
  assert.deepEqual(bare.args, ["-n", SHUTDOWN_BIN]);
});

test("localShutdownCheckCommand runs the same probe the remote command runs", () => {
  const inContainer = localShutdownCheckCommand({ mntNs: "/host/proc/1/ns/mnt" });
  assert.equal(inContainer.file, "nsenter");
  assert.equal(inContainer.args[2], "sh");
  const script = inContainer.args.at(-1);
  assert.match(script, /test -x /);
  assert.match(script, /--check/);
  assert.match(script, /exit 126/);

  const bare = localShutdownCheckCommand({ mntNs: null });
  assert.equal(bare.file, "sh");
  assert.equal(bare.args[0], "-c");
});

test("checkLocalShutdown: exit 0 resolves", async () => {
  const child = fakeChild();
  const pending = checkLocalShutdown({ mntNs: null, spawnFn: () => child });
  child.emit("exit", 0);
  await assert.doesNotReject(pending);
});

test("checkLocalShutdown: a missing helper (127) and denied sudo (126) reject with the reason", async () => {
  const missing = checkLocalShutdown({
    mntNs: null,
    spawnFn: () => {
      const c = fakeChild();
      queueMicrotask(() => c.emit("exit", 127));
      return c;
    },
  });
  await assert.rejects(missing, /not found/);

  const denied = checkLocalShutdown({
    mntNs: null,
    spawnFn: () => {
      const c = fakeChild();
      queueMicrotask(() => c.emit("exit", 126));
      return c;
    },
  });
  await assert.rejects(denied, /passwordless sudo/);
});

test("checkLocalShutdown: a check that never exits rejects instead of hanging the route", async () => {
  await assert.rejects(
    checkLocalShutdown({ mntNs: null, spawnFn: () => fakeChild(), timeoutMs: 10 }),
    /timed out/
  );
});

test("checkLocalShutdown: a spawn error rejects (check transport missing)", async () => {
  const pending = checkLocalShutdown({
    mntNs: null,
    spawnFn: () => {
      const c = fakeChild();
      queueMicrotask(() => c.emit("error", { message: "spawn nsenter ENOENT" }));
      return c;
    },
  });
  await assert.rejects(pending, /not found/);
});

test("spawnLocalShutdown: exit 0 resolves; a nonzero exit rejects with the status", async () => {
  const okChild = fakeChild();
  const ok = spawnLocalShutdown({ mntNs: null, spawnFn: () => okChild });
  okChild.emit("spawn");
  okChild.emit("exit", 0);
  await assert.doesNotReject(ok);

  const failChild = fakeChild();
  const fail = spawnLocalShutdown({ mntNs: null, spawnFn: () => failChild });
  failChild.emit("spawn");
  failChild.emit("exit", 1);
  await assert.rejects(fail, /status 1/);
});

test("spawnLocalShutdown: a missing binary still reports through 'error', never success", async () => {
  const child = fakeChild();
  const pending = spawnLocalShutdown({ mntNs: null, spawnFn: () => child });
  child.emit("error", { message: "spawn sudo ENOENT" });
  await assert.rejects(pending, /not found/);
});

test("localPowerOffMode: root with the host namespace is direct; anything else uses the helper", () => {
  assert.equal(localPowerOffMode({ uid: 0, mntNs: "/host/proc/1/ns/mnt" }), "direct");
  assert.equal(localPowerOffMode({ uid: 1000, mntNs: "/host/proc/1/ns/mnt" }), "helper");
  assert.equal(localPowerOffMode({ uid: 0, mntNs: null }), "helper");
  assert.equal(localPowerOffMode({ uid: null, mntNs: "/host/proc/1/ns/mnt" }), "helper");
});

test("directPowerOffCommand: nsenter runs the host poweroff binary; the check reserves 127 for a missing binary", () => {
  const cmd = directPowerOffCommand({ mntNs: "/host/proc/1/ns/mnt" });
  assert.equal(cmd.file, "nsenter");
  assert.deepEqual(cmd.args, ["--mount=/host/proc/1/ns/mnt", "--", POWEROFF_BIN]);

  const check = directPowerOffCheckCommand({ mntNs: "/host/proc/1/ns/mnt" });
  assert.equal(check.file, "nsenter");
  assert.match(check.args.at(-1), /test -x /);
  assert.match(check.args.at(-1), /exit 127/);
});

test("checkLocalPowerOff dispatches: root with a namespace checks poweroff, otherwise the helper", async () => {
  let direct;
  const directPending = checkLocalPowerOff({
    uid: 0,
    mntNs: "/host/proc/1/ns/mnt",
    spawnFn: (file, args) => {
      direct = { file, args };
      const c = fakeChild();
      queueMicrotask(() => c.emit("exit", 0));
      return c;
    },
  });
  await assert.doesNotReject(directPending);
  assert.equal(direct.file, "nsenter");
  assert.match(direct.args.at(-1), /test -x \/usr\/sbin\/poweroff/);

  let helper;
  const helperPending = checkLocalPowerOff({
    uid: 1000,
    mntNs: "/host/proc/1/ns/mnt",
    spawnFn: (file, args) => {
      helper = { file, args };
      const c = fakeChild();
      queueMicrotask(() => c.emit("exit", 0));
      return c;
    },
  });
  await assert.doesNotReject(helperPending);
  assert.match(helper.args.at(-1), new RegExp(SHUTDOWN_BIN.replace(/\//g, "\\$&")));
  assert.match(helper.args.at(-1), /--check/);
});

test("checkLocalDirectPowerOff: exit 0 resolves; a missing binary and an unreachable namespace reject with reasons", async () => {
  const okChild = fakeChild();
  const ok = checkLocalDirectPowerOff({ mntNs: "/host/proc/1/ns/mnt", spawnFn: () => okChild });
  okChild.emit("exit", 0);
  await assert.doesNotReject(ok);

  const missing = checkLocalDirectPowerOff({
    mntNs: "/host/proc/1/ns/mnt",
    spawnFn: () => {
      const c = fakeChild();
      queueMicrotask(() => c.emit("exit", 127));
      return c;
    },
  });
  await assert.rejects(missing, /poweroff was not found/);

  const blocked = checkLocalDirectPowerOff({
    mntNs: "/host/proc/1/ns/mnt",
    spawnFn: () => {
      const c = fakeChild();
      queueMicrotask(() => c.emit("exit", 1));
      return c;
    },
  });
  await assert.rejects(blocked, /privileged: true/);

  const noNsenter = checkLocalDirectPowerOff({
    mntNs: "/host/proc/1/ns/mnt",
    spawnFn: () => {
      const c = fakeChild();
      queueMicrotask(() => c.emit("error", { message: "spawn nsenter ENOENT" }));
      return c;
    },
  });
  await assert.rejects(noNsenter, /nsenter not found/);
});

test("spawnLocalPowerOff dispatches the direct spawn for root and reports a failed power-off", async () => {
  const okChild = fakeChild();
  const ok = spawnLocalPowerOff({ uid: 0, mntNs: "/host/proc/1/ns/mnt", spawnFn: () => okChild });
  okChild.emit("spawn");
  okChild.emit("exit", 0);
  await assert.doesNotReject(ok);
  await assert.rejects(
    spawnLocalDirectPowerOff({
      mntNs: "/host/proc/1/ns/mnt",
      spawnFn: () => {
        const c = fakeChild();
        queueMicrotask(() => c.emit("exit", 1));
        return c;
      },
    }),
    /direct power-off is unavailable/
  );
});
