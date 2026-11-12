import test from "node:test";
import assert from "node:assert/strict";
import { MonthlyEnergyArchive } from "../../energy/FleetEnergyMonthly.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const OCT = Date.UTC(2026, 9, 1);

function bucket(minuteStartMs, wh = 1) {
  return {
    minuteStartMs,
    nodeWh: { a: wh, b: 2 * wh },
    nodeCoverageMs: { a: MINUTE, b: MINUTE },
    fleetWattMs: 3 * wh * 3_600_000,
    fleetCoverageMs: MINUTE,
    outputTokens: 0,
    coveredOutputTokens: 0,
  };
}

/** An archive over one in-memory file. */
function memoryArchive(initial, now) {
  const files = { text: initial == null ? null : JSON.stringify(initial) };
  const fileSystem = {
    readFileSync() {
      if (files.text == null) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return files.text;
    },
    renameSync() {},
  };
  const archive = new MonthlyEnergyArchive({ filePath: "/mem/monthly.json", now: () => now, fileSystem, writeState: (_p, text) => (files.text = text) });
  return { archive, files };
}

test("every minute also lands in its node's UTC hour of the month", () => {
  const archive = new MonthlyEnergyArchive({ now: () => OCT + 3 * HOUR });
  const minutes = [bucket(OCT + 5 * MINUTE), bucket(OCT + 6 * MINUTE), bucket(OCT + 2 * HOUR + 30 * MINUTE, 4)];
  archive.foldBuckets(minutes, { nowMs: OCT + 3 * HOUR });
  const [month] = archive.snapshot().months;
  assert.equal(month.binnedFromMs, OCT);
  assert.deepEqual(month.nodes.a.hourWh, [2, 0, 4]);
  assert.deepEqual(month.nodes.b.hourWh, [4, 0, 8]);
  assert.equal(month.nodes.a.wh, 6);
});

test("hours are kept across a restart, rounded and without trailing empty hours", () => {
  const now = OCT + 5 * HOUR;
  const first = memoryArchive(null, now);
  first.archive.foldBuckets([bucket(OCT + 10 * MINUTE, 1 / 3), bucket(OCT + HOUR, 1 / 3)], { nowMs: now });
  first.archive.flush();
  const stored = JSON.parse(first.files.text).months["2026-10"];
  assert.deepEqual(stored.nodes.a.hourWh, [0.33, 0.33]);
  assert.equal(stored.binnedFromMs, OCT);
  const again = memoryArchive(JSON.parse(first.files.text), now).archive;
  assert.deepEqual(again.snapshot().months[0].nodes.b.hourWh, [0.67, 0.67]);
});

test("a month from before hourly records is backfilled once, from minutes the tracker still keeps", () => {
  const now = OCT + 40 * HOUR;
  // An older version folded 3 Wh for node a by OCT+30h, with no hours.
  const legacy = {
    version: 1,
    foldedThroughMs: OCT + 30 * HOUR,
    months: { "2026-10": { nodes: { a: { wh: 3, coverageMs: 3 * MINUTE }, b: { wh: 6, coverageMs: 3 * MINUTE } }, fleetWh: 9, fleetCoverageMs: 3 * MINUTE } },
  };
  const { archive } = memoryArchive(legacy, now);
  assert.equal(archive.snapshot().months[0].binnedFromMs, undefined);
  // Minutes folded after the upgrade get hours as they fold.
  archive.foldBuckets([bucket(OCT + 31 * HOUR)], { nowMs: now });
  // The tracker still holds two of the three old minutes (one is older than its window), and the new one.
  const kept = [bucket(OCT + 20 * HOUR), bucket(OCT + 20 * HOUR + MINUTE), bucket(OCT + 31 * HOUR)];
  assert.equal(archive.backfillHours(kept), 1);
  assert.equal(archive.backfillHours(kept), 0, "never twice");
  const [month] = archive.snapshot().months;
  assert.equal(month.binnedFromMs, OCT + 20 * HOUR);
  assert.equal(month.nodes.a.hourWh[20], 2);
  assert.equal(month.nodes.a.hourWh[31], 1, "the new minute is not counted again");
  assert.equal(month.nodes.a.wh, 4);
  // 1 Wh stays outside the hours: the minute the tracker no longer keeps.
  assert.equal(month.nodes.a.wh - month.nodes.a.hourWh.reduce((s, v) => s + v, 0), 1);
});

test("a legacy month the tracker holds nothing of is marked as having no hours", () => {
  const legacy = { version: 1, foldedThroughMs: Date.UTC(2026, 9, 1), months: { "2026-09": { nodes: { a: { wh: 5, coverageMs: MINUTE } } } } };
  const { archive } = memoryArchive(legacy, Date.UTC(2026, 10, 1));
  archive.backfillHours([]);
  const [month] = archive.snapshot().months;
  assert.equal(month.binnedFromMs, Date.UTC(2026, 9, 1));
  assert.equal(month.nodes.a.hourWh, undefined);
});

test("stored hours that do not fit the month are dropped on load", () => {
  const legacy = {
    version: 1,
    foldedThroughMs: OCT,
    months: { "2026-02": { binnedFromMs: 5, nodes: { a: { wh: 1, coverageMs: 0, hourWh: new Array(700).fill(1) }, b: { wh: 1, coverageMs: 0, hourWh: [1, -2, "x"] } } } },
  };
  const [month] = memoryArchive(legacy, OCT).archive.snapshot().months;
  assert.equal(month.nodes.a.hourWh, undefined, "February has 672 hours");
  assert.deepEqual(month.nodes.b.hourWh, [1]);
  assert.equal(month.binnedFromMs, undefined, "a marker outside the month is ignored");
});

test("wall hours come from imported meter hours, and dropWall removes them", () => {
  const archive = new MonthlyEnergyArchive({ now: () => OCT + 10 * HOUR });
  archive.foldBuckets([bucket(OCT + 2 * HOUR)], { nowMs: OCT + 10 * HOUR });
  archive.importWallHours(new Map([["a", [{ startMs: OCT + 2 * HOUR, endMs: OCT + 3 * HOUR, meanW: 50 }]]]), { beforeMs: OCT + 5 * HOUR });
  assert.deepEqual(archive.snapshot().months[0].nodes.a.wallHourWh, [0, 0, 50]);
  archive.dropWall();
  const node = archive.snapshot().months[0].nodes.a;
  assert.equal(node.wallHourWh, undefined);
  assert.deepEqual(node.hourWh, [0, 0, 1]);
});