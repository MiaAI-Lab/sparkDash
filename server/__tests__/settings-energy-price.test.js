import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-energy-price-"));
process.env.SETTINGS_JSON_PATH = path.join(root, "settings.json");

const { updateSettings, getSettings, loadSettings } = await import("../settings.js");

const PEAK = { from: 14, to: 19, price: 0.42, days: "weekdays" };
const NIGHT = { from: 22, to: 6, price: 0.11, days: "all" };

test("pricing defaults to flat with no periods and no price", () => {
  const s = loadSettings();
  assert.equal(s.energyPriceMode, "flat");
  assert.deepEqual(s.energyPricePeriods, []);
  assert.equal(s.energyPricePerKwh, null);
});

test("a time-of-use tariff is saved and read back as numbers", () => {
  const s = updateSettings({ energyPriceMode: "tou", energyPricePerKwh: 0.2, energyPricePeriods: [{ ...PEAK, from: "14", price: "0.42" }, NIGHT] });
  assert.equal(s.energyPriceMode, "tou");
  assert.deepEqual(s.energyPricePeriods, [PEAK, NIGHT]);
  const saved = JSON.parse(fs.readFileSync(process.env.SETTINGS_JSON_PATH, "utf-8"));
  assert.deepEqual(saved.energyPricePeriods, [PEAK, NIGHT]);
  assert.equal(saved.energyPriceMode, "tou");
});

test("overlapping or malformed periods are refused and nothing changes", () => {
  assert.throws(() => updateSettings({ energyPricePeriods: [NIGHT, { from: 5, to: 8, price: 0.3, days: "weekdays" }] }), /period 2 overlaps period 1/);
  for (const bad of [{ ...PEAK, from: 24 }, { ...PEAK, to: 0 }, { ...PEAK, to: 14 }, { ...PEAK, price: -1 }, { ...PEAK, price: 101 }, { ...PEAK, days: "sundays" }, { ...PEAK, from: 1.5 }]) {
    assert.throws(() => updateSettings({ energyPricePeriods: [bad] }), /period 1 needs/, JSON.stringify(bad));
  }
  assert.throws(() => updateSettings({ energyPricePeriods: "peak" }), /must be a list/);
  assert.throws(() => updateSettings({ energyPricePeriods: Array.from({ length: 13 }, (_, i) => ({ from: i, to: i + 1, price: 0.1, days: "all" })) }), /at most 12/);
  assert.deepEqual(getSettings().energyPricePeriods, [PEAK, NIGHT]);
});

test("weekday and weekend periods may share hours", () => {
  const weekend = { from: 14, to: 19, price: 0.25, days: "weekends" };
  assert.deepEqual(updateSettings({ energyPricePeriods: [PEAK, weekend] }).energyPricePeriods, [PEAK, weekend]);
});

test("an unknown mode reads as flat, and a hand-edited unusable list is dropped whole", () => {
  fs.writeFileSync(process.env.SETTINGS_JSON_PATH, JSON.stringify({ energyPriceMode: "peak", energyPricePeriods: [PEAK, { ...PEAK, days: "all" }] }));
  const s = loadSettings();
  assert.equal(s.energyPriceMode, "flat");
  assert.deepEqual(s.energyPricePeriods, []);
});