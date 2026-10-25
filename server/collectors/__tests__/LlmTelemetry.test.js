import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { LlmTelemetryStore } from "../LlmTelemetry.js";

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-llm-telemetry-"));
  return { dir, file: path.join(dir, "telemetry.json"), store: new LlmTelemetryStore(path.join(dir, "telemetry.json")) };
}

test("LlmTelemetryStore buckets, retains unavailable samples, and persists", (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-08-27T12:00:00.000Z"));
  const { dir, file, store } = makeStore();
  try {
    const base = new Date("2026-08-27T12:00:01.000Z");
    store.record("john", 8888, { available: true, backend: "vllm", requestsRunning: 2 }, base);
    store.record("john", 8888, { available: true, backend: "vllm", requestsRunning: 4 }, new Date(base.getTime() + 8_000));
    store.record("john", 8888, { available: false, backend: "vllm", requestsRunning: null }, new Date(base.getTime() + 11_000));

    const series = store.getSeries("john", 8888, { hours: 1, now: new Date(base.getTime() + 20_000) });
    assert.equal(series.bucketSeconds, 10);
    assert.equal(series.retentionHours, 168);
    assert.equal(series.points.length, 2);
    assert.equal(series.points[0].requestsRunning, 4);
    assert.equal(series.points[1].available, false);

    store.flush();
    assert.ok(fs.statSync(`${file}.journal`).size > 0);
    const restored = new LlmTelemetryStore(file);
    assert.deepEqual(
      restored.getSeries("john", 8888, { hours: 1, now: new Date(base.getTime() + 20_000) }),
      series
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("LlmTelemetryStore compacts its recovery journal without losing samples", (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-08-27T12:00:00.000Z"));
  const { dir, file, store } = makeStore();
  try {
    const now = new Date("2026-08-27T12:00:00.000Z");
    store.record("john", 8888, { available: true, requestsWaiting: 3 }, now);
    store.flush();
    store.compact(now.getTime());

    assert.equal(fs.readFileSync(`${file}.journal`, "utf8"), "");
    const restored = new LlmTelemetryStore(file);
    assert.equal(restored.getSeries("john", 8888, { hours: 1, now }).points[0].requestsWaiting, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("LlmTelemetryStore prunes samples older than seven days", (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-08-27T12:00:00.000Z"));
  const { dir, store } = makeStore();
  try {
    const now = new Date("2026-08-27T12:00:00.000Z");
    store.record("john", 8888, { available: false }, new Date(now.getTime() - 8 * 86400000));
    store.record("john", 8888, { available: true }, now);
    const series = store.getSeries("john", 8888, { hours: 168, now });
    assert.equal(series.points.length, 1);
    assert.equal(series.points[0].available, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("LlmTelemetryStore persists model/status/counters and migrates old points", (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-08-27T12:00:00.000Z"));
  const { dir, file, store } = makeStore();
  try {
    const now = new Date("2026-08-27T12:00:00.000Z");
    store.record(
      "mama",
      4000,
      {
        available: false,
        status: "ambiguous_model",
        statusReason: "ambiguous_model",
        modelId: null,
        lastObservedAt: now.getTime() - 45_000,
        telemetrySource: "relay",
        generationTps: null,
        prefillTps: null,
        totalPromptTokens: 12,
        totalOutputTokens: 8,
        completedRequestsTotal: 1,
      },
      now
    );
    store.flush();
    const point = new LlmTelemetryStore(file).getSeries("mama", 4000, { hours: 1, now }).points[0];
    assert.equal(point.status, "ambiguous_model");
    assert.equal(point.telemetrySource, "relay");
    assert.equal(point.totalPromptTokens, 12);
    assert.equal(point.totalOutputTokens, 8);
    assert.equal(point.completedRequestsTotal, 1);

    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        series: {
          "old:8888": [{ t: now.getTime(), available: true, backend: "vllm" }],
        },
      })
    );
    const migrated = new LlmTelemetryStore(file).getSeries("old", 8888, { hours: 1, now }).points[0];
    assert.equal(migrated.status, "unknown");
    assert.equal(migrated.modelId, null);
    assert.equal(migrated.statusReason, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("compaction removes expired series even after their port is deleted", (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-08-27T12:00:00.000Z"));
  const { dir, file, store } = makeStore();
  try {
    const now = Date.now();
    store.record("deleted-unit", 8000, { available: true }, new Date(now - 8 * 86400000));
    store.flush();
    store.compact(now);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).series, {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
