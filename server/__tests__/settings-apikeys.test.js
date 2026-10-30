import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-apikeys-settings-"));
process.env.SETTINGS_JSON_PATH = path.join(root, "settings.json");

const { updateSettings, loadSettings } = await import("../settings.js");

test("apiKeysEnabled defaults to off", () => {
  assert.equal(loadSettings().apiKeysEnabled, false);
});

test("apiKeysEnabled is saved as a boolean and no bridge credential is persisted", () => {
  assert.equal(updateSettings({ apiKeysEnabled: "yes" }).apiKeysEnabled, true);
  const saved = fs.readFileSync(process.env.SETTINGS_JSON_PATH, "utf-8");
  assert.equal(JSON.parse(saved).apiKeysEnabled, true);
  assert.deepEqual(Object.keys(JSON.parse(saved)).filter((k) => /^apiKeys/i.test(k)), ["apiKeysEnabled"]);
  assert.equal(/apikeys.?bridge/i.test(saved), false);
  assert.equal(updateSettings({ apiKeysEnabled: false }).apiKeysEnabled, false);
});
