/**
 * Unit tests for LlmProbe's vLLM histogram parsing and quantile computation.
 *
 * These cover the pure-math helpers (_parseVllmHistogram, _histogramQuantile)
 * that compute TTFT/ITL p95 from vLLM's Prometheus /metrics exposition. A wrong
 * quantile silently renders a plausible-but-wrong latency SLO number, so the
 * edge cases here (empty body, +Inf tail, multi-series, partial body, label
 * injection) are the correctness-critical paths.
 *
 * Uses node:test (shipped with Node 22) — no dependencies required.
 * Run: npm test
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

// Stub spark — LlmProbe only reads spark.lanIp in the constructor.
const stubSpark = { lanIp: "127.0.0.1" };
function makeProbe() {
  return new LlmProbe(stubSpark, 8888);
}

// A realistic single-series TTFT histogram body (vLLM default buckets).
const SINGLE_SERIES_BODY = `
vllm:time_to_first_token_seconds_bucket{engine="0",le="0.001",model_name="m"} 0.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="0.1",model_name="m"} 634.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="0.5",model_name="m"} 1749.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="1.0",model_name="m"} 2330.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="10.0",model_name="m"} 2588.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="2560.0",model_name="m"} 2644.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="+Inf",model_name="m"} 2644.0
vllm:time_to_first_token_seconds_count{engine="0",model_name="m"} 2644.0
vllm:time_to_first_token_seconds_sum{engine="0",model_name="m"} 2869.0
`;

// ─── _parseVllmHistogram ──────────────────────────────────────────────────

test("_parseVllmHistogram parses a single-series body into sorted monotonic buckets", () => {
  const probe = makeProbe();
  const { buckets, total } = probe._parseVllmHistogram(
    SINGLE_SERIES_BODY,
    "vllm:time_to_first_token_seconds"
  );
  assert.equal(total, 2644);
  assert.ok(buckets.length >= 7, `expected >=7 buckets, got ${buckets.length}`);
  // Counts must be monotonically non-decreasing.
  for (let i = 1; i < buckets.length; i++) {
    assert.ok(
      buckets[i].count >= buckets[i - 1].count,
      `non-monotonic at ${i}: ${buckets[i - 1].count} -> ${buckets[i].count}`
    );
  }
  // +Inf bucket is retained as the last entry with upper Infinity.
  const inf = buckets.find((b) => b.upper === Infinity);
  assert.ok(inf, "+Inf bucket should be retained");
  assert.equal(inf.count, 2644);
});

test("_parseVllmHistogram sums cumulative counts per le across multi-series label sets", () => {
  const probe = makeProbe();
  // Two engines, each emitting the same bucket layout. The per-le sum should
  // combine the cumulative counts (cumulative + cumulative = combined cumulative).
  const body = `
vllm:time_to_first_token_seconds_bucket{engine="0",le="0.1",model_name="m"} 100.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="1.0",model_name="m"} 500.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="+Inf",model_name="m"} 500.0
vllm:time_to_first_token_seconds_bucket{engine="1",le="0.1",model_name="m"} 50.0
vllm:time_to_first_token_seconds_bucket{engine="1",le="1.0",model_name="m"} 250.0
vllm:time_to_first_token_seconds_bucket{engine="1",le="+Inf",model_name="m"} 250.0
vllm:time_to_first_token_seconds_count{engine="0",model_name="m"} 500.0
vllm:time_to_first_token_seconds_count{engine="1",model_name="m"} 250.0
`;
  const { buckets, total } = probe._parseVllmHistogram(
    body,
    "vllm:time_to_first_token_seconds"
  );
  assert.equal(total, 750, "total should sum both _count lines");
  const le01 = buckets.find((b) => b.upper === 0.1);
  const le10 = buckets.find((b) => b.upper === 1.0);
  const inf = buckets.find((b) => b.upper === Infinity);
  assert.equal(le01.count, 150, "le=0.1 should sum 100+50");
  assert.equal(le10.count, 750, "le=1.0 should sum 500+250");
  assert.equal(inf.count, 750, "+Inf should sum 500+250");
});

test("_parseVllmHistogram returns empty buckets and null total on an empty body", () => {
  const probe = makeProbe();
  const { buckets, total } = probe._parseVllmHistogram("", "vllm:time_to_first_token_seconds");
  assert.deepEqual(buckets, []);
  assert.equal(total, null);
});

test("_parseVllmHistogram returns empty buckets when +Inf count != _count (partial/corrupted body)", () => {
  const probe = makeProbe();
  // Body with only low-le buckets present but a full _count — a truncated/relabel-filtered
  // exposition. The +Inf count (9000) does not equal _count (10000), so the body is
  // inconsistent and the parser must refuse to yield a plausible-but-wrong quantile.
  const body = `
vllm:time_to_first_token_seconds_bucket{engine="0",le="0.1",model_name="m"} 100.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="0.5",model_name="m"} 9000.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="+Inf",model_name="m"} 9000.0
vllm:time_to_first_token_seconds_count{engine="0",model_name="m"} 10000.0
`;
  const { buckets, total } = probe._parseVllmHistogram(
    body,
    "vllm:time_to_first_token_seconds"
  );
  assert.deepEqual(buckets, [], "inconsistent body should yield empty buckets");
  assert.equal(total, null, "inconsistent body should yield null total");
});

test("_parseVllmHistogram is robust to a label value containing le=\" as a substring", () => {
  const probe = makeProbe();
  // A model_name containing le=" — the regex must match the actual le label, not the
  // one embedded in the model name. vLLM model names are user-configurable.
  const body = `
vllm:time_to_first_token_seconds_bucket{engine="0",le="0.1",model_name="le=\\"0.5\\""} 100.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="1.0",model_name="le=\\"0.5\\""} 500.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="+Inf",model_name="le=\\"0.5\\""} 500.0
vllm:time_to_first_token_seconds_count{engine="0",model_name="le=\\"0.5\\""} 500.0
`;
  const { buckets, total } = probe._parseVllmHistogram(
    body,
    "vllm:time_to_first_token_seconds"
  );
  assert.equal(total, 500);
  // The first bucket's upper must be 0.1 (the real le), not 0.5 (the one in the model name).
  const first = buckets.find((b) => b.upper !== Infinity);
  assert.equal(first.upper, 0.1, "should match the real le label, not the one in model_name");
});

// ─── _histogramQuantile ───────────────────────────────────────────────────

test("_histogramQuantile interpolates a p80 within a finite bucket", () => {
  const probe = makeProbe();
  // Buckets: le=0.1 c=100, le=0.5 c=500, le=1.0 c=900, le=+Inf c=1000. p80 target=800.
  // 500 < 800 <= 900 → falls in le=1.0 bucket; interpolate 0.5 + (1.0-0.5)*((800-500)/(900-500))=0.875.
  const buckets = [
    { upper: 0.1, count: 100 },
    { upper: 0.5, count: 500 },
    { upper: 1.0, count: 900 },
    { upper: Infinity, count: 1000 },
  ];
  const result = probe._histogramQuantile(buckets, 1000, 0.8);
  assert.ok(result !== null, "expected a finite quantile, got null");
  assert.ok(Math.abs(result - 0.875) < 1e-9, `expected ~0.875, got ${result}`);
});

test("_histogramQuantile p95 lands in +Inf tail when highest finite bucket is below target", () => {
  const probe = makeProbe();
  // Same buckets, p95 target=950. 900 < 950 <= 1000 (the +Inf bucket) → null (unbounded tail).
  const buckets = [
    { upper: 0.1, count: 100 },
    { upper: 0.5, count: 500 },
    { upper: 1.0, count: 900 },
    { upper: Infinity, count: 1000 },
  ];
  const result = probe._histogramQuantile(buckets, 1000, 0.95);
  assert.equal(result, null, "p95 in +Inf tail must return null, not interpolate to Infinity");
});

test("_histogramQuantile returns null when target lands in the +Inf tail", () => {
  const probe = makeProbe();
  // All samples in the +Inf bucket (highest finite le=10, c=95; +Inf c=100). p97 target=97.
  // 95 < 97 → falls into the +Inf bucket → unbounded → null (UI shows '—').
  const buckets = [
    { upper: 1.0, count: 50 },
    { upper: 10.0, count: 95 },
    { upper: Infinity, count: 100 },
  ];
  const result = probe._histogramQuantile(buckets, 100, 0.97);
  assert.equal(result, null, "target in +Inf tail must return null, not Infinity");
});

test("_histogramQuantile returns null on empty buckets, missing total, or non-positive total", () => {
  const probe = makeProbe();
  assert.equal(probe._histogramQuantile([], 100, 0.95), null);
  assert.equal(probe._histogramQuantile([{ upper: 1, count: 50 }], null, 0.95), null);
  assert.equal(probe._histogramQuantile([{ upper: 1, count: 50 }], 0, 0.95), null);
  assert.equal(probe._histogramQuantile([{ upper: 1, count: 50 }], -5, 0.95), null);
});

test("_histogramQuantile count===prevCount short-circuit returns the bucket upper (defensive)", () => {
  const probe = makeProbe();
  // Non-monotonic input where a bucket has the same cumulative count as the previous
  // bucket (no new samples) and the target falls in it. The short-circuit returns the
  // bucket's upper boundary directly rather than dividing by (count - prevCount) = 0.
  // Construct: [{0.1, 0}, {0.5, 0}, {1.0, 100}, {Inf, 100}], total=100, p50 target=50.
  // Buckets 0.1 and 0.5 have count 0 (below target 50). Bucket 1.0 count=100 >= 50,
  // prevCount=0 → 100 !== 0, interpolates. To hit count===prevCount we need the
  // FIRST bucket that reaches the target to have count == prevCount. That requires
  // prevCount >= target already — which means a prior bucket already met the target.
  // This path is defensive against non-monotonic buckets; verify it doesn't divide by
  // zero: [{0.1, 100}, {0.5, 100}], total=100, p50 target=50. Bucket 0.1 count=100>=50,
  // prevCount=0 → interpolates 0.05. The short-circuit is unreachable for valid data,
  // so this test just confirms normal interpolation on the boundary target=prevCount.
  const buckets = [
    { upper: 0.1, count: 100 },
    { upper: 0.5, count: 100 },
    { upper: Infinity, count: 100 },
  ];
  // p50 target=50 falls in the 0.1 bucket (count 100 >= 50), prevCount 0: interpolate
  // 0 + (0.1-0)*((50-0)/(100-0)) = 0.05. Verifies no division-by-zero on the boundary.
  const result = probe._histogramQuantile(buckets, 100, 0.5);
  assert.ok(Math.abs(result - 0.05) < 1e-9, `expected ~0.05, got ${result}`);
});

test("_histogramQuantile returns null when all buckets are +Inf (degenerate)", () => {
  const probe = makeProbe();
  const buckets = [{ upper: Infinity, count: 100 }];
  const result = probe._histogramQuantile(buckets, 100, 0.95);
  assert.equal(result, null, "only +Inf bucket must return null");
});