import test from "node:test";
import assert from "node:assert/strict";
import {
  MOVED_PROBE_INTERVAL_MS,
  detectLlmMovedToWorker,
  llmDown,
  pairedWorkers,
  workerPorts,
} from "../LlmMovedToWorker.js";

const head = (partial = {}) => ({
  id: "h",
  name: "Spark 1",
  role: "head",
  online: true,
  llmPorts: [8888],
  metrics: { llm: [{ port: 8888, available: false, modelId: null }] },
  ...partial,
});

const worker = (partial = {}) => ({
  id: "w",
  name: "Spark 2",
  role: "worker",
  online: true,
  workerHeadId: "h",
  llmPorts: [8888],
  metrics: { llm: [] },
  ...partial,
});

const answering = { available: true, modelId: "DeepSeek-V4.1-Flash-1017", backend: "tensorfold" };

test("a head with a live port is not down", () => {
  const snap = head({ metrics: { llm: [{ available: false }, { available: true, modelId: "x" }] } });
  assert.equal(llmDown(snap), false);
});

test("every head port down, while online, counts as down", () => {
  assert.equal(llmDown(head()), true);
  assert.equal(llmDown(head({ online: false })), false); // offline head: nothing to explain
  assert.equal(llmDown(head({ metrics: { llm: [] } })), false); // never polled
});

test("only workers whose workerHeadId points at the head are paired", () => {
  const sparks = [head(), worker(), worker({ id: "w2", workerHeadId: "other" }), worker({ id: "w3", online: false })];
  assert.deepEqual(
    pairedWorkers(sparks[0], sparks).map((s) => s.id),
    ["w"]
  );
});

test("worker ports fall back to 8888", () => {
  assert.deepEqual(workerPorts({ llmPorts: [8888, 8000] }), [8888, 8000]);
  assert.deepEqual(workerPorts({ llmPort: 9000 }), [9000]);
  assert.deepEqual(workerPorts({}), [8888]);
  assert.deepEqual(workerPorts({ llmPorts: [] }), [8888]);
});

test("engine answering on the paired worker yields a hint", async () => {
  const sparks = [head(), worker()];
  const probed = [];
  const hint = await detectLlmMovedToWorker({
    head: sparks[0],
    sparks,
    probe: async (w, port) => {
      probed.push([w.id, port]);
      return answering;
    },
    state: new Map(),
  });
  assert.deepEqual(probed, [["w", 8888]]);
  assert.equal(hint.workerId, "w");
  assert.equal(hint.workerName, "Spark 2");
  assert.equal(hint.port, 8888);
  assert.equal(hint.modelId, "DeepSeek-V4.1-Flash-1017");
  assert.equal(hint.backend, "tensorfold");
  assert.match(hint.message, /Spark 2 answers on port 8888/);
  assert.match(hint.message, /swap head and worker\?/);
});

test("a silent worker produces no hint", async () => {
  const sparks = [head(), worker()];
  const hint = await detectLlmMovedToWorker({
    head: sparks[0],
    sparks,
    probe: async () => ({ available: false }),
    state: new Map(),
  });
  assert.equal(hint, null);
});

test("a probe that throws is treated as silent", async () => {
  const sparks = [head(), worker()];
  const hint = await detectLlmMovedToWorker({
    head: sparks[0],
    sparks,
    probe: async () => {
      throw new Error("connect ECONNREFUSED");
    },
    state: new Map(),
  });
  assert.equal(hint, null);
});

test("no paired workers: never probes", async () => {
  const sparks = [head()];
  let calls = 0;
  const hint = await detectLlmMovedToWorker({
    head: sparks[0],
    sparks,
    probe: async () => {
      calls += 1;
      return answering;
    },
    state: new Map(),
  });
  assert.equal(hint, null);
  assert.equal(calls, 0);
});

test("a live head short-circuits and clears throttle state", async () => {
  const live = head({ metrics: { llm: [{ available: true, modelId: "x" }] } });
  const state = new Map([["h", { at: 1, hint: { workerId: "w" } }]]);
  let calls = 0;
  const hint = await detectLlmMovedToWorker({
    head: live,
    sparks: [live, worker()],
    probe: async () => {
      calls += 1;
      return answering;
    },
    state,
  });
  assert.equal(hint, null);
  assert.equal(calls, 0);
  assert.equal(state.has("h"), false);
});

test("worker probing is throttled per head", async () => {
  const sparks = [head(), worker()];
  const state = new Map();
  let calls = 0;
  const probe = async () => {
    calls += 1;
    return answering;
  };
  const first = await detectLlmMovedToWorker({ head: sparks[0], sparks, probe, state, now: 1_000 });
  const second = await detectLlmMovedToWorker({ head: sparks[0], sparks, probe, state, now: 2_000 });
  assert.equal(calls, 1);
  assert.deepEqual(second, first);
  const third = await detectLlmMovedToWorker({
    head: sparks[0],
    sparks,
    probe,
    state,
    now: 1_000 + MOVED_PROBE_INTERVAL_MS + 1,
  });
  assert.equal(calls, 2);
  assert.equal(third.workerId, "w");
});

test("the first answering port wins across several workers", async () => {
  const sparks = [head(), worker({ id: "w1" }), worker({ id: "w2", llmPorts: [8888, 8000] })];
  const seen = [];
  const hint = await detectLlmMovedToWorker({
    head: sparks[0],
    sparks,
    probe: async (w, port) => {
      seen.push(`${w.id}:${port}`);
      return w.id === "w2" && port === 8000 ? answering : { available: false };
    },
    state: new Map(),
  });
  assert.deepEqual(seen, ["w1:8888", "w2:8888", "w2:8000"]);
  assert.equal(hint.workerId, "w2");
  assert.equal(hint.port, 8000);
});
