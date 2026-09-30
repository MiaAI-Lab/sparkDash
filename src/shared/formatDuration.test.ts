import { describe, expect, it } from "vitest";
import { formatDuration } from "./formatDuration";

describe("formatDuration", () => {
  it("rolls 60 seconds into the next minute", () => {
    expect(formatDuration(119_500)).toBe("2m 0s");
    expect(formatDuration(59_950)).toBe("1m 0s");
  });

  it("keeps shorter runs and exact minutes", () => {
    expect(formatDuration(500)).toBe("500 ms");
    expect(formatDuration(27_800)).toBe("27.8 s");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(119_400)).toBe("1m 59s");
  });
});
