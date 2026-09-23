/**
 * docker.test.js — tests for the docker action layer (Batch 2A).
 *
 * child_process.execFile is simulated by injecting a fake through
 * opts.execFile — the exact call seam docker.js uses, with the same
 * `(file, args, options, callback)` signature. This keeps tests hermetic
 * (no docker daemon needed) and lets each test assert the exact argv,
 * which is what proves no-shell, no-injection.
 *
 * Fake error shapes mirror real child_process.execFile on Node v24.21
 * (verified empirically before writing these tests):
 *   - non-zero exit: err.code === <exit code> (number), stderr as 3rd callback arg
 *   - binary missing: err.code === "ENOENT"
 *   - timeout:        err.killed === true, err.signal === "SIGTERM", err.code === null
 *
 * Run: node --test agent/actions/__tests__/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startContainer,
  stopContainer,
  restartContainer,
  removeContainer,
  DEFAULT_TIMEOUT_MS,
  ERROR_MAX_CHARS,
} from "../docker.js";

/**
 * A recording fake execFile.
 * @param {(callIndex: number) => [Error | null, string, string]} behavior
 *   returns [err, stdout, stderr] for the Nth call
 */
function fakeExecFile(behavior) {
  /** @type {Array<{file: string, args: string[], options: object}>} */
  const calls = [];
  /** @type {typeof import("node:child_process").execFile} */
  const fn = (file, args, options, cb) => {
    calls.push({ file: String(file), args: [...args], options: { ...options } });
    const [err, stdout, stderr] = behavior(calls.length - 1);
    if (typeof cb === "function") cb(err, stdout, stderr);
  };
  return { fn, calls };
}

/** @param {number} code @param {string} [stderr] */
function exitErr(code, stderr = "Error response from daemon: boom") {
  const e = new Error("Command failed: docker");
  e.code = code;
  return [e, "", stderr];
}

test("startContainer: exit 0 → success ActionResponse, exact argv, default timeout knob", async () => {
  const { fn, calls } = fakeExecFile(() => [null, "qwen38-sglang\n", ""]);
  const res = await startContainer("qwen38-sglang", {
    actionId: "act-1",
    serviceName: "llm-tp1",
    execFile: fn,
  });
  assert.equal(res.ok, true);
  assert.equal(res.status, "success");
  assert.equal(res.error, null);
  assert.equal(res.idempotent, true);
  assert.equal(res.actionId, "act-1");
  assert.equal(res.serviceName, "llm-tp1");
  assert.equal(res.message, "docker start qwen38-sglang → exit 0");
  assert.equal(typeof res.at, "number");
  assert.ok(res.durationMs >= 0, "durationMs is a non-negative number");
  // exact argv: binary + single-arg name, no shell
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "docker");
  assert.deepEqual(calls[0].args, ["start", "qwen38-sglang"]);
  assert.equal(calls[0].options.timeout, DEFAULT_TIMEOUT_MS, "default timeout knob honored");
});

test("startContainer: exit 1 → failure with error = stderr, message → exit 1", async () => {
  const { fn } = fakeExecFile(() =>
    exitErr(1, "Error response from daemon: no such container: ghost")
  );
  const res = await startContainer("ghost", { execFile: fn });
  assert.equal(res.ok, false);
  assert.equal(res.status, "failure");
  assert.equal(res.error, "Error response from daemon: no such container: ghost");
  assert.equal(res.message, "docker start ghost → exit 1");
  assert.equal(res.idempotent, true);
});

test("stopContainer: exit 0 → ok true, args ['stop', name]", async () => {
  const { fn, calls } = fakeExecFile(() => [null, "c\n", ""]);
  const res = await stopContainer("c", { execFile: fn });
  assert.equal(res.ok, true);
  assert.equal(res.status, "success");
  assert.equal(res.idempotent, true);
  assert.equal(res.message, "docker stop c → exit 0");
  assert.deepEqual(calls[0].args, ["stop", "c"]);
});

test("restartContainer: exit 0 → ok true, args ['restart', name]", async () => {
  const { fn, calls } = fakeExecFile(() => [null, "c\n", ""]);
  const res = await restartContainer("c", { execFile: fn });
  assert.equal(res.ok, true);
  assert.equal(res.status, "success");
  assert.equal(res.idempotent, true);
  assert.deepEqual(calls[0].args, ["restart", "c"]);
});

test("removeContainer: exit 0 → ok true, idempotent FALSE, args ['rm', name]", async () => {
  const { fn, calls } = fakeExecFile(() => [null, "c\n", ""]);
  const res = await removeContainer("c", { execFile: fn });
  assert.equal(res.ok, true);
  assert.equal(res.status, "success");
  assert.equal(res.idempotent, false, "remove is not idempotent");
  assert.deepEqual(calls[0].args, ["rm", "c"]);
});

