import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-age-"));
process.env.SETTINGS_JSON_PATH = path.join(root, "settings.json");

const { updateSettings, OCCUPANCY_AGE_DEFAULT_MS, OCCUPANCY_AGE_MAX_MS } = await import("../../settings.js");

test("session age is finite and out of range becomes 12 hours", () => {
  assert.equal(updateSettings({ occupancyMaxAgeMs: 0 }).occupancyMaxAgeMs, OCCUPANCY_AGE_DEFAULT_MS);
  assert.equal(updateSettings({ occupancyMaxAgeMs: 59_999 }).occupancyMaxAgeMs, OCCUPANCY_AGE_DEFAULT_MS);
  assert.equal(updateSettings({ occupancyMaxAgeMs: 60_000 }).occupancyMaxAgeMs, 60_000);
  assert.equal(updateSettings({ occupancyMaxAgeMs: OCCUPANCY_AGE_MAX_MS }).occupancyMaxAgeMs, OCCUPANCY_AGE_MAX_MS);
  assert.equal(updateSettings({ occupancyMaxAgeMs: OCCUPANCY_AGE_MAX_MS + 1 }).occupancyMaxAgeMs, OCCUPANCY_AGE_DEFAULT_MS);
  assert.equal(updateSettings({ occupancyMaxAgeMs: "forever" }).occupancyMaxAgeMs, OCCUPANCY_AGE_DEFAULT_MS);
});
