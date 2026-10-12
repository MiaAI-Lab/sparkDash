/**
 * Settings defaults the UI mirrors as its pre-load fallback (App.tsx). A
 * mismatch shows one thing until /api/settings answers and another after.
 */
import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-settings-"));
process.env.SETTINGS_JSON_PATH = path.join(dir, "settings.json");
const { loadSettings, updateSettings } = await import("../../settings.js");

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("showVramBreakdown defaults on, and the fresh file records it", () => {
  const s = loadSettings();
  assert.equal(s.showVramBreakdown, true);
  const onDisk = JSON.parse(fs.readFileSync(process.env.SETTINGS_JSON_PATH, "utf-8"));
  assert.equal(onDisk.showVramBreakdown, true);
});

test("an older settings.json without the key gets the default", () => {
  fs.writeFileSync(process.env.SETTINGS_JSON_PATH, JSON.stringify({ density: "compact" }));
  assert.equal(loadSettings().showVramBreakdown, true);
});

test("showVramBreakdown turns off and is stored as a boolean", () => {
  assert.equal(updateSettings({ showVramBreakdown: false }).showVramBreakdown, false);
  assert.equal(updateSettings({ showVramBreakdown: 1 }).showVramBreakdown, true);
  assert.equal(loadSettings().showVramBreakdown, true);
});

test("prometheusExport is opt-in and stored as a boolean", () => {
  fs.writeFileSync(process.env.SETTINGS_JSON_PATH, JSON.stringify({ density: "compact" }));
  assert.equal(loadSettings().prometheusExport, false);
  assert.equal(updateSettings({ prometheusExport: "yes" }).prometheusExport, true);
  assert.equal(loadSettings().prometheusExport, true);
  assert.equal(updateSettings({ prometheusExport: 0 }).prometheusExport, false);
});

test("vulnhuntEnabled is opt-in and stored as a boolean", () => {
  fs.writeFileSync(process.env.SETTINGS_JSON_PATH, JSON.stringify({ density: "compact" }));
  assert.equal(loadSettings().vulnhuntEnabled, false);
  assert.equal(updateSettings({ vulnhuntEnabled: "yes" }).vulnhuntEnabled, true);
  assert.equal(loadSettings().vulnhuntEnabled, true);
  assert.equal(updateSettings({ vulnhuntEnabled: 0 }).vulnhuntEnabled, false);
});

test("reaEnabled is opt-in and stored as a boolean", () => {
  fs.writeFileSync(process.env.SETTINGS_JSON_PATH, JSON.stringify({ density: "compact" }));
  assert.equal(loadSettings().reaEnabled, false);
  assert.equal(updateSettings({ reaEnabled: "yes" }).reaEnabled, true);
  assert.equal(updateSettings({ reaEnabled: 0 }).reaEnabled, false);
});

test("metricsHistory is opt-in and stored as a boolean", () => {
  fs.writeFileSync(process.env.SETTINGS_JSON_PATH, JSON.stringify({ density: "compact" }));
  assert.equal(loadSettings().metricsHistory, false);
  assert.equal(updateSettings({ metricsHistory: 1 }).metricsHistory, true);
  assert.equal(loadSettings().metricsHistory, true);
  assert.equal(updateSettings({ metricsHistory: "" }).metricsHistory, false);
});

test("timeZone follows the browser by default, accepts IANA names and drops anything else", () => {
  fs.writeFileSync(process.env.SETTINGS_JSON_PATH, JSON.stringify({ density: "compact" }));
  assert.equal(loadSettings().timeZone, "");
  assert.equal(updateSettings({ timeZone: "Europe/Paris" }).timeZone, "Europe/Paris");
  assert.equal(updateSettings({ timeZone: " Asia/Kolkata " }).timeZone, "Asia/Kolkata");
  assert.equal(updateSettings({ timeZone: "Not/AZone" }).timeZone, "");
  assert.equal(updateSettings({ timeZone: 5 }).timeZone, "");
  assert.equal(updateSettings({ timeZone: "x".repeat(80) }).timeZone, "");
  assert.equal(updateSettings({ timeZone: "" }).timeZone, "");
});

test("every Overview panel is shown by default (an older file gets that too) and each can be switched off", () => {
  const keys = ["showFleetEnergy", "showLlmTokenTotals", "showActivityFeed", "showKpiDecode", "showKpiPower", "showKpiMemory", "showKpiTokens"];
  fs.writeFileSync(process.env.SETTINGS_JSON_PATH, JSON.stringify({ density: "compact" }));
  const fresh = loadSettings();
  for (const k of keys) assert.equal(fresh[k], true, k);
  for (const k of keys) {
    assert.equal(updateSettings({ [k]: false })[k], false, k);
    assert.equal(updateSettings({ [k]: true })[k], true, k);
  }
});
