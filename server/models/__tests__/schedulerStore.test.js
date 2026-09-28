import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * schedulerStore — global scheduler switch + time zone persistence.
 *
 * The operator's zone is Europe/Prague; "UTC" is treated as "unset" and must
 * never become the effective schedule zone (that was the 2h drift bug: a
 * persisted `tz:"UTC"` made 18:00 windows fire at 20:00 local). These tests
 * pin the coercion on every read/load/update path.
 *
 * env is set BEFORE importing the module because config.js captures
 * SCHEDULER_JSON_PATH / MODEL_SCHEDULER_TZ at load time.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-sched-"));
const cfgPath = path.join(dir, "scheduler.json");
process.env.SCHEDULER_JSON_PATH = cfgPath;
process.env.MODEL_SCHEDULER_TZ = "Europe/Prague";

const { loadSchedulerConfig, getSchedulerConfig, updateSchedulerConfig } =
  await import("../schedulerStore.js");

function writeDisk(config) {
  fs.writeFileSync(cfgPath, JSON.stringify(config) + "\n");
}

test("un-loaded getSchedulerConfig resolves persisted UTC to the operator zone", () => {
  // Fresh import above: _loaded is still false here (no loadSchedulerConfig yet).
  writeDisk({ enabled: false, tz: "UTC" });
  const cfg = getSchedulerConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.tz, "Europe/Prague");
});

test("loadSchedulerConfig coerces persisted UTC to the operator zone and persists it", () => {
  writeDisk({ enabled: false, tz: "UTC" });
  const cfg = loadSchedulerConfig();
  assert.equal(cfg.tz, "Europe/Prague");
  // The on-disk value is rewritten to the operator zone, so a restart is
  // self-healing rather than re-reading the drift.
  const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  assert.equal(onDisk.tz, "Europe/Prague");
});

test("loadSchedulerConfig honours a real, different zone", () => {
  writeDisk({ enabled: true, tz: "Asia/Tokyo" });
  const cfg = loadSchedulerConfig();
  assert.equal(cfg.tz, "Asia/Tokyo");
  assert.equal(cfg.enabled, true);
});

test("updateSchedulerConfig coerces a UTC patch to the operator zone", () => {
  // Move to a real zone first, then ask for UTC — must not stick.
  updateSchedulerConfig({ tz: "Asia/Tokyo" });
  const cfg = updateSchedulerConfig({ tz: "UTC" });
  assert.equal(cfg.tz, "Europe/Prague");
});

test("updateSchedulerConfig keeps a real zone", () => {
  const cfg = updateSchedulerConfig({ tz: "America/New_York" });
  assert.equal(cfg.tz, "America/New_York");
});

test("updateSchedulerConfig rejects an unknown zone with a 400", () => {
  assert.throws(
    () => updateSchedulerConfig({ tz: "Not/AZone" }),
    (e) => e.status === 400 && /Unknown time zone/.test(e.message)
  );
});

test("toggling enabled never resets the operator zone to UTC", () => {
  updateSchedulerConfig({ tz: "Asia/Tokyo" });
  const cfg = updateSchedulerConfig({ enabled: false });
  assert.equal(cfg.enabled, false);
  // Toggling the switch must not smuggle UTC back in.
  assert.equal(cfg.tz, "Asia/Tokyo");
});
