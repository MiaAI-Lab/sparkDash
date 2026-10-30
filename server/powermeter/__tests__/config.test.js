import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPowerMeterConfig, validatePowerMeterConfig } from "../config.js";

const valid = () => ({
  meters: { ha: { type: "homeassistant", url: "https://ha.lan:8123", tokenEnv: "HA_TOKEN" } },
  units: {
    "spark-a": { meter: "ha", channel: "sensor.strip_power_3", since: "2026-08-13T00:00:00Z" },
    "spark-b": { meter: "ha", channel: "sensor.strip_power_4" },
  },
});

function withFile(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "power-meters-"));
  const file = path.join(dir, "power-meters.json");
  if (contents !== undefined) fs.writeFileSync(file, contents);
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("no file means the feature is absent, not an error", () => {
  withFile(undefined, (file) => assert.deepEqual(loadPowerMeterConfig({ filePath: file }), { status: "absent" }));
});

test("enabled: false turns a present file off without validating it", () => {
  withFile(JSON.stringify({ enabled: false }), (file) => {
    assert.equal(loadPowerMeterConfig({ filePath: file }).status, "disabled");
  });
});

test("malformed JSON is reported as invalid", () => {
  withFile("{ nope", (file) => {
    const result = loadPowerMeterConfig({ filePath: file });
    assert.equal(result.status, "invalid");
    assert.match(result.error, /not valid JSON/);
  });
});

test("a valid file yields defaults, parsed since and trimmed channels", () => {
  withFile(JSON.stringify(valid()), (file) => {
    const result = loadPowerMeterConfig({ filePath: file });
    assert.equal(result.status, "ok");
    assert.equal(result.config.pollIntervalMs, 10_000);
    assert.equal(result.config.staleAfterMs, 30_000);
    assert.deepEqual(result.config.history, { enabled: true, backfillDays: 400 });
    assert.equal(result.config.units["spark-a"].sinceMs, Date.parse("2026-08-13T00:00:00Z"));
    assert.equal(result.config.units["spark-b"].sinceMs, null);
  });
});

test("credentials never belong in the file", () => {
  const raw = valid();
  raw.meters.ha.token = "secret";
  const { error } = validatePowerMeterConfig(raw);
  assert.match(error, /token must not be stored in the file/);
  raw.meters.ha = { type: "homeassistant", url: "https://user:pw@ha.lan" };
  assert.match(validatePowerMeterConfig(raw).error, /must not embed credentials/);
});

test("problems are collected across meters, units and options", () => {
  const raw = valid();
  raw.meters.other = { type: "pdu-of-the-future" };
  raw.units["spark-a"].channel = "Not An Entity";
  raw.units["spark-c"] = { meter: "missing", channel: "sensor.x" };
  raw.units["spark-b"].since = "yesterday-ish";
  raw.pollIntervalMs = 50;
  const { error } = validatePowerMeterConfig(raw);
  assert.match(error, /meters\.other\.type must be one of: homeassistant/);
  assert.match(error, /units\.spark-a\.channel: must be a Home Assistant entity id/);
  assert.match(error, /units\.spark-c\.meter must name a configured meter/);
  assert.match(error, /units\.spark-b\.since must be an ISO 8601 timestamp/);
  assert.match(error, /pollIntervalMs must be an integer from 5000/);
});

test("history can be turned off and the backfill depth bounded", () => {
  const raw = { ...valid(), history: { enabled: false, backfillDays: 30 }, pollIntervalMs: 5000 };
  const { config } = validatePowerMeterConfig(raw);
  assert.deepEqual(config.history, { enabled: false, backfillDays: 30 });
  assert.equal(config.staleAfterMs, 30_000);
  assert.match(validatePowerMeterConfig({ ...valid(), history: { backfillDays: -1 } }).error, /backfillDays/);
});
