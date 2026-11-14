import { describe, expect, it } from "vitest";
import { EARLIEST_REAL_SECONDS, isStale, relativeTime } from "./relativeTime";

// Local times, so the tests mean the same in every time zone.
const at = (y: number, mo: number, d: number, h = 12, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const secs = (ms: number) => Math.floor(ms / 1000);
const NOW = at(2026, 10, 26, 12, 0);

describe("relativeTime", () => {
  it("is today for now, under a minute ago and hours ago on the same day", () => {
    expect(relativeTime(secs(NOW), NOW)).toBe("today");
    expect(relativeTime(secs(NOW - 30_000), NOW)).toBe("today");
    expect(relativeTime(secs(at(2026, 10, 26, 0, 0, 1)), NOW)).toBe("today");
  });

  it("counts calendar days: late yesterday is yesterday, not today", () => {
    const late = at(2026, 10, 26, 0, 30);
    expect(relativeTime(secs(at(2026, 10, 25, 23, 50)), late)).toBe("yesterday");
    expect(relativeTime(secs(at(2026, 10, 25, 0, 0)), NOW)).toBe("yesterday");
    expect(relativeTime(secs(at(2026, 10, 24, 23, 59)), NOW)).toBe("2 days ago");
    expect(relativeTime(secs(at(2026, 9, 27)), NOW)).toBe("29 days ago");
  });

  it("then months, then years", () => {
    expect(relativeTime(secs(at(2026, 9, 26)), NOW)).toBe("1 month ago");
    expect(relativeTime(secs(at(2026, 5, 20)), NOW)).toBe("5 months ago");
    expect(relativeTime(secs(at(2025, 10, 27)), NOW)).toBe("11 months ago");
    expect(relativeTime(secs(at(2025, 10, 26)), NOW)).toBe("1 year ago");
    expect(relativeTime(secs(at(2024, 3, 1)), NOW)).toBe("2 years ago");
    expect(relativeTime(secs(at(2014, 1, 1)), NOW)).toBe("12 years ago");
  });

  it("thirty days or more is never '0 months'", () => {
    expect(relativeTime(secs(at(2026, 3, 1)), at(2026, 3, 31))).toBe("1 month ago");
  });

  it("a time in the future reads today", () => {
    expect(relativeTime(secs(NOW + 3_600_000), NOW)).toBe("today");
    expect(relativeTime(secs(at(2030, 1, 1)), NOW)).toBe("today");
  });

  it("has no answer without a usable time: never 1970", () => {
    for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -5, 1, EARLIEST_REAL_SECONDS - 1]) expect(relativeTime(v, NOW)).toBeNull();
    expect(relativeTime(EARLIEST_REAL_SECONDS, NOW)).toBe("46 years ago");
  });
});

describe("isStale", () => {
  it("is a year or more, and never for an unknown time", () => {
    expect(isStale(secs(at(2025, 10, 26, 11)), NOW)).toBe(true);
    expect(isStale(secs(at(2026, 1, 1)), NOW)).toBe(false);
    expect(isStale(secs(NOW + 1000), NOW)).toBe(false);
    expect(isStale(null, NOW)).toBe(false);
    expect(isStale(0, NOW)).toBe(false);
  });
});
