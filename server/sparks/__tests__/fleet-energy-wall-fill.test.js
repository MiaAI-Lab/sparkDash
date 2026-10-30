// Filling wall power where no meter measured it: estimate × the learned wall/estimate ratio.
import test from "node:test";
import assert from "node:assert/strict";
import { FleetEnergyTracker } from "../../energy/FleetEnergyTracker.js";
import { learnWallRatios, wallMinute, MIN_RATIO_MINUTES } from "../../energy/wallMinute.js";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-20T12:00:00Z");
const close = (actual, expected, eps = 1e-3) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} ≈ ${expected}`);

// Estimates: a = 50 W GPU + 35.1 W CPU + 23 = 108.1 W, b = 20 + 5.2 + 23 = 48.2 W, c = 30 + 5.2 + 23 = 58.2 W.
const EST = { a: 108.1, b: 48.2, c: 58.2 };
const GPU = { a: [50, 50], b: [20, 0], c: [30, 0] };
const WALL = { a: 150, b: 120 };

function snap(id, wallWatts) {
  const [gpu, cpuUsage] = GPU[id];
  return { id, online: true, telemetryFresh: true, role: "worker", metrics: { gpu: { power: { draw: gpu } }, cpu: { usage: cpuUsage } }, wallWatts };
}

/** a and b metered, c not; `aWall(at)` decides whether a's meter reads at that instant. */
function run({ minutes, aWall = () => true, nodeIds = ["a", "b", "c"] }) {
  let clock = T0;
  const tracker = new FleetEnergyTracker({ nodeIds, now: () => clock, load: false, setIntervalFn: null });
  tracker.configureWall({ nodeIds: ["a", "b"] });
  for (let at = T0; at <= T0 + minutes * MINUTE; at += 2000) {
    clock = at;
    tracker.record(nodeIds.map((id) => snap(id, id === "c" ? null : id === "a" && !aWall(at) ? null : WALL[id])), at);
  }
  return { tracker, at: () => clock };
}

test("ratios are learned per metered node from full-overlap minutes, with a fleet fallback", () => {
  const { tracker, at } = run({ minutes: MIN_RATIO_MINUTES + 2 });
  const learned = learnWallRatios(tracker._buckets.values(), ["a", "b", "c"], new Set(["a", "b"]), at());
  close(learned.own.a, WALL.a / EST.a);
  close(learned.own.b, WALL.b / EST.b);
  assert.equal(learned.own.c, undefined, "c has no meter");
  close(learned.fleet, (WALL.a + WALL.b) / (EST.a + EST.b));
  close(learned.byNode.get("c"), learned.fleet);
  assert.ok(learned.minutes.a >= MIN_RATIO_MINUTES);
});

test("too little overlap, or an implausible ratio, is not used", () => {
  const { tracker, at } = run({ minutes: 10 });
  const learned = learnWallRatios(tracker._buckets.values(), ["a", "b", "c"], new Set(["a", "b"]), at());
  assert.equal(learned.own.a, null);
  assert.equal(learned.fleet, null);
  assert.equal(learned.byNode.size, 0);
  // A meter reading 20× the estimate is measuring something else as well.
  const buckets = Array.from({ length: MIN_RATIO_MINUTES }, (_, i) => ({
    minuteStartMs: T0 + i * MINUTE,
    nodeWh: { a: 1 },
    nodeCoverageMs: { a: MINUTE },
    wall: { a: [20, MINUTE, 0] },
  }));
  assert.equal(learnWallRatios(buckets, ["a"], new Set(["a"]), T0 + MIN_RATIO_MINUTES * MINUTE).own.a, null);
});

test("wallMinute fills only the time the meter missed and needs every node for fleet figures", () => {
  const bucket = {
    minuteStartMs: T0,
    nodeWh: { a: 1, b: 1 },
    nodeCoverageMs: { a: MINUTE, b: MINUTE },
    wall: { a: [1, 30_000, 0] },
  };
  const ratios = new Map([["a", 2], ["b", 1.5]]);
  const m = wallMinute(bucket, ["a", "b"], new Set(["a", "b"]), ratios);
  assert.equal(m.nodes.a.filledMs, 30_000);
  close(m.nodes.a.filledWh, 1 * 0.5 * 2);
  assert.equal(m.nodes.b.filledMs, MINUTE);
  close(m.nodes.b.filledWh, 1.5);
  assert.equal(m.fleet.coverageMs, MINUTE);
  close(m.fleet.wh, 1 + 1 + 1.5);
  close(m.fleet.filledWh, 1 + 1.5);
  assert.equal(wallMinute(bucket, ["a", "b"], new Set(["a", "b"]), null).fleet, null, "b has neither a reading nor a ratio");
});

test("a meter gap and an unmetered node are filled from the estimate, kept apart from measured", () => {
  const gapFrom = T0 + 65 * MINUTE;
  const gapTo = T0 + 70 * MINUTE;
  const { tracker, at } = run({ minutes: 75, aWall: (t) => t < gapFrom || t >= gapTo });
  const history = tracker.history(at());
  close(history.wallRatios.a, WALL.a / EST.a);
  close(history.wallRatios.b, WALL.b / EST.b);
  // c has no meter: the fleet ratio, weighted by each node's overlapping minutes.
  const fleetRatio = tracker.snapshot(at()).wall.fleetRatio;
  close(history.wallRatios.c, fleetRatio);
  assert.ok(fleetRatio > WALL.a / EST.a && fleetRatio < WALL.b / EST.b);
  const row = history.hourly.at(-1);
  // a's gap: about 5 minutes at 108.1 W × (150 / 108.1) = 150 W, filled.
  close(row.nodeWallFilledMs.a, 5 * MINUTE, 2_000);
  close(row.nodeWallFilledWh.a, (150 * 5) / 60, 0.2);
  // c has no meter at all: every estimated second is filled at the fleet ratio.
  assert.equal(row.nodeWallWh.c, 0);
  assert.equal(row.nodeWallFilledMs.c, row.nodeCoverageMs.c);
  close(row.nodeWallFilledWh.c, row.nodeWh.c * fleetRatio, 0.05);
  assert.ok(row.fleetWallFilledWh > 0 && row.fleetWallFilledWh < row.fleetWallWh);
  assert.ok(row.fleetWallCoverageMs > 0, "the whole fleet is covered once c is filled");

  const wall = tracker.snapshot(at()).wall;
  assert.deepEqual(wall.freshNodeIds, ["a", "b"]);
  assert.deepEqual(wall.filledNodeIds, ["c"]);
  assert.deepEqual(wall.staleNodeIds, []);
  assert.equal(wall.currentFilled, true);
  // A 30 s average; the learned ratio may tick over once inside it.
  close(wall.currentWatts30s, WALL.a + WALL.b + EST.c * wall.ratios.c, 0.1);
  assert.ok(wall.filledEnergy24hKwh > 0 && wall.filledEnergy24hKwh < wall.energy24hKwh);
});

test("before any ratio is learned nothing is filled, and the fleet figure waits", () => {
  const { tracker, at } = run({ minutes: 5 });
  const row = tracker.history(at()).hourly.at(-1);
  assert.equal(row.nodeWallFilledMs.c, 0);
  assert.equal(row.fleetWallCoverageMs, 0, "c is neither measured nor fillable yet");
  assert.equal(tracker.snapshot(at()).wall.currentWatts30s, null);
});

test("filled wall power folds into months next to the measured part", () => {
  const { tracker, at } = run({ minutes: 70 });
  const month = tracker.monthlySnapshot(at() + 2 * MINUTE).months.at(-1);
  assert.ok(month.nodes.a.wallWh > 0);
  assert.ok(month.nodes.c.wallFilledWh > 0);
  assert.equal(month.nodes.c.wallWh, 0);
  assert.ok(month.totalWallFilledWh > 0 && month.totalWallFilledWh < month.totalWallWh);
  close(month.totalWallWh, month.nodes.a.wallWh + month.nodes.a.wallFilledWh + month.nodes.b.wallWh + month.nodes.b.wallFilledWh + month.nodes.c.wallFilledWh, 0.01);
});
