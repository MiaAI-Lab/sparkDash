import { describe, expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import { LlmPanel } from "./LlmPanel";

vi.mock("./LlmTokenTotals", () => ({ LlmTokenTotals: () => null }));
vi.mock("./LlmDailyChart", () => ({ LlmDailyChart: () => null }));
vi.mock("./LlmTrendChart", () => ({ LlmTrendChart: () => null }));

describe("Splash live metrics", () => {
  it("names the engine and shows the latency tiles the probe fills", () => {
    const llm = {
      ...makeSpark().metrics.llm[0],
      backend: "splash" as const,
      generationTps: 131.8,
      prefillTps: 1528,
      ttftP95Seconds: 29.945,
      itlP95Seconds: 0.011,
    };
    const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={1245} />);
    expect(container.textContent).toContain("Splash · :1245");
    expect(container.textContent).toContain("TTFT p95");
    expect(container.textContent).toContain("29945 ms");
    expect(container.textContent).toContain("Inter-token p95");
  });
});
