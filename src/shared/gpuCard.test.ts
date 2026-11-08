import { describe, expect, it } from "vitest";
import { formatFan, pcieLinkText, throttleReasons } from "./gpuCard";
import type { GpuThrottle } from "../api/types";

const throttle = (over: Partial<GpuThrottle>): GpuThrottle => ({
  thermal: false,
  hwSlowdown: false,
  powerCap: false,
  active: false,
  reason: "ok",
  smClockMHz: 1755,
  smClockMaxMHz: 2115,
  smClockPct: 83,
  detail: "Clocks not limited",
  ...over,
});

describe("formatFan", () => {
  it("shows a percentage, rounded", () => {
    expect(formatFan(30)).toBe("30 %");
    expect(formatFan(0)).toBe("0 %");
    expect(formatFan(41.6)).toBe("42 %");
  });
  it("shows a dash when the card reports no fan", () => {
    expect(formatFan(null)).toBe("—");
    expect(formatFan(undefined)).toBe("—");
  });
});

describe("pcieLinkText", () => {
  it("shows the link, and the best one only when it differs", () => {
    expect(pcieLinkText({ gen: 5, genMax: 5, width: 16, widthMax: 16 })).toEqual({ now: "Gen 5 x16", best: null });
    expect(pcieLinkText({ gen: 1, genMax: 4, width: 16, widthMax: 16 })).toEqual({ now: "Gen 1 x16", best: "Gen 4 x16" });
    expect(pcieLinkText({ gen: 3, genMax: 3, width: 8, widthMax: 16 })).toEqual({ now: "Gen 3 x8", best: "Gen 3 x16" });
  });
  it("is null when unknown", () => {
    expect(pcieLinkText(null)).toBeNull();
    expect(pcieLinkText({ gen: null, genMax: null, width: null, widthMax: null })).toBeNull();
  });
});

describe("throttleReasons", () => {
  it("is empty when clocks are not limited, or there is no data", () => {
    expect(throttleReasons(throttle({}))).toEqual([]);
    expect(throttleReasons(null)).toEqual([]);
  });
  it("lists every active reason once", () => {
    expect(throttleReasons(throttle({ active: true, thermal: true, hwSlowdown: true, powerCap: true }))).toEqual([
      { reason: "thermal" },
      { reason: "power" },
    ]);
    expect(throttleReasons(throttle({ active: true, hwSlowdown: true }))).toEqual([{ reason: "hw" }]);
  });
  it("names a locked clock cap", () => {
    expect(throttleReasons(throttle({ clockCapMHz: 1800 }))).toEqual([{ reason: "clockCap", mhz: 1800 }]);
  });
});
