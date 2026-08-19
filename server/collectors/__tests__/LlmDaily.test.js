import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { LlmDailyStore } from "../LlmDaily.js";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-daily-"));
  return new LlmDailyStore(path.join(dir, "llm-daily.json"));
}

test("LlmDailyStore: busy samples roll into UTC day max/avg", () => {
  const store = tmpStore();
  const now = new Date("2026-08-16T12:00:00.000Z");
  store.record("spark-a", 8888, { available: true, generationTps: 10, prefillTps: 40 }, now);
  store.record("spark-a", 8888, { available: true, generationTps: 30, prefillTps: 0 }, now);
  store.record("spark-a", 8888, { available: true, generationTps: 0, prefillTps: 0 }, now);
  const { days } = store.getSeries("spark-a", 8888, { days: 1, now });
  assert.equal(days.length, 1);
  assert.equal(days[0].date, "2026-08-16");
  assert.equal(days[0].decodeMax, 30);
  assert.equal(days[0].decodeAvg, 20);
  assert.equal(days[0].prefillMax, 40);
  assert.equal(days[0].prefillAvg, 40);
  assert.equal(days[0].cachedPrefillMax, null);
});

test("LlmDailyStore: ds4 split rates + calendar zeros", () => {
  const store = tmpStore();
  const now = new Date("2026-08-16T12:00:00.000Z");
  store.record(
    "spark-a",
    8888,
    {
      available: true,
      generationTps: 12,
      prefillTps: 80,
      cachedPrefillTps: 400,
      uncachedPrefillTps: 80,
    },
    now
  );
  const { days } = store.getSeries("spark-a", 8888, { days: 3, now });
  assert.equal(days.length, 3);
  assert.equal(days[0].date, "2026-08-14");
  assert.equal(days[0].decodeMax, 0);
  assert.equal(days[2].cachedPrefillMax, 400);
  assert.equal(days[2].uncachedPrefillMax, 80);
});

test("LlmDailyStore: skips unavailable probes", () => {
  const store = tmpStore();
  const now = new Date("2026-08-16T12:00:00.000Z");
  store.record("spark-a", 8888, { available: false, generationTps: 99 }, now);
  const { days } = store.getSeries("spark-a", 8888, { days: 1, now });
  assert.equal(days[0].decodeMax, 0);
  assert.equal(days[0].decodeAvg, null);
});
