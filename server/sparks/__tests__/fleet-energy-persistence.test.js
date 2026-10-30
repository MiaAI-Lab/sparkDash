// How the fleet-energy file is written: sparse buckets for optional series, and a small
// "recent" file between hourly full writes. fleet-energy.test.js guards the estimate's own
// persistence through flush()/close(), which still write the full file.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FleetEnergyTracker } from "../../energy/FleetEnergyTracker.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.parse("2026-10-20T12:00:00Z");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "energy-persist-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "fleet-energy.json");
  const recentPath = path.join(dir, "fleet-energy.recent.json");
  let clock = T0;
  let tick = null;
  const make = () => {
    const tracker = new FleetEnergyTracker({
      nodeIds: ["a", "b"],
      filePath,
      now: () => clock,
      setIntervalFn: (fn) => {
        tick = fn;
        return 1;
      },
      clearIntervalFn: () => {},
    });
    tracker.configureWall({ nodeIds: ["a", "b"], settledBefore: () => -Infinity });
    return tracker;
  };
  return {
    filePath,
    recentPath,
    make,
    setNow: (ms) => (clock = ms),
    at: () => clock,
    tick: () => tick(),
    read: (p) => JSON.parse(fs.readFileSync(p, "utf8")),
  };
}

const snap = (id, wallWatts) => ({
  id,
  online: true,
  telemetryFresh: true,
  role: "worker",
  metrics: { gpu: { power: { draw: 50 } }, cpu: { usage: 10 } },
  wallWatts,
});

function feed(env, tracker, from, to) {
  for (let at = from; at <= to; at += 2000) {
    env.setNow(at);
    tracker.record([snap("a", 120), snap("b", 100)], at);
  }
}

test("a bucket with only optional series is written without the estimate's zeros, rounded", (t) => {
  const env = setup(t);
  const tracker = env.make();
  tracker.applyWallPeriods("a", [{ startMs: T0 - 5 * MINUTE, endMs: T0, meanW: 57.123456789 }]);
  tracker.flush();
  const saved = env.read(env.filePath);
  assert.deepEqual(saved.buckets[0], { minuteStartMs: T0 - 5 * MINUTE, wall: { a: [0.952058, 60000, 60000] } });
  // It loads back as an ordinary bucket.
  const reloaded = env.make();
  const [row] = reloaded.history(T0).hourly;
  assert.equal(row.nodeWallWh.a, 4.76);
  assert.equal(row.nodeWh.a, 0);
});

test("buckets with estimate data keep every upstream field", (t) => {
  const env = setup(t);
  const tracker = env.make();
  feed(env, tracker, T0, T0 + 10_000);
  tracker.flush();
  const bucket = env.read(env.filePath).buckets[0];
  for (const key of ["minuteStartMs", "nodeWh", "nodeCoverageMs", "fleetWattMs", "fleetCoverageMs", "outputTokens", "coveredOutputTokens"]) {
    assert.ok(key in bucket, key);
  }
  assert.ok(bucket.parts && bucket.wall);
});

test("between full writes the timer writes only changed minutes to the recent file", (t) => {
  const env = setup(t);
  const tracker = env.make();
  feed(env, tracker, T0, T0 + 3 * MINUTE);
  env.tick(); // first write is always full
  assert.equal(fs.existsSync(env.recentPath), false);
  const base = fs.readFileSync(env.filePath, "utf8");

  feed(env, tracker, T0 + 3 * MINUTE + 2000, T0 + 5 * MINUTE);
  env.tick();
  assert.equal(fs.readFileSync(env.filePath, "utf8"), base, "the full file is left alone");
  const recent = env.read(env.recentPath);
  assert.equal(recent.baseSavedAt, env.read(env.filePath).savedAt);
  // The sample at 5:00 closes minute 4; only the minutes those samples touched are written.
  assert.deepEqual(recent.buckets.map((b) => b.minuteStartMs), [T0 + 3 * MINUTE, T0 + 4 * MINUTE]);

  // Nothing new: nothing written.
  assert.equal(tracker.flushRecent(), false);

  // A restart from base + recent sees everything.
  const reloaded = env.make();
  assert.deepEqual(reloaded.history(env.at()).hourly, tracker.history(env.at()).hourly);
  assert.deepEqual(reloaded.snapshot(env.at()).wall.nodeCoverage24hMs, tracker.snapshot(env.at()).wall.nodeCoverage24hMs);
});

