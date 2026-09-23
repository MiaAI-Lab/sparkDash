import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  switchLlm,
  canaryProbe,
  isValidContainerName,
  validPort,
} from "../llm-switch.js";

// ─── helpers ────────────────────────────────────────────────────────────────

const OK = { exitCode: 0, stdout: "", stderr: "", notFound: false, timedOut: false };

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

/**
 * Fetch mock. `routes` maps exact URL → {status, body} or an Error to throw.
 * `routes["*"]` is the catch-all. Records every requested URL.
 */
function mockFetch(routes) {
  const calls = [];
  const fn = async (url, _opts) => {
    calls.push(url);
    const route = routes[url] ?? routes["*"] ?? { status: 404, body: null };
    if (route instanceof Error) throw route;
    const status = route.status ?? 404;
    const body = "body" in route ? route.body : null;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body == null) throw new Error("no json body");
        return typeof body === "string" ? JSON.parse(body) : body;
      },
      text: async () => (body == null ? "" : JSON.stringify(body)),
    };
  };
  return { fn, calls };
}

const SERVER_INFO = {
  model_path: "RadixArk/Qwen3.8-27B-NVFP4",
  context_length: 262144,
  mem_fraction_static: 0.85,
  tp_size: 1,
  version: "0.2.90",
};

const H = (port) => `http://127.0.0.1:${port}/health`;
const I = (port) => `http://127.0.0.1:${port}/get_server_info`;

/** Fast polling budget for tests (knobs). */
const FAST = { canaryTimeoutMs: 80, pollMs: 5 };

// ─── canaryProbe: state machine ─────────────────────────────────────────────

test("canaryProbe: /health 200 + /get_server_info 200 → state 'ready' with parsed fields", async () => {
  const m = mockFetch({
    [H(8080)]: { status: 200, body: {} },
    [I(8080)]: { status: 200, body: SERVER_INFO },
  });
  const r = await canaryProbe(8080, { fetch: m.fn });
  assert.equal(r.state, "ready");
  assert.equal(r.modelId, "RadixArk/Qwen3.8-27B-NVFP4");
  assert.equal(r.contextLength, 262144);
  assert.equal(r.memFraction, 0.85);
  assert.equal(r.tpSize, 1);
});

test("canaryProbe: model_path normalization (HF cache → org/name; abs path → leaf)", async () => {
  const cachePath =
    "/root/.cache/huggingface/hub/models--org--name/snapshots/abcd1234";
  const m1 = mockFetch({
    [H(8080)]: { status: 200, body: {} },
    [I(8080)]: { status: 200, body: { model_path: cachePath, context_length: 4096 } },
  });
  const r1 = await canaryProbe(8080, { fetch: m1.fn });
  assert.equal(r1.modelId, "org/name");

  const m2 = mockFetch({
    [H(8080)]: { status: 200, body: {} },
    [I(8080)]: {
      status: 200,
      body: { model_path: "/models/Qwen3.8-27B", max_total_tokens: 8192, tensor_parallel_size: 2 },
    },
  });
  const r2 = await canaryProbe(8080, { fetch: m2.fn });
  assert.equal(r2.modelId, "Qwen3.8-27B");
  assert.equal(r2.contextLength, 8192); // max_total_tokens fallback
  assert.equal(r2.tpSize, 2); // tensor_parallel_size fallback
});

test("canaryProbe: /health 200 + /get_server_info 503 (canary fails) → state 'loading'", async () => {
  const m = mockFetch({
    [H(8080)]: { status: 200, body: {} },
    [I(8080)]: { status: 503 },
  });
  const r = await canaryProbe(8080, { fetch: m.fn, ...FAST });
  assert.equal(r.state, "loading");
  assert.equal(r.modelId, null);
  assert.equal(r.contextLength, null);
  assert.equal(r.memFraction, null);
  assert.equal(r.tpSize, null);
});

test("canaryProbe: /health 200 + /get_server_info 200 but body unparseable → 'loading'", async () => {
  const m = mockFetch({
    [H(8080)]: { status: 200, body: {} },
    [I(8080)]: { status: 200, body: "this is not json" },
  });
  const r = await canaryProbe(8080, { fetch: m.fn, ...FAST });
  assert.equal(r.state, "loading");
});

test("canaryProbe: /health 200 + /get_server_info 404 → state 'wedged'", async () => {
  const m = mockFetch({
    [H(8080)]: { status: 200, body: {} },
    [I(8080)]: { status: 404 },
  });
  const r = await canaryProbe(8080, { fetch: m.fn });
  assert.equal(r.state, "wedged");
  assert.equal(r.modelId, null);
});

