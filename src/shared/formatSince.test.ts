import { describe, expect, it } from "vitest";
import { formatSince } from "./formatSince";

const NOW = 1_800_000_000_000;
const ago = (ms: number) => formatSince(NOW - ms, NOW);

describe("formatSince", () => {
  it("is null without a timestamp", () => {
    expect(formatSince(null, NOW)).toBeNull();
    expect(formatSince(undefined, NOW)).toBeNull();
    expect(formatSince(0, NOW)).toBeNull();
    expect(formatSince(Number.NaN, NOW)).toBeNull();
  });

  it("counts seconds up to 90", () => {
    expect(ago(0)).toBe("0s");
    expect(ago(42_400)).toBe("42s");
    expect(ago(89_999)).toBe("89s");
  });

  it("rolls into minutes, hours and days", () => {
    expect(ago(90_000)).toBe("1m");
    expect(ago(12 * 60_000 + 30_000)).toBe("12m");
    expect(ago(89 * 60_000)).toBe("89m");
    expect(ago(90 * 60_000)).toBe("1h");
    expect(ago(47 * 3_600_000)).toBe("47h");
    expect(ago(48 * 3_600_000)).toBe("2d");
    expect(ago(10 * 86_400_000)).toBe("10d");
  });

  it("reads a timestamp from a slightly fast clock as now", () => {
    expect(formatSince(NOW + 5_000, NOW)).toBe("0s");
  });
});
