import test from "node:test";
import assert from "node:assert/strict";
import { LlmProbe } from "../LlmProbe.js";

// Addendum C.7: avgDecodeSeconds must be mean decode over a rolling 15-minute
// window of cumulative-histogram sum/count deltas — never lifetime totals.
// `_updateDecodeWindow` takes an injectable `now` so the window is testable.

const probe = () => new LlmProbe({ id: "t" });
const T0 = 1_700_000_000_000;

test("a single sample has no completions in-window -> null", () => {
  const p = probe();
  assert.equal(p._updateDecodeWindow(120, 4, T0), null);
});

test("two samples inside the window -> mean of the deltas", () => {
  const p = probe();
  assert.equal(p._updateDecodeWindow(100, 10, T0), null); // first sample: baseline
  // 1 min later: 60 s of decode across 2 completions -> 30 s mean.
  assert.equal(p._updateDecodeWindow(160, 12, T0 + 60_000), 30);
});

test("samples older than 15 m are pruned: lifetime skew is impossible", () => {
  const p = probe();
  // A slow distant past: 900 s per request, 10 minutes ago.
  p._updateDecodeWindow(900, 1, T0);
  // Window slides past it; only fresh fast completions count (10 s each ×5).
  const result = p._updateDecodeWindow(900 + 50, 6, T0 + 16 * 60_000);
  assert.equal(result, 10); // (950-900)/(6-1) — the 900 s request is out of window
});

test("counter reset (sum/count going backwards) -> null, never a negative mean", () => {
  const p = probe();
  p._updateDecodeWindow(500, 5, T0);
  assert.equal(p._updateDecodeWindow(100, 1, T0 + 5_000), null);
});

test("no completions in the window -> null (the '—' state)", () => {
  const p = probe();
  p._updateDecodeWindow(100, 5, T0);
  p._updateDecodeWindow(100, 5, T0 + 30_000);
  assert.equal(p._updateDecodeWindow(100, 5, T0 + 60_000), null);
});
