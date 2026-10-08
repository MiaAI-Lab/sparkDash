import { describe, expect, it } from "vitest";
import type { LlmMetrics } from "../../api/types";
import { engineStateLabel } from "./llmEngineState";

function llm(gpuMemoryUtilization: number | null): LlmMetrics {
  return { available: true, backend: "tensorfold", gpuMemoryUtilization } as LlmMetrics;
}

describe("engineStateLabel", () => {
  it("says n/a, with a reason, when the backend reports no sleep state", () => {
    expect(engineStateLabel(llm(null))).toEqual({
      text: "n/a",
      title: "This backend does not report engine sleep state",
      muted: true,
    });
  });

  it("reads Sleeping and Active from the engine gauge", () => {
    expect(engineStateLabel(llm(0))).toEqual({ text: "Sleeping", muted: false });
    expect(engineStateLabel(llm(1))).toEqual({ text: "Active", muted: false });
  });

  it("keeps the dash when there is no LLM at all", () => {
    expect(engineStateLabel(null).text).toBe("—");
  });
});
