import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { ensureMultiplexReady, sshExec, sshMultiplexConfig } from "../ssh.js";

function mockExec(t, handler) {
  const mocked = t.mock.method(childProcess, "execFile", handler);
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
}

function unit(id) {
  return { id, ssh: { host: "10.0.0.2", user: "sparky" } };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("builds a private, isolated control socket config", () => {
  delete process.env.SSH_CONTROL_PERSIST_SECONDS;
  const config = sshMultiplexConfig({ id: "spark-2" }, "10.0.0.2", "sparky", "key", null);
  assert.equal(config.persistSeconds, 60);
  assert.ok(config.args.includes("ControlMaster=auto"));
  assert.ok(config.args.includes("ControlPersist=60"));
  const pathArg = config.args.find((arg) => arg.startsWith("ControlPath="));
  const socketDir = pathArg.slice("ControlPath=".length).replace(/\/[^/]+$/, "");
  assert.equal(fs.statSync(socketDir).mode & 0o777, 0o700);
});

test("isolates password credentials without exposing them", () => {
  const spark = { id: "test" };
  const first = sshMultiplexConfig(spark, "192.168.1.2", "user", "pass", "secret-one");
  const second = sshMultiplexConfig(spark, "192.168.1.2", "user", "pass", "secret-two");
  assert.notEqual(first.key, second.key);
  assert.equal(first.args.join(" ").includes("secret-one"), false);
});

test("supports disable and clamps excessive persistence", () => {
  process.env.SSH_CONTROL_PERSIST_SECONDS = "0";
  assert.equal(sshMultiplexConfig({ id: "s" }, "10.0.0.1", "u", "key", null), null);
  process.env.SSH_CONTROL_PERSIST_SECONDS = "99999";
  assert.equal(sshMultiplexConfig({ id: "s" }, "10.0.0.1", "u", "key", null).persistSeconds, 3600);
  delete process.env.SSH_CONTROL_PERSIST_SECONDS;
});

test("gates concurrent cold probes behind one connection setup", async () => {
  const config = { key: `gate-${Date.now()}`, persistSeconds: 60 };
  let releaseProbe;
  let calls = 0;
  const initial = ensureMultiplexReady(config, async () => {
    calls += 1;
    await new Promise((resolve) => { releaseProbe = resolve; });
  });
  await Promise.resolve();
  const follower = ensureMultiplexReady(config, async () => {
    calls += 1;
  });
  await Promise.resolve();
  assert.equal(calls, 1);
  releaseProbe();
  await Promise.all([initial, follower]);
  assert.equal(calls, 1);
});

test("post-probe transport failure gates recovery and ignores stale failures", async (t) => {
  const spark = unit("transport-recovery");
  let probes = 0;
  let releaseRecovery;
  let failLate;
  let brokenCalls = 0;
  mockExec(t, (_file, args, _options, callback) => {
    const cmd = args.at(-1);
    if (cmd === "true") {
      probes += 1;
      if (probes === 2) { releaseRecovery = callback; return; }
    }
    if (cmd === "late") { failLate = callback; return; }
    if (cmd === "broken") {
      brokenCalls += 1;
      callback(Object.assign(new Error("lost transport"), { code: 255 }), "", "connection lost");
      return;
    }
    callback(null, "ok", "");
  });
  assert.equal(await sshExec(spark, "seed"), "ok");
  const late = assert.rejects(sshExec(spark, "late"), /connection lost/);
  await tick();
  await assert.rejects(sshExec(spark, "broken"), /connection lost/);
  assert.equal(brokenCalls, 1, "failed command is not replayed");
  const wave = Array.from({ length: 12 }, () => sshExec(spark, "metric"));
  await tick();
  assert.equal(probes, 2, "one new probe before TTL expiry");
  failLate(Object.assign(new Error("lost transport"), { code: 255 }), "", "connection lost");
  await late;
  const follower = sshExec(spark, "metric");
  await tick();
  assert.equal(probes, 2, "late failure preserves the recovery generation");
  releaseRecovery(null, "", "");
  assert.deepEqual(await Promise.all([...wave, follower]), Array(13).fill("ok"));
});

test("remote command exit does not invalidate a healthy transport", async (t) => {
  let probes = 0;
  mockExec(t, (_file, args, _options, callback) => {
    if (args.at(-1) === "true") probes += 1;
    if (args.at(-1) === "missing") {
      callback(Object.assign(new Error("exit 1"), { code: 1 }), "", "not found");
    } else callback(null, "ok", "");
  });
  const spark = unit("remote-exit");
  await assert.rejects(sshExec(spark, "missing"), /not found/);
  await sshExec(spark, "metric");
  assert.equal(probes, 1);
});

test("timed-out command invalidates multiplex readiness", async (t) => {
  let probes = 0;
  mockExec(t, (_file, args, _options, callback) => {
    if (args.at(-1) === "true") probes += 1;
    if (args.at(-1) === "slow") {
      callback(Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM", code: null }), "", "");
    } else callback(null, "ok", "");
  });
  const spark = unit("timeout-recovery");
  await assert.rejects(sshExec(spark, "slow"), /timed out/);
  await Promise.all([sshExec(spark, "metric"), sshExec(spark, "metric")]);
  assert.equal(probes, 2);
});
