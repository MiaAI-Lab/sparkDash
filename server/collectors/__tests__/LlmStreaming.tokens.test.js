/**
 * Unit tests for live token estimation (SSE chunks ≠ tokens when batched).
 * Run: npm test
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { estimateTokenCount, round2 } from "../LlmStreaming.js";

test("estimateTokenCount: empty → 0", () => {
  assert.equal(estimateTokenCount(""), 0);
  assert.equal(estimateTokenCount(null), 0);
  assert.equal(estimateTokenCount(undefined), 0);
});

test("estimateTokenCount: short non-empty text → at least 1", () => {
  assert.equal(estimateTokenCount("hi"), 1);
  assert.equal(estimateTokenCount("abc"), 1);
});

test("estimateTokenCount: ~4 chars per token", () => {
  assert.equal(estimateTokenCount("a".repeat(40)), 10);
  assert.equal(estimateTokenCount("a".repeat(16)), 4);
});

test("batched SSE delta estimate beats event-count of 1", () => {
  // vLLM often sends ~16 chars (≈4 tokens) in one delta
  const chars = "Invent many rows of JSON metrics data";
  const estimated = estimateTokenCount(chars);
  assert.ok(estimated > 1, `expected >1 tokens for ${chars.length} chars, got ${estimated}`);
  assert.equal(estimated, Math.round(chars.length / 4));
});

test("live decode rate formula matches final decodeTps shape", () => {
  // Same math ShowcaseManager / LlmStreaming use: (tokens-1) / (tLast-tFirst) * 1000
  const tokenCount = 100;
  const tFirst = 1000;
  const tLast = 5000; // 4s decode window
  const decodeTokens = Math.max(0, tokenCount - 1);
  const elapsedMs = tLast - tFirst;
  const live = round2((decodeTokens / elapsedMs) * 1000);
  assert.equal(live, 24.75);
});

test("prefill tok/s is prompt tokens over TTFT", () => {
  const prefillTokens = 1024;
  const ttftMs = 80;
  const prefillTps = round2((prefillTokens / ttftMs) * 1000);
  assert.equal(prefillTps, 12800);
});
