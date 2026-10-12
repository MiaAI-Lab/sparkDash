import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";

import { SystemCollector } from "../SystemCollector.js";

function localCollector() {
  const collector = new SystemCollector({
    id: "rootless-test",
    name: "Rootless Test",
    isLocal: true,
    lanIp: "127.0.0.1",
  });
  collector._hasHostProc = () => true;
  return collector;
}

/** Stub execFile: nsenter fails with the rootless EPERM shape, plain sh echoes. */
function stubExecFile(t, nsenterErr, shStdout = "container-view") {
  const seen = { nsenter: 0, sh: 0 };
  t.mock.method(childProcess, "execFile", (file, args, opts, cb) => {
    if (file === "nsenter") {
      seen.nsenter += 1;
      cb(nsenterErr, "");
      return;
    }
    seen.sh += 1;
    cb(null, shStdout);
  });
  return seen;
}

const EPERM_ERR = Object.assign(
  new Error("Command failed: nsenter --mount=/host/proc/1/ns/mnt ... setns: Operation not permitted"),
  { code: 1, stderr: "nsenter: setns: Operation not permitted" }
);

test("rootless EPERM falls back once, warns once, then skips nsenter", async (t) => {
  const collector = localCollector();
  const warn = t.mock.method(console, "warn", () => {});
  const seen = stubExecFile(t, EPERM_ERR);

  const first = await collector._execOnHost("echo container-view");
  assert.equal(first, "container-view");
  assert.equal(seen.nsenter, 1);
  assert.equal(warn.mock.callCount(), 1);

  // The classification is remembered: no doomed nsenter retry on later polls.
  const second = await collector._execOnHost("echo container-view");
  assert.equal(second, "container-view");
  assert.equal(seen.nsenter, 1);
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(collector._nsenterBroken, true);
});

test("allowContainerFallback:false throws so callers report unknown, not container zeros", async (t) => {
  const collector = localCollector();
  collector._nsenterBroken = true; // already classified

  await assert.rejects(
    collector._execOnHost("journalctl -k ...", { allowContainerFallback: false })
  );
});

test("a hung nsenter (timeout) propagates and does not mark nsenter broken", async (t) => {
  const collector = localCollector();
  const timeoutErr = Object.assign(new Error("Command timed out"), {
    killed: true,
    code: null,
    signal: "SIGTERM",
  });
  const seen = stubExecFile(t, timeoutErr);

  await assert.rejects(collector._execOnHost("echo x"), /timed out/);
  assert.equal(collector._nsenterBroken, false);

  // A later poll retries nsenter rather than silently degrading.
  await assert.rejects(collector._execOnHost("echo x"), /timed out/);
  assert.equal(seen.nsenter, 2);
});

test("net fallback requires the container netns to be the host's", async (t) => {
  const collector = localCollector();
  collector._nsenterBroken = true;

  collector._containerNetnsIsHost = () => false;
  await assert.rejects(collector._execOnHostNet("ip -4 addr show"));
  await assert.rejects(collector._readHostNetFile("dev"));

  collector._containerNetnsIsHost = () => true;
  stubExecFile(t, EPERM_ERR, "netns-ok");
  assert.equal(await collector._execOnHostNet("echo netns-ok"), "netns-ok");

  t.mock.method(fs, "readFileSync", () => "Inter-| Receive | Transmit\n");
  assert.match(await collector._readHostNetFile("dev"), /Inter-\|/);
});

test("healthy nsenter path: host output, net flag only for net variant, no fallback state", async (t) => {
  const collector = localCollector();
  const warn = t.mock.method(console, "warn", () => {});
  const calls = [];
  t.mock.method(childProcess, "execFile", (file, args, opts, cb) => {
    if (file === "nsenter") {
      calls.push({ args, timeout: opts?.timeout });
      cb(null, "host-view\n");
      return;
    }
    cb(null, "");
  });

  assert.equal(await collector._execOnHost("nvidia-smi"), "host-view");
  assert.equal(await collector._execOnHostNet("ip -4 addr show"), "host-view");

  assert.equal(calls.length, 2);
  assert.match(calls[0].args[0], /^--mount=/);
  assert.ok(!calls[0].args.some((a) => a.startsWith("--net=")));
  assert.match(calls[1].args[1], /^--net=/);
  assert.ok(calls.every((c) => c.timeout === 8000));
  assert.equal(collector._nsenterBroken, false);
  assert.equal(warn.mock.callCount(), 0);
});

test("_containerNetnsIsHost compares netns dev+ino, caches, and treats stat failure as no", (t) => {
  const collector = localCollector();
  let scenario = "same";
  let stats = 0;
  t.mock.method(fs, "statSync", (p) => {
    stats += 1;
    if (String(p).includes("/host/proc")) return { dev: 7, ino: 42 };
    if (scenario === "boom") throw new Error("no proc");
    return scenario === "same" ? { dev: 7, ino: 42 } : { dev: 7, ino: 43 };
  });

  assert.equal(collector._containerNetnsIsHost(), true); // same ns -> host view valid
  assert.equal(collector._containerNetnsIsHost(), true);
  assert.equal(stats, 2); // cached: the second call did not re-stat

  const other = localCollector();
  scenario = "differs";
  assert.equal(other._containerNetnsIsHost(), false);

  const broken = localCollector();
  scenario = "boom";
  assert.equal(broken._containerNetnsIsHost(), false);

  // The first collector's cached verdict survives the other instances' checks.
  assert.equal(collector._containerNetnsShared, true);
});
