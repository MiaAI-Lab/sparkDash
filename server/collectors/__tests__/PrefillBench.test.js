/**
 * PrefillBench helpers + job-manager gates (no live LLM calls).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import os from "os";
import path from "path";
import fs from "fs";
import {
  ALLOWED_CONTEXT_SIZES,
  DEFAULT_CONTEXT_SIZES,
  PrefillBenchManager,
  buildPrefillPrompt,
  formatContextSize,
  medianOf,
  normalizeContextSizes,
  rateFromSample,
  repeatsForSize,
  timeoutMsForSize,
} from "../PrefillBench.js";

test("allowed sizes include 300k and power-of-two steps", () => {
  assert.ok(ALLOWED_CONTEXT_SIZES.includes(300000));
  assert.ok(ALLOWED_CONTEXT_SIZES.includes(1024));
  assert.ok(ALLOWED_CONTEXT_SIZES.includes(131072));
  assert.deepEqual(DEFAULT_CONTEXT_SIZES, [4096, 8192, 16384, 32768]);
});

test("formatContextSize uses compact labels", () => {
  assert.equal(formatContextSize(1024), "1k");
  assert.equal(formatContextSize(32768), "32k");
  assert.equal(formatContextSize(300000), "300k");
  assert.equal(formatContextSize(262144), "256k");
});

test("normalizeContextSizes sorts, uniques, and accepts custom integers", () => {
  assert.deepEqual(normalizeContextSizes([8192, 1024, 8192, 99, "4096"]), [
    1024, 4096, 8192,
  ]);
  assert.deepEqual(normalizeContextSizes([12000, 256, 300000, 300001]), [
    256, 12000, 300000,
  ]);
  assert.deepEqual(normalizeContextSizes("nope"), []);
  assert.deepEqual(normalizeContextSizes([]), []);
});

test("buildPrefillPrompt puts salt first so sizes do not share a prefix", () => {
  const a = buildPrefillPrompt(128, "salt-aaa");
  const b = buildPrefillPrompt(128, "salt-bbb");
  assert.ok(a.startsWith("[prefill-bench salt-aaa]"));
  assert.ok(b.startsWith("[prefill-bench salt-bbb]"));
  assert.notEqual(a.slice(0, 40), b.slice(0, 40));
  const small = buildPrefillPrompt(64, "x");
  const large = buildPrefillPrompt(4096, "x");
  assert.ok(large.length > small.length * 10);
});

test("timeoutMsForSize scales with context and caps", () => {
  assert.equal(timeoutMsForSize(1024), 90_000);
  assert.ok(timeoutMsForSize(262144) > 1_800_000); // >30 min at 256k
  assert.ok(timeoutMsForSize(300000) <= 2_700_000);
  assert.ok(timeoutMsForSize(300000) > timeoutMsForSize(8192));
});

test("PrefillBenchManager.start rejects empty sizes and overlapping jobs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prefill-bench-"));
  const mgr = new PrefillBenchManager(
    path.join(dir, "hist.json"),
    path.join(dir, "active.json")
  );
  assert.throws(
    () =>
      mgr.start({
        sparkId: "s1",
        lanIp: "127.0.0.1",
        port: 8888,
        modelId: "m",
        contextSizes: [],
      }),
    /at least one context size/i
  );

  mgr.activeBySpark.set("s1", "fake-id");
  assert.throws(
    () =>
      mgr.start({
        sparkId: "s1",
        lanIp: "127.0.0.1",
        port: 8888,
        modelId: "m",
        contextSizes: [1024],
      }),
    /already running/i
  );
});

test("rateFromSample prefers server timings, subtracts overhead and cached tokens", () => {
  const base = { promptTokens: 8000, ttftMs: 2000, cachedTokens: 0, serverPromptMs: null, serverPromptN: null };
  assert.equal(rateFromSample(base, 0).tps, 4000);
  assert.equal(rateFromSample(base, 500).tps, round(8000 / 1.5));
  assert.equal(rateFromSample({ ...base, cachedTokens: 4000 }, 0).tps, 2000);
  assert.equal(rateFromSample({ ...base, serverPromptMs: 1000, serverPromptN: 8000 }, 500).method, "server");
  assert.equal(rateFromSample({ ...base, serverPromptMs: 1000, serverPromptN: 8000 }, 500).tps, 8000);
  // oversized overhead never removes more than 80% of the TTFT
  assert.equal(rateFromSample(base, 99999).tps, 20000);
  assert.equal(rateFromSample({ ...base, ttftMs: 0 }, 0).tps, 0);
});

function round(n) {
  return Math.round(n * 100) / 100;
}

test("repeatsForSize and medianOf", () => {
  assert.equal(repeatsForSize(4096), 3);
  assert.equal(repeatsForSize(65536), 2);
  assert.equal(repeatsForSize(262144), 1);
  assert.equal(medianOf([3, 1, 2]), 2);
  assert.equal(medianOf([1, 2, 3, 4]), 2.5);
  assert.equal(medianOf([]), 0);
});
