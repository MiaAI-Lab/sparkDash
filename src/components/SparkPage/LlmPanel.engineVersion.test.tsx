import { describe, expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import { LlmPanel } from "./LlmPanel";

vi.mock("./LlmTokenTotals", () => ({ LlmTokenTotals: () => null }));
vi.mock("./LlmDailyChart", () => ({ LlmDailyChart: () => null }));
vi.mock("./LlmTrendChart", () => ({ LlmTrendChart: () => null }));

describe("engine version chip", () => {
  it("shows the version vLLM reported on /version", () => {
    const llm = {
      ...makeSpark().metrics.llm[0],
      backend: "vllm" as const,
      available: true,
      engineVersion: "0.11.0",
    };
    const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8888} />);
    expect(container.textContent).toContain("vLLM · :8888 · v0.11.0");
  });

  it("leaves the chip unchanged when no version was read", () => {
    const llm = {
      ...makeSpark().metrics.llm[0],
      backend: "vllm" as const,
      available: true,
      engineVersion: null,
    };
    const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8888} />);
    expect(container.textContent).toContain("vLLM · :8888");
    expect(container.textContent).not.toContain("vLLM · :8888 ·");
  });
});
