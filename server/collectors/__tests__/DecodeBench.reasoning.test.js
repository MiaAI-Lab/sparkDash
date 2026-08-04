/**
 * Unit tests for DecodeBench's streamed-delta extraction.
 *
 * Reasoning models (DeepSeek-V4-Flash, R1-style) emit their thinking phase as
 * `delta.reasoning` / `delta.reasoning_content` and only switch to
 * `delta.content` at the very end — while `usage.completion_tokens` counts
 * both. Timing the decode window on content alone pairs the full token count
 * with a fraction of the wall clock (inflated tok/s), or with a zero-length
 * window when the reply never leaves the reasoning phase (tok/s reads 0).
 * These cases pin the delta shapes that must count as generated tokens.
 *
 * Uses node:test (shipped with Node 22) — no dependencies required.
 * Run: npm test
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { extractDeltaText } from "../DecodeBench.js";

test("plain content delta is generated text, not reasoning", () => {
  const r = extractDeltaText({ delta: { content: "hello" } });
  assert.equal(r.text, "hello");
  assert.equal(r.isReasoning, false);
});

test("legacy completions `text` field still counts", () => {
  const r = extractDeltaText({ text: "hello" });
  assert.equal(r.text, "hello");
  assert.equal(r.isReasoning, false);
});

test("DeepSeek-V4-Flash `reasoning` delta counts as generated text", () => {
  const r = extractDeltaText({ delta: { reasoning: "1. The user asks" } });
  assert.equal(r.text, "1. The user asks");
  assert.equal(r.isReasoning, true);
});

test("OpenAI/vLLM `reasoning_content` delta counts as generated text", () => {
  const r = extractDeltaText({ delta: { reasoning_content: "thinking" } });
  assert.equal(r.text, "thinking");
  assert.equal(r.isReasoning, true);
});

test("content wins when a chunk carries both", () => {
  const r = extractDeltaText({
    delta: { content: "answer", reasoning: "thought" },
  });
  assert.equal(r.text, "answer");
  assert.equal(r.isReasoning, false);
});

test("role-only opener yields no tokens", () => {
  const r = extractDeltaText({ delta: { role: "assistant", content: "" } });
  assert.equal(r.text, "");
  assert.equal(r.isReasoning, false);
});

test("usage-only / finish-only chunks yield no tokens", () => {
  assert.equal(extractDeltaText({ delta: {}, finish_reason: "length" }).text, "");
  assert.equal(extractDeltaText(undefined).text, "");
  assert.equal(extractDeltaText(null).text, "");
  assert.equal(extractDeltaText({}).text, "");
});

test("non-string deltas (tool calls) are ignored", () => {
  const r = extractDeltaText({
    delta: { content: null, tool_calls: [{ index: 0 }] },
  });
  assert.equal(r.text, "");
});
