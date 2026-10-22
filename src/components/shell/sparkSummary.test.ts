import { describe, expect, it } from "vitest";
import { primaryDecodeTps, railSubLabel } from "./sparkSummary";
import { makeSpark } from "../../testing/fixtures";

function withLlm(overrides: Record<string, unknown>) {
  const spark = makeSpark();
  Object.assign(spark.metrics.llm[0], { available: true, ...overrides });
  return spark;
}

describe("sparkSummary with an engine whose stats could not be read", () => {
  it("shows no decode rate on the rail instead of 0.0", () => {
    const spark = withLlm({ generationTps: 0, measurementValid: false });
    expect(primaryDecodeTps(spark)).toBeNull();
    expect(railSubLabel(spark)).toBe("—");
  });

  it("still shows a readable idle engine as 0.0", () => {
    const spark = withLlm({ generationTps: 0, measurementValid: true });
    expect(primaryDecodeTps(spark)).toBe(0);
    expect(railSubLabel(spark)).toBe("0.0");
  });
});
