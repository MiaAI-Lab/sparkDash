import test from "node:test";
import assert from "node:assert/strict";
import { portsNeedingProbe, buildModelStatus, probeModels, certainlyDown } from "../ModelProbe.js";

// Three kits, one port — the real config shape of this deployment.
const QWEN = { id: "qwen", name: "Qwen", container: "vllm-fn", port: 8000 };
const GLM = { id: "glm", name: "GLM", container: "glm-head", port: 8000 };
const DS = { id: "ds", name: "DeepSeek", container: null, port: 8000 };
const MODELS = [QWEN, GLM, DS];

/** Containers for the legacy single-host default target. */
const cmap = (setOrNull) => new Map([["local", setOrNull]]);
const SSH_A = { kind: "ssh", key: "ssh:sparkA", label: "sparkA", spark: { id: "sparkA", lanIp: "10.0.0.10", ssh: { host: "10.0.0.10", user: "u", auth: "pass", password: "p" } } };
const SSH_B = { kind: "ssh", key: "ssh:sparkB", label: "sparkB", spark: { id: "sparkB", lanIp: "10.0.0.11", ssh: { host: "10.0.0.11", user: "u", auth: "pass", password: "p" } } };

// ─── portsNeedingProbe ─────────────────────────────────────
test("a port owned by a confirmed container needs no HTTP probe at all", () => {
  assert.deepEqual([...portsNeedingProbe(MODELS, cmap(new Set(["vllm-fn"])))], []);
});

test("with nothing running the (single unique) port is probed once", () => {
  assert.deepEqual([...portsNeedingProbe(MODELS, cmap(new Set(["unrelated"])))], ["local:8000"]);
});

test("docker failure falls back to probing every configured port", () => {
  assert.deepEqual([...portsNeedingProbe(MODELS, cmap(null))], ["local:8000"]);
});

test("forcePorts overrides the skip (start job readiness, manual refresh)", () => {
  assert.deepEqual(
    [...portsNeedingProbe(MODELS, cmap(new Set(["vllm-fn"])), new Set(["8000"]))],
    ["local:8000"]
  );
});

test("distinct ports are tracked independently", () => {
  const a = { id: "a", container: "ca", port: 8000 };
  const b = { id: "b", container: "cb", port: 8001 };
  const c = { id: "c", container: null, port: 8002 };
  const up = cmap(new Set(["ca"])); // a owns 8000; 8001/8002 still open questions
  assert.deepEqual(
    [...portsNeedingProbe([a, b, c], up)].sort(),
    ["local:8001", "local:8002"]
  );
});

// ─── the machine-agnostic core: ports contend per machine ─
test("the same port on two Sparks is probed on BOTH machines", () => {
  const a = { id: "a", container: "ca", port: 8000, sparkId: "sparkA" };
  const b = { id: "b", container: "cb", port: 8000, sparkId: "sparkB" };
  const keyOf = (m) => (m.sparkId === "sparkA" ? "ssh:sparkA" : "ssh:sparkB");
  const containers = new Map([
    ["ssh:sparkA", new Set(["other"])],
    ["ssh:sparkB", new Set(["other"])],
  ]);
  assert.deepEqual(
    [...portsNeedingProbe([a, b], containers, new Set(), keyOf)].sort(),
    ["ssh:sparkA:8000", "ssh:sparkB:8000"]
  );
});

test("a container on ANOTHER spark never settles this spark's port question", () => {
  const a = { id: "a", name: "A", container: "ca", port: 8000, sparkId: "sparkA" };
  const containers = new Map([
    ["ssh:sparkA", new Set(["unrelated"])],
    ["ssh:sparkB", new Set(["ca"])], // same name, wrong machine — not a's
  ]);
  const wanted = portsNeedingProbe([a], containers, new Set(), (m) => `ssh:${m.sparkId}`);
  assert.deepEqual([...wanted], ["ssh:sparkA:8000"]);

  const st = buildModelStatus([a], {
    containers,
    ports: {},
    keys: { a: "ssh:sparkA" },
    checkedAt: 1,
  });
  assert.equal(st.a.containerUp, false, "ca on sparkB must not read as a's container");
});

test("an unresolvable target gets the reason as status, not a false down", () => {
  const st = buildModelStatus([GLM], {
    containers: new Map(),
    ports: {},
    keys: { glm: null },
    reasons: { glm: "Model glm has no Spark assigned" },
    checkedAt: 1,
  });
  assert.equal(st.glm.running, false);
  assert.equal(st.glm.containerUp, null);
  assert.equal(st.glm.portUp, null);
  assert.match(st.glm.error, /no Spark assigned/);
});

