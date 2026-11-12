// Copyright 2026 Maxrio9. SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { registerTrainingProgressRoutes } from "../training/progress.js";
import { normalizeProgressDocument, RETENTION_MS, MAX_BYTES } from "../training/schema.js";

const unit = (id) => ({ id, name: `Unit ${id}`, isLocal: true });
const raw = (time, id = "example", extra = {}) => ({ schema_version: 1, id, campaign: `Experiment ${id}`, updatedAt: time,
  stages: { training: [{ id: "fit", label: "Training", state: "running", completed: 0 }] }, ...extra });
function fixture(options = {}) {
  const handlers = new Map();
  const runtime = registerTrainingProgressRoutes({ get: (route, handler) => handlers.set(route, handler) }, {
    enabled: true, start: false, env: { TRAINING_PROGRESS_ROOTS: '["/reports"]' }, getSparks: () => [unit("a")], ...options,
  });
  return { ...runtime, read() {
    let status = 200, body;
    handlers.get("/api/training-progress")({}, {
      set: (key, value) => assert.deepEqual([key, value], ["Cache-Control", "no-store"]),
      status(code) { status = code; return this; }, json(value) { body = value; return this; },
    });
    return { status, body };
  } };
}

test("disabled, invalid and empty-root operation performs no collection; GET only reads cached snapshots", async () => {
  for (const options of [
    { enabled: false, env: { TRAINING_PROGRESS_ROOTS: "bad" } },
    { env: { TRAINING_PROGRESS_ROOTS: "bad" } }, { env: {} },
  ]) {
    const runtime = fixture({ ...options, createCollector: () => assert.fail("must not collect") });
    await runtime.poll();
    const result = runtime.read();
    assert.equal(result.status, options.enabled === false ? 404 : 200);
    assert.deepEqual(runtime.snapshot().runs, []);
    if (options.env.TRAINING_PROGRESS_ROOTS === "bad" && options.enabled !== false) assert.ok(result.body.error);
    runtime.dispose();
  }
  let calls = 0;
  const runtime = fixture({ createCollector: () => ({ collect: async () => { calls++; return { records: [], truncated: false }; } }) });
  runtime.read(); runtime.read();
  assert.equal(calls, 0);
  await runtime.poll(); runtime.read(); runtime.read();
  assert.equal(calls, 1);
});

test("re-reading unchanged reports never refreshes worker evidence or one-hour retention", async () => {
  let time = 1000;
  const document = normalizeProgressDocument(raw(time), time);
  const runtime = fixture({ now: () => time,
    createCollector: () => ({ collect: async () => ({ records: [{ key: "report", document }], truncated: false }) }) });
  await runtime.poll();
  assert.equal(runtime.snapshot().runs[0].sources[0].status, "live");
  time += 31_000;
  await runtime.poll();
  let source = runtime.snapshot().runs[0].sources[0];
  assert.equal(source.status, "stale");
  assert.equal(source.reportedAt, 1000);
  assert.equal(source.stages.training[0].completed, 0);
  assert.equal(source.stages.training[0].total, null);
  time = 1001 + RETENTION_MS;
  await runtime.poll();
  assert.deepEqual(runtime.snapshot().runs, []);
});

test("missing and malformed reporters retain only stale history; unit failures stay isolated", async () => {
  let time = 1000, partial = false, failB = false;
  const old = normalizeProgressDocument(raw(time), time);
  const runtime = fixture({ now: () => time, getSparks: () => [unit("a"), unit("b")],
    createCollector: (spark) => ({ collect: async () => {
      if (spark.id === "b" && failB) throw new Error("private transport details");
      return { records: [{ key: spark.id, document: partial && spark.id === "a" ? null : old }], truncated: false, partial };
    } }) });
  await runtime.poll();
  assert.equal(runtime.snapshot().runs[0].sources.length, 2);
  partial = true; failB = true; time += 1000;
  await runtime.poll();
  const result = runtime.snapshot();
  assert.equal(result.runs[0].sources.find((source) => source.sparkId === "a").status, "stale");
  assert.equal(result.runs[0].sources.find((source) => source.sparkId === "b").status, "unavailable");
  assert.ok(result.units.find((row) => row.sparkId === "a").detail);
  assert.ok(!JSON.stringify(result).includes("private transport"));
});

