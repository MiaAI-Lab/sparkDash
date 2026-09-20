import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  addTokens,
  addTokensTo,
  formatTokensCompact,
  MAX_SAFE_TOKENS,
} from "../../../src/shared/tokenFormat.js";

test("formatTokensCompact: compact suffixes with 3 significant digits", () => {
  assert.equal(formatTokensCompact(0), "0");
  assert.equal(formatTokensCompact(500), "500");
  // Sub-10k uses locale grouping (separator varies with ICU availability).
  assert.equal(formatTokensCompact(9812).replace(/[.,\s\u00A0]/g, ""), "9812");
  assert.ok(!/[kMBT]$/.test(formatTokensCompact(9812)));
  assert.equal(formatTokensCompact(10000), "10k");
  assert.equal(formatTokensCompact(12345), "12.3k");
  assert.equal(formatTokensCompact(123456), "123k");
  assert.equal(formatTokensCompact(999499), "999k");
  assert.equal(formatTokensCompact(999999), "1M"); // rounds up to the bigger suffix
  assert.equal(formatTokensCompact(1234567), "1.23M");
  assert.equal(formatTokensCompact(12345678), "12.3M");
  assert.equal(formatTokensCompact(1050000000), "1.05B");
  assert.equal(formatTokensCompact(2400000000000), "2.4T");
});

test("formatTokensCompact: saturated counters show a ceiling marker", () => {
  assert.equal(formatTokensCompact(MAX_SAFE_TOKENS), "9.0e15+");
  assert.equal(formatTokensCompact(Number.MAX_VALUE), "9.0e15+");
});

test("addTokens: saturates at MAX_SAFE_INTEGER instead of losing precision", () => {
  assert.equal(addTokens(5, 10), 15);
  assert.equal(addTokens(MAX_SAFE_TOKENS, 1000), MAX_SAFE_TOKENS);
  assert.equal(addTokens(MAX_SAFE_TOKENS - 1, 1), MAX_SAFE_TOKENS);
  const obj = { completionTokens: MAX_SAFE_TOKENS };
  addTokensTo(obj, "completionTokens", 5000);
  assert.equal(obj.completionTokens, MAX_SAFE_TOKENS);
  addTokensTo(obj, "promptTokens", 7);
  assert.equal(obj.promptTokens, 7);
});
