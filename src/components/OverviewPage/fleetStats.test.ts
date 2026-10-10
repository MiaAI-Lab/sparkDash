import { describe, expect, it } from "vitest";
import type { SparkSnapshot } from "../../api/types";
import { computeFleetTotals, formatCtx, pushRolling, shutdownWarnings, trendDeltaPct } from "./fleetStats";

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
    expect(t).toMatchObject({ total: 3, online: 2, decodeTps: 45.5, powerW: 100, memUsedMb: 30, memTotalMb: 300 });
  });

  it("rolls a fixed window", () => {
    let b: number[] = [];
    for (let i = 0; i < 5; i++) b = pushRolling(b, i, 3);
    expect(b).toEqual([2, 3, 4]);
  });

  it("tracks loaded endpoints whose decode rate is unknown without adding their placeholders", () => {
    const unknown = spark({ metrics: { llm: [{ available: true, liveRatesAvailable: false, generationTps: 99 }] } });
    expect(computeFleetTotals([unknown])).toMatchObject({ decodeTps: 0, decodeMeasuredEndpoints: 0, decodeUnknownEndpoints: 1 });
    const measured = spark({ id: "b", metrics: { llm: [{ available: true, generationTps: 30 }] } });
    expect(computeFleetTotals([unknown, measured])).toMatchObject({ decodeTps: 30, decodeMeasuredEndpoints: 1, decodeUnknownEndpoints: 1 });
    unknown.online = false;
    expect(computeFleetTotals([unknown, measured])).toMatchObject({ decodeTps: 30, decodeMeasuredEndpoints: 1, decodeUnknownEndpoints: 0 });
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
