import { describe, expect, it } from "vitest";
import { chartSeriesSpecs, gpuColor, parseGpuMetric, parseGpuView } from "./gpuChartView";

describe("gpuChartView", () => {
  it("parses a stored view and falls back to all when the card is gone", () => {
    expect(parseGpuView("combined", [0, 1])).toBe("combined");
    expect(parseGpuView("all", [0, 1])).toBe("all");
    expect(parseGpuView("1", [0, 1])).toBe(1);
    expect(parseGpuView("2", [0, 1])).toBe("all");
    expect(parseGpuView("junk", [0, 1])).toBe("all");
    expect(parseGpuView(null, [0, 1])).toBe("all");
  });

  it("parses the stored metric with a utilization default", () => {
    expect(parseGpuMetric("temp")).toBe("temp");
    expect(parseGpuMetric("nope")).toBe("usage");
    expect(parseGpuMetric(null)).toBe("usage");
  });

  it("combined keeps today's three aggregate lines", () => {
    const specs = chartSeriesSpecs("combined", "usage", [0, 1]);
    expect(specs.map((s) => s.metric)).toEqual(["gpu.usage", "gpu.powerPct", "gpu.temp"]);
    expect(specs.filter((s) => s.fill).map((s) => s.key)).toEqual(["usage"]);
  });

  it("all draws one line per card for the chosen metric, each in its own colour", () => {
    const specs = chartSeriesSpecs("all", "temp", [0, 2]);
    expect(specs.map((s) => s.metric)).toEqual(["gpu.0.temp", "gpu.2.temp"]);
    expect(specs.map((s) => s.label)).toEqual(["GPU 0", "GPU 2"]);
    expect(new Set(specs.map((s) => s.color)).size).toBe(2);
    expect(specs.some((s) => s.fill)).toBe(false);
  });

  it("one card shows its three metrics", () => {
    expect(chartSeriesSpecs(1, "usage", [0, 1]).map((s) => s.metric)).toEqual([
      "gpu.1.usage",
      "gpu.1.powerPct",
      "gpu.1.temp",
    ]);
  });

  it("colours are theme tokens and cycle", () => {
    expect(gpuColor(0)).toMatch(/^var\(--color-/);
    expect(gpuColor(6)).toBe(gpuColor(0));
  });
});
