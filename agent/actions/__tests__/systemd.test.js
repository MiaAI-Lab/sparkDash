import test from "node:test";
import assert from "node:assert/strict";
import {
  startUnit,
  stopUnit,
  restartUnit,
  runExec,
  isValidUnitName,
  buildActionResponse,
  withIdempotency,
} from "../systemd.js";

// ─── helpers ────────────────────────────────────────────────────────────────

const OK = { exitCode: 0, stdout: "", stderr: "", notFound: false, timedOut: false };

/**
 * Sequential exec mock: results[i] is consumed by call i+1.
 * Each entry: ExecResult, an Error to throw, or a Promise to return.
 */
function execMock(results) {
  const calls = [];
  const fn = async (file, args, runOpts) => {
    calls.push({ file, args, runOpts });
    const r = results[calls.length - 1];
    if (r instanceof Promise) return r;
    if (r instanceof Error) throw r;
    return r;
  };
  return { fn, calls };
}

// ─── start/stop/restart: success + failure mapping ──────────────────────────

test("systemd: startUnit exit 0 → ActionResponse {ok:true, status:'success'}", async () => {
  const m = execMock([{ ...OK }]);
  const r = await startUnit("qwen38-sglang.service", {
    actionId: "a1",
    serviceName: "llm-tp1",
    timeoutMs: 5000,
  }, { exec: m.fn });
  assert.equal(r.ok, true);
  assert.equal(r.status, "success");
  assert.equal(r.idempotent, true);
  assert.equal(r.error, null);
  assert.equal(r.actionId, "a1");
  assert.equal(r.serviceName, "llm-tp1");
  assert.equal(typeof r.at, "number");
  assert.ok(r.at <= Date.now());
  assert.equal(typeof r.durationMs, "number");
  assert.equal(r.message, "systemctl start qwen38-sglang.service → exit 0");
});

test("systemd: startUnit exit 1 → {ok:false, status:'failure', error:stderr}", async () => {
  const stderr = "Unit qwen38-sglang.service could not be found.";
  const m = execMock([{ exitCode: 1, stdout: "", stderr, notFound: false, timedOut: false }]);
  const r = await startUnit("qwen38-sglang.service", {}, { exec: m.fn });
  assert.equal(r.ok, false);
  assert.equal(r.status, "failure");
  assert.equal(r.error, stderr);
  assert.equal(r.message, "systemctl start qwen38-sglang.service → exit 1");
});

test("systemd: stderr longer than 500 chars is truncated to 500", async () => {
  const stderr = "x".repeat(1000);
  const m = execMock([{ exitCode: 1, stdout: "", stderr, notFound: false, timedOut: false }]);
  const r = await stopUnit("foo.service", {}, { exec: m.fn });
  assert.equal(r.ok, false);
  assert.equal(r.error.length, 500);
  assert.equal(r.error, "x".repeat(500));
});

test("systemd: exit 0 with stderr present → success, error null (exit code is truth)", async () => {
  const m = execMock([{ exitCode: 0, stdout: "", stderr: "warning: something", notFound: false, timedOut: false }]);
  const r = await startUnit("foo.service", {}, { exec: m.fn });
  assert.equal(r.ok, true);
  assert.equal(r.status, "success");
  assert.equal(r.error, null);
});

test("systemd: stopUnit exit 0 → {ok:true, status:'success'}", async () => {
  const m = execMock([{ ...OK }]);
  const r = await stopUnit("qwen28-sglang.service", {}, { exec: m.fn });
  assert.equal(r.ok, true);
  assert.equal(r.status, "success");
  assert.equal(r.message, "systemctl stop qwen28-sglang.service → exit 0");
});

test("systemd: restartUnit exit 0 → {ok:true, status:'success'}", async () => {
  const m = execMock([{ ...OK }]);
  const r = await restartUnit("vllm.service", {}, { exec: m.fn });
  assert.equal(r.ok, true);
  assert.equal(r.status, "success");
  assert.equal(r.message, "systemctl restart vllm.service → exit 0");
});

// ─── graceful degradation ───────────────────────────────────────────────────

test("systemd: systemctl not found (ENOENT) → {ok:false, error:'systemctl not found'}", async () => {
  const m = execMock([{ exitCode: null, stdout: "", stderr: "", notFound: true, timedOut: false }]);
  const r = await startUnit("foo.service", {}, { exec: m.fn });
  assert.equal(r.ok, false);
  assert.equal(r.status, "failure");
  assert.equal(r.error, "systemctl not found");
  assert.equal(r.message, "systemctl not found");
});

