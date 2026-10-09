import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { FleetEnergyTracker } from "../../energy/FleetEnergyTracker.js";
import { MonthlyEnergyArchive, monthKey, monthRange } from "../../energy/FleetEnergyMonthly.js";
import { registerFleetEnergyRoute } from "../../energy/FleetEnergyRuntime.js";

const MINUTE = 60_000;
// 128.2 W per node: 100 W GPU + idle CPU (5.2 W) + 23 W base.
const WH_PER_NODE_MINUTE = 128.2 / 60;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "energy-monthly-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function snap(id, tokens) {
  return {
    id,
    online: true,
    telemetryFresh: true,
    role: "standalone",
    llmPorts: [8000],
    metrics: {
      gpu: { power: { draw: 100 } },
      cpu: { usage: 0 },
      llm: [{ available: true, totalOutputTokens: tokens }],
    },
  };
}

/** Record one sample every 2 s from `fromMs` to `toMs` (inclusive). */
function feed(tracker, nodes, fromMs, toMs, tokenRate = 0) {
  for (let at = fromMs; at <= toMs; at += 2000) {
    const tokens = Math.floor(((at - fromMs) / 2000) * tokenRate);
    tracker.record(nodes.map((id) => snap(id, tokens)), at);
  }
}

function bucket(minuteStartMs, wh = 1, extra = {}) {
  return {
    minuteStartMs,
    nodeWh: { a: wh, b: wh },
    nodeCoverageMs: { a: MINUTE, b: MINUTE },
    fleetWattMs: 2 * wh * 3_600_000,
    fleetCoverageMs: MINUTE,
    outputTokens: 0,
    coveredOutputTokens: 0,
    ...extra,
  };
}

test("month keys and ranges use UTC", () => {
  assert.equal(monthKey(Date.UTC(2026, 8, 30, 23, 59, 59)), "2026-09");
  assert.equal(monthKey(Date.UTC(2026, 9, 1, 0, 0, 0)), "2026-10");
  assert.deepEqual(monthRange("2026-12"), [Date.UTC(2026, 11, 1), Date.UTC(2027, 0, 1)]);
  assert.equal(monthRange("2026-13"), null);
  assert.equal(monthRange("26-1"), null);
});

test("folding is idempotent and leaves open minutes for later", () => {
  const archive = new MonthlyEnergyArchive();
  const t0 = Date.UTC(2026, 9, 5, 12, 0);
  const buckets = [bucket(t0), bucket(t0 + MINUTE), bucket(t0 + 2 * MINUTE)];
  // At t0+2m+5s the third minute has not ended; the second ended less than the 10 s grace ago.
  assert.equal(archive.foldBuckets(buckets, { nowMs: t0 + 2 * MINUTE + 5000 }), 1);
  assert.equal(archive.foldBuckets(buckets, { nowMs: t0 + 2 * MINUTE + 5000 }), 0);
  assert.equal(archive.foldBuckets(buckets, { nowMs: t0 + 3 * MINUTE + 10_000 }), 2);
  assert.equal(archive.foldBuckets(buckets, { nowMs: t0 + 3 * MINUTE + 10_000 }), 0);
  const [month] = archive.snapshot().months;
  assert.equal(month.month, "2026-10");
  assert.equal(month.nodes.a.wh, 3);
  assert.equal(month.totalWh, 6);
  assert.equal(month.fleetCoverageMs, 3 * MINUTE);
});

test("minutes either side of a UTC month boundary land in different months", () => {
  const archive = new MonthlyEnergyArchive();
  const boundary = Date.UTC(2026, 9, 1);
  const buckets = [bucket(boundary - MINUTE, 1), bucket(boundary, 2)];
  archive.foldBuckets(buckets, { nowMs: boundary + 5 * MINUTE });
  const { months } = archive.snapshot(boundary + 5 * MINUTE);
  assert.deepEqual(months.map((m) => [m.month, m.totalWh]), [["2026-09", 2], ["2026-10", 4]]);
  assert.deepEqual(months.map((m) => m.closed), [true, false]);
});

