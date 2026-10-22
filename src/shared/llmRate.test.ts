import { describe, expect, it } from "vitest";
import { measuredGenerationTps } from "./llmRate";

describe("measuredGenerationTps", () => {
  it("is the live decode rate of a readable engine, 0 included", () => {
    expect(measuredGenerationTps({ generationTps: 41.5 })).toBe(41.5);
    expect(measuredGenerationTps({ generationTps: 0, measurementValid: true })).toBe(0);
  });

  it("is null when the endpoint answered but its stats could not be read, or there is no engine", () => {
    expect(measuredGenerationTps({ generationTps: 0, measurementValid: false })).toBeNull();
    expect(measuredGenerationTps(null)).toBeNull();
    expect(measuredGenerationTps(undefined)).toBeNull();
  });
});
