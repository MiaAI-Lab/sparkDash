/**
 * Unit tests for live token estimation (SSE chunks ≠ tokens when batched).
 * Run: npm test
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { getEventListeners } from "node:events";
import {
  applyThinkingFlags,
  coerceThinkingFlag,
  stripThinkingFlags,
  thinkingOffFallbackBody,
  estimateTokenCount,
  round2,
  describeStreamFetchError,
  sleep,
  closeLlmStreamAgent,
} from "../LlmStreaming.js";

test("sleep removes its abort listener after normal completion", async () => {
  const controller = new AbortController();
  for (let i = 0; i < 25; i += 1) await sleep(0, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("sleep rejects promptly on abort and removes its listener", async () => {
  const controller = new AbortController();
  const pending = sleep(10_000, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("shared LLM dispatcher cleanup is idempotent", async () => {
  const first = closeLlmStreamAgent();
  const second = closeLlmStreamAgent();
  assert.equal(first, second);
  assert.equal(await first, true);
});

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

test("coerceThinkingFlag defaults off", () => {
  assert.equal(coerceThinkingFlag(undefined), false);
  assert.equal(coerceThinkingFlag(false), false);
  assert.equal(coerceThinkingFlag("false"), false);
  assert.equal(coerceThinkingFlag(true), true);
  assert.equal(coerceThinkingFlag("true"), true);
});

test("applyThinkingFlags always sends MiniMax thinking_mode even without model id", () => {
  const off = applyThinkingFlags({ messages: [] }, null, false);
  assert.equal(off.chat_template_kwargs.enable_thinking, false);
  assert.equal(off.chat_template_kwargs.thinking, false);
  assert.equal(off.chat_template_kwargs.thinking_mode, "disabled");

  const on = applyThinkingFlags({ messages: [] }, "Qwen3-32B", true);
  assert.equal(on.chat_template_kwargs.enable_thinking, true);
  assert.equal(on.chat_template_kwargs.thinking_mode, "enabled");
});

test("thinking-off 400 fallback keeps an explicit disable, strip does not", () => {
  const body = applyThinkingFlags({ model: "x", stream: true }, "MiniMax-M2.5", false);
  const fallback = thinkingOffFallbackBody(body);
  assert.equal(fallback.enable_thinking, false);
  assert.deepEqual(fallback.thinking, { type: "disabled" });
  assert.equal(fallback.chat_template_kwargs.enable_thinking, false);

  const stripped = stripThinkingFlags({ ...body, chat_template_kwargs: { ...body.chat_template_kwargs } });
  assert.equal(stripped.chat_template_kwargs, undefined);
  assert.equal(stripped.enable_thinking, undefined);
});

test("describeStreamFetchError maps undici 5-minute idle timeouts", () => {
  assert.equal(
    describeStreamFetchError({
      name: "HeadersTimeoutError",
      code: "UND_ERR_HEADERS_TIMEOUT",
      message: "Headers Timeout Error",
    }),
    "HTTP idle timeout (UND_ERR_HEADERS_TIMEOUT): no data from the LLM for 5 minutes"
  );
  assert.equal(
    describeStreamFetchError({ name: "AbortError", message: "This operation was aborted" }),
    "Request aborted or timed out"
  );
  assert.equal(describeStreamFetchError({ message: "ECONNRESET" }), "ECONNRESET");
});