test("tracker rolls up finished minutes and keeps them after the window is reset", (t) => {
  const start = Date.UTC(2026, 9, 5, 12, 0);
  let clock = start + 5 * MINUTE;
  const tracker = new FleetEnergyTracker({ nodeIds: ["a", "b"], setIntervalFn: null, now: () => clock });
  feed(tracker, ["a", "b"], start, start + 5 * MINUTE);
  const before = tracker.monthlySnapshot(start + 5 * MINUTE).months[0];
  assert.ok(before.nodes.a.wh > 4 * WH_PER_NODE_MINUTE && before.nodes.a.wh < 5 * WH_PER_NODE_MINUTE);

  tracker.clear();
  assert.equal(tracker.history(start + 5 * MINUTE).hourly.length, 0);
  const after = tracker.monthlySnapshot(start + 5 * MINUTE).months[0];
  assert.equal(after.totalWh, before.totalWh);

  feed(tracker, ["a", "b"], start + 6 * MINUTE, start + 8 * MINUTE);
  const later = tracker.monthlySnapshot(start + 8 * MINUTE).months[0];
  assert.ok(later.totalWh > before.totalWh);
});

test("a minute written to twice by the tracker is counted once", () => {
  const start = Date.UTC(2026, 9, 5, 12, 0);
  const tracker = new FleetEnergyTracker({ nodeIds: ["a"], setIntervalFn: null, now: () => start + 3 * MINUTE + 20_000 });
  feed(tracker, ["a"], start, start + 3 * MINUTE);
  const first = tracker.monthlySnapshot(start + 3 * MINUTE + 20_000).months[0].nodes.a.wh;
  tracker.monthlySnapshot(start + 3 * MINUTE + 20_000);
  tracker.flush();
  assert.equal(tracker.monthlySnapshot(start + 3 * MINUTE + 20_000).months[0].nodes.a.wh, first);
});

test("totals survive a restart and re-reading the 31-day file does not double count", (t) => {
  const dir = tempDir(t);
  const filePath = path.join(dir, "fleet-energy.json");
  const monthlyFilePath = path.join(dir, "fleet-energy-monthly.json");
  const options = { nodeIds: ["a", "b"], filePath, monthlyFilePath, setIntervalFn: null };
  const start = Date.UTC(2026, 9, 5, 12, 0);

  const first = new FleetEnergyTracker({ ...options, now: () => start + 4 * MINUTE });
  feed(first, ["a", "b"], start, start + 4 * MINUTE);
  first.close();

  // The 31-day file reloads the same minutes; the watermark keeps them from being added twice.
  const second = new FleetEnergyTracker({ ...options, now: () => start + 10 * MINUTE });
  const reloaded = second.monthlySnapshot(start + 10 * MINUTE).months[0].totalWh;
  assert.ok(Math.abs(reloaded - 2 * 4 * WH_PER_NODE_MINUTE) < 0.01, `${reloaded}`);
  feed(second, ["a", "b"], start + 10 * MINUTE, start + 12 * MINUTE);
  second.close();

  const third = new FleetEnergyTracker({ ...options, now: () => start + 20 * MINUTE });
  const total = third.monthlySnapshot(start + 20 * MINUTE).months[0].totalWh;
  assert.ok(total > reloaded);
  assert.ok(total < reloaded + 3 * 2 * WH_PER_NODE_MINUTE + 0.01, `${total}`);
  third.close();
  const fourth = new FleetEnergyTracker({ ...options, now: () => start + 30 * MINUTE });
  assert.equal(fourth.monthlySnapshot(start + 30 * MINUTE).months[0].totalWh, total);
  assert.equal(JSON.parse(fs.readFileSync(monthlyFilePath, "utf8")).version, 1);
  assert.equal(fs.statSync(monthlyFilePath).mode & 0o777, 0o600);
});