test("systemd: timeout → {ok:false, error:'timeout'}", async () => {
  const m = execMock([{ exitCode: null, stdout: "", stderr: "", notFound: false, timedOut: true }]);
  const r = await stopUnit("foo.service", {}, { exec: m.fn });
  assert.equal(r.ok, false);
  assert.equal(r.status, "failure");
  assert.equal(r.error, "timeout");
  assert.match(r.message, /timed out/);
});

// ─── input validation (no command ever executed for invalid input) ─────────

test("systemd: invalid unit names → failure, exec NEVER called", async () => {
  const m = execMock([]);
  const bad = [
    "",
    "a b",               // whitespace → injection vector
    "x;rm -rf /",        // shell metacharacters
    "foo$(echo hi)",     // command substitution
    "foo|bar",           // pipe
    "a/b",               // path separator
    "../etc",            // traversal
    42,                  // non-string
    null,                // null
    "x".repeat(300),     // > 255 (filesystem limit)
  ];
  for (const unit of bad) {
    const r = await startUnit(unit, {}, { exec: m.fn });
    assert.equal(r.ok, false, `unit: ${JSON.stringify(unit)}`);
    assert.equal(r.status, "failure", `unit: ${JSON.stringify(unit)}`);
    assert.equal(r.error, "invalid unit name", `unit: ${JSON.stringify(unit)}`);
  }
  assert.equal(m.calls.length, 0, "no exec call for any invalid unit");
});

test("systemd: isValidUnitName boundary checks", () => {
  assert.equal(isValidUnitName("qwen38-sglang.service"), true);
  assert.equal(isValidUnitName("a@b.service"), true); // template instance
  assert.equal(isValidUnitName("x.target"), true);
  assert.equal(isValidUnitName("a b"), false);
  assert.equal(isValidUnitName(""), false);
  assert.equal(isValidUnitName(42), false);
});

// ─── exact argv (no shell) ──────────────────────────────────────────────────

test("systemd: exact-argv — execFile gets binary + plain args, no sh/-c", async () => {
  const m = execMock([{ ...OK }, { ...OK }, { ...OK }]);
  await startUnit("qwen38-sglang.service", {}, { exec: m.fn });
  await stopUnit("qwen38-sglang.service", {}, { exec: m.fn });
  await restartUnit("qwen38-sglang.service", {}, { exec: m.fn });
  assert.deepEqual(m.calls.map((c) => c.file), ["systemctl", "systemctl", "systemctl"]);
  assert.deepEqual(
    m.calls.map((c) => c.args),
    [
      ["start", "qwen38-sglang.service"],
      ["stop", "qwen38-sglang.service"],
      ["restart", "qwen38-sglang.service"],
    ]
  );
  // no shell wrapper anywhere in the invocation
  for (const c of m.calls) {
    assert.ok(!c.args.includes("-c"), "no sh -c wrapper");
    assert.equal(c.args.length, 2);
  }
});

// ─── knobs ──────────────────────────────────────────────────────────────────

test("systemd: timeoutMs knob is honored (non-default value)", async () => {
  const m = execMock([{ ...OK }]);
  await startUnit("foo.service", { timeoutMs: 1234 }, { exec: m.fn });
  assert.equal(m.calls[0].runOpts.timeoutMs, 1234);
});

test("systemd: default timeoutMs is 30000", async () => {
  const m = execMock([{ ...OK }]);
  await startUnit("foo.service", {}, { exec: m.fn });
  assert.equal(m.calls[0].runOpts.timeoutMs, 30000);
});

test("systemd: default serviceName falls back to the unit", async () => {
  const m = execMock([{ ...OK }]);
  const r = await startUnit("foo.service", {}, { exec: m.fn });
  assert.equal(r.serviceName, "foo.service");
});

test("systemd: invalid timeoutMs falls back to default", async () => {
  const m = execMock([{ ...OK }, { ...OK }]);
  await startUnit("foo.service", { timeoutMs: -5 }, { exec: m.fn });
  await startUnit("foo.service", { timeoutMs: "fast" }, { exec: m.fn });
  assert.equal(m.calls[0].runOpts.timeoutMs, 30000);
  assert.equal(m.calls[1].runOpts.timeoutMs, 30000);
});

