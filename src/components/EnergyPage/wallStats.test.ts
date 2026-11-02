import { describe, expect, it } from "vitest";
import type { EnergyHistoryRow, MonthlyEnergyMonth } from "../../api/types";
import { filledShare, formatRatio, hasWall, hourLines, nodeParts, wallMonth, wallRows } from "./wallStats";

const HOUR = 3_600_000;
const T = Date.UTC(2026, 9, 20, 12);

function row(over: Partial<EnergyHistoryRow> = {}): EnergyHistoryRow {
  return {
    t: T,
    nodeWh: { a: 100, b: 50 },
    nodeCoverageMs: { a: HOUR, b: HOUR },
    avgWatts: 150,
    fleetEnergyWh: 150,
    fleetCoverageMs: HOUR,
    outputTokens: 1000,
    coveredOutputTokens: 900,
    ...over,
  };
}

const metered = (over: Partial<EnergyHistoryRow> = {}) =>
  row({
    nodeGpuWh: { a: 50, b: 20 },
    nodeCpuWh: { a: 27, b: 7 },
    nodePartsCoverageMs: { a: HOUR, b: HOUR },
    nodeWallWh: { a: 140, b: 0 },
    nodeWallCoverageMs: { a: HOUR, b: 0 },
    nodeWallMeteredMs: { a: HOUR, b: 0 },
    nodeWallFilledWh: { a: 0, b: 70 },
    nodeWallFilledMs: { a: 0, b: HOUR },
    avgWallWatts: 210,
    fleetWallWh: 210,
    fleetWallFilledWh: 70,
    fleetWallCoverageMs: HOUR,
    wallCoveredOutputTokens: 1000,
    ...over,
  });

describe("wall stats", () => {
  it("knows when a payload carries wall power", () => {
    expect(hasWall(null)).toBe(false);
    expect(hasWall({ estimated: true, membershipChanged: false, generatedAt: T, retentionMs: 1, nodeIds: ["a"], hourly: [] })).toBe(false);
    expect(hasWall({ estimated: true, membershipChanged: false, generatedAt: T, retentionMs: 1, nodeIds: ["a"], wallNodeIds: ["a"], hourly: [] })).toBe(true);
  });

  it("re-expresses wall figures in the estimate's row shape, measured plus filled", () => {
    const [w] = wallRows([metered(), row({ t: T - HOUR })], ["a", "b"]);
    expect(w).toEqual({
      t: T,
      nodeWh: { a: 140, b: 70 },
      nodeCoverageMs: { a: HOUR, b: HOUR },
      avgWatts: 210,
      fleetEnergyWh: 210,
      fleetCoverageMs: HOUR,
      outputTokens: 1000,
      coveredOutputTokens: 1000,
    });
    // An hour without wall figures is a gap on the wall basis, not a zero.
    expect(wallRows([row()], ["a", "b"])).toEqual([]);
  });

  it("reports how much of the wall energy was filled", () => {
    expect(filledShare([metered()])).toBeCloseTo(70 / 210);
    expect(filledShare([row()])).toBe(0);
  });

  it("sums GPU, CPU and measured vs filled wall energy per node", () => {
    const parts = nodeParts([metered(), metered({ t: T + HOUR })], ["a", "b"]);
    expect(parts.get("a")).toEqual({ gpuKwh: 0.1, cpuKwh: 0.054, measuredKwh: 0.28, filledKwh: 0 });
    expect(parts.get("b")?.filledKwh).toBeCloseTo(0.14);
  });

  it("draws GPU and CPU lines only for hours every node reported", () => {
    const lines = hourLines([metered(), metered({ t: T + HOUR, nodePartsCoverageMs: { a: HOUR, b: 0 } })], ["a", "b"]);
    expect(lines.get(T)).toEqual({ gpu: 70, cpu: 34 });
    expect(lines.get(T + HOUR)).toEqual({ gpu: null, cpu: null });
  });

  it("turns a month with wall power into a wall-basis month and leaves others alone", () => {
    const m: MonthlyEnergyMonth = {
      month: "2026-10",
      startMs: Date.UTC(2026, 9, 1),
      endMs: Date.UTC(2026, 10, 1),
      closed: false,
      nodeIds: ["a", "b"],
      nodes: { a: { wh: 100, coverageMs: HOUR, wallWh: 140, wallCoverageMs: HOUR, wallFilledWh: 0, wallFilledMs: 0 }, b: { wh: 50, coverageMs: HOUR } },
      totalWh: 150,
      fleetWh: 150,
      fleetCoverageMs: HOUR,
      outputTokens: 0,
      coveredOutputTokens: 0,
      whPerOutputToken: null,
      totalWallWh: 140,
      fleetWallWh: 0,
      fleetWallCoverageMs: 0,
    };
    const w = wallMonth(m)!;
    expect(w.totalWh).toBe(140);
    expect(w.nodeIds).toEqual(["a"]);
    expect(w.nodes.a).toEqual({ wh: 140, coverageMs: HOUR });
    expect(wallMonth({ ...m, totalWallWh: undefined })).toBeNull();
    expect(formatRatio(1.414)).toBe("141%");
    expect(formatRatio(null)).toBe("—");
  });
});