test("first start backfills the existing 31-day file", (t) => {
  const dir = tempDir(t);
  const filePath = path.join(dir, "fleet-energy.json");
  const monthlyFilePath = path.join(dir, "fleet-energy-monthly.json");
  const start = Date.UTC(2026, 9, 5, 12, 0);

  const old = new FleetEnergyTracker({ nodeIds: ["a"], filePath, setIntervalFn: null, now: () => start });
  feed(old, ["a"], start, start + 3 * MINUTE);
  old.close();
  assert.equal(fs.existsSync(monthlyFilePath), false);

  const upgraded = new FleetEnergyTracker({
    nodeIds: ["a"],
    filePath,
    monthlyFilePath,
    setIntervalFn: null,
    now: () => start + 2 * 60 * MINUTE,
  });
  const [month] = upgraded.monthlySnapshot(start + 2 * 60 * MINUTE).months;
  assert.ok(month.nodes.a.wh > 2 * WH_PER_NODE_MINUTE);
});

test("a membership change keeps the old scope's months and adds the new scope", (t) => {
  const dir = tempDir(t);
  const filePath = path.join(dir, "fleet-energy.json");
  const monthlyFilePath = path.join(dir, "fleet-energy-monthly.json");
  const start = Date.UTC(2026, 9, 5, 12, 0);

  const before = new FleetEnergyTracker({ nodeIds: ["a", "b"], filePath, monthlyFilePath, setIntervalFn: null, now: () => start });
  feed(before, ["a", "b"], start, start + 3 * MINUTE);
  before.close();

  const later = start + 60 * MINUTE;
  const after = new FleetEnergyTracker({ nodeIds: ["a", "c"], filePath, monthlyFilePath, setIntervalFn: null, now: () => later });
  feed(after, ["a", "c"], later, later + 3 * MINUTE);
  const [month] = after.monthlySnapshot(later + 3 * MINUTE).months;
  assert.deepEqual(month.nodeIds, ["a", "b", "c"]);
  assert.ok(month.nodes.b.wh > 2 * WH_PER_NODE_MINUTE);
  assert.ok(month.nodes.c.wh > 1.5 * WH_PER_NODE_MINUTE);
  // "a" has both periods.
  assert.ok(month.nodes.a.wh > month.nodes.c.wh + 2 * WH_PER_NODE_MINUTE);
});

test("an out-of-scope file's implausible minutes never reach the archive", (t) => {
  const dir = tempDir(t);
  const filePath = path.join(dir, "fleet-energy.json");
  const monthlyFilePath = path.join(dir, "fleet-energy-monthly.json");
  const start = Date.UTC(2026, 9, 5, 12, 0);
  const at = (n) => start + n * MINUTE;
  const poisoned = [
    bucket(at(0)), // plausible: 60 W per node for a full minute
    bucket(at(1), 50), // implausible Wh (over 4 Wh/min)
    bucket(at(2), 1, { nodeCoverageMs: { a: 120_000, b: MINUTE } }), // coverage beyond a minute
    bucket(at(3), 1, { fleetCoverageMs: 120_000 }), // fleet coverage beyond a minute
    bucket(at(4), 1, { nodeWh: { a: -1, b: 1 } }), // negative Wh
    bucket(at(5), 1, { fleetWattMs: -5 }), // negative watts
    bucket(at(6), 1, { fleetWattMs: 1e12 }), // watts above the fleet bound
    bucket(at(7), 1, { fleetWattMs: 1 }), // watts below the fleet floor
    bucket(at(8), 1, { nodeWh: { a: null, b: 1 } }), // NaN does not survive JSON; it arrives as null
    bucket(at(9), 1, { nodeWh: { a: 1 } }), // node set differs from the file's own nodeIds
    bucket(at(10), 1, { outputTokens: -3 }),
    bucket(at(11) + 1), // not minute aligned
    bucket(at(0), 3), // duplicate minute
  ];
  fs.writeFileSync(
    filePath,
    JSON.stringify({ version: 1, savedAt: at(20), nodeIds: ["a", "b"], buckets: poisoned })
  );

  const tracker = new FleetEnergyTracker({
    nodeIds: ["a", "c"],
    filePath,
    monthlyFilePath,
    setIntervalFn: null,
    now: () => at(30),
  });
  const [month, ...rest] = tracker.monthlySnapshot(at(30)).months;
  assert.equal(rest.length, 0);
  assert.deepEqual(month.nodeIds, ["a", "b"]);
  assert.ok(Math.abs(month.nodes.a.wh - 1) < 1e-9, `${month.nodes.a.wh}`);
  assert.ok(Math.abs(month.totalWh - 2) < 1e-9, `${month.totalWh}`);
  assert.equal(month.fleetCoverageMs, MINUTE);
  assert.equal(month.outputTokens, 0);
  tracker.close();
  assert.ok(fs.readdirSync(dir).some((name) => name.includes(".scope-")));
});

