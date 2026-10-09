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
  runPrefillMeasured,
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
  // oversized overhead never removes more than 50% of the TTFT (max 2x inflation)
  assert.equal(rateFromSample(base, 99999).tps, 8000);
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

test("rateFromSample flags low confidence when overhead exceeds 30% of TTFT", () => {
  const base = { promptTokens: 8000, ttftMs: 2000, cachedTokens: 0, serverPromptMs: null, serverPromptN: null };
  assert.equal(rateFromSample(base, 500).lowConfidence, false); // 25%
  assert.equal(rateFromSample(base, 700).lowConfidence, true); // 35%
  assert.equal(rateFromSample(base, 99999).lowConfidence, true);
  assert.equal(rateFromSample({ ...base, serverPromptMs: 1000, serverPromptN: 8000 }, 99999).lowConfidence, false);
});

test("rateFromSample gives a reason for a zero rate (no TTFT / fully cached)", () => {
  const base = { promptTokens: 8000, ttftMs: 2000, cachedTokens: 0, serverPromptMs: null, serverPromptN: null };
  assert.match(rateFromSample({ ...base, ttftMs: 0 }, 0).reason, /first token/i);
  assert.match(rateFromSample({ ...base, cachedTokens: 8000 }, 0).reason, /prefix cache/i);
});

const sample = (over = {}) => ({
  targetTokens: 4096,
  promptTokens: 4000,
  promptChars: 16000,
  prefillTps: 0,
  cachedTokens: 0,
  serverPromptMs: null,
  serverPromptN: null,
  ttftMs: 1000,
  ttftContentMs: null,
  completionTokens: 8,
  durationMs: 1100,
  model: "m",
  error: null,
  ...over,
});

test("runPrefillMeasured reports the median-rate sample's own values and the summed duration", async () => {
  const ttfts = [1000, 500, 2000]; // 4000, 8000, 2000 tok/s -> median 4000 (ttft 1000)
  let i = 0;
  const row = await runPrefillMeasured({ targetTokens: 4096 }, 0, null, async () => sample({ ttftMs: ttfts[i++] }));
  assert.equal(row.error, null);
  assert.equal(row.samples, 3);
  assert.equal(row.samplesRequested, 3);
  assert.equal(row.prefillTps, 4000);
  assert.equal(row.ttftMs, 1000);
  assert.equal(row.durationMs, 3300);
  assert.equal(row.notice, undefined);
});

test("runPrefillMeasured marks a partially failed size and keeps the reason", async () => {
  let i = 0;
  const row = await runPrefillMeasured({ targetTokens: 4096 }, 0, null, async () =>
    i++ === 0 ? sample() : sample({ error: "HTTP 500", ttftMs: 0, durationMs: 50 })
  );
  assert.equal(row.error, null);
  assert.equal(row.samples, 1);
  assert.equal(row.samplesRequested, 3);
  assert.match(row.notice, /1 of 3 samples succeeded \(HTTP 500\)/);
  assert.equal(row.durationMs, 1150); // failed attempt counted
});

test("runPrefillMeasured: no-TTFT and fully-cached samples fail with an explicit error", async () => {
  const noTtft = await runPrefillMeasured({ targetTokens: 4096 }, 0, null, async () => sample({ ttftMs: 0 }));
  assert.equal(noTtft.samples, 0);
  assert.match(noTtft.error, /first token/i);
  assert.equal(noTtft.prefillTps, 0);
  const cached = await runPrefillMeasured({ targetTokens: 4096 }, 0, null, async () => sample({ cachedTokens: 4000 }));
  assert.match(cached.error, /prefix cache/i);
});

test("runPrefillMeasured flags lowConfidence when calibration dominates", async () => {
  const row = await runPrefillMeasured({ targetTokens: 4096 }, 800, null, async () => sample({ ttftMs: 1000 }));
  assert.equal(row.lowConfidence, true);
  assert.equal(row.prefillTps, 8000); // capped at half the TTFT
});

test("runPrefillMeasured stops on abort and reports Cancelled", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const row = await runPrefillMeasured({ targetTokens: 4096, abortSignal: ctrl.signal }, 0, null, async () => sample());
  assert.equal(row.error, "Cancelled");
  assert.equal(row.samples, 0);
});

test("PrefillBenchManager prunes finished jobs and only clears its own active slot", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prefill-bench-"));
  const mgr = new PrefillBenchManager(path.join(dir, "hist.json"), path.join(dir, "active.json"));
  const job = mgr.start({
    sparkId: "s1",
    lanIp: "127.0.0.1",
    port: 9, // nothing listens: warmup fails, sizes fail fast or the run is cancelled
    modelId: "m",
    contextSizes: [256],
    contextLength: 128, // 256 does not fit -> skipped row, no network for the size
  });
  mgr.cancel("s1", job.benchId);
  for (let i = 0; i < 200 && mgr.activeBySpark.has("s1"); i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(mgr.activeBySpark.has("s1"), false);
  assert.equal(mgr.jobs.has(job.benchId), false); // pruned
  assert.ok(mgr.getJob(job.benchId)); // served from history
  assert.equal(mgr.cancel("s1", job.benchId)?.benchId, job.benchId);
});
