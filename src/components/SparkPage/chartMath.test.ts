import { describe, expect, it } from "vitest";
import { bucketByTime, memoryBreakdown, seriesSegments, splitSegments, windowAxisLabels } from "./chartMath";

describe("bucketByTime", () => {
  it("averages samples inside each bucket and drops empty ones", () => {
    const pts = bucketByTime(
      [
        { at: 0, value: 10 },
        { at: 2, value: 20 },
        { at: 90, value: 50 },
      ],
      0,
      100,
      10
    );
    expect(pts).toHaveLength(2);
    expect(pts[0].value).toBe(15);
    expect(pts[1].value).toBe(50);
  });
  it("ignores samples outside the window", () => {
    expect(bucketByTime([{ at: -5, value: 1 }, { at: 200, value: 1 }], 0, 100, 4)).toEqual([]);
  });
});

describe("splitSegments / seriesSegments", () => {
  it("breaks the line across a long gap", () => {
    const segs = splitSegments(
      [
        { at: 0, value: 1 },
        { at: 2000, value: 1 },
        { at: 100_000, value: 1 },
      ],
      20_000
    );
    expect(segs.map((s) => s.length)).toEqual([2, 1]);
  });
  it("keeps contiguous 2 s samples as one segment", () => {
    const samples = Array.from({ length: 300 }, (_, i) => ({ at: i * 2000, value: i }));
    const segs = seriesSegments(samples, 600_000, 598_000);
    expect(segs).toHaveLength(1);
  });
});

describe("memoryBreakdown", () => {
  it("carves the KV pool out of GPU memory", () => {
    const segs = memoryBreakdown({ totalMb: 128_000, gpuUsedMb: 90_000, cpuUsedMb: 6_000, kvBytes: 20_000 * 1024 ** 2, hasModel: true });
    expect(segs.map((s) => s.key)).toEqual(["weights", "kv", "system", "free"]);
    expect(segs.find((s) => s.key === "weights")?.mb).toBe(70_000);
    expect(segs.find((s) => s.key === "free")?.mb).toBe(32_000);
    expect(segs.reduce((a, s) => a + s.mb, 0)).toBe(128_000);
  });
  it("falls back to GPU processes / system / free without LLM data", () => {
    const segs = memoryBreakdown({ totalMb: 100, gpuUsedMb: 40, cpuUsedMb: 10 });
    expect(segs.map((s) => s.label)).toEqual(["GPU processes", "System", "Free"]);
  });
  it("never lets KV exceed the GPU slice or free go negative", () => {
    const segs = memoryBreakdown({ totalMb: 100, gpuUsedMb: 60, cpuUsedMb: 60, kvBytes: 500 * 1024 ** 2 });
    expect(segs.find((s) => s.key === "kv")?.mb).toBe(60);
    expect(segs.find((s) => s.key === "free")?.mb).toBe(0);
  });
});

describe("windowAxisLabels", () => {
  it("labels minutes and hours", () => {
    expect(windowAxisLabels(30 * 60_000)).toEqual(["−30 min", "−15 min", "now"]);
    expect(windowAxisLabels(8 * 3600_000)).toEqual(["−8 h", "−4 h", "now"]);
  });
});