test("canaryProbe: /health 404 → state 'stopped'", async () => {
  const m = mockFetch({
    [H(8080)]: { status: 404 },
  });
  const r = await canaryProbe(8080, { fetch: m.fn });
  assert.equal(r.state, "stopped");
  assert.equal(m.calls.length, 1, "404 is definitive — no extra polling");
});

test("canaryProbe: fetch failures (ECONNREFUSED) degrade to 'loading', never 'stopped'", async () => {
  const m = mockFetch({
    "*": Object.assign(new Error("fetch failed: ECONNREFUSED 127.0.0.1:8080"), {
      code: "ECONNREFUSED",
    }),
  });
  const r = await canaryProbe(8080, { fetch: m.fn, ...FAST });
  assert.equal(r.state, "loading");
  assert.ok(m.calls.length > 1, "kept polling within budget");
});

test("canaryProbe: /health 503 (server up, not ready) until budget → 'loading'", async () => {
  const m = mockFetch({
    [H(8080)]: { status: 503 },
  });
  const r = await canaryProbe(8080, { fetch: m.fn, ...FAST });
  assert.equal(r.state, "loading");
  // budget honored: poll count bounded (80ms / 5ms ≈ 16 + slack)
  assert.ok(m.calls.length <= 20, `polls: ${m.calls.length}`);
});

test("canaryProbe: canaryTimeoutMs knob bounds total polling time", async () => {
  const m = mockFetch({ [H(8080)]: { status: 503 } });
  const t0 = Date.now();
  const r = await canaryProbe(8080, { fetch: m.fn, canaryTimeoutMs: 30, pollMs: 10 });
  const elapsed = Date.now() - t0;
  assert.equal(r.state, "loading");
  assert.ok(elapsed < 5000, `took ${elapsed}ms with a 30ms budget`);
});

// ─── canaryProbe: input validation ──────────────────────────────────────────

test("canaryProbe: out-of-bounds / invalid port → 'stopped', fetch never called", async () => {
  const m = mockFetch({});
  for (const port of [0, -1, 99999, 65536, "abc", "8080.5", undefined, null, {}]) {
    const r = await canaryProbe(port, { fetch: m.fn });
    assert.equal(r.state, "stopped", `port: ${JSON.stringify(port)}`);
  }
  assert.equal(m.calls.length, 0);
});

test("canaryProbe: string port is accepted (knob)", async () => {
  const m = mockFetch({
    [H(8080)]: { status: 200, body: {} },
    [I(8080)]: { status: 200, body: SERVER_INFO },
  });
  const r = await canaryProbe("8080", { fetch: m.fn });
  assert.equal(r.state, "ready");
});

test("canaryProbe: validPort / isValidContainerName boundaries", () => {
  assert.equal(validPort(8080), true);
  assert.equal(validPort("8080"), true);
  assert.equal(validPort(0), false);
  assert.equal(validPort(65536), false);
  assert.equal(validPort("abc"), false);
  assert.equal(validPort(8080.5), false);

  assert.equal(isValidContainerName("qwen38-sglang"), true);
  assert.equal(isValidContainerName("a_b.c-d"), true);
  assert.equal(isValidContainerName("-lead"), false); // must start alnum
  assert.equal(isValidContainerName("a b"), false);
  assert.equal(isValidContainerName("x;rm -rf /"), false);
  assert.equal(isValidContainerName(42), false);
});

// ─── switchLlm: happy path (systemd) ───────────────────────────────────────

