/**
 * Unit tests for per-model thinking flag mapping.
 * Run: npm test
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { applyThinkingFlags, stripThinkingFlags } from "../LlmStreaming.js";

test("applyThinkingFlags: default models get enable_thinking only", () => {
  const body = applyThinkingFlags({}, "qwen3-32b", false);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
});

test("applyThinkingFlags: MiniMax gets thinking_mode", () => {
  const body = applyThinkingFlags({}, "minimax-m3", false);
  assert.equal(body.chat_template_kwargs.thinking_mode, "disabled");
});

test("applyThinkingFlags: DeepSeek gets thinking (enable_thinking is ignored by its template)", () => {
  const off = applyThinkingFlags({}, "deepseek-v4-flash-0731", false);
  assert.equal(off.chat_template_kwargs.thinking, false);
  const on = applyThinkingFlags({}, "DeepSeek-V4-Flash-0731", true);
  assert.equal(on.chat_template_kwargs.thinking, true);
});

test("applyThinkingFlags: preserves existing chat_template_kwargs", () => {
  const body = applyThinkingFlags(
    { chat_template_kwargs: { reasoning_effort: "low" } },
    "deepseek-v4-flash-0731",
    false,
  );
  assert.equal(body.chat_template_kwargs.reasoning_effort, "low");
  assert.equal(body.chat_template_kwargs.thinking, false);
});

test("stripThinkingFlags: removes thinking key too", () => {
  const body = { chat_template_kwargs: { thinking: false, enable_thinking: false } };
  stripThinkingFlags(body);
  assert.equal(body.chat_template_kwargs, undefined);
});
