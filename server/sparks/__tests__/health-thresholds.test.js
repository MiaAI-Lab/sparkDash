import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Settings are read from SETTINGS_JSON_PATH at import time; keep them out of config/.
process.env.SETTINGS_JSON_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-monitor-temps-")), "settings.json");

const { SparkMonitor } = await import("../SparkMonitor.js");
const { updateSettings, loadSettings } = await import("../../settings.js");

const gpu = (temperature) => ({
  temperature,
  usage: 10,
  power: { draw: 18.5, limit: 120, systemDraw: 39 },
  vram: { used: 100, total: 128_000, percentage: 0, available: 120_000 },
  processes: [],
  throttle: {},
});

function monitorWithEvents() {
  const monitor = new SparkMonitor({ id: "spark-test", name: "Spark Test", lanIp: "127.0.0.1", isLocal: true, llmMonitoring: false, comfyMonitoring: false });
  const events = [];
  monitor._onEvent = (e) => events.push(e);
  monitor._healthNow = () => 1_000_000;
  const reading = (temperature) => {
    monitor._metrics.gpu = gpu(temperature);
    monitor._updateHealth("gpu");
  };
  return { events, reading };
}

test("activity events and the finding follow the configured temperature limits", () => {
  loadSettings();
  updateSettings({ healthTempWarnC: 78, healthTempCriticalC: 88 });
  const { events, reading } = monitorWithEvents();
  reading(60); // baseline: no event for the first evaluation
  reading(80); // below the old 85 °C limit, above the configured 78 °C
  const hot = events.filter((e) => e.type === "health.thermal");
  assert.equal(hot.length, 1);
  assert.equal(hot[0].severity, "warn");
  assert.match(hot[0].message, /80°C \(warns at 78°C, critical at 88°C\)/);
});

test("a limit changed in Settings applies to the next sample of a running monitor", () => {
  loadSettings();
  updateSettings({ healthTempWarnC: 85, healthTempCriticalC: 90 });
  const { events, reading } = monitorWithEvents();
  reading(60);
  reading(80);
  assert.equal(events.filter((e) => e.type === "health.thermal").length, 0);
  updateSettings({ healthTempWarnC: 75 });
  reading(80);
  const hot = events.filter((e) => e.type === "health.thermal");
  assert.equal(hot.length, 1);
  assert.match(hot[0].message, /warns at 75°C, critical at 90°C/);
});
