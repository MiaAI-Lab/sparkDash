import test from "node:test";
import assert from "node:assert/strict";
import { parseNvErrNoMemoryCount } from "../SystemCollector.js";

test("parseNvErrNoMemoryCount reads grep -c output", () => {
  assert.equal(parseNvErrNoMemoryCount("12"), 12);
  assert.equal(parseNvErrNoMemoryCount("0"), 0);
  assert.equal(parseNvErrNoMemoryCount(" 43\n"), 43);
});

test("parseNvErrNoMemoryCount defaults invalid input to 0", () => {
  assert.equal(parseNvErrNoMemoryCount(""), 0);
  assert.equal(parseNvErrNoMemoryCount("not-a-number"), 0);
  assert.equal(parseNvErrNoMemoryCount(undefined), 0);
  assert.equal(parseNvErrNoMemoryCount("-3"), 0);
});
