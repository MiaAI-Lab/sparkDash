import { describe, expect, it } from "vitest";
import { BENCH_TYPES, NAV_BENCH_TYPES, benchNavActive, benchTypeById } from "./benchCatalog";

describe("bench catalog", () => {
  it("keeps sub-pages resolvable by id but out of the nav lists", () => {
    expect(BENCH_TYPES.some((b) => b.id === "quality-compare")).toBe(true);
    expect(NAV_BENCH_TYPES.some((b) => b.id === "quality-compare")).toBe(false);
    expect(benchTypeById("quality-compare")?.subPageOf).toBe("quality");
    // Every nav type is a real catalog entry, and nothing else is a sub-page today.
    expect(NAV_BENCH_TYPES.length).toBe(BENCH_TYPES.length - 1);
  });

  it("marks the parent bench active while one of its sub-pages is open", () => {
    const quality = benchTypeById("quality")!;
    expect(benchNavActive(quality, "quality")).toBe(true);
    expect(benchNavActive(quality, "quality-compare")).toBe(true);
    expect(benchNavActive(quality, "decode")).toBe(false);
    expect(benchNavActive(quality, null)).toBe(false);
  });
});
