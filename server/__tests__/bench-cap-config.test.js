import assert from "node:assert/strict";
import test from "node:test";
import { parseMaxActiveBenchJobs } from "../config.js";

test("MAX_ACTIVE_BENCH_JOBS defaults to 2 and is clamped to 1-32", () => {
  assert.equal(parseMaxActiveBenchJobs(undefined), 2);
  assert.equal(parseMaxActiveBenchJobs(""), 2);
  assert.equal(parseMaxActiveBenchJobs("abc"), 2);
  assert.equal(parseMaxActiveBenchJobs("4"), 4);
  assert.equal(parseMaxActiveBenchJobs("0"), 1);
  assert.equal(parseMaxActiveBenchJobs("-3"), 1);
  assert.equal(parseMaxActiveBenchJobs("500"), 32);
});