test("the full file is rewritten hourly, after a large change, and on flush/close; the recent file then goes", (t) => {
  const env = setup(t);
  const tracker = env.make();
  feed(env, tracker, T0, T0 + MINUTE);
  env.tick();
  feed(env, tracker, T0 + MINUTE + 2000, T0 + 2 * MINUTE);
  env.tick();
  assert.equal(fs.existsSync(env.recentPath), true);

  // An hour after the last full write the timer writes the full file again.
  const later = T0 + HOUR + 2 * MINUTE;
  feed(env, tracker, later, later + 4000);
  env.tick();
  assert.equal(fs.existsSync(env.recentPath), false);

  // A backfill's worth of changes goes straight to a full write.
  feed(env, tracker, later + 6000, later + 8000);
  env.tick();
  assert.equal(fs.existsSync(env.recentPath), true);
  const p = Array.from({ length: 40 }, (_, i) => ({ startMs: T0 - (i + 1) * HOUR, endMs: T0 - i * HOUR, meanW: 50 }));
  tracker.applyWallPeriods("a", p);
  env.tick();
  assert.equal(fs.existsSync(env.recentPath), false);

  // close() leaves a single file even when only the recent file was behind.
  feed(env, tracker, later + 10_000, later + 12_000);
  env.tick();
  assert.equal(fs.existsSync(env.recentPath), true);
  assert.equal(tracker.close(), true);
  assert.equal(fs.existsSync(env.recentPath), false);
});

test("re-applying the meter's same figures changes nothing to write", (t) => {
  const env = setup(t);
  const tracker = env.make();
  const periods = [{ startMs: T0 - 5 * MINUTE, endMs: T0, meanW: 50 }];
  tracker.applyWallPeriods("a", periods);
  tracker.flush();
  tracker.applyWallPeriods("a", periods);
  tracker.setWallState("a", { key: "k", marks: {}, backfill: null });
  env.tick();
  assert.deepEqual(env.read(env.recentPath).buckets, [], "only the bookkeeping changed");
});

test("a recent file that belongs to an older full write is ignored", (t) => {
  const env = setup(t);
  const tracker = env.make();
  feed(env, tracker, T0, T0 + MINUTE);
  tracker.flush();
  fs.writeFileSync(
    env.recentPath,
    JSON.stringify({ version: 1, baseSavedAt: 1, savedAt: 2, buckets: [{ minuteStartMs: T0 + 30 * MINUTE, wall: { a: [100, 60000, 60000] } }] })
  );
  const reloaded = env.make();
  assert.equal(reloaded.history(T0 + HOUR).hourly.some((r) => (r.nodeWallWh?.a ?? 0) >= 100), false);
});

test("the meter's figures fetched again after a restart are not a change", (t) => {
  const env = setup(t);
  const periods = [{ startMs: T0 - 10 * MINUTE, endMs: T0 - 5 * MINUTE, meanW: 113.123456789 }];
  const first = env.make();
  first.applyWallPeriods("a", periods);
  first.close();
  const second = env.make();
  second.applyWallPeriods("a", periods);
  assert.equal(second.flushRecent(), false, "nothing to write");
  assert.equal(fs.existsSync(env.recentPath), false);
});

for (const [name, content] of [
  ["from another scope", (raw) => ({ ...raw, nodeIds: ["a", "c"] })],
  ["with an unknown version", (raw) => ({ ...raw, version: 99 })],
  ["that loading had to repair", (raw) => ({ ...raw, buckets: [...raw.buckets, { minuteStartMs: 7 }] })],
]) {
  test(`a file ${name} is never the base of a recent-only write`, (t) => {
    const env = setup(t);
    const first = env.make();
    feed(env, first, T0, T0 + MINUTE);
    first.close();
    fs.writeFileSync(env.filePath, JSON.stringify(content(env.read(env.filePath))));
    const second = env.make();
    feed(env, second, T0 + MINUTE + 2000, T0 + 2 * MINUTE);
    env.tick();
    assert.equal(fs.existsSync(env.recentPath), false, "the first write is a full one");
    assert.deepEqual(env.read(env.filePath).nodeIds, ["a", "b"]);
    assert.equal(env.read(env.filePath).version, 1);
  });
}
