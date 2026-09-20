import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import {
  LlmTokenLedger,
  extractTokenObservations,
  normalizeLlmTokenRange,
} from "../LlmTokenLedger.js";
import {
  createLlmTokenRuntime,
  registerLlmTokenTotalsRoute,
} from "../LlmTokenRuntime.js";

function tmpLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-tokens-"));
  return new LlmTokenLedger(path.join(dir, "llm-token-totals.json"));
}

function obs(sparkId, port, modelId, output, prompt) {
  return { sparkId, port, modelId, output, prompt };
}

test("extractTokenObservations: aligns metrics.llm with llmPorts and skips invalid rows", () => {
  const snapshots = [
    {
      id: "spark-a",
      llmPorts: [8888, 8000],
      metrics: {
        llm: [
          { available: true, modelId: "org/model-a", totalOutputTokens: 100, totalPromptTokens: 500 },
          { available: false, modelId: "org/model-b", totalOutputTokens: 999 },
        ],
      },
    },
    { id: "spark-b", llmPorts: [8888], metrics: { llm: [{ available: true, totalOutputTokens: 7 }] } },
    { id: "spark-c", llmPorts: [8888], metrics: { llm: [{ available: true }] } }, // no counter
    { id: "spark-d", llmPorts: [8888, 8000], metrics: { llm: [{ available: true, totalOutputTokens: 1 }] } }, // length mismatch
  ];
  const rows = extractTokenObservations(snapshots);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    sparkId: "spark-a",
    port: 8888,
    modelId: "org/model-a",
    output: 100,
    prompt: 500,
  });
  assert.deepEqual(rows[1], {
    sparkId: "spark-b",
    port: 8888,
    modelId: null,
    output: 7,
    prompt: null,
  });
});

test("LlmTokenLedger: seeds baseline on first observation, credits deltas after", () => {
  const ledger = tmpLedger();
  const t0 = 1_730_000_000_000;
  ledger.record([obs("spark-a", 8888, "org/model", 1000, 5000)], t0);
  // Snapshot: totals empty (baseline only).
  assert.equal(ledger.snapshot().series[0].models.length, 0);

  ledger.record([obs("spark-a", 8888, "org/model", 1100, 6000)], t0 + 10_000);
  const s = ledger.snapshot().series[0];
  assert.equal(s.models.length, 1);
  assert.equal(s.models[0].modelId, "org/model");
  assert.equal(s.models[0].completionTokens, 100);
  assert.equal(s.models[0].promptTokens, 1000);
  assert.equal(s.totals.completionTokens, 100);
});

test("LlmTokenLedger: attributes deltas to the model active at each observation", () => {
  const ledger = tmpLedger();
  const t0 = 1_730_000_000_000;
  ledger.record([obs("spark-a", 8888, "org/a", 100, 10)], t0);
  ledger.record([obs("spark-a", 8888, "org/a", 150, 60)], t0 + 5_000);
  ledger.record([obs("spark-a", 8888, "org/b", 250, 80)], t0 + 10_000);
  // Same tick batch: two models credited together.
  ledger.record(
    [obs("spark-a", 8888, "org/b", 260, 90), obs("spark-a", 8000, "org/c", 10, 5)],
    t0 + 15_000
  );

  const byModel = Object.fromEntries(
    ledger
      .snapshot()
      .series.filter((s) => s.port === 8888)
      .flatMap((s) => s.models.map((m) => [m.modelId, m]))
  );
  assert.equal(byModel["org/a"].completionTokens, 50);
  assert.equal(byModel["org/b"].completionTokens, 110); // 100 + 10
  assert.equal(byModel["org/b"].promptTokens, 30); // 20 + 10
});

test("LlmTokenLedger: fallback keeps last known model when probe omits modelId", () => {
  const ledger = tmpLedger();
  const t0 = 1_730_000_000_000;
  ledger.record([obs("spark-a", 8888, "org/a", 100, 0)], t0);
  ledger.record([obs("spark-a", 8888, null, 140, 10)], t0 + 5_000);
  const s = ledger.snapshot().series[0];
  assert.equal(s.models.length, 1);
  assert.equal(s.models[0].modelId, "org/a");
  assert.equal(s.models[0].completionTokens, 40);
  assert.equal(s.lastModelId, "org/a");
});

test("LlmTokenLedger: counter reset (engine restart) re-seeds without crediting", () => {
  const ledger = tmpLedger();
  const t0 = 1_730_000_000_000;
  ledger.record([obs("spark-a", 8888, "org/a", 1000, 5000)], t0);
  ledger.record([obs("spark-a", 8888, "org/a", 1100, 6000)], t0 + 5_000);
  // Engine restarted: counters back to near zero.
  ledger.record([obs("spark-a", 8888, "org/a", 5, 10)], t0 + 10_000);
  // New traffic after restart.
  ledger.record([obs("spark-a", 8888, "org/a", 25, 30)], t0 + 15_000);

  const s = ledger.snapshot().series[0];
  assert.equal(s.models.length, 1);
  // Only post-restart delta (20) credited; pre-restart total (100) survives.
  assert.equal(s.models[0].completionTokens, 120);
  assert.equal(s.models[0].promptTokens, 1020);
});

