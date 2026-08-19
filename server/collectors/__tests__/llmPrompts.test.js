/**
 * Shared prompt catalog used by Showcase and Decode bench.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  STRUCTURAL_PROMPTS,
  pickShowcasePrompts,
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

test("bench-style prompts apply fill-to-max like Showcase", () => {
  const prompts = pickShowcasePrompts("structural", 2).map(withFillToMaxInstruction);
  for (const p of prompts) {
    assert.match(p, /maximum output length/);
  }
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
  assert.equal(mod.DECODE_BENCH_DEFAULTS.defaultMaxTokens, 512);
});
