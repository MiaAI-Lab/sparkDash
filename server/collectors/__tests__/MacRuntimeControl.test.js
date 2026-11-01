import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedConfigEnv } from "../../__tests__/isolatedEnv.js";
import {
  actRuntimeControl,
  beginRuntimeControl,
  assertMacControlSpark,
  readRuntimeControl,
} from "../MacRuntimeControl.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function ready(extra = {}) {
  return {
    schema: "sparkdash.mac-control/1", control: "ready", serving: [], busy: false,
    targets: [{ name: "omlx", models: [{ id: "model-a" }, { id: "model-b" }], startable: true, stoppable: true }],
    ...extra,
  };
}

const finishBackground = () => new Promise((resolve) => setImmediate(resolve));

test("begin returns immediately, polls progress, and lets completed Mac status win", { timeout: 2000 }, async () => {
  const node = { ...spark, id: "async-progress" };
  const action = deferred();
  let status = ready({ operation: { id: "previous", state: "complete", ok: true } });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return options.method === "POST" ? action.promise : jsonResponse(200, status);
  };
  const options = { fetchImpl, token: "private-control-token" };
  const started = await beginRuntimeControl(node, "start", { runtime: "omlx", model: "model-a" }, options);
  assert.equal(started.state, "ready");
  assert.equal(started.busy, true);
  assert.equal(started.operation.state, "running");
  assert.equal(started.operation.runtime, "omlx");
  assert.equal(started.operation.model, "model-a");
  assert.equal(started.operation.action, "start");
  assert.ok(started.operation.id);
  assert.equal(JSON.stringify(started).includes(options.token), false);
  // Control requests check the address before connecting, so the POST reaches
  // the fixture one tick after the reservation. It still never waits on the
  // Mac's answer.
  await finishBackground();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${options.token}`);
  assert.ok(calls[1].options.dispatcher);

  const duplicate = await beginRuntimeControl(node, "stop", { runtime: "omlx" }, options);
  assert.equal(duplicate.busy, true);
  assert.equal(calls.length, 2);
  const pending = await readRuntimeControl(node, options);
  assert.equal(pending.busy, true);
  assert.equal(pending.operation.id, started.operation.id);

  status = ready({ busy: true, operation: { id: "mac-job", state: "running", runtime: "omlx", model: "model-a", action: "start" } });
  assert.equal((await readRuntimeControl(node, options)).operation.id, "mac-job");
  status = ready({ operation: { ...status.operation, state: "complete", ok: true, output: "ready", error: null } });
  const awaitingResponse = await readRuntimeControl(node, options);
  assert.equal(awaitingResponse.busy, true);
  assert.equal(awaitingResponse.operation.state, "running");
  action.resolve(jsonResponse(200, status));
  await finishBackground();
  const complete = await readRuntimeControl(node, options);
  assert.equal(complete.busy, false);
  assert.equal(complete.operation.id, "mac-job");
  assert.equal(complete.operation.ok, true);
  assert.equal(complete.operation.output, "ready");
  assert.equal(calls.filter(({ options: opts }) => opts.method === "POST").length, 1);
});

test("reservation precedes the status await and failed validation releases it", async () => {
  const node = { ...spark, id: "async-reservation" };
  const status = deferred();
  let posts = 0;
  let reads = 0;
  const options = { token: "secret", fetchImpl: async (_url, opts) => {
    if (opts.method === "POST") { posts++; return jsonResponse(200, ready({ ok: true })); }
    reads++;
    return reads === 1 ? status.promise : jsonResponse(200, ready());
  } };
  const first = beginRuntimeControl(node, "start", { runtime: "unknown" }, options);
  const second = beginRuntimeControl(node, "start", { runtime: "omlx", model: "model-a" }, options);
  // Both begin before either address check settles, then get a tick to reach
  // the fixture: the reservation, not the agent's idle answer, is what keeps
  // the second request from reading status and dispatching a duplicate action.
  await finishBackground();
  assert.equal((await second).busy, true);
  assert.equal(reads, 1);
  status.resolve(jsonResponse(200, ready()));
  assert.match((await first).error, /unknown runtime/);
  assert.equal(posts, 0);
  assert.equal((await beginRuntimeControl(node, "start", { runtime: "omlx", model: "model-a" }, options)).busy, true);
  await finishBackground();
  assert.equal(posts, 1);
});

test("begin validates permissions, catalog, action and model without posting", async () => {
  let posts = 0;
  const options = { token: "secret", fetchImpl: async (_url, opts) => {
    if (opts.method === "POST") posts++;
    return jsonResponse(200, ready());
  } };
  for (const [action, request, pattern] of [
    ["restart", { runtime: "omlx" }, /action/],
    ["start", { runtime: "unknown" }, /unknown runtime/],
    ["start", { runtime: "omlx", model: "wrong" }, /unknown model/],
    ["start", { runtime: "omlx" }, /model is required/],
    ["stop", { runtime: "omlx", model: {} }, /model must be a string/],
    ["start", { runtime: {} }, /runtime is required/],
  ]) {
    const result = await beginRuntimeControl({ ...spark, id: "async-invalid" }, action, request, options);
    assert.match(result.error, pattern);
    assert.notEqual(result.ok, true);
  }
  const neverFetch = async () => { assert.fail("must not contact the agent"); };
  assert.equal((await beginRuntimeControl(spark, "start", { runtime: "omlx" }, { token: "", fetchImpl: neverFetch })).state, "denied");
  assert.equal((await beginRuntimeControl({ ...spark, kind: "spark" }, "start", {}, { ...options, fetchImpl: neverFetch })).state, "unavailable");
  assert.equal((await beginRuntimeControl({ id: "no-agent", kind: "mac" }, "start", {}, { ...options, fetchImpl: neverFetch })).state, "unavailable");
  const denied = await beginRuntimeControl(spark, "start", { runtime: "omlx" }, {
    ...options, fetchImpl: async () => jsonResponse(403, ready({ control: "denied", reason: "control token rejected" })),
  });
  assert.equal(denied.state, "denied");
  assert.equal(posts, 0);
});

test("Mac busy prevents starts even after a Node restart; unlaunchable targets refuse actions", async () => {
  for (const status of [
    ready({ busy: true, operation: { id: "other-server", state: "running" } }),
    ready({ targets: [{ name: "omlx", models: [], startable: false, reason: "profile is missing" }] }),
  ]) {
    const result = await beginRuntimeControl({ ...spark, id: "async-mac-lock" }, "start", { runtime: "omlx" }, {
      token: "secret", fetchImpl: async (_url, opts) => {
        assert.equal(opts.method, "GET");
        return jsonResponse(200, status);
      },
    });
    if (status.busy) assert.equal(result.busy, true);
    else assert.match(result.error, /profile is missing/);
  }
});

test("a lost POST never replays and a running Mac remains busy until authoritative completion", async () => {
  const node = { ...spark, id: "async-disconnected" };
  const action = deferred();
  let status = ready();
  let posts = 0;
  const options = { token: "secret", fetchImpl: async (_url, opts) => {
    if (opts.method === "POST") { posts++; return action.promise; }
    return jsonResponse(200, status);
  } };
  await beginRuntimeControl(node, "start", { runtime: "omlx", model: "model-b" }, options);
  status = ready({ busy: true, operation: { id: "still-running", state: "running" } });
  action.reject(new Error("ECONNRESET"));
  await finishBackground();
  const running = await readRuntimeControl(node, options);
  assert.equal(running.busy, true);
  assert.equal(running.operation.state, "running");
  assert.match(running.error, /ECONNRESET/);
  assert.equal((await beginRuntimeControl(node, "stop", { runtime: "omlx" }, options)).busy, true);
  status = ready({ operation: { id: "still-running", state: "complete", ok: false, error: "readiness failed", output: "startup log" } });
  const complete = await readRuntimeControl(node, options);
  assert.equal(complete.busy, false);
  assert.equal(complete.operation.ok, false);
  assert.equal(complete.operation.error, "readiness failed");
  assert.equal(posts, 1);
});

test("older agents get a completed Node operation fallback, including connection failures", async () => {
  for (const disconnected of [false, true]) {
    const node = { ...spark, id: `async-fallback-${disconnected}` };
    const action = deferred();
    const oldStatus = ready(disconnected ? { operation: { id: "last-completed", state: "complete", ok: true } } : {});
    const options = { token: "secret", fetchImpl: async (_url, opts) => opts.method === "POST" ? action.promise : jsonResponse(200, oldStatus) };
    const started = await beginRuntimeControl(node, "stop", { runtime: "omlx" }, options);
    if (disconnected) action.reject(new Error("ECONNREFUSED"));
    else action.resolve(jsonResponse(200, ready({ ok: false, error: "stop failed", output: "command output" })));
    await finishBackground();
    const result = await readRuntimeControl(node, options);
    assert.equal(result.busy, false);
    assert.equal(result.operation.id, started.operation.id);
    assert.equal(result.operation.state, "complete");
    assert.equal(result.operation.ok, false);
    assert.match(result.operation.error, disconnected ? /ECONNREFUSED/ : /stop failed/);
    if (!disconnected) assert.equal(result.operation.output, "command output");
  }
});

test("a failed status probe releases the reservation and never fabricates an idle Mac", async () => {
  const node = { ...spark, id: "async-status-failure" };
  const options = { token: "secret", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } };
  assert.equal((await beginRuntimeControl(node, "stop", { runtime: "omlx" }, options)).state, "unavailable");
  const action = deferred();
  let online = true;
  const working = { token: "secret", fetchImpl: async (_url, opts) => {
    if (opts.method === "POST") return action.promise;
    if (!online) throw new Error("ECONNREFUSED");
    return jsonResponse(200, ready());
  } };
  assert.equal((await beginRuntimeControl(node, "stop", { runtime: "omlx" }, working)).busy, true);
  online = false;
  assert.equal((await readRuntimeControl(node, working)).busy, true);
  action.reject(new Error("ECONNRESET"));
  await finishBackground();
  const unknown = await readRuntimeControl(node, working);
  assert.equal(unknown.state, "unavailable");
  assert.notEqual(unknown.busy, false);
  assert.match(unknown.operation.error, /ECONNRESET/);
});

test("status maps only public operation fields and uses the short probe timeout", async () => {
  const originalTimeout = AbortSignal.timeout;
  const timeouts = [];
  AbortSignal.timeout = (ms) => { timeouts.push(ms); return originalTimeout(ms); };
  try {
    const read = await readRuntimeControl({ ...spark, id: "status-public-fields" }, {
      token: "private-control-token", fetchImpl: async () => jsonResponse(200, ready({
        busy: true,
        operation: { id: "mac-operation", state: "running", runtime: "omlx", model: "model-a", action: "start", token: "private-control-token", argv: ["private-command"] },
      })),
    });
    assert.deepEqual(read.operation, { id: "mac-operation", state: "running", runtime: "omlx", model: "model-a", action: "start" });
    assert.equal(read.busy, true);
    assert.doesNotMatch(JSON.stringify(read), /private-control-token|private-command/);
    await actRuntimeControl(spark, "stop", { runtime: "omlx" }, {
      token: "secret", fetchImpl: async () => jsonResponse(200, ready({ ok: true })),
    });
    assert.equal(timeouts[0], 8000);
    assert.ok(timeouts[1] > 660000);
  } finally { AbortSignal.timeout = originalTimeout; }
});

test("HTTP POST returns 202 before the Mac command completes and GET polls without replay", { timeout: 15000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mac-control-route-"));
  let pendingResponse;
  const dispatched = deferred();
  let posts = 0;
  let status = ready();
  const agent = createServer((req, res) => {
    req.resume();
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/control/start") {
      posts++;
      pendingResponse = res;
      dispatched.resolve();
      status = ready({ busy: true, operation: { id: "http-mac-job", state: "running", runtime: "omlx", model: "model-a", action: "start" } });
    } else if (req.url === "/control") res.end(JSON.stringify(status));
    else res.end(JSON.stringify({ schema: "sparkdash.mac-agent/1", runtimes: [], metrics: {} }));
  });
  let child;
  try {
    agent.listen(0, "127.0.0.1");
    await once(agent, "listening");
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const env = isolatedConfigEnv(dir);
    await writeFile(env.SPARKS_JSON_PATH, JSON.stringify({ sparks: [{
      ...spark, lanIp: "127.0.0.1", agent: { host: "127.0.0.1", port: agent.address().port },
      ssh: { host: "127.0.0.1", port: 1, user: "fixture" }, llmMonitoring: false, storagePollDisabled: true,
    }] }));
    child = spawn(process.execPath, ["server/index.js"], {
      cwd: path.resolve(import.meta.dirname, "../../.."), detached: true,
      env: { ...process.env, ...env, PORT: String(port), BIND_HOST: "127.0.0.1", SPARKDASH_TOKEN: "dashboard-fixture", SPARKDASH_MAC_CONTROL_TOKEN: "control-fixture" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("isolated dashboard did not start")), 5000);
      const exited = () => { clearTimeout(timer); reject(new Error("isolated dashboard exited before startup")); };
      child.once("exit", exited);
      child.stdout.on("data", (data) => {
        if (String(data).includes("server listening")) { clearTimeout(timer); child.off("exit", exited); resolve(); }
      });
      child.stderr.resume();
    });
    const url = `http://127.0.0.1:${port}/api/sparks/${spark.id}/runtime-control`;
    const headers = { Authorization: "Bearer dashboard-fixture", "Content-Type": "application/json" };
    const post = () => fetch(`${url}/start`, { method: "POST", headers, body: JSON.stringify({ runtime: "omlx", model: "model-a" }), signal: AbortSignal.timeout(2000) });
    assert.equal((await fetch(`${url}/start`, { method: "POST" })).status, 401);
    const accepted = await post();
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).busy, true);
    let dispatchTimer;
    try {
      await Promise.race([dispatched.promise, new Promise((_, reject) => {
        dispatchTimer = setTimeout(() => reject(new Error("Mac POST did not arrive")), 2000);
      })]);
    } finally { clearTimeout(dispatchTimer); }
    assert.ok(pendingResponse && !pendingResponse.writableEnded);
    assert.equal((await post()).status, 202);
    const polled = await fetch(url, { headers });
    assert.equal(polled.status, 200);
    assert.equal((await polled.json()).operation.id, "http-mac-job");
    assert.equal(posts, 1);
    status = ready({ operation: { ...status.operation, state: "complete", ok: false, error: "readiness failed", output: "fixture log" } });
    pendingResponse.end(JSON.stringify(status));
    let complete;
    for (let attempt = 0; attempt < 10; attempt++) {
      complete = await (await fetch(url, { headers })).json();
      if (!complete.busy) break;
    }
    assert.equal(complete.busy, false);
    assert.equal(complete.operation.error, "readiness failed");
    assert.equal(complete.operation.output, "fixture log");
    assert.doesNotMatch(JSON.stringify(complete), /dashboard-fixture|control-fixture/);
    assert.equal(posts, 1);
  } finally {
    if (child) {
      const exited = child.exitCode == null ? once(child, "exit") : Promise.resolve();
      try { process.kill(-child.pid, "SIGTERM"); } catch (err) { if (err.code !== "ESRCH") throw err; }
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 2000);
      await exited;
      clearTimeout(timer);
      try { process.kill(-child.pid, "SIGKILL"); } catch (err) { if (err.code !== "ESRCH") throw err; }
    }
    agent.closeAllConnections();
    await new Promise((resolve) => agent.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

const spark = {
  id: "macbook",
  kind: "mac",
  lanIp: "10.0.0.9",
  agent: { port: 8790 },
};

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

test("list, start, and stop talk only to the control endpoint", async () => {
  const requested = [];
  const fetchImpl = async (url, opts = {}) => {
    requested.push({ url, method: opts.method || "GET", body: opts.body, auth: opts.headers?.Authorization });
    if (url.endsWith("/control") && (opts.method || "GET") === "GET") {
      return jsonResponse(200, {
        schema: "sparkdash.mac-control/1",
        control: "ready",
        reason: null,
        serving: [],
        targets: [{ name: "splash-35b", label: "Splash 35B", group: "splash", groupLabel: "Splash", models: [], startable: true, stoppable: true }],
      });
    }
    const payload = JSON.parse(opts.body);
    return jsonResponse(200, {
      schema: "sparkdash.mac-control/1",
      ok: true,
      control: "ready",
      action: url.endsWith("/start") ? "start" : "stop",
      runtime: payload.runtime,
      model: payload.model,
      serving: url.endsWith("/start") ? [{ name: payload.runtime, state: "serving" }] : [],
      targets: [],
      error: null,
    });
  };

  const listed = await readRuntimeControl(spark, { fetchImpl, token: "secret" });
  assert.equal(listed.state, "ready");
  assert.equal(listed.targets[0].name, "splash-35b");
  assert.deepEqual(listed.serving, []);

  const started = await actRuntimeControl(spark, "start", { runtime: "splash-35b", model: "m" }, { fetchImpl, token: "secret" });
  assert.equal(started.ok, true);
  assert.equal(started.serving[0].name, "splash-35b");

  const stopped = await actRuntimeControl(spark, "stop", { runtime: "splash-35b" }, { fetchImpl, token: "secret" });
  assert.deepEqual(stopped.serving, []);

  assert.deepEqual(requested.map((row) => `${row.method} ${row.url}`), [
    "GET http://10.0.0.9:8790/control",
    "POST http://10.0.0.9:8790/control/start",
    "POST http://10.0.0.9:8790/control/stop",
  ]);
  assert.equal(requested.some((row) => row.url.includes("/metrics")), false);
  assert.equal(requested[1].auth, "Bearer secret");
  assert.equal(JSON.parse(requested[1].body).runtime, "splash-35b");
});

test("permission denied and agent unavailable stay distinct and do not look successful", async () => {
  const deniedFetch = async () => jsonResponse(403, {
    schema: "sparkdash.mac-control/1",
    control: "denied",
    reason: "control token rejected",
    error: "control token rejected",
    serving: null,
    targets: [],
  });
  const denied = await actRuntimeControl(spark, "start", { runtime: "omlx" }, { fetchImpl: deniedFetch, token: "secret" });
  assert.equal(denied.state, "denied");
  assert.equal(denied.reason, "control token rejected");
  assert.notEqual(denied.ok, true);

  const down = await readRuntimeControl(spark, {
    token: "secret",
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(down.state, "unavailable");
  assert.match(down.reason, /unreachable/);
  assert.match(down.reason, /ECONNREFUSED/);
  assert.equal(down.serving, null);
});

test("a missing dashboard token does not POST", async () => {
  let called = false;
  const result = await actRuntimeControl(spark, "start", { runtime: "omlx" }, {
    token: "",
    fetchImpl: async () => { called = true; return jsonResponse(200, {}); },
  });
  assert.equal(called, false);
  assert.equal(result.state, "denied");
  assert.match(result.reason, /SPARKDASH_MAC_CONTROL_TOKEN/);
});

test("other node kinds and a missing agent are unavailable, not a launcher", async () => {
  const other = assertMacControlSpark({ id: "gx10", kind: "spark" });
  assert.equal(other.status, 404);
  assert.match(other.body.reason, /Apple Silicon Mac node/);

  let called = false;
  const missing = await readRuntimeControl({ id: "mac", kind: "mac" }, {
    fetchImpl: async () => { called = true; return jsonResponse(200, {}); },
  });
  assert.equal(called, false);
  assert.equal(missing.state, "unavailable");
  assert.match(missing.reason, /not configured/);
});

test("an old agent without /control is unavailable rather than an empty success", async () => {
  const result = await readRuntimeControl(spark, {
    token: "secret",
    fetchImpl: async () => jsonResponse(404, { error: "not found" }),
  });
  assert.equal(result.state, "unavailable");
  assert.match(result.reason, /no runtime control endpoint/);
});

test("invalid agent targets never receive the control credential and redirects are refused", async () => {
  let calls = 0;
  const result = await readRuntimeControl({ ...spark, agent: { url: "http://169.254.169.254" } }, {
    token: "synthetic-secret", fetchImpl: async () => { calls += 1; throw new Error("must not be called"); },
  });
  assert.equal(calls, 0);
  assert.equal(result.state, "unavailable");
  await readRuntimeControl(spark, { token: "synthetic-secret", fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, "error");
    return jsonResponse(404, {});
  } });
});

test("control requests connect to the single checked address and keep the URL host", async () => {
  let lookupCalls = 0;
  const seen = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      seen.push({
        url: request.url,
        host: request.headers.host,
        auth: request.headers.authorization,
        raw,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          schema: "sparkdash.mac-control/1",
          ok: true,
          control: "ready",
          action: "start",
          runtime: "splash-35b",
          serving: [{ name: "splash-35b", state: "serving" }],
          targets: [],
          error: null,
        })
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  // A name that resolves nowhere: the request only reaches the server if it
  // connects to the address the policy already checked.
  const hostname = "mac-agent.fixture.test";
  const target = { id: "macbook", kind: "mac", agent: { url: `http://${hostname}:${port}/` } };

  try {
    const result = await actRuntimeControl(
      target,
      "start",
      { runtime: "splash-35b" },
      {
        token: "secret",
        lookup: async (host, options) => {
          lookupCalls += 1;
          assert.equal(host, hostname);
          assert.equal(options.all, true);
          return [{ address: "127.0.0.1", family: 4 }];
        },
      }
    );
    assert.equal(result.state, "ready");
    assert.equal(result.ok, true);
    assert.equal(lookupCalls, 1, "the connection must not resolve the hostname a second time");
    assert.deepEqual(seen.map((row) => row.url), ["/control/start"]);
    assert.equal(seen[0].host, `${hostname}:${port}`, "the request keeps the original Host header");
    assert.equal(seen[0].auth, "Bearer secret", "the control credential still rides");
    assert.deepEqual(JSON.parse(seen[0].raw), { runtime: "splash-35b" });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("control port is independent of privileged telemetry", async () => {
  let url;
  await readRuntimeControl({ ...spark, agent: { host: "mac.tailnet", port: 8791, controlPort: 8790 } }, {
    token: "secret",
    // Control requests pin the address the policy checked, so the fixture
    // supplies the resolver instead of trusting a host name on this host.
    lookup: async () => [{ address: "10.0.0.9", family: 4 }],
    fetchImpl: async (value) => { url = value; return jsonResponse(404, {}); },
  });
  assert.equal(url, "http://mac.tailnet:8790/control");
});

test("control token file requires a private regular file owned by the server", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { macControlToken } = await import("../MacRuntimeControl.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mac-control-token-"));
  const file = path.join(dir, "token");
  try {
    fs.writeFileSync(file, "private-test-token\n", { mode: 0o600 });
    const env = { SPARKDASH_MAC_CONTROL_TOKEN_FILE: file };
    assert.equal(macControlToken(env), "private-test-token");
    fs.chmodSync(file, 0o644);
    assert.equal(macControlToken(env), "");
    fs.chmodSync(file, 0o600);
    fs.symlinkSync(file, path.join(dir, "link"));
    assert.equal(macControlToken({ SPARKDASH_MAC_CONTROL_TOKEN_FILE: path.join(dir, "link") }), "");
    assert.equal(macControlToken({ ...env, SPARKDASH_MAC_CONTROL_TOKEN: "override" }), "override");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
