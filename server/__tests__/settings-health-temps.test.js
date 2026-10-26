import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-health-temps-"));
process.env.SETTINGS_JSON_PATH = path.join(root, "settings.json");

const { updateSettings, getSettings, loadSettings } = await import("../settings.js");

test("thermal thresholds default to 85 and 90", () => {
  const s = loadSettings();
  assert.equal(s.healthTempWarnC, 85);
  assert.equal(s.healthTempCriticalC, 90);
});

test("valid thresholds are saved, either one alone or both", () => {
  assert.equal(updateSettings({ healthTempWarnC: 80, healthTempCriticalC: 95 }).healthTempWarnC, 80);
  assert.equal(updateSettings({ healthTempWarnC: 82 }).healthTempWarnC, 82);
  assert.equal(updateSettings({ healthTempCriticalC: 96 }).healthTempCriticalC, 96);
  const saved = JSON.parse(fs.readFileSync(process.env.SETTINGS_JSON_PATH, "utf-8"));
  assert.equal(saved.healthTempWarnC, 82);
  assert.equal(saved.healthTempCriticalC, 96);
});

test("a save is rejected when warn is not below critical, and nothing changes", () => {
  updateSettings({ healthTempWarnC: 80, healthTempCriticalC: 90 });
  assert.throws(() => updateSettings({ healthTempWarnC: 90 }), /lower than/);
  assert.throws(() => updateSettings({ healthTempWarnC: 95, healthTempCriticalC: 90 }), /lower than/);
  assert.throws(() => updateSettings({ healthTempCriticalC: 80 }), /lower than/);
  assert.equal(getSettings().healthTempWarnC, 80);
  assert.equal(getSettings().healthTempCriticalC, 90);
});

test("a save is rejected for values that are not numbers in range", () => {
  for (const bad of ["hot", null, "", NaN, Infinity, true, 39, 111]) {
    assert.throws(() => updateSettings({ healthTempWarnC: bad }), /healthTempWarnC/, String(bad));
    assert.throws(() => updateSettings({ healthTempCriticalC: bad }), /healthTempCriticalC/, String(bad));
  }
  assert.equal(getSettings().healthTempWarnC, 80);
});

test("a patch that leaves the thresholds alone is never rejected", () => {
  assert.equal(updateSettings({ density: "comfortable" }).healthTempWarnC, 80);
});

test("an unusable settings.json falls back to 85/90 together", () => {
  fs.writeFileSync(process.env.SETTINGS_JSON_PATH, JSON.stringify({ healthTempWarnC: 95, healthTempCriticalC: 90 }));
  const s = loadSettings();
  assert.equal(s.healthTempWarnC, 85);
  assert.equal(s.healthTempCriticalC, 90);
});
