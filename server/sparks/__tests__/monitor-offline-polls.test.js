/**
 * A remote unit whose SSH stops working must not be polled forever.
 *
 * The bug this pins down: every domain interval kept firing while the monitor
 * already knew the unit was unreachable, so each poll opened another SSH
 * connection that failed authentication — one broken unit produced ~60k failed
 * logins a day, indefinitely. Now the collectors pause while it is offline, the
 * liveness probe backs off (an auth failure goes straight to the slowest
 * interval, because it cannot fix itself), and the reason reaches the snapshot.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  SparkMonitor,
  isSshAuthFailure,
  livenessReason,
  nextLivenessDelayMs,
  sshAuthGaveUp,
} from "../SparkMonitor.js";

function spark(overrides = {}) {
  return {
    id: "rtx-pro-6000",
    name: "RTX PRO 6000",
    kind: "host",
    lanIp: "192.168.10.253",
    isLocal: false,
    llmMonitoring: false,
    comfyMonitoring: false,
    hermesMonitoring: false,
    tailscaleMonitoring: false,
    storagePollDisabled: true,
    ...overrides,
  };
}

/** Monitor whose collector calls are counted rather than executed. */
function countingMonitor(overrides) {
  const monitor = new SparkMonitor(spark(overrides));
  monitor._running = true;
  const calls = { gpu: 0, cpu: 0, uptime: 0 };
  monitor.collector.collectGpu = async () => {
    calls.gpu += 1;
    return monitor.collector._defaultGpu();
  };
  monitor.collector.collectCpu = async () => {
    calls.cpu += 1;
    return monitor.collector._defaultCpu();
  };
  monitor._readUptime = async () => {
    calls.uptime += 1;
    return 1234;
  };
  return { monitor, calls };
}

test("remote unit that is offline: collector polls are suspended", async (t) => {
  const logs = [];
  t.mock.method(console, "log", (line) => logs.push(String(line)));
  const { monitor, calls } = countingMonitor();
  monitor.online = false;
  monitor.offlineReason = "SSH authentication failed — check the key or user for this unit";

  await monitor._pollDomain("gpu");
  await monitor._pollDomain("cpu");

  assert.equal(calls.gpu, 0, "collectGpu must not run against an unreachable unit");
  assert.equal(calls.cpu, 0, "collectCpu must not run against an unreachable unit");
  assert.equal(monitor._pollsPaused, true);
  assert.equal(logs.length, 1, "the pause is logged once, not per interval");
  assert.match(logs[0], /pausing collector polls/);
  assert.match(logs[0], /SSH authentication failed/);
});

test("local unit that is offline: collectors still run", async () => {
  // Local reads are /proc and /sys — cheap, and partially useful when a liveness
  // check trips. Only remote units pause.
  const { monitor, calls } = countingMonitor({ isLocal: true, kind: "spark" });
  monitor.online = false;

  await monitor._pollDomain("gpu");
  await monitor._pollDomain("cpu");

  assert.equal(calls.gpu, 1);
  assert.equal(calls.cpu, 1);
  assert.equal(monitor._pollsPaused, false);
});

test("remote unit that comes back: polls resume and say so", async (t) => {
  const logs = [];
  t.mock.method(console, "log", (line) => logs.push(String(line)));
  const { monitor, calls } = countingMonitor();
  monitor.online = false;
  await monitor._pollDomain("gpu");
  assert.equal(calls.gpu, 0);

  monitor.online = true;
  await monitor._pollDomain("gpu");
  assert.equal(calls.gpu, 1);
  assert.equal(monitor._pollsPaused, false);
  assert.ok(logs.some((l) => /resuming collector polls/.test(l)));
});

test("liveness respects the backoff gate instead of retrying every interval", async () => {
  const { monitor, calls } = countingMonitor();
  monitor._nextLivenessAt = Date.now() + 30_000;

  await monitor._checkOnline();

  assert.equal(calls.uptime, 0, "a gated attempt must not open a connection");
});

test("liveness failure records the reason and starts the prompt retries", async () => {
  const { monitor } = countingMonitor();
  monitor._readUptime = async () => {
    throw new Error("SSH to 192.168.10.253 failed: Permission denied (publickey,password).");
  };

  const before = Date.now();
  await monitor._checkOnline();

  assert.equal(monitor.online, false);
  assert.match(monitor.offlineReason, /SSH authentication failed/);
  assert.match(monitor.snapshot().offlineReason, /SSH authentication failed/);
  assert.equal(monitor._livenessFailures, 1);
  // Quick attempts first: a wrong user deserves a prompt report, not a 1-minute
  // wait. Compared with slack — the schedule is Date.now() + delay, so the
  // difference includes however long this line took to run.
  const firstWait = monitor._nextLivenessAt - before;
  assert.ok(firstWait >= 5_000 && firstWait < 6_000, `expected ~5s, got ${firstWait}ms`);
});

