import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateRequests } from "../aggregate.js";

// ─── Helpers ────────────────────────────────────────────────────────────────
// Mock NodeAgentSnapshots carry only the fields aggregateRequests reads
// (`requests`); the rest of the seam shape is irrelevant to aggregation.

function stat(modelId, engine, nodeId, port, queued, running, finished) {
  return { modelId, engine, nodeId, port, queued, running, finished, polledAt: 123 };
}

function nodeSnapshots(nodeId, stats) {
  return {
    nodeId,
    requests: { nodeId, stats, polledAt: 123 },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test("aggregateRequests: 3 nodes with requests → byModel/byEngine/byMachine", () => {
  const snapshots = {
    n1: nodeSnapshots("n1", [stat("qwen3.8-27b", "sglang", "n1", 8080, 2, 1, 10)]),
    n2: nodeSnapshots("n2", [stat("glm-5.3", "vllm", "n2", 8000, 0, 2, 5)]),
    n3: nodeSnapshots("n3", [stat("qwen3.8-27b", "sglang", "n3", 8080, 3, 0, 7)]),
  };
  const r = aggregateRequests(snapshots);

  // byModel: two nodes serve the same model
  assert.deepEqual(Object.keys(r.byModel).sort(), ["glm-5.3", "qwen3.8-27b"]);
  assert.equal(r.byModel["qwen3.8-27b"].length, 2);
  assert.equal(r.byModel["glm-5.3"].length, 1);
  assert.deepEqual(
    r.byModel["qwen3.8-27b"].map((s) => s.nodeId).sort(),
    ["n1", "n3"]
  );

  // byEngine: two nodes on sglang, one on vllm
  assert.deepEqual(Object.keys(r.byEngine).sort(), ["sglang", "vllm"]);
  assert.equal(r.byEngine["sglang"].length, 2);
  assert.equal(r.byEngine["vllm"].length, 1);

  // byMachine: one entry per node
  assert.deepEqual(Object.keys(r.byMachine).sort(), ["n1", "n2", "n3"]);
  for (const nodeId of ["n1", "n2", "n3"]) {
    assert.equal(r.byMachine[nodeId].length, 1);
  }

  // Stats are pushed by reference (no cloning) — values preserved verbatim
  assert.equal(r.byModel["glm-5.3"][0], snapshots.n2.requests.stats[0]);
  assert.equal(r.byMachine["n1"][0].queued, 2);
  assert.equal(r.byMachine["n1"][0].finished, 10);
});

test("aggregateRequests: empty snapshots → three empty Records", () => {
  assert.deepEqual(aggregateRequests({}), { byModel: {}, byEngine: {}, byMachine: {} });
  // Non-object inputs degrade the same way (no crash)
  assert.deepEqual(aggregateRequests(null), { byModel: {}, byEngine: {}, byMachine: {} });
  assert.deepEqual(
    aggregateRequests(undefined),
    { byModel: {}, byEngine: {}, byMachine: {} }
  );
});

test("aggregateRequests: node with null requests is skipped (no crash)", () => {
  const snapshots = {
    n1: { nodeId: "n1", requests: null },
    n2: nodeSnapshots("n2", [stat("glm-5.3", "vllm", "n2", 8000, 0, 1, 3)]),
    n3: { nodeId: "n3" }, // no requests field at all
    n4: { nodeId: "n4", requests: "garbage" }, // wrong type
    n5: { nodeId: "n5", requests: { stats: "not-an-array" } },
    n6: null, // null snapshot value
  };
  const r = aggregateRequests(snapshots);
  assert.equal(r.byModel["glm-5.3"].length, 1);
  assert.equal(Object.keys(r.byModel).length, 1);
  assert.equal(r.byEngine["vllm"].length, 1);
  assert.deepEqual(Object.keys(r.byMachine), ["n2"]);
});

test("aggregateRequests: 2 nodes with same modelId → byModel[modelId] has 2 entries", () => {
  const snapshots = {
    a: nodeSnapshots("a", [stat("qwen3.8-27b", "sglang", "a", 8080, 1, 1, 4)]),
    b: nodeSnapshots("b", [stat("qwen3.8-27b", "sglang", "b", 8080, 0, 1, 9)]),
  };
  const r = aggregateRequests(snapshots);
  assert.equal(r.byModel["qwen3.8-27b"].length, 2);
  assert.deepEqual(
    r.byModel["qwen3.8-27b"].map((s) => s.nodeId).sort(),
    ["a", "b"]
  );
});

test("aggregateRequests: 2 nodes with same engine → byEngine[engine] has 2 entries", () => {
  const snapshots = {
    a: nodeSnapshots("a", [stat("m1", "sglang", "a", 8080, 1, 0, 2)]),
    b: nodeSnapshots("b", [stat("m2", "sglang", "b", 8081, 0, 1, 6)]),
  };
  const r = aggregateRequests(snapshots);
  assert.equal(r.byEngine["sglang"].length, 2);
  assert.deepEqual(Object.keys(r.byEngine), ["sglang"]);
});

test("aggregateRequests: 2 stats with same nodeId → byMachine[nodeId] has 2 entries", () => {
  // Two service ports on the same machine report under one nodeId.
  const snapshots = {
    n1: nodeSnapshots("n1", [
      stat("qwen3.8-27b", "sglang", "n1", 8080, 1, 1, 10),
      stat("glm-5.3", "vllm", "n1", 8000, 0, 2, 5),
    ]),
  };
  const r = aggregateRequests(snapshots);
  assert.equal(r.byMachine["n1"].length, 2);
  assert.deepEqual(
    r.byMachine["n1"].map((s) => s.port).sort((x, y) => x - y),
    [8000, 8080]
  );
});

test("aggregateRequests: known-answer", () => {
  const stat1 = {
    modelId: "qwen3.8-27b",
    engine: "sglang",
    nodeId: "n1",
    port: 8080,
    queued: 2,
    running: 1,
    finished: 10,
    polledAt: 123,
  };
  const stat2 = {
    modelId: "glm-5.3",
    engine: "vllm",
    nodeId: "n2",
    port: 8000,
    queued: 0,
    running: 2,
    finished: 5,
    polledAt: 123,
  };
  const snapshots = {
    n1: { requests: { stats: [stat1] } },
    n2: { requests: { stats: [stat2] } },
  };
  const expected = {
    byModel: { "qwen3.8-27b": [stat1], "glm-5.3": [stat2] },
    byEngine: { sglang: [stat1], vllm: [stat2] },
    byMachine: { n1: [stat1], n2: [stat2] },
  };
  const r = aggregateRequests(snapshots);
  assert.deepEqual(r, expected);
  // Ground truth: every grouping holds the exact stat, values intact
  assert.equal(r.byModel["qwen3.8-27b"][0].queued, 2);
  assert.equal(r.byModel["qwen3.8-27b"][0].running, 1);
  assert.equal(r.byModel["qwen3.8-27b"][0].finished, 10);
  assert.equal(r.byEngine["vllm"][0].running, 2);
  assert.equal(r.byMachine["n2"][0].port, 8000);
});

test("aggregateRequests: malformed stat entries degrade without crashing", () => {
  const snapshots = {
    n1: {
      requests: {
        stats: [
          null,
          42,
          { modelId: "m1", engine: "sglang", port: 8080, queued: 1, running: 0, finished: 0, polledAt: 1 }, // missing nodeId → falls back to snapshot key
          { modelId: undefined, engine: "sglang", nodeId: "n1", port: 8080, queued: 1, running: 0, finished: 0, polledAt: 1 }, // missing modelId → skipped from byModel only
        ],
      },
    },
  };
  const r = aggregateRequests(snapshots);
  // No garbage keys ("undefined", "42") in any view
  assert.deepEqual(Object.keys(r.byModel), ["m1"]);
  assert.deepEqual(Object.keys(r.byEngine), ["sglang"]);
  assert.deepEqual(Object.keys(r.byMachine), ["n1"]);
  // nodeId fallback kept stat#3 in byMachine; stat#4 (explicit nodeId) also lands there
  assert.equal(r.byMachine["n1"].length, 2);
  // Per-view degradation: stat#4 missing modelId drops it from byModel only —
  // engine/machine views still count it
  assert.equal(r.byEngine["sglang"].length, 2);
  assert.equal(r.byModel["m1"].length, 1);
});
