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
  SHUTDOWN_BIN,
  checkLocalShutdown,
  localShutdownCheckCommand,
  localShutdownCommand,
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
