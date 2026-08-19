/**
 * Unit tests for showcase fill-to-max helpers and request shaping.
 * Run: npm test
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import {
  withFillToMaxInstruction,
  stripFillForceFields,
} from "../ShowcaseManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const managerSrc = readFileSync(
  path.join(__dirname, "../ShowcaseManager.js"),
  "utf8"
);
const promptsSrc = readFileSync(
  path.join(__dirname, "../../../src/shared/llmPrompts.js"),
  "utf8"
);
const showcaseUiSrc = readFileSync(
  path.join(
    __dirname,
    "../../../src/components/ShowcasePage/showcasePrompts.ts"
  ),
  "utf8"
);
const benchSrc = readFileSync(
  path.join(__dirname, "../DecodeBench.js"),
  "utf8"
);

test("withFillToMaxInstruction appends hard length rule to soft prompts", () => {
  const out = withFillToMaxInstruction("Keep expanding with more examples.");
  assert.match(out, /maximum output length/);
  assert.match(out, /do not stop early/);
  assert.ok(out.startsWith("Keep expanding"));
});

test("withFillToMaxInstruction does not double-append when already stated", () => {
  const base =
    "Write forever until you hit the maximum output length; do not stop early.";
  const out = withFillToMaxInstruction(base);
  assert.equal(out, base);
});

test("withFillToMaxInstruction trims and rejects empty", () => {
  assert.equal(withFillToMaxInstruction("   "), "");
  assert.equal(withFillToMaxInstruction(""), "");
});

test("stripFillForceFields removes vLLM-only sampling knobs", () => {
  const stripped = stripFillForceFields({
    model: "m",
    max_tokens: 512,
    min_tokens: 512,
    ignore_eos: true,
    stop: [],
    temperature: 0.7,
  });
  assert.equal(stripped.max_tokens, 512);
  assert.equal(stripped.temperature, 0.7);
  assert.equal(stripped.min_tokens, undefined);
  assert.equal(stripped.ignore_eos, undefined);
  assert.equal(stripped.stop, undefined);
});

test("ShowcaseManager request body forces full-length generation", () => {
  assert.match(managerSrc, /ignore_eos:\s*true/);
  assert.match(managerSrc, /min_tokens:\s*session\.maxTokens/);
  assert.match(managerSrc, /stop:\s*\[\s*\]/);
  assert.match(managerSrc, /withFillToMaxInstruction/);
  assert.match(managerSrc, /stripFillForceFields/);
  assert.match(managerSrc, /PER_REQUEST_TIMEOUT_MS = 360_000/);
});

test("ShowcaseManager persists promptType on sessions", () => {
  assert.match(managerSrc, /promptType:\s*session\.promptType/);
  assert.match(managerSrc, /promptType:\s*record\.promptType/);
});

test("catalog prompts exist for text, structural, and mixed pickers", () => {
  assert.match(promptsSrc, /export const TEXT_PROMPTS/);
  assert.match(promptsSrc, /export const STRUCTURAL_PROMPTS/);
  assert.match(promptsSrc, /export function pickShowcasePrompts/);
  assert.match(showcaseUiSrc, /from \"\.\.\/\.\.\/shared\/llmPrompts\.js\"/);
  const textCount = (promptsSrc.match(/TEXT_PROMPTS/g) || []).length;
  assert.ok(textCount >= 2);
});

test("DecodeBench uses Showcase structural prompts at temperature 0, thinking off", () => {
  assert.match(benchSrc, /pickShowcasePrompts\("structural"/);
  assert.match(benchSrc, /withFillToMaxInstruction/);
  assert.match(benchSrc, /temperature:\s*0/);
  assert.match(benchSrc, /applyThinkingFlags\(body,\s*modelId,\s*false\)/);
  assert.match(benchSrc, /min_tokens:\s*maxTokens/);
  assert.doesNotMatch(benchSrc, /uniquePrefillPrefix/);
  assert.doesNotMatch(benchSrc, /BENCH_PROMPTS/);
});
