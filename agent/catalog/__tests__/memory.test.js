import test from "node:test";
import assert from "node:assert/strict";

import { computeMemoryBudget } from "../memory.js";

test("known-answer 1: enough free → no make-room", () => {
  const b = computeMemoryBudget(
    122880,
    70000,
    [{ name: "llm", footprintMB: 50000, running: true, needed: false }],
    40000
  );
  assert.equal(b.freeMB, 52880); // 122880 - 70000
  assert.equal(b.needMakeRoom, false);
  assert.deepEqual(b.makeRoom, []);
  assert.equal(b.servicesUsedMB, 50000);
  assert.equal(b.otherUsedMB, 20000); // 70000 - 50000
  assert.equal(b.totalMB, 122880);
  assert.equal(b.usedMB, 70000);
  assert.equal(b.services.length, 1);
  assert.equal(b.services[0].kind, "other"); // kind absent → default
  assert.ok(Number.isFinite(b.polledAt));
  assert.equal(b.nodeId, "unknown"); // default when no opts.nodeId
});

test("known-answer 2 (SPEC-ERROR FLAG): deficit → make-room plan", () => {
  // The Batch 1B task sheet listed makeRoom=[{serviceName:"tts",freesMB:5000}]
  // for these inputs. That plan CANNOT cover the deficit: freeMB=22880,
  // wantMB=40000 → deficit=17120, and stopping tts alone frees only 5000
  // (22880 + 5000 = 27880 < 40000). The task's own algorithm ("sort stoppable
  // by footprintMB desc, greedily add until deficit covered") selects "llm"
  // (50000 MB) first. Asserted against the algorithm; the spec line is
  // reported to the orchestrator as an error.
  const b = computeMemoryBudget(
    122880,
    100000,
    [
      { name: "llm", footprintMB: 50000, running: true, needed: false },
      { name: "tts", footprintMB: 5000, running: true, needed: false },
    ],
    40000
  );
  assert.equal(b.freeMB, 22880); // 122880 - 100000
  assert.equal(b.needMakeRoom, true);
  assert.deepEqual(b.makeRoom, [{ serviceName: "llm", freesMB: 50000, reason: "stoppable" }]);
});

test("make-room: small stoppable service covers a small deficit (tts case)", () => {
  // Same shape as known-answer 2, but llm is needed → only tts is stoppable,
  // and the deficit (1120) is covered by tts alone.
  const b = computeMemoryBudget(
    122880,
    100000,
    [
      { name: "llm", footprintMB: 50000, running: true, needed: true },
      { name: "tts", footprintMB: 5000, running: true, needed: false },
    ],
    24000
  );
  assert.equal(b.freeMB, 22880);
  assert.equal(b.needMakeRoom, true);
  assert.deepEqual(b.makeRoom, [{ serviceName: "tts", freesMB: 5000, reason: "stoppable" }]);
});

test("make-room: greedy multi-stop, largest first, until covered", () => {
  const b = computeMemoryBudget(
    100000,
    90000,
    [
      { name: "a", footprintMB: 3000, running: true, needed: false },
      { name: "b", footprintMB: 4000, running: true, needed: false },
      { name: "c", footprintMB: 1000, running: true, needed: false },
    ],
    20000
  );
  // freeMB=10000 → deficit=10000 → b(4000)+a(3000)+c(1000)=8000, not covered:
  // all stoppables are listed, largest first.
  assert.equal(b.needMakeRoom, true);
  assert.deepEqual(
    b.makeRoom.map((e) => e.serviceName),
    ["b", "a", "c"]
  );
  assert.deepEqual(b.makeRoom.map((e) => e.freesMB), [4000, 3000, 1000]);
});

test("boundary: freeMB == wantMB → no plan (>=, not >)", () => {
  const b = computeMemoryBudget(100, 60, [], 40);
  assert.equal(b.freeMB, 40);
  assert.equal(b.needMakeRoom, false);
  assert.deepEqual(b.makeRoom, []);
});

test("nothing stoppable → infeasible: needMakeRoom=true, makeRoom=[]", () => {
  const b = computeMemoryBudget(
    100,
    90,
    [
      { name: "llm", footprintMB: 50, running: true, needed: true }, // needed → not stoppable
      { name: "tts", footprintMB: 10, running: false, needed: false }, // stopped → not stoppable
    ],
    20
  );
  assert.equal(b.needMakeRoom, true);
  assert.deepEqual(b.makeRoom, []);
});

test("tie-break: equal footprints sorted by name (deterministic)", () => {
  const b = computeMemoryBudget(
    100,
    95,
    [
      { name: "zeta", footprintMB: 20, running: true, needed: false },
      { name: "alpha", footprintMB: 20, running: true, needed: false },
    ],
    30
  );
  assert.deepEqual(
    b.makeRoom.map((e) => e.serviceName),
    ["alpha", "zeta"]
  );
});

test("usedMB > totalMB: freeMB clamps to 0, no crash", () => {
  const b = computeMemoryBudget(
    100,
    150,
    [{ name: "x", footprintMB: 10, running: true, needed: false }],
    10
  );
  assert.equal(b.freeMB, 0);
  assert.equal(b.needMakeRoom, true);
  assert.equal(b.servicesUsedMB, 10);
  assert.equal(b.otherUsedMB, 140); // usedMB(150) - servicesUsedMB(10)
});

test("nodeId override (non-default knob)", () => {
  const b = computeMemoryBudget(100, 0, [], 10, { nodeId: "gx10-1c2c" });
  assert.equal(b.nodeId, "gx10-1c2c");
});

test("degenerate: all zeros → zeros, no plan", () => {
  const b = computeMemoryBudget(0, 0, [], 0);
  assert.equal(b.freeMB, 0);
  assert.equal(b.servicesUsedMB, 0);
  assert.equal(b.otherUsedMB, 0);
  assert.equal(b.needMakeRoom, false);
  assert.deepEqual(b.services, []);
  assert.deepEqual(b.makeRoom, []);
});

test("invalid inputs throw readable TypeErrors", () => {
  assert.throws(() => computeMemoryBudget(-1, 0, [], 0), /totalMB/);
  assert.throws(() => computeMemoryBudget(100, NaN, [], 0), /usedMB/);
  assert.throws(() => computeMemoryBudget(100, 0, [], -5), /wantMB/);
  assert.throws(() => computeMemoryBudget(100, 0, null, 0), /services must be an array/);
  assert.throws(() => computeMemoryBudget(100, 0, [{ name: "" }], 0), /services\[0\].name/);
  assert.throws(
    () => computeMemoryBudget(100, 0, [{ name: "a", footprintMB: -5 }], 0),
    /services\[0\].footprintMB/
  );
  assert.throws(() => computeMemoryBudget(100, 0, ["x"], 0), /services\[0\] must be an object/);
  // non-boolean running is tolerated, coerced to false (behavioral pin, not a throw)
  assert.doesNotThrow(() =>
    computeMemoryBudget(100, 0, [{ name: "a", footprintMB: 1, running: "yes" }], 0)
  );
  // witness: boolean coercion actually happens (red-then-green: assertion pins behavior)
  const b = computeMemoryBudget(100, 10, [{ name: "a", footprintMB: 5, running: "yes" }], 10);
  assert.equal(b.services[0].running, false);
  assert.equal(b.servicesUsedMB, 0);
});