// ─── idempotency (concurrent duplicate actionId shares one execution) ──────

test("systemd: concurrent startUnit with same actionId → exactly one exec", async () => {
  let resolveExec;
  const pending = new Promise((res) => {
    resolveExec = res;
  });
  const m = execMock([pending]);
  const p1 = startUnit("u.service", { actionId: "same" }, { exec: m.fn });
  const p2 = startUnit("u.service", { actionId: "same" }, { exec: m.fn });
  // Watchdog: even if the assert below fails, the shared exec always settles
  // (no dangling promise).
  const watchdog = setTimeout(() => resolveExec({ ...OK }), 2000);
  // Flush microtasks: the shared exec starts on the next tick.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(m.calls.length, 1, "second concurrent call must not re-exec");
  clearTimeout(watchdog);
  resolveExec({ ...OK });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, r2, "both callers receive the same response");
  assert.equal(r1.ok, true);
});

test("systemd: different actionIds → separate executions", async () => {
  const m = execMock([{ ...OK }, { ...OK }]);
  await Promise.all([
    startUnit("u.service", { actionId: "a" }, { exec: m.fn }),
    startUnit("u.service", { actionId: "b" }, { exec: m.fn }),
  ]);
  assert.equal(m.calls.length, 2);
});

test("systemd: actionId released after settle — later call re-executes", async () => {
  const m = execMock([{ ...OK }, { ...OK }]);
  const r1 = await startUnit("u.service", { actionId: "same" }, { exec: m.fn });
  const r2 = await startUnit("u.service", { actionId: "same" }, { exec: m.fn });
  assert.equal(m.calls.length, 2, "settled id must be released (bounded state)");
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(typeof r1.at, "number");
  assert.equal(typeof r2.at, "number");
});

test("systemd: withIdempotency converts unexpected rejection to failure response", async () => {
  const r = await withIdempotency("x", async () => {
    throw new Error("dep blew up");
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, "failure");
  assert.match(r.error, /dep blew up/);
  assert.equal(r.actionId, "x");
});

// ─── buildActionResponse defaults ───────────────────────────────────────────

test("systemd: buildActionResponse safe defaults", () => {
  const r = buildActionResponse();
  assert.deepEqual(r, {
    actionId: "",
    serviceName: "",
    status: "failure",
    ok: false,
    message: "",
    error: null,
    durationMs: null,
    idempotent: true,
    at: r.at,
  });
  assert.equal(typeof r.at, "number");
  // error truncation at the builder too (defense in depth)
  const r2 = buildActionResponse({ error: "y".repeat(900) });
  assert.equal(r2.error.length, 500);
});

// ─── ground truth: the REAL execFile runner (not the injected mock) ────────

test("runExec: ground truth — real execFile success/exit-1/ENOENT/timeout", async () => {
  // success
  const ok = await runExec("echo", ["hi from execfile"]);
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout.trim(), "hi from execfile");
  assert.equal(ok.notFound, false);
  assert.equal(ok.timedOut, false);

  // non-zero exit
  const fail = await runExec("false", []);
  assert.equal(fail.exitCode, 1);
  assert.equal(fail.notFound, false);

  // ENOENT
  const nf = await runExec("definitely-missing-binary-12345", []);
  assert.equal(nf.notFound, true);
  assert.equal(nf.exitCode, null);

  // real timeout: sleep 5s with a 200ms budget → killed well before 5s
  const t0 = Date.now();
  const to = await runExec("sleep", ["5"], { timeoutMs: 200 });
  const elapsed = Date.now() - t0;
  assert.equal(to.timedOut, true);
  assert.equal(to.exitCode, null);
  assert.ok(elapsed < 4000, `timeout must kill early, took ${elapsed}ms`);
});

test("runUnitAction: ground truth — default runner, systemctl missing (stripped PATH)", async () => {
  // Hermetic "systemctl not found": default runner is the real execFile;
  // point PATH at an empty dir so the binary cannot resolve.
  const oldPath = process.env.PATH;
  process.env.PATH = "/nonexistent-sparkdash-test-dir";
  try {
    const r = await startUnit("foo.service", { actionId: "gt1" });
    assert.equal(r.ok, false);
    assert.equal(r.status, "failure");
    assert.equal(r.error, "systemctl not found");
    assert.equal(r.idempotent, true);
  } finally {
    process.env.PATH = oldPath;
  }
});
