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

test("metricsHistory is opt-in and stored as a boolean", () => {
  fs.writeFileSync(process.env.SETTINGS_JSON_PATH, JSON.stringify({ density: "compact" }));
  assert.equal(loadSettings().metricsHistory, false);
  assert.equal(updateSettings({ metricsHistory: 1 }).metricsHistory, true);
  assert.equal(loadSettings().metricsHistory, true);
  assert.equal(updateSettings({ metricsHistory: "" }).metricsHistory, false);
});

test("alertsEnabled is opt-in and stored as a boolean", () => {
  fs.writeFileSync(process.env.SETTINGS_JSON_PATH, JSON.stringify({ density: "compact" }));
  assert.equal(loadSettings().alertsEnabled, false);
  assert.equal(updateSettings({ alertsEnabled: "yes" }).alertsEnabled, true);
  assert.equal(loadSettings().alertsEnabled, true);
  assert.equal(updateSettings({ alertsEnabled: 0 }).alertsEnabled, false);
});

test("mqtt publishing is opt-in with a validated broker URL and topic prefix", () => {
  fs.writeFileSync(process.env.SETTINGS_JSON_PATH, JSON.stringify({ density: "compact" }));
  assert.equal(loadSettings().mqttEnabled, false);
  assert.equal(loadSettings().mqttUrl, "");
  assert.equal(updateSettings({ mqttEnabled: "yes" }).mqttEnabled, true);
  assert.equal(updateSettings({ mqttUrl: "  mqtt://broker.local:1883 " }).mqttUrl, "mqtt://broker.local:1883");
  assert.equal(updateSettings({ mqttUrl: "mqtts://broker.local:8883" }).mqttUrl, "mqtts://broker.local:8883");
  assert.equal(updateSettings({ mqttUrl: "wss://broker.local:9001" }).mqttUrl, "wss://broker.local:9001");
  assert.equal(updateSettings({ mqttUrl: "http://broker.local" }).mqttUrl, "");
  assert.equal(updateSettings({ mqttUrl: "broker.local" }).mqttUrl, "");
  assert.equal(updateSettings({ mqttUrl: 7 }).mqttUrl, "");
  assert.equal(updateSettings({ mqttUrl: `mqtt://${"x".repeat(300)}` }).mqttUrl, "");
  assert.equal(updateSettings({ mqttTopicPrefix: "home/fleet" }).mqttTopicPrefix, "home/fleet");
  assert.equal(updateSettings({ mqttTopicPrefix: " bad#topic " }).mqttTopicPrefix, "sparkdash");
  assert.equal(updateSettings({ mqttTopicPrefix: "/leading" }).mqttTopicPrefix, "sparkdash");
  // Trailing slashes are stripped, not rejected (they are normal while typing).
  assert.equal(updateSettings({ mqttTopicPrefix: "trailing/" }).mqttTopicPrefix, "trailing");
  assert.equal(updateSettings({ mqttTopicPrefix: "+" }).mqttTopicPrefix, "sparkdash");
  assert.equal(updateSettings({ mqttTopicPrefix: "" }).mqttTopicPrefix, "sparkdash");
  assert.equal(loadSettings().mqttDiscovery, false);
  assert.equal(loadSettings().mqttDiscoveryPrefix, "homeassistant");
  assert.equal(updateSettings({ mqttDiscovery: "yes" }).mqttDiscovery, true);
  assert.equal(updateSettings({ mqttDiscoveryPrefix: " ha/ " }).mqttDiscoveryPrefix, "ha");
  assert.equal(updateSettings({ mqttDiscoveryPrefix: "bad#prefix" }).mqttDiscoveryPrefix, "homeassistant");
  assert.equal(updateSettings({ mqttUsername: "  mia " }).mqttUsername, "mia");
});

test("a broker URL with embedded credentials is refused and never written to disk", () => {
  fs.writeFileSync(process.env.SETTINGS_JSON_PATH, JSON.stringify({ density: "compact" }));
  loadSettings();
  for (const url of [
    "mqtt://mia:hunter2@broker.local:1883",
    "mqtts://:hunter2@broker.local",
    "ws://mia@broker.local:9001",
    " MQTT://mia:hunter2@broker.local ",
    "mqtt://mia:hunter2@",
  ]) {
    assert.equal(updateSettings({ mqttUrl: url }).mqttUrl, "", url);
  }
  assert.ok(!fs.readFileSync(process.env.SETTINGS_JSON_PATH, "utf-8").includes("hunter2"));
  // An "@" in the path is not a credential.
  assert.equal(updateSettings({ mqttUrl: "wss://broker.local/mqtt@v5" }).mqttUrl, "wss://broker.local/mqtt@v5");
  assert.equal(updateSettings({ mqttUrl: "mqtt://" }).mqttUrl, "");
});

test("a credentialed broker URL already in settings.json is scrubbed on load", () => {
  fs.writeFileSync(
    process.env.SETTINGS_JSON_PATH,
    JSON.stringify({ mqttEnabled: true, mqttUrl: "mqtt://mia:hunter2@broker.local:1883" })
  );
  const s = loadSettings();
  assert.equal(s.mqttUrl, "");
  assert.equal(s.mqttEnabled, true);
  const onDisk = fs.readFileSync(process.env.SETTINGS_JSON_PATH, "utf-8");
  assert.ok(!onDisk.includes("hunter2"));
  assert.equal(JSON.parse(onDisk).mqttUrl, "");
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

test("intelVramSudo is opt-in and stored as a boolean", () => {
  fs.writeFileSync(process.env.SETTINGS_JSON_PATH, JSON.stringify({ density: "compact" }));
  assert.equal(loadSettings().intelVramSudo, false);
  assert.equal(updateSettings({ intelVramSudo: "yes" }).intelVramSudo, true);
  assert.equal(updateSettings({ intelVramSudo: 0 }).intelVramSudo, false);
});
