import { describe, expect, it } from "vitest";
import { formatLiveStrip } from "./liveStrip";

describe("formatLiveStrip", () => {
  it("is null when idle", () => {
    expect(formatLiveStrip(0, 14.6)).toBeNull();
    expect(formatLiveStrip(2, 0)).toBeNull();
  });
  it("formats Sparky-style combined line", () => {
    expect(formatLiveStrip(4, 58.2)).toBe("4 live · ~14.6 tok/s each · 58.2 combined");
  });
});
