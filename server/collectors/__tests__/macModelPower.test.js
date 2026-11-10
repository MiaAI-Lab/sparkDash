import test from "node:test";
import assert from "node:assert/strict";
import { estimateSystemPowerW } from "../macModelPower.js";

test("adds Apple's published idle draw for a desktop chip it knows", () => {
  assert.deepEqual(
    estimateSystemPowerW({ model: "Mac17,14", chip: "Apple M5 Max", packageW: 0.2 }),
    { watts: 7.2, source: "apple-idle" }
  );
});

test("falls back to a desktop mid-range figure for an unpublished chip", () => {
  assert.deepEqual(
    estimateSystemPowerW({ model: "Mac99,1", chip: "Apple M7 Max", packageW: 40 }),
    { watts: 48, source: "desktop-idle" }
  );
  assert.deepEqual(
    estimateSystemPowerW({ model: "Mac99,1", packageW: 40 }),
    { watts: 48, source: "desktop-idle" }
  );
});

test("estimates nothing without a measured package figure to build on", () => {
  for (const packageW of [null, undefined, NaN, "8", -1]) {
    assert.equal(
      estimateSystemPowerW({ model: "Mac17,14", chip: "Apple M5 Max", packageW }),
      null,
      `packageW ${String(packageW)} must not produce a total`
    );
  }
});

test("leaves laptops and iMacs alone, where a static wall figure would be wrong", () => {
  for (const model of ["MacBookPro21,1", "MacBookAir10,1", "iMac21,1", "iMacPro1,1", null, ""]) {
    assert.equal(
      estimateSystemPowerW({ model, chip: "Apple M5 Max", packageW: 3 }),
      null,
      `model ${String(model)} must stay unestimated`
    );
  }
});
