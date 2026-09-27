import { describe, expect, it } from "vitest";
import { RingBuffer } from "./ringBuffer";

describe("RingBuffer", () => {
  it("keeps bounded chronological output after wraparound", () => {
    const buffer = new RingBuffer<number>(3);
    [1, 2, 3, 4, 5].forEach((value) => buffer.push(value));
    expect(buffer.length).toBe(3);
    expect(buffer.toArray()).toEqual([3, 4, 5]);
    expect(buffer.first).toBe(3);
    expect(buffer.last).toBe(5);
  });

  it("supports pruning and replacing a duplicate-timestamp tail", () => {
    const buffer = new RingBuffer<number>(3);
    buffer.push(1);
    buffer.push(2);
    buffer.replaceLast(9);
    expect(buffer.shift()).toBe(1);
    expect(buffer.toArray()).toEqual([9]);
  });

  it("bounds an eight-hour-equivalent 12-node metric workload", () => {
    const series = Array.from({ length: 12 * 8 }, () => new RingBuffer<number>(28_800));
    const startedAt = performance.now();
    for (let sample = 0; sample <= 28_800; sample += 1) {
      for (const buffer of series) buffer.push(sample);
    }
    const elapsedMs = performance.now() - startedAt;
    expect(series.every((buffer) => buffer.length === 28_800)).toBe(true);
    expect(series[0].toArray().slice(0, 2)).toEqual([1, 2]);
    expect(elapsedMs).toBeLessThan(5_000);
  }, 10_000);
});
