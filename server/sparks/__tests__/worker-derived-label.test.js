import test from "node:test";
import assert from "node:assert/strict";
import { SparkMonitor } from "../SparkMonitor.js";

// Real instances, never started (no timers / no I/O in constructors).
// Head metrics are injected to simulate probe results.
const head = (id = "h") =>
  new SparkMonitor({ id, name: id, kind: "spark", role: "head", lanIp: "10.0.0.1" });

const worker = (partial = {}, options = {}) =>
  new SparkMonitor(
    {
      id: "w",
      name: "w",
      kind: "spark",
      role: "worker",
      lanIp: "10.0.0.2",
      workerHeadId: "h",
      workerLabel: null,
      ...partial,
    },
    options,
  );

const withHead = (workerMon, headMon) => {
  workerMon._resolveHeadModelId = (headId) =>
    headId === headMon.spark.id ? headMon.headLlmModelId() : null;
  return workerMon;
};

test("worker mirrors head model when head probe is healthy", () => {
  const h = head();
  h._metrics.llm = [{ available: true, modelId: "glm-5.3-flash-exl3-abliterated" }];
  const w = withHead(worker(), h);
  const snap = w.snapshot();
  assert.equal(snap.workerDerivedLabel, "glm-5.3-flash-exl3-abliterated");
  // Raw config label untouched (derived display never writes back).
  assert.equal(snap.workerLabel, null);
  assert.equal(w.spark.workerLabel, null);
});

test("manual workerLabel override is preserved alongside derived (frontend prefers manual)", () => {
  const h = head();
  h._metrics.llm = [{ available: true, modelId: "glm-5.3-flash-exl3-abliterated" }];
  const w = withHead(worker({ workerLabel: "Custom cluster" }), h);
  const snap = w.snapshot();
  assert.equal(snap.workerLabel, "Custom cluster");
  assert.equal(snap.workerDerivedLabel, "glm-5.3-flash-exl3-abliterated");
});

test("head offline yields no derived label (never a stale model)", () => {
  const h = head();
  h._metrics.llm = [{ modelId: null, available: false }]; // failed-probe shape
  const w = withHead(worker(), h);
  assert.equal(w.snapshot().workerDerivedLabel, null);

  const h2 = head();
  h2._metrics.llm = []; // no probe data yet
  const w2 = withHead(worker(), h2);
  assert.equal(w2.snapshot().workerDerivedLabel, null);
});

test("unresolvable or self workerHeadId yields no derived label", () => {
  const h = head();
  h._metrics.llm = [{ available: true, modelId: "glm-x" }];
  const w = withHead(worker({ workerHeadId: "ghost" }), h);
  assert.equal(w.snapshot().workerDerivedLabel, null);

  const wSelf = withHead(worker({ id: "h", workerHeadId: "h" }), h);
  assert.equal(wSelf.snapshot().workerDerivedLabel, null);
});

test("standalone never mirrors, even with a workerHeadId set", () => {
  const h = head();
  h._metrics.llm = [{ available: true, modelId: "glm-x" }];
  const s = withHead(
    worker({ id: "s", role: "standalone", workerHeadId: "h" }),
    h,
  );
  assert.equal(s.snapshot().workerDerivedLabel, null);
});

test("headLlmModelId picks first non-empty model across ports", () => {
  const h = head();
  h._metrics.llm = [{ available: true, modelId: null }, { available: true, modelId: "  " }, { available: true, modelId: "qwen-x" }];
  assert.equal(h.headLlmModelId(), "qwen-x");
  h._metrics.llm = "oops";
  assert.equal(h.headLlmModelId(), null);
});

test("unavailable entries are skipped even when they retain a stale modelId", () => {
  const h = head();
  h._metrics.llm = [
    { available: false, modelId: "stale" },
    { available: true, modelId: "live" },
  ];
  assert.equal(h.headLlmModelId(), "live");
  const w = withHead(worker(), h);
  assert.equal(w.snapshot().workerDerivedLabel, "live");
});

test("all entries unavailable yields no derived label", () => {
  const h = head();
  h._metrics.llm = [
    { available: false, modelId: "stale-a" },
    { available: false, modelId: null },
  ];
  assert.equal(h.headLlmModelId(), null);
  const w = withHead(worker(), h);
  assert.equal(w.snapshot().workerDerivedLabel, null);
});