test("LlmTokenLedger: daily buckets credit deltas and serve ranged snapshots", () => {
  const ledger = tmpLedger();
  // Two UTC days apart (2026-10-27 and 2026-10-28).
  const d1 = Date.UTC(2026, 9, 27, 23, 0, 0);
  const d2 = Date.UTC(2026, 9, 28, 10, 0, 0);
  ledger.record([obs("spark-a", 8888, "org/a", 100, 10)], d1);
  ledger.record([obs("spark-a", 8888, "org/a", 200, 20)], d1 + 60_000);
  ledger.record([obs("spark-a", 8888, "org/a", 300, 40)], d2);

  // Lifetime includes everything.
  const all = ledger.snapshot("all", d2).series[0];
  assert.equal(all.models[0].completionTokens, 200);

  // "today" (day of d2) only includes the d2 delta.
  const today = ledger.snapshot("today", d2).series[0];
  assert.equal(today.models.length, 1);
  assert.equal(today.models[0].completionTokens, 100);
  assert.equal(today.models[0].promptTokens, 20);
  assert.equal(today.models[0].lastSeenAt, null);

  // 7d/14d/30d windows include both days.
  const seven = ledger.snapshot("7d", d2).series[0];
  assert.equal(seven.models[0].completionTokens, 200);
  assert.equal(ledger.snapshot("30d", d2).range, "30d");

  // Invalid range falls back to lifetime.
  assert.equal(ledger.snapshot("nonsense", d2).range, "all");
});

test("normalizeLlmTokenRange: accepts the documented keys only", () => {
  assert.equal(normalizeLlmTokenRange("today"), "today");
  assert.equal(normalizeLlmTokenRange("7d"), "7d");
  assert.equal(normalizeLlmTokenRange("14d"), "14d");
  assert.equal(normalizeLlmTokenRange("30d"), "30d");
  assert.equal(normalizeLlmTokenRange("all"), "all");
  assert.equal(normalizeLlmTokenRange(undefined), "all");
  assert.equal(normalizeLlmTokenRange("week"), "all");
});

test("LlmTokenLedger: persistence round-trips daily buckets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-tokens-"));
  const file = path.join(dir, "llm-token-totals.json");
  const t0 = Date.UTC(2026, 9, 28, 12, 0, 0);
  const first = new LlmTokenLedger(file);
  first.record([obs("spark-a", 8888, "org/a", 100, 10)], t0);
  first.record([obs("spark-a", 8888, "org/a", 150, 20)], t0 + 60_000);
  first.close();

  const second = new LlmTokenLedger(file);
  const today = second.snapshot("today", t0 + 120_000).series[0];
  assert.equal(today.models[0].completionTokens, 50);
  assert.equal(today.models[0].promptTokens, 10);
});

test("LlmTokenLedger: persistence round-trips counters", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-tokens-"));
  const file = path.join(dir, "llm-token-totals.json");
  const t0 = 1_730_000_000_000;
  const first = new LlmTokenLedger(file);
  first.record([obs("spark-a", 8888, "org/a", 100, 10)], t0);
  first.record([obs("spark-a", 8888, "org/a", 160, 60)], t0 + 5_000);
  first.close();

  const second = new LlmTokenLedger(file);
  second.record([obs("spark-a", 8888, "org/a", 200, 100)], t0 + 10_000);
  const s = second.snapshot().series[0];
  assert.equal(s.models[0].completionTokens, 100);
  assert.equal(s.models[0].promptTokens, 90);
});

test("LlmTokenRuntime: tick pulls observations via orderedSnapshots and route registers", () => {
  const ledger = tmpLedger();
  let ticks = 0;
  let cleared = 0;
  const timers = [];
  const runtime = createLlmTokenRuntime({
    ledger,
    orderedSnapshots: () => {
      ticks++;
      return [
        {
          id: "spark-a",
          llmPorts: [8888],
          metrics: { llm: [{ available: true, modelId: "org/a", totalOutputTokens: 10 + ticks * 5, totalPromptTokens: 100 }] },
        },
      ];
    },
    now: () => 1_730_000_000_000,
    setIntervalFn: (fn, ms) => {
      timers.push(fn);
      return timers.length;
    },
    clearIntervalFn: () => {
      cleared++;
    },
  });

  assert.equal(runtime.start(), true);
  assert.equal(runtime.start(), false); // idempotent
  assert.equal(ticks, 1); // immediate first tick
  assert.equal(timers.length, 1);
  timers[0](); // manual tick
  assert.equal(ticks, 2);
  assert.equal(runtime.stop(), true);
  assert.equal(cleared, 1);

  const s = ledger.snapshot().series[0];
  assert.equal(s.models[0].completionTokens, 5); // second tick: 20 - 15

  const routes = [];
  const app = { get: (p, h) => routes.push({ p, h }) };
  registerLlmTokenTotalsRoute(app, ledger);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].p, "/api/llm-token-totals");
  let sent = null;
  routes[0].h({}, { json: (v) => (sent = v) });
  assert.equal(sent.series[0].sparkId, "spark-a");
});
