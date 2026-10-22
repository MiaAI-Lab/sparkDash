import { describe, expect, it } from "vitest";
import { backendLabel } from "./llmBackends.js";

describe("backendLabel", () => {
  it("names the Locals engine instead of echoing its id", () => {
    expect(backendLabel("locals")).toBe("Locals");
  });

  it("names the Splash engine instead of echoing its id", () => {
    expect(backendLabel("splash")).toBe("Splash");
  });
});