test("an out-of-scope file with no usable node list adds nothing", (t) => {
  const dir = tempDir(t);
  const filePath = path.join(dir, "fleet-energy.json");
  const start = Date.UTC(2026, 9, 5, 12, 0);
  fs.writeFileSync(
    filePath,
    JSON.stringify({ version: 1, savedAt: start, nodeIds: [], buckets: [bucket(start)] })
  );
  const tracker = new FleetEnergyTracker({
    nodeIds: ["a", "c"],
    filePath,
    monthlyFilePath: path.join(dir, "fleet-energy-monthly.json"),
    setIntervalFn: null,
    now: () => start + 30 * MINUTE,
  });
  assert.equal(tracker.monthlySnapshot(start + 30 * MINUTE).months.length, 0);
  tracker.close();
});

test("Wh per output token pairs fleet energy with covered tokens", () => {
  const tracker = new FleetEnergyTracker({ nodeIds: ["a"], setIntervalFn: null });
  const start = Date.UTC(2026, 9, 5, 12, 0);
  feed(tracker, ["a"], start, start + 4 * MINUTE, 10);
  const [month] = tracker.monthlySnapshot(start + 4 * MINUTE + 20_000).months;
  assert.ok(month.coveredOutputTokens > 0);
  assert.ok(month.whPerOutputToken > 0);
  const noTokens = new FleetEnergyTracker({ nodeIds: ["a"], setIntervalFn: null });
  feed(noTokens, ["a"], start, start + 3 * MINUTE, 0);
  assert.equal(noTokens.monthlySnapshot(start + 3 * MINUTE + 20_000).months[0].whPerOutputToken, null);
});

test("an unreadable monthly file is set aside, not overwritten", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "fleet-energy-monthly.json");
  fs.writeFileSync(file, "{not json");
  const archive = new MonthlyEnergyArchive({ filePath: file, now: () => 1234 });
  assert.equal(archive.snapshot().months.length, 0);
  assert.deepEqual(fs.readdirSync(dir), ["fleet-energy-monthly.unreadable-1234.json"]);
});

