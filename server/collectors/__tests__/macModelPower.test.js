import test from "node:test";
import assert from "node:assert/strict";
import { estimateSystemPowerW } from "../macModelPower.js";

test("adds Apple's published idle draw for a desktop chip it knows", () => {
  assert.deepEqual(
    estimateSystemPowerW({ model: "Mac17,14", chip: "Apple M5 Max", packageW: 0.024 }),
    { watts: 7, source: "apple-idle" },
    "an idle package leaves the published wall figure untouched"
  );
});

test("a loaded package adds what it draws above the SoC's own idle share", () => {
  assert.deepEqual(
    estimateSystemPowerW({ model: "Mac17,14", chip: "Apple M5 Max", packageW: 40 }),
    { watts: 44.5, source: "apple-idle" },
    "2.5 W of the package is already inside Apple's 7 W, so 37.5 W is what stacks"
  );
});

test("every desktop chassis gets its published figure", () => {
  const desktops = [
    ["Macmini9,1", "Apple M1", 6.8],
    ["Mac14,3", "Apple M2", 7],
    ["Mac14,12", "Apple M2 Pro", 7],
    ["Mac16,10", "Apple M4", 4],
    ["Mac16,11", "Apple M4 Pro", 5],
    ["Mac17,16", "Apple M5 Pro", 6],
    ["Mac18,5", "Apple M6", 4],
    ["Mac13,1", "Apple M1 Max", 11],
    ["Mac13,2", "Apple M1 Ultra", 13],
    ["Mac14,13", "Apple M2 Max", 9],
    ["Mac14,14", "Apple M2 Ultra", 10],
    ["Mac15,14", "Apple M3 Ultra", 9],
    ["Mac16,9", "Apple M4 Max", 6],
    ["Mac17,14", "Apple M5 Max", 7],
    ["Mac17,15", "Apple M5 Ultra", 9],
    ["Mac14,8", "Apple M2 Ultra", 10],
  ];
  for (const [model, chip, idleW] of desktops) {
    assert.deepEqual(
      estimateSystemPowerW({ model, chip, packageW: 0 }),
      { watts: idleW, source: "apple-idle" },
      `${model} (${chip}) must carry its published idle figure`
    );
  }
});

test("falls back to a desktop mid-range figure for an unpublished chip", () => {
  assert.deepEqual(
    estimateSystemPowerW({ model: "Mac17,14", chip: "Apple M7 Max", packageW: 40 }),
    { watts: 45.5, source: "desktop-idle" }
  );
  assert.deepEqual(
    estimateSystemPowerW({ model: "Mac17,14", packageW: 40 }),
    { watts: 45.5, source: "desktop-idle" },
    "a desktop whose chip string is missing still gets the desktop floor"
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

test("a laptop stays unestimated even though it shares the desktop's model prefix", () => {
  // Mac14,3 is a Mac mini and Mac14,9 a MacBook Pro; Apple reuses the prefix across
  // chassis, so the identifier list is the only safe discriminator.
  for (const model of [
    "Mac14,9", "Mac14,2", "Mac15,12", "Mac16,6", "MacBookPro21,1", "MacBookAir10,1",
  ]) {
    assert.equal(
      estimateSystemPowerW({ model, chip: "Apple M5 Max", packageW: 3 }),
      null,
      `laptop ${model} must stay unestimated`
    );
  }
});

test("an iMac stays unestimated, its display is inside the wall figure", () => {
  for (const model of ["iMac21,1", "iMacPro1,1"]) {
    assert.equal(
      estimateSystemPowerW({ model, chip: "Apple M5 Max", packageW: 3 }),
      null,
      `iMac ${model} must stay unestimated`
    );
  }
});

test("a desktop Apple has not listed yet waits for its identifier", () => {
  // Mac99,1 stands for a machine nobody has named here. Guessing a floor would
  // repeat the laptop bug this list exists to avoid, so it keeps the rails alone.
  assert.equal(estimateSystemPowerW({ model: "Mac99,1", chip: "Apple M6", packageW: 10 }), null);
});

test("no model identifier at all estimates nothing", () => {
  for (const model of [null, undefined, "", 17, {}]) {
    assert.equal(
      estimateSystemPowerW({ model, chip: "Apple M5 Max", packageW: 3 }),
      null,
      `model ${String(model)} must not produce a total`
    );
  }
});
