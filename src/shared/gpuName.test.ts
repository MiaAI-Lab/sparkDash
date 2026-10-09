import { describe, expect, it } from "vitest";
import { shortGpuName } from "./gpuName";

describe("shortGpuName", () => {
  it("drops the NVIDIA / GeForce prefix", () => {
    expect(shortGpuName("NVIDIA GeForce RTX 5080")).toBe("RTX 5080");
    expect(shortGpuName("NVIDIA GB10")).toBe("GB10");
  });

  it("keeps Intel in the name and drops marks and the Graphics suffix", () => {
    expect(shortGpuName("Intel(R) Arc(TM) A770 Graphics")).toBe("Intel Arc A770");
    expect(shortGpuName("Intel Arc Pro B70")).toBe("Intel Arc Pro B70");
    expect(shortGpuName("Intel GPU [abcd]")).toBe("Intel GPU [abcd]");
  });

  it("returns an empty string for a missing name", () => {
    expect(shortGpuName(null)).toBe("");
  });
});