test("monthly HTTP API: read, and clearing is explicit", async (t) => {
  const start = Date.UTC(2026, 9, 5, 12, 0);
  const tracker = new FleetEnergyTracker({ nodeIds: ["a", "b"], setIntervalFn: null, now: () => start + 3 * MINUTE + 20_000 });
  feed(tracker, ["a", "b"], start, start + 3 * MINUTE);
  const app = express();
  registerFleetEnergyRoute(app, tracker);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/fleet-energy`;

  const got = await (await fetch(`${base}/monthly`)).json();
  assert.deepEqual(got.months.map((m) => m.month), ["2026-10"]);

  // The ordinary reset does not touch the archive.
  assert.equal((await fetch(base, { method: "DELETE" })).status, 200);
  assert.equal((await (await fetch(`${base}/monthly`)).json()).months.length, 1);

  assert.equal((await fetch(`${base}/monthly`, { method: "DELETE" })).status, 400);
  assert.equal((await fetch(`${base}/monthly?month=nope`, { method: "DELETE" })).status, 400);
  assert.equal((await fetch(`${base}/monthly?all=1`, { method: "DELETE" })).status, 400);
  // Wiping everything needs the explicit confirmation, and a refusal deletes nothing.
  const unconfirmed = await fetch(`${base}/monthly?all=true`, { method: "DELETE" });
  assert.equal(unconfirmed.status, 400);
  assert.match((await unconfirmed.json()).error, /confirm=delete-all-history/);
  assert.equal((await fetch(`${base}/monthly?all=true&confirm=yes`, { method: "DELETE" })).status, 400);
  assert.equal((await (await fetch(`${base}/monthly`)).json()).months.length, 1);
  const one = await (await fetch(`${base}/monthly?month=2026-10`, { method: "DELETE" })).json();
  assert.equal(one.removed, 1);
  assert.equal((await (await fetch(`${base}/monthly`)).json()).months.length, 0);

  feed(tracker, ["a", "b"], start + 10 * MINUTE, start + 13 * MINUTE);
  assert.equal((await (await fetch(`${base}/monthly`)).json()).months.length, 1);
  const all = await fetch(`${base}/monthly?all=true&confirm=delete-all-history`, { method: "DELETE" });
  assert.equal(all.status, 200);
  assert.equal((await all.json()).removed, 1);
  assert.equal((await (await fetch(`${base}/monthly`)).json()).months.length, 0);
});

test("a clock that ran far ahead cannot hide later real minutes", () => {
  const t0 = Date.UTC(2026, 9, 5, 12, 0);
  const clock = t0;
  const archive = new MonthlyEnergyArchive({ now: () => clock });
  const tenDays = 10 * 24 * 60 * MINUTE;
  // Data recorded while the clock was 10 days ahead: folding stops at now + 1 day of the injected clock.
  assert.equal(archive.foldBuckets([bucket(t0 + tenDays)], { nowMs: t0 + tenDays + MINUTE * 2 }), 0);
  assert.ok(archive.foldedThroughMs <= t0 + 24 * 60 * MINUTE);
  assert.equal(archive.foldBuckets([bucket(t0 - 5 * MINUTE)], { nowMs: t0 }), 1);
  assert.equal(archive.snapshot(t0).months[0].nodes.a.wh, 1);
});

test("a stored watermark beyond now + 1 day is clamped on the next fold and totals are kept", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "monthly.json");
  const t0 = Date.UTC(2026, 9, 5, 12, 0);
  const future = t0 + 400 * 24 * 60 * MINUTE;
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      savedAt: t0,
      foldedThroughMs: future,
      months: { "2026-09": { nodes: { a: { wh: 7, coverageMs: MINUTE } }, fleetWh: 7, fleetCoverageMs: MINUTE, outputTokens: 0, coveredOutputTokens: 0, tokenFleetWh: 0 } },
    })
  );
  const archive = new MonthlyEnergyArchive({ filePath: file, now: () => t0 });
  assert.ok(archive.foldedThroughMs <= t0);
  assert.equal(archive.foldBuckets([bucket(t0 + MINUTE)], { nowMs: t0 + 3 * MINUTE }), 1);
  const months = archive.snapshot(t0).months;
  assert.equal(months.find((m) => m.month === "2026-09").nodes.a.wh, 7);
  assert.equal(months.find((m) => m.month === "2026-10").nodes.a.wh, 1);
});

test("a discarded bucket adds nothing to an existing month", () => {
  const archive = new MonthlyEnergyArchive();
  const t0 = Date.UTC(2026, 9, 5, 12, 0);
  const empty = { minuteStartMs: t0 + MINUTE, nodeWh: {}, nodeCoverageMs: {}, fleetWattMs: 0, fleetCoverageMs: MINUTE, outputTokens: 0, coveredOutputTokens: 5 };
  archive.foldBuckets([bucket(t0), empty], { nowMs: t0 + 5 * MINUTE });
  const [month] = archive.snapshot().months;
  assert.equal(month.fleetCoverageMs, MINUTE);
  assert.equal(month.coveredOutputTokens, 0);
  assert.equal(month.fleetWh, 2);
});
