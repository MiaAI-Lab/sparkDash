import { describe, expect, it } from "vitest";
import { forEachLimited, mergeTraces } from "./useKioskTraces";
import type { KioskTraces } from "./kioskModel";

const traces = (n: number): KioskTraces => ({ gpu: [n], cpu: [n], gen: [n], prefill: [n] }) as unknown as KioskTraces;

describe("mergeTraces", () => {
  it("drops a unit that has left the fleet instead of holding it for the wall's lifetime", () => {
    const previous = { a: traces(1), b: traces(2) };
    // b was removed from the registry, so this refresh fetched nothing for it.
    expect(Object.keys(mergeTraces(previous, { a: traces(3) }, ["a"]))).toEqual(["a"]);
  });

  it("keeps a unit's previous series when its own fetch failed", () => {
    const previous = { a: traces(1), b: traces(2) };
    // Only a answered this round; b is still in the fleet and keeps its last good frame.
    const merged = mergeTraces(previous, { a: traces(3) }, ["a", "b"]);
    expect(merged.a).toEqual(traces(3));
    expect(merged.b).toEqual(previous.b);
  });

  it("takes a newly added unit's first series and needs no previous one", () => {
    expect(Object.keys(mergeTraces({}, { c: traces(4) }, ["c"]))).toEqual(["c"]);
    // A unit with neither a fetch nor a previous series is simply absent, not an empty trace.
    expect(mergeTraces({}, {}, ["d"])).toEqual({});
  });
});

describe("forEachLimited", () => {
  it("runs every item, never more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await forEachLimited([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, n % 3));
      done.push(n);
      running -= 1;
    });
    expect(peak).toBe(4);
    expect(done.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("finishes at once with nothing to do", async () => {
    await expect(forEachLimited([], 4, async () => {})).resolves.toBeUndefined();
  });
});
