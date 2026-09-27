/**
 * Shared prompt catalog used by Showcase and Decode bench.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  STRUCTURAL_PROMPTS,
  DECODE_STRUCTURED_PROMPT,
  DECODE_PROSE_PROMPT,
  DECODE_CODE_PROMPT,
  DECODE_CODE_TASKS,
  DECODE_CODE_WARMUP_PROMPT,
  DECODE_JSON_PROMPT,
  DECODE_BENCH_DEFAULT_TYPE,
  pickShowcasePrompts,
  pickDecodeBenchPrompts,
  normalizeDecodeBenchType,
  decodeBenchPromptForType,
  withFillToMaxInstruction,
} from "../../../src/shared/llmPrompts.js";

test("pickShowcasePrompts structural cycles the shared catalog", () => {
  const one = pickShowcasePrompts("structural", 1);
  assert.equal(one.length, 1);
  assert.equal(one[0], STRUCTURAL_PROMPTS[0]);
  const many = pickShowcasePrompts("structural", STRUCTURAL_PROMPTS.length + 2);
  assert.equal(many[0], STRUCTURAL_PROMPTS[0]);
  assert.equal(many[STRUCTURAL_PROMPTS.length], STRUCTURAL_PROMPTS[0]);
});

test("bench-style showcase prompts apply fill-to-max", () => {
  const prompts = pickShowcasePrompts("structural", 2).map(withFillToMaxInstruction);
  for (const p of prompts) {
    assert.match(p, /maximum output length/);
  }
});

test("decode bench uses lab count-1-200, not the Showcase catalog", () => {
  const one = pickDecodeBenchPrompts(1);
  assert.equal(one.length, 1);
  assert.equal(one[0], DECODE_STRUCTURED_PROMPT);
  assert.match(one[0], /Count from 1 to 200/);
  assert.doesNotMatch(one[0], /maximum output length/);
  assert.notEqual(one[0], STRUCTURAL_PROMPTS[0]);

  const many = pickDecodeBenchPrompts(4);
  assert.equal(many.length, 4);
  assert.equal(new Set(many).size, 4);
  for (const p of many) {
    assert.match(p, /Count from 1 to 200/);
  }
});

test("decode bench types pick fixed prompts (structured default)", () => {
  assert.equal(normalizeDecodeBenchType(undefined), DECODE_BENCH_DEFAULT_TYPE);
  assert.equal(normalizeDecodeBenchType("nope"), "structured");
  assert.equal(decodeBenchPromptForType("structured"), DECODE_STRUCTURED_PROMPT);
  assert.equal(decodeBenchPromptForType("prose"), DECODE_PROSE_PROMPT);
  assert.match(DECODE_PROSE_PROMPT, /hash map works/);
  assert.equal(decodeBenchPromptForType("code"), DECODE_CODE_PROMPT);
  assert.equal(DECODE_CODE_PROMPT, DECODE_CODE_TASKS[0]);
  assert.match(DECODE_CODE_PROMPT, /binary_search/);
  assert.match(DECODE_CODE_PROMPT, /No comments/);
  assert.doesNotMatch(DECODE_CODE_PROMPT, /JSON schema|response_format|xgrammar/i);
  assert.equal(decodeBenchPromptForType("json"), DECODE_JSON_PROMPT);
  assert.equal(DECODE_JSON_PROMPT, STRUCTURAL_PROMPTS[0]);

  const prose = pickDecodeBenchPrompts(1, "prose");
  assert.equal(prose[0], DECODE_PROSE_PROMPT);
  const codeMany = pickDecodeBenchPrompts(3, "code");
  assert.equal(codeMany.length, 3);
  assert.equal(new Set(codeMany).size, 3);
  assert.deepEqual(codeMany, DECODE_CODE_TASKS.slice(0, 3));
  const firstLines = codeMany.map((p) => p.split("\n")[0]);
  assert.equal(new Set(firstLines).size, 3);
  for (const p of codeMany) {
    assert.match(p, /No comments/);
    assert.doesNotMatch(p, /\(stream /);
  }
});

test("concurrent code tasks stay distinct through the catalog and past it", () => {
  assert.equal(DECODE_CODE_TASKS.length, 32);
  const heads = DECODE_CODE_TASKS.map((p) => p.split("\n")[0]);
  assert.equal(new Set(heads).size, heads.length);
  assert.equal(new Set(DECODE_CODE_TASKS).size, DECODE_CODE_TASKS.length);
  for (const p of DECODE_CODE_TASKS) {
    assert.match(p, /^[a-z0-9_]+\n/);
    assert.match(p, /No comments/);
  }
  assert.ok(DECODE_CODE_WARMUP_PROMPT.startsWith("warmup_noop\n"));
  assert.equal(DECODE_CODE_TASKS.includes(DECODE_CODE_WARMUP_PROMPT), false);

  const wave = pickDecodeBenchPrompts(32, "code");
  assert.deepEqual(wave, DECODE_CODE_TASKS);

  const wrapped = pickDecodeBenchPrompts(33, "code");
  assert.equal(wrapped[0], DECODE_CODE_TASKS[0]);
  assert.ok(wrapped[32].startsWith("[stream 33]\n"));
  assert.ok(wrapped[32].endsWith(DECODE_CODE_TASKS[0]));
  assert.notEqual(wrapped[32].split("\n")[0], wrapped[0].split("\n")[0]);
});

test("concurrent structural streams are unique until the catalog wraps", () => {
  const n = STRUCTURAL_PROMPTS.length;
  assert.equal(n, 18);
  const uniq = new Set(STRUCTURAL_PROMPTS);
  assert.equal(uniq.size, n, "catalog entries must be distinct");

  const at16 = pickShowcasePrompts("structural", 16);
  assert.equal(new Set(at16).size, 16);

  const at24 = pickShowcasePrompts("structural", 24);
  assert.equal(at24.length, 24);
  assert.equal(new Set(at24).size, n);
  assert.equal(at24[0], at24[n]);
});

test("import path from collectors resolves src/shared (Docker + Node)", async () => {
  const mod = await import("../DecodeBench.js");
  assert.equal(mod.DECODE_BENCH_DEFAULTS.defaultMaxTokens, 400);
});