test("switchLlm: stop old + start new + canary ready → {ok:true, status:'success'}", async () => {
  const m = execMock([{ ...OK }, { ...OK }]);
  const f = mockFetch({
    [H(8080)]: { status: 200, body: {} },
    [I(8080)]: { status: 200, body: SERVER_INFO },
  });
  const r = await switchLlm(8081, 8080, {
    actionId: "sw1",
    serviceName: "llm-tp1",
    oldUnit: "qwen28-sglang.service",
    newUnit: "qwen38-sglang.service",
    exec: m.fn,
    fetch: f.fn,
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, "success");
  assert.equal(r.idempotent, true);
  assert.equal(r.error, null);
  assert.equal(typeof r.durationMs, "number");
  assert.match(r.message, /LLM switch complete/);
  assert.match(r.message, /qwen38-sglang\.service/);
  assert.match(r.message, /RadixArk\/Qwen3\.8-27B-NVFP4/);
  // exact argv, in order, no shell
  assert.deepEqual(m.calls.map((c) => c.file), ["systemctl", "systemctl"]);
  assert.deepEqual(m.calls.map((c) => c.args), [
    ["stop", "qwen28-sglang.service"],
    ["start", "qwen38-sglang.service"],
  ]);
  assert.equal(f.calls[0], H(8080));
});

test("switchLlm: canary not ready (503) → {ok:true, status:'running'} (still loading)", async () => {
  const m = execMock([{ ...OK }, { ...OK }]);
  const f = mockFetch({
    [H(8080)]: { status: 200, body: {} },
    [I(8080)]: { status: 503 },
  });
  const r = await switchLlm(8081, 8080, {
    oldUnit: "qwen28-sglang.service",
    newUnit: "qwen38-sglang.service",
    exec: m.fn,
    fetch: f.fn,
    ...FAST,
  });
  // Seam union is success|failure|running; "still loading" maps to running.
  assert.equal(r.ok, true);
  assert.equal(r.status, "running");
  assert.match(r.message, /still loading/);
  assert.equal(m.calls.length, 2, "stop+start both executed before the probe");
});

// ─── switchLlm: failures stop the pipeline early ───────────────────────────

test("switchLlm: stop fails → {ok:false, status:'failure'}, start never attempted", async () => {
  const m = execMock([{ exitCode: 1, stdout: "", stderr: "Failed to stop unit: boom", notFound: false, timedOut: false }]);
  const f = mockFetch({});
  const r = await switchLlm(8081, 8080, {
    oldUnit: "qwen28-sglang.service",
    newUnit: "qwen38-sglang.service",
    exec: m.fn,
    fetch: f.fn,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, "failure");
  assert.equal(r.error, "Failed to stop unit: boom");
  assert.match(r.message, /exit 1/);
  assert.equal(m.calls.length, 1, "start must not run after a failed stop");
  assert.equal(f.calls.length, 0, "canary must not run after a failed stop");
});

test("switchLlm: start fails → failure, canary never runs", async () => {
  // oldPort null → stop step is skipped, so call #1 IS the start command.
  const m = execMock([{ exitCode: 1, stdout: "", stderr: "job failed", notFound: false, timedOut: false }]);
  const f = mockFetch({});
  const r = await switchLlm(null, 8080, {
    newUnit: "qwen38-sglang.service",
    exec: m.fn,
    fetch: f.fn,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "job failed");
  assert.equal(m.calls.length, 1);
  assert.equal(f.calls.length, 0);
});

test("switchLlm: old LLM present but no oldUnit/oldContainer → failure, no exec", async () => {
  const m = execMock([]);
  const f = mockFetch({});
  const r = await switchLlm(8081, 8080, {
    newUnit: "qwen38-sglang.service",
    exec: m.fn,
    fetch: f.fn,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, "failure");
  assert.match(r.message, /no oldUnit or oldContainer/);
  assert.equal(r.error, "old LLM not manageable");
  assert.equal(m.calls.length, 0);
});

test("switchLlm: no newUnit/newContainer → failure, no exec", async () => {
  const m = execMock([]);
  const f = mockFetch({});
  const r = await switchLlm(null, 8080, { exec: m.fn, fetch: f.fn });
  assert.equal(r.ok, false);
  assert.match(r.message, /no newUnit or newContainer/);
  assert.equal(r.error, "new LLM not manageable");
  assert.equal(m.calls.length, 0);
});

test("switchLlm: invalid newPort → failure, no exec", async () => {
  const m = execMock([]);
  for (const bad of [0, 99999, -8, "abc", null]) {
    const r = await switchLlm(null, bad, { newUnit: "u.service", exec: m.fn, fetch: mockFetch({}).fn });
    assert.equal(r.ok, false, `newPort: ${JSON.stringify(bad)}`);
    assert.equal(r.error, "invalid newPort", `newPort: ${JSON.stringify(bad)}`);
  }
  assert.equal(m.calls.length, 0);
});

test("switchLlm: invalid oldPort (non-zero, unparseable) → failure, no exec", async () => {
  const m = execMock([]);
  const r = await switchLlm("abc", 8080, { newUnit: "u.service", exec: m.fn, fetch: mockFetch({}).fn });
  assert.equal(r.ok, false);
  assert.equal(r.error, "invalid oldPort");
  assert.equal(m.calls.length, 0);
});

test("switchLlm: systemctl not found → 'systemctl not found'", async () => {
  const m = execMock([{ exitCode: null, stdout: "", stderr: "", notFound: true, timedOut: false }]);
  const r = await switchLlm(8081, 8080, {
    oldUnit: "qwen28-sglang.service",
    newUnit: "qwen38-sglang.service",
    exec: m.fn,
    fetch: mockFetch({}).fn,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "systemctl not found");
});

test("switchLlm: start times out → 'timeout', canary never runs", async () => {
  // oldPort null → stop step is skipped, so call #1 IS the start command.
  const m = execMock([
    { exitCode: null, stdout: "", stderr: "", notFound: false, timedOut: true },
  ]);
  const f = mockFetch({});
  const r = await switchLlm(null, 8080, {
    newUnit: "qwen38-sglang.service",
    exec: m.fn,
    fetch: f.fn,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "timeout");
  assert.equal(f.calls.length, 0);
});

// ─── switchLlm: docker path + goal-state tolerances ─────────────────────────

test("switchLlm: docker path — exact argv + 'already running' / 'No such container' tolerances", async () => {
  const m = execMock([
    {
      exitCode: 1,
      stdout: "",
      stderr: "Error response from daemon: No such container: qwen28-sglang",
      notFound: false,
      timedOut: false,
    },
    {
      exitCode: 1,
      stdout: "",
      stderr: "Error response from daemon: container qwen38-sglang is already running",
      notFound: false,
      timedOut: false,
    },
  ]);
  const f = mockFetch({
    [H(8080)]: { status: 200, body: {} },
    [I(8080)]: { status: 200, body: SERVER_INFO },
  });
  const r = await switchLlm(8081, 8080, {
    oldContainer: "qwen28-sglang",
    newContainer: "qwen38-sglang",
    exec: m.fn,
    fetch: f.fn,
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, "success");
  assert.deepEqual(m.calls.map((c) => c.file), ["docker", "docker"]);
  assert.deepEqual(m.calls.map((c) => c.args), [
    ["stop", "qwen28-sglang"],
    ["start", "qwen38-sglang"],
  ]);
});

test("switchLlm: docker start real failure (no tolerance) → failure", async () => {
  const m = execMock([
    { ...OK },
    { exitCode: 1, stdout: "", stderr: "Error response from daemon: pull access denied", notFound: false, timedOut: false },
  ]);
  const r = await switchLlm(8081, 8080, {
    oldContainer: "a",
    newContainer: "b",
    exec: m.fn,
    fetch: mockFetch({}).fn,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, "failure");
  assert.match(r.error, /pull access denied/);
});

test("switchLlm: docker stop 'No such container' is tolerated on its own", async () => {
  const m = execMock([
    { exitCode: 1, stdout: "", stderr: "No such container: gone", notFound: false, timedOut: false },
    { ...OK },
  ]);
  const f = mockFetch({
    [H(8080)]: { status: 200, body: {} },
    [I(8080)]: { status: 200, body: SERVER_INFO },
  });
  const r = await switchLlm(8081, 8080, {
    oldContainer: "gone",
    newContainer: "fresh",
    exec: m.fn,
    fetch: f.fn,
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, "success");
});

// ─── switchLlm: canary outcome mapping ──────────────────────────────────────

test("switchLlm: canary wedged → {ok:false, status:'failure', error:'canary: wedged'}", async () => {
  const m = execMock([{ ...OK }, { ...OK }]);
  const f = mockFetch({
    [H(8080)]: { status: 200, body: {} },
    [I(8080)]: { status: 404 },
  });
  const r = await switchLlm(null, 8080, { newUnit: "u.service", exec: m.fn, fetch: f.fn });
  assert.equal(r.ok, false);
  assert.equal(r.status, "failure");
  assert.equal(r.error, "canary: wedged");
  assert.match(r.message, /wedged/);
});

test("switchLlm: canary stopped (health 404) → {ok:false, error:'canary: stopped'}", async () => {
  const m = execMock([{ ...OK }, { ...OK }]);
  const f = mockFetch({ [H(8080)]: { status: 404 } });
  const r = await switchLlm(null, 8080, { newUnit: "u.service", exec: m.fn, fetch: f.fn });
  assert.equal(r.ok, false);
  assert.equal(r.error, "canary: stopped");
});

test("switchLlm: canary refused (never up) → {ok:true, status:'running'} loading", async () => {
  const m = execMock([{ ...OK }, { ...OK }]);
  const f = mockFetch({
    "*": Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }),
  });
  const r = await switchLlm(null, 8080, { newUnit: "u.service", exec: m.fn, fetch: f.fn, ...FAST });
  assert.equal(r.ok, true);
  assert.equal(r.status, "running");
  assert.match(r.message, /still loading/);
});

// ─── switchLlm: options plumbing ───────────────────────────────────────────

test("switchLlm: oldPort null skips the stop step entirely", async () => {
  const m = execMock([{ ...OK }]);
  const f = mockFetch({
    [H(8080)]: { status: 200, body: {} },
    [I(8080)]: { status: 200, body: SERVER_INFO },
  });
  const r = await switchLlm(null, 8080, { newUnit: "u.service", exec: m.fn, fetch: f.fn });
  assert.equal(r.ok, true);
  assert.equal(m.calls.length, 1, "only the start command");
  assert.deepEqual(m.calls[0].args, ["start", "u.service"]);
});

test("switchLlm: timeoutMs knob is forwarded to exec", async () => {
  const m = execMock([{ ...OK }]);
  const f = mockFetch({
    [H(8080)]: { status: 200, body: {} },
    [I(8080)]: { status: 200, body: SERVER_INFO },
  });
  await switchLlm(null, 8080, { newUnit: "u.service", timeoutMs: 777, exec: m.fn, fetch: f.fn });
  assert.equal(m.calls[0].runOpts.timeoutMs, 777);
});

test("switchLlm: concurrent identical actionId → exactly one stop+start", async () => {
  let resolveExec;
  const pending = new Promise((res) => {
    resolveExec = res;
  });
  const m = execMock([pending, { ...OK }]);
  const f = mockFetch({
    [H(8080)]: { status: 200, body: {} },
    [I(8080)]: { status: 200, body: SERVER_INFO },
  });
  const opts = {
    actionId: "sw-dup",
    oldUnit: "a.service",
    newUnit: "b.service",
    exec: m.fn,
    fetch: f.fn,
  };
  const p1 = switchLlm(8081, 8080, opts);
  const p2 = switchLlm(8081, 8080, opts);
  // Watchdog: even if the assert below fails, the shared stop always settles
  // (no dangling promise).
  const watchdog = setTimeout(() => resolveExec({ ...OK }), 2000);
  // Flush microtasks: the shared stop starts on the next tick.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(m.calls.length, 1, "second concurrent call must not re-exec");
  clearTimeout(watchdog);
  resolveExec({ ...OK });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, r2);
  assert.equal(m.calls.length, 2, "stop + start");
});

test("switchLlm: default serviceName derived from newPort", async () => {
  const m = execMock([{ ...OK }]);
  const f = mockFetch({
    [H(8080)]: { status: 200, body: {} },
    [I(8080)]: { status: 200, body: SERVER_INFO },
  });
  const r = await switchLlm(null, 8080, { newUnit: "u.service", exec: m.fn, fetch: f.fn });
  assert.equal(r.serviceName, "llm:8080");
});

// ─── ground truth: REAL fetch against a REAL local HTTP server ──────────────

function startTestServer(handler) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
    srv.once("error", reject);
  });
}

test("canaryProbe: ground truth — real fetch vs real HTTP server → 'ready'", async () => {
  const srv = await startTestServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url === "/get_server_info") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(SERVER_INFO));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const port = srv.address().port;
  try {
    const r = await canaryProbe(port, { canaryTimeoutMs: 3000, pollMs: 50 });
    assert.equal(r.state, "ready");
    assert.equal(r.modelId, "RadixArk/Qwen3.8-27B-NVFP4");
    assert.equal(r.contextLength, 262144);
    assert.equal(r.memFraction, 0.85);
    assert.equal(r.tpSize, 1);
  } finally {
    await new Promise((res) => srv.close(res));
  }
});

test("canaryProbe: ground truth — real fetch vs closed port → 'loading' (graceful)", async () => {
  // Grab an OS-assigned port, close it, then probe: connection refused.
  const srv = await startTestServer((_req, res) => res.end("x"));
  const port = srv.address().port;
  await new Promise((res) => srv.close(res));
  const r = await canaryProbe(port, { canaryTimeoutMs: 100, pollMs: 10 });
  assert.equal(r.state, "loading");
});

test("switchLlm: ground truth — default runner, systemctl missing (stripped PATH)", async () => {
  // Hermetic "systemctl not found": the default runner is the real execFile;
  // point PATH at an empty dir so the binary cannot resolve. This exercises
  // the documented graceful-degradation path end-to-end without touching a
  // real system's systemd.
  const oldPath = process.env.PATH;
  process.env.PATH = "/nonexistent-sparkdash-test-dir";
  try {
    const f = mockFetch({
      [H(8080)]: { status: 200, body: {} },
      [I(8080)]: { status: 200, body: SERVER_INFO },
    });
    const r = await switchLlm(null, 8080, { newUnit: "u.service", fetch: f.fn });
    assert.equal(r.ok, false);
    assert.equal(r.status, "failure");
    assert.equal(r.error, "systemctl not found");
    assert.equal(f.calls.length, 0, "canary must not run after a failed start");
  } finally {
    process.env.PATH = oldPath;
  }
});