test("newest logical reporter wins before pending priority, including after its file disappears", async () => {
  const now = 10_000;
  let missing = false;
  const older = normalizeProgressDocument(raw(now - 1000, "example", { source_id: "trainer" }), now);
  const newer = normalizeProgressDocument(raw(now, "example", { source_id: "trainer",
    stages: { training: [{ id: "fit", label: "Fit", state: "complete", completed: 10, total: 10 }] } }), now);
  const runtime = fixture({ now: () => now, createCollector: () => ({ collect: async () => ({ records: [
    { key: "copy", document: older }, { key: "original", document: missing ? null : newer },
  ], truncated: false }) }) });
  await runtime.poll();
  assert.equal(runtime.snapshot().runs[0].sources.length, 1);
  assert.equal(runtime.snapshot().runs[0].sources[0].stages.training[0].state, "complete");
  missing = true;
  await runtime.poll();
  assert.equal(runtime.snapshot().runs[0].sources[0].stages.training[0].state, "complete");
  assert.equal(runtime.snapshot().runs[0].sources[0].status, "stale");
});

test("polls do not overlap; removed units and unsupported transports cannot preserve current evidence", async () => {
  let release, calls = 0;
  let sparks = [unit("a"), { ...unit("mac"), kind: "mac", agent: { url: "http://agent.invalid" } }];
  const runtime = fixture({ getSparks: () => sparks, now: () => 1000, createCollector: () => ({ collect: async () => {
    calls++; await new Promise((resolve) => { release = resolve; });
    return { records: [{ key: "a", document: normalizeProgressDocument(raw(1000), 1000) }], truncated: false };
  } }) });
  const poll = runtime.poll();
  await Promise.resolve(); await runtime.poll();
  assert.equal(calls, 1);
  release(); await poll;
  assert.equal(runtime.snapshot().units.find((row) => row.sparkId === "mac").status, "unsupported");
  sparks = [];
  assert.deepEqual(runtime.snapshot().runs, []);
  assert.deepEqual(runtime.snapshot().units, []);
});

test("cache and response remain count/byte bounded, favoring fresh reports over abandoned running ones", async () => {
  const now = 100_000;
  const sparks = Array.from({ length: 6 }, (_, i) => unit(String(i)));
  const runtime = fixture({ getSparks: () => sparks, now: () => now, createCollector: (spark) => ({ collect: async () => ({
    records: Array.from({ length: 16 }, (_, i) => {
      const id = `${spark.id}-${i}`;
      const old = spark.id === "0";
      return { key: id, document: normalizeProgressDocument(raw(old ? now - 31_000 : now, id, {
        stages: { training: [{ id: "fit", label: "Fit", state: old ? "running" : "complete" }] },
      }), now) };
    }), truncated: false,
  }) }) });
  await runtime.poll();
  const result = runtime.snapshot();
  assert.equal(result.truncated, true);
  assert.equal(result.runs.length, 64);
  assert.ok(!result.runs.some((run) => run.id.startsWith("json:0-")));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_BYTES);
});

test("byte-heavy reports and many reporters of one run remain bounded independently of count limits", async () => {
  const time = 100_000;
  const roots = Array.from({ length: 16 }, (_, i) => `/report-${i}`);
  const stages = Array.from({ length: 12 }, (_, i) => ({ id: `stage-${i}`, label: "Worker-reported result", state: "complete",
    metrics: Array.from({ length: 8 }, () => ({ label: "m".repeat(80), value: "v".repeat(120), unit: "u".repeat(32) })) }));
  const runtime = fixture({ now: () => time, env: { TRAINING_PROGRESS_ROOTS: JSON.stringify(roots) },
    getSparks: () => [unit("a"), unit("b"), unit("c"), unit("d")], createCollector: (spark) => ({ collect: async () => ({
      records: roots.map((root, i) => ({ key: `${spark.id}-${i}`, document: normalizeProgressDocument(raw(time, "shared", {
        source_id: `worker-${i}`, stages: { evaluation: stages },
      }), time) })), truncated: false,
    }) }) });
  await runtime.poll();
  const result = runtime.snapshot();
  assert.equal(result.truncated, true);
  assert.equal(result.runs.length, 1);
  assert.ok(result.runs[0].sources.length <= 32);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_BYTES);
});
