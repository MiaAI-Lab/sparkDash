import { describe, expect, it } from "vitest";
import { mergeTraces } from "./useKioskTraces";
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