test("docker not found (ENOENT) → ok false, error 'docker not found'", async () => {
  const enoent = [new Error("spawn docker ENOENT"), "", ""];
  enoent[0].code = "ENOENT";
  const { fn } = fakeExecFile(() => enoent);
  const res = await stopContainer("c", { execFile: fn });
  assert.equal(res.ok, false);
  assert.equal(res.status, "failure");
  assert.equal(res.error, "docker not found");
  assert.match(res.message, /docker stop c → docker not found/);
});

test("timeout (killed/SIGTERM) → ok false, error 'timeout'", async () => {
  const timeoutErr = new Error("Command failed: docker start c");
  timeoutErr.killed = true;
  timeoutErr.signal = "SIGTERM";
  timeoutErr.code = null;
  const { fn, calls } = fakeExecFile(() => [timeoutErr, "", ""]);
  const res = await startContainer("c", { timeoutMs: 250, execFile: fn });
  assert.equal(res.ok, false);
  assert.equal(res.status, "failure");
  assert.equal(res.error, "timeout");
  assert.equal(res.message, "docker start c → timeout after 250ms");
  // non-default timeout knob: 250 ms actually reached the execFile options
  assert.equal(calls[0].options.timeout, 250);
});

test("exact-argv: shell metacharacters in name stay ONE argv entry (no injection)", async () => {
  const evil = "a; rm -rf / && echo pwned";
  const { fn, calls } = fakeExecFile(() =>
    exitErr(1, `Error response from daemon: no such container: ${evil}`)
  );
  const res = await startContainer(evil, { execFile: fn });
  assert.equal(res.ok, false);
  // the whole malicious string is a single argv entry — a shell would have
  // split on ';' / '&&'; docker just sees an unknown container name
  assert.deepEqual(calls[0].args, ["start", evil]);
  assert.equal(calls[0].args.length, 2);
  assert.equal(calls[0].file, "docker");
  assert.equal(res.error, `Error response from daemon: no such container: ${evil}`);
});

test("stderr is truncated to 500 chars in error", async () => {
  const longStderr = "x".repeat(600);
  const { fn } = fakeExecFile(() => exitErr(1, longStderr));
  const res = await startContainer("c", { execFile: fn });
  assert.equal(res.ok, false);
  assert.equal(res.error.length, ERROR_MAX_CHARS);
  assert.equal(res.error, "x".repeat(ERROR_MAX_CHARS));
});

test("invalid name: empty / non-string / oversized → failure WITHOUT spawning", async () => {
  for (const bad of ["", null, 42, "n".repeat(2000), "bad\nname"]) {
    const { fn, calls } = fakeExecFile(() => [null, "", ""]);
    const res = await startContainer(/** @type {any} */ (bad), { execFile: fn });
    assert.equal(res.ok, false, `name ${JSON.stringify(bad).slice(0, 20)} should fail`);
    assert.equal(res.status, "failure");
    assert.match(res.error, /invalid container name/);
    assert.equal(res.durationMs, 0);
    assert.equal(calls.length, 0, "execFile must not be called for invalid names");
  }
});

test("defaults: actionId generated, serviceName falls back to container name", async () => {
  const { fn } = fakeExecFile(() => [null, "c\n", ""]);
  const before = Date.now();
  const res = await startContainer("c", { execFile: fn });
  assert.match(res.actionId, /^act-\d+/);
  assert.equal(res.serviceName, "c");
  assert.ok(res.at >= before && res.at <= Date.now());
});

test("empty stderr on failure → fallback error text, never empty", async () => {
  const { fn } = fakeExecFile(() => exitErr(7, ""));
  const res = await stopContainer("c", { execFile: fn });
  assert.equal(res.ok, false);
  assert.equal(res.error, "docker stop exited with code 7");
});

test("opts: undefined and null tolerated (all defaults)", async () => {
  // Real execFile default (no seam): a container name guaranteed absent on
  // every node. `docker start` on a non-existent container is a no-op
  // failure (exit 1, "no such container") — no side effects; either outcome
  // (exit 1, or ENOENT when docker is missing) must be well-formed.
  const a = await startContainer("sparkdash-2a-no-such-container", undefined);
  assert.equal(typeof a.ok, "boolean");
  assert.ok(["success", "failure"].includes(a.status));
  assert.equal(typeof a.durationMs, "number");
  assert.equal(typeof a.at, "number");

  // null opts normalizes to no-opts like undefined does. Drive it through
  // the fast-fail path (empty name) so no process is spawned at all.
  const b = await stopContainer("", /** @type {any} */ (null));
  assert.equal(b.ok, false);
  assert.equal(b.status, "failure");
  assert.match(b.error, /invalid container name/);
});
