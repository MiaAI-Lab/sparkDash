import { describe, expect, it } from "vitest";
import { addDeviceLabel, deviceKindNoun, editDeviceTitle } from "./deviceKind";

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
