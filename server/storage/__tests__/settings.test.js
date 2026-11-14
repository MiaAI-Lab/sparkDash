import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("allowPlainSudoPassword is off by default, can be turned on, and only ever holds a boolean", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-plain-"));
  process.env.SETTINGS_JSON_PATH = path.join(dir, "settings.json");
  try {
    const { getSettings, loadSettings, updateSettings } = await import(`../../settings.js?plain=${Date.now()}`);
    loadSettings();
    assert.equal(getSettings().allowPlainSudoPassword, false);
    assert.equal(updateSettings({ allowPlainSudoPassword: true }).allowPlainSudoPassword, true);
    assert.equal(getSettings().allowPlainSudoPassword, true);
    // Anything that is not an explicit "on" coerces to a boolean, and the choice survives a reload.
    assert.equal(updateSettings({ allowPlainSudoPassword: "" }).allowPlainSudoPassword, false);
    updateSettings({ allowPlainSudoPassword: true });
    await new Promise((r) => setTimeout(r, 50));
    const reread = JSON.parse(fs.readFileSync(process.env.SETTINGS_JSON_PATH, "utf8"));
    assert.equal(reread.allowPlainSudoPassword, true);
  } finally {
    delete process.env.SETTINGS_JSON_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a string that merely looks false does not switch the plain-http password setting on", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-plain2-"));
  process.env.SETTINGS_JSON_PATH = path.join(dir, "settings.json");
  try {
    const { getSettings, loadSettings, updateSettings } = await import(`../../settings.js?plain2=${Date.now()}`);
    loadSettings();
    for (const v of ["false", "0", 1, "yes", {}]) {
      assert.equal(updateSettings({ allowPlainSudoPassword: v }).allowPlainSudoPassword, false, JSON.stringify(v));
    }
    assert.equal(getSettings().allowPlainSudoPassword, false);
    assert.equal(updateSettings({ allowPlainSudoPassword: true }).allowPlainSudoPassword, true);
  } finally {
    delete process.env.SETTINGS_JSON_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
