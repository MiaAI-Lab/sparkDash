import { describe, expect, it } from "vitest";
import type { SparkSnapshot } from "../../api/types";
import { computeFleetTotals, estimateNodeWatts, formatCtx, pushRolling, shutdownWarnings, trendDeltaPct } from "./fleetStats";

function spark(over: Record<string, unknown>): SparkSnapshot {
  return { id: "a", name: "a", online: true, metrics: { storage: [], llm: [] }, ...over } as unknown as SparkSnapshot;
}

describe("fleetStats", () => {
  it("sums decode, power and memory for online units only", () => {
    const t = computeFleetTotals([
      spark({ metrics: { llm: [{ available: true, generationTps: 40 }, { available: false, generationTps: 9 }], gpu: { power: { draw: 100 }, vram: { used: 10, total: 100 } } } }),
      spark({ id: "b", metrics: { llm: [{ available: true, generationTps: 5.5 }], unifiedMemory: { used: 20, total: 100 }, gpu: null } }),
      spark({ id: "c", online: false, metrics: { llm: [], unifiedMemory: { used: 99, total: 100 } } }),
    ]);
    // Unit a: 100 W GPU + 23 W platform overhead. Unit b reports no power telemetry at all.
    expect(t).toMatchObject({ total: 3, online: 2, decodeTps: 45.5, powerW: 123, memUsedMb: 30, memTotalMb: 300 });
  });

  it("estimates whole-node power per online unit: GPU + CPU + platform overhead", () => {
    const t = computeFleetTotals([
      spark({ metrics: { llm: [], gpu: { power: { draw: 40 } }, cpu: { draw: 12.5 } } }),
      // GPU reading missing: the CPU estimate and the overhead still count.
      spark({ id: "b", metrics: { llm: [], gpu: null, cpu: { draw: 5.2 } } }),
      spark({ id: "c", online: false, metrics: { llm: [], gpu: { power: { draw: 90 } }, cpu: { draw: 60 } } }),
    ]);
    expect(t.powerW).toBeCloseTo(40 + 12.5 + 23 + 5.2 + 23);
  });

  it("does not invent watts for a unit that reports no power telemetry", () => {
    expect(estimateNodeWatts(spark({ metrics: { llm: [] } }))).toBeNull();
    expect(estimateNodeWatts(spark({ metrics: { llm: [], gpu: { power: { draw: Number.NaN } }, cpu: null } }))).toBeNull();
    // An idle GPU reading of 0 W is telemetry, not a gap.
    expect(estimateNodeWatts(spark({ metrics: { llm: [], gpu: { power: { draw: 0 } } } }))).toBe(23);
  });

  it("rolls a fixed window", () => {
    let b: number[] = [];
    for (let i = 0; i < 5; i++) b = pushRolling(b, i, 3);
    expect(b).toEqual([2, 3, 4]);
  });

  it("computes trend delta only with enough samples", () => {
    expect(trendDeltaPct([1, 2, 3])).toBeNull();
    expect(trendDeltaPct([10, 10, 10, 10, 20, 20, 20, 20])).toBeCloseTo(100);
    expect(trendDeltaPct([0, 0, 0, 0, 0, 0, 0, 5])).toBeNull();
  });

  it("lists interrupted work for shutdown warnings", () => {
    const w = shutdownWarnings([
      spark({ name: "x", metrics: { llm: [{ slotsActive: 2, requestsRunning: 1 }], comfy: { queueRunning: 1 } } }),
      spark({ name: "off", online: false, metrics: { llm: [{ slotsActive: 3 }] } }),
    ]);
    expect(w).toEqual(["x: 2 in-flight LLM requests", "x: ComfyUI job running"]);
  });
});