// ─── probeModels wiring ────────────────────────────────────
test("probeModels issues ZERO fetchPort calls while one model runs", async () => {
  const calls = [];
  const res = await probeModels(MODELS, {
    listContainers: async () => new Set(["vllm-fn"]),
    fetchPort: async (p) => {
      calls.push(p);
      return { ok: true, modelId: "x", status: 200, error: null };
    },
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(res.ports, {}); // nothing answered, because nothing was asked
});

test("probeModels probes exactly once when the port is unowned", async () => {
  const calls = [];
  await probeModels(MODELS, {
    listContainers: async () => new Set(),
    fetchPort: async (p) => {
      calls.push(p);
      return { ok: false, modelId: null, status: null, error: "ECONNREFUSED" };
    },
  });
  assert.deepEqual(calls, ["8000"]); // three models, one unique port, one GET
});

test("probeModels asks every target once and probes ports on their own machine", async () => {
  const ps = [];
  const ports = [];
  const a = { id: "a", container: "ca", port: 8000, sparkId: "sparkA" };
  const b = { id: "b", container: "cb", port: 8000, sparkId: "sparkB" };
  const targets = { a: SSH_A, b: SSH_B };
  const res = await probeModels([a, b], {
    targetFor: (m) => targets[m.id],
    listContainers: async (target) => {
      ps.push(target.key);
      return new Set(); // nothing running anywhere
    },
    fetchPort: async (p, _t, host) => {
      ports.push(`${host}:${p}`);
      return { ok: false, modelId: null, status: null, error: "refused" };
    },
  });
  assert.deepEqual(ps.sort(), ["ssh:sparkA", "ssh:sparkB"]); // one docker ps per machine
  assert.deepEqual(ports.sort(), ["10.0.0.10:8000", "10.0.0.11:8000"]); // LAN host, not loopback
  assert.equal(res.keys.a, "ssh:sparkA");
  assert.equal(res.keys.b, "ssh:sparkB");
});

test("probeModels on an unassigned model sends no traffic at all", async () => {
  const res = await probeModels([GLM], {
    targetFor: () => ({ kind: null, error: "Model glm has no Spark assigned" }),
    listContainers: async () => {
      throw new Error("must not be called");
    },
    fetchPort: async () => {
      throw new Error("must not be called");
    },
  });
  assert.equal(res.keys.glm, null);
  assert.match(res.reasons.glm, /no Spark assigned/);
});

// ─── buildModelStatus with skipped ports ───────────────────
test("skipped port: owner reads up, the others read held-by — without portChecked", () => {
  const st = buildModelStatus(MODELS, {
    containers: cmap(new Set(["vllm-fn"])),
    ports: {}, // probeModels probed nothing
    keys: { qwen: "local", glm: "local", ds: "local" },
    checkedAt: 123,
  });
  assert.equal(st.qwen.running, true);
  assert.equal(st.qwen.portUp, true);
  assert.equal(st.qwen.portChecked, false, "verdict came from docker, not a GET");
  assert.equal(st.qwen.error, null);

  for (const id of ["glm", "ds"]) {
    assert.equal(st[id].running, false);
    assert.equal(st[id].portUp, false);
    assert.equal(st[id].portChecked, false);
    assert.match(st[id].error, /:8000 held by Qwen/);
  }
});

test("a port whose verdict is unknown stays unknown (portChecked false, portUp null)", () => {
  // docker failed AND nothing answered — statuses must not hard-say "down".
  const st = buildModelStatus([GLM], {
    containers: cmap(null),
    ports: {},
    keys: { glm: "local" },
    checkedAt: 1,
  });
  assert.equal(st.glm.running, false);
  assert.equal(st.glm.containerUp, null);
  assert.match(st.glm.error, /docker ps unavailable/);
});

test("probed port keeps the old semantics exactly (regression)", () => {
  const st = buildModelStatus(MODELS, {
    containers: cmap(new Set()), // nothing up
    ports: { "local:8000": { ok: true, modelId: "deepseek-v4", status: 200, error: null } },
    keys: { qwen: "local", glm: "local", ds: "local" },
    checkedAt: 1,
  });
  // No container claims 8000 → the bare answer counts for everyone probing it.
  for (const id of ["qwen", "glm", "ds"]) {
    assert.equal(st[id].running, true);
    assert.equal(st[id].portUp, true);
    assert.equal(st[id].portChecked, true);
  }
});

test("probed port answered while another container owns it → held by other", () => {
  const st = buildModelStatus(MODELS, {
    containers: cmap(new Set(["vllm-fn"])),
    // forced probe:
    ports: { "local:8000": { ok: true, modelId: "other", status: 200, error: null } },
    keys: { qwen: "local", glm: "local", ds: "local" },
    checkedAt: 1,
  });
  assert.equal(st.qwen.running, true); // container proves it
  assert.equal(st.glm.running, false);
  assert.match(st.glm.error, /answering but held by Qwen/);
});

// ─── certainlyDown: the exclusive-start incumbent filter ───
test("certainlyDown trusts only a docker-confirmed miss AND a non-serving port", () => {
  const st = (over) => ({ running: false, containerUp: null, portUp: null, portChecked: false, ...over });
  assert.equal(certainlyDown(null, QWEN), false, "never probed → assume it holds the GPU");
  assert.equal(certainlyDown(st({ containerUp: null, portUp: false }), QWEN), false, "docker unknown is no proof");
  assert.equal(certainlyDown(st({ containerUp: false, portUp: null }), QWEN), false, "port verdict unknown is no proof");
  assert.equal(certainlyDown(st({ running: true }), QWEN), false, "up is never down");
  assert.equal(certainlyDown(st({ containerUp: false, portUp: false }), QWEN), true, "both signals said no");
  // held-by-another-container: portChecked false, portUp false, container
  // confirmed absent — the port question WAS answered, elsewhere.
  assert.equal(certainlyDown(st({ containerUp: false, portUp: false, portChecked: false }), QWEN), true);
  // no port configured: nothing can contradict the confirmed container miss
  assert.equal(certainlyDown(st({ containerUp: false, portUp: null }), { id: "x", port: null }), true);
});
