import { afterEach, describe, expect, it } from "vitest";
import { isValidTimeZone, setConfiguredTimeZone, tzOffsetMinutes, activeTimeZone } from "./timeZone";

afterEach(() => setConfiguredTimeZone(null));

describe("time zone", () => {
  it("validates IANA names", () => {
    expect(isValidTimeZone("Europe/Paris")).toBe(true);
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });

  it("computes offsets including DST and half-hour zones", () => {
    const winter = Date.UTC(2026, 0, 15, 12, 0, 0);
    const summer = Date.UTC(2026, 6, 15, 12, 0, 0);
    expect(tzOffsetMinutes(winter, "Europe/Paris")).toBe(60);
    expect(tzOffsetMinutes(summer, "Europe/Paris")).toBe(120);
    expect(tzOffsetMinutes(winter, "Asia/Kolkata")).toBe(330);
    expect(tzOffsetMinutes(winter, "America/New_York")).toBe(-300);
    expect(tzOffsetMinutes(summer, "UTC")).toBe(0);
  });

  it("uses the configured zone when none is passed, and the browser's otherwise", () => {
    const t = Date.UTC(2026, 0, 15, 12, 0, 0);
    setConfiguredTimeZone("Asia/Tokyo");
    expect(tzOffsetMinutes(t)).toBe(540);
    expect(activeTimeZone()).toBe("Asia/Tokyo");
    setConfiguredTimeZone("garbage");
    expect(tzOffsetMinutes(t)).toBe(-new Date(t).getTimezoneOffset());
  });
});