test("credential failures stop after a few attempts and say what to do", async () => {
  const { monitor } = countingMonitor();
  monitor._readUptime = async () => {
    throw new Error("Permission denied (publickey)");
  };

  const waits = [];
  for (let i = 1; i <= 6; i += 1) {
    monitor._nextLivenessAt = 0;
    const before = Date.now();
    await monitor._checkOnline();
    waits.push(monitor._nextLivenessAt - before);
  }

  // Four quick attempts (5s/15s/30s/60s), then effectively stopped: ~15 minutes
  // apart is 96 logins a day instead of 60,000.
  assert.deepEqual(waits.slice(0, 4), [5_000, 15_000, 30_000, 60_000]);
  assert.equal(waits[4], 15 * 60_000);
  assert.equal(waits[5], 15 * 60_000);
  assert.equal(sshAuthGaveUp(4), false);
  assert.equal(sshAuthGaveUp(5), true);
  assert.match(monitor.offlineReason, /paused after \d+ attempts/);
  assert.match(monitor.offlineReason, /edit the unit to retry now/);
});

test("editing the unit restarts the credential retries immediately", async () => {
  const { monitor } = countingMonitor();
  monitor._readUptime = async () => {
    throw new Error("Permission denied (publickey)");
  };
  for (let i = 0; i < 5; i += 1) {
    monitor._nextLivenessAt = 0;
    await monitor._checkOnline();
  }
  assert.equal(sshAuthGaveUp(monitor._livenessFailures), true);

  monitor.updateConfig({ ...spark({ ssh: { host: "192.168.10.253", user: "zurich" } }) });

  assert.equal(monitor._livenessFailures, 0);
  assert.equal(monitor._nextLivenessAt, 0, "the next attempt must not wait");
});

test("liveness backoff widens for ordinary failures and resets on success", async () => {
  const { monitor, calls } = countingMonitor();
  monitor._readUptime = async () => {
    throw new Error("connect ETIMEDOUT 192.168.10.253:22");
  };

  await monitor._checkOnline();
  const first = monitor._nextLivenessAt - Date.now();
  assert.ok(first <= 5_000, `first retry should be prompt, got ${first}ms`);
  assert.match(monitor.offlineReason, /timed out/i);

  monitor._nextLivenessAt = 0;
  await monitor._checkOnline();
  const second = monitor._nextLivenessAt - Date.now();
  assert.ok(second > first, "a second failure waits longer than the first");

  monitor._nextLivenessAt = 0;
  monitor._readUptime = async () => {
    calls.uptime += 1;
    return 1234;
  };
  await monitor._checkOnline();
  assert.equal(monitor._livenessFailures, 0, "success clears the failure count");
  assert.equal(monitor.offlineReason, null);
  assert.equal(monitor._nextLivenessAt, 0);
  assert.equal(monitor.online, true);
  assert.equal(calls.uptime, 1, "only the successful attempt read uptime");
});

test("backoff schedule and reason mapping", () => {
  assert.equal(nextLivenessDelayMs(1, "connection timed out"), 5_000);
  assert.equal(nextLivenessDelayMs(2, "connection timed out"), 15_000);
  assert.equal(nextLivenessDelayMs(3, "connection timed out"), 30_000);
  assert.equal(nextLivenessDelayMs(4, "connection timed out"), 60_000);
  assert.equal(nextLivenessDelayMs(40, "connection timed out"), 60_000);
  // Credential problems retry promptly a few times, then go quiet.
  assert.equal(nextLivenessDelayMs(1, "SSH authentication failed"), 5_000);
  assert.equal(nextLivenessDelayMs(4, "SSH authentication failed"), 60_000);
  assert.equal(nextLivenessDelayMs(5, "SSH authentication failed"), 15 * 60_000);
  assert.equal(isSshAuthFailure("Permission denied (publickey)"), true);
  assert.equal(isSshAuthFailure("connect ETIMEDOUT"), false);

  assert.equal(livenessReason(new Error("connect ETIMEDOUT 10.0.0.9:22")), "connection timed out");
  assert.equal(livenessReason(new Error("connect ECONNREFUSED 10.0.0.9:22")), "connection refused");
  assert.equal(livenessReason(new Error("connect EHOSTUNREACH")), "no route to host");
  assert.equal(livenessReason(new Error("Permission denied (publickey)")), "SSH authentication failed — check the key or user for this unit");
  assert.equal(livenessReason(null), "unreachable");
});

test("online snapshot carries no offline reason", () => {
  const { monitor } = countingMonitor();
  monitor.online = true;
  monitor.offlineReason = "stale text from a previous failure";
  assert.equal(monitor.snapshot().offlineReason, null);
});
