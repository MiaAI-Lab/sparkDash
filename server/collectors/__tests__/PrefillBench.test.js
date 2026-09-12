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
  normalizeContextSizes,
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
