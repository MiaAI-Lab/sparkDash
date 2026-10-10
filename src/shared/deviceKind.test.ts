import { describe, expect, it } from "vitest";
import { addDeviceLabel, deviceKindNoun, editDeviceTitle, unitTypeOf, unitTypePatch } from "./deviceKind";

describe("deviceKind labels", () => {
  it("names a Spark", () => {
    expect(deviceKindNoun("spark")).toBe("Spark");
    expect(addDeviceLabel("spark")).toBe("Add Spark");
    expect(editDeviceTitle("spark")).toBe("Edit Spark");
  });
  it("names a GPU host", () => {
    expect(deviceKindNoun("host")).toBe("GPU Host");
    expect(addDeviceLabel("host")).toBe("Add GPU Host");
    expect(editDeviceTitle("host")).toBe("Edit GPU Host");
  });
  it("treats an unset kind as a Spark", () => {
    expect(addDeviceLabel(undefined)).toBe("Add Spark");
  });
});

describe("unit type", () => {
  it("reads the type from kind and platform", () => {
    expect(unitTypeOf({})).toBe("spark");
    expect(unitTypeOf({ kind: "host" })).toBe("host");
    expect(unitTypeOf({ kind: "host", platform: "windows" })).toBe("windows");
  });

  it("a Windows PC is a remote GPU host", () => {
    expect(unitTypePatch("windows", {})).toEqual({ kind: "host", platform: "windows", isLocal: false });
  });

  it("switching back to Spark or Linux host clears the Windows platform and keeps macOS", () => {
    expect(unitTypePatch("spark", { platform: "windows" })).toEqual({ kind: "spark", platform: "linux" });
    expect(unitTypePatch("host", { platform: "windows" })).toEqual({ kind: "host", platform: "linux" });
    expect(unitTypePatch("host", { platform: "darwin" })).toEqual({ kind: "host", platform: "darwin" });
  });
});
