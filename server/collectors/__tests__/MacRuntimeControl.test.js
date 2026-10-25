import test from "node:test";
import assert from "node:assert/strict";
import {
  actRuntimeControl,
  assertMacControlSpark,
  readRuntimeControl,
} from "../MacRuntimeControl.js";

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
