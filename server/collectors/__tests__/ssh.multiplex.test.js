import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { ensureMultiplexReady, invalidateMultiplex, sshMultiplexConfig } from "../ssh.js";

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

test("invalidating a failed transport forces a fresh readiness probe", async () => {
  const config = { key: `invalidate-${Date.now()}`, persistSeconds: 60 };
  let calls = 0;
  const establish = async () => { calls += 1; };
  await ensureMultiplexReady(config, establish);
  invalidateMultiplex(config);
  await ensureMultiplexReady(config, establish);
  assert.equal(calls, 2);
});
