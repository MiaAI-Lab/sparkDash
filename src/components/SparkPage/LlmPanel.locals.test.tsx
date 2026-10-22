import { describe, expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import { LlmPanel } from "./LlmPanel";

vi.mock("./LlmTokenTotals", () => ({ LlmTokenTotals: () => null }));
vi.mock("./LlmDailyChart", () => ({ LlmDailyChart: () => null }));
vi.mock("./LlmTrendChart", () => ({ LlmTrendChart: () => null }));

describe("Locals live metrics", () => {
  it("names the engine and shows the request tile the probe fills", () => {
    const llm = {
      ...makeSpark().metrics.llm[0],
      backend: "locals" as const,
      generationTps: 41.5,
      prefillTps: 320,
      requestsRunning: 1,
      requestsWaiting: null,
      prefixCacheHitRate: 0.8976,
    };
    const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8030} />);
    expect(container.textContent).toContain("Locals · :8030");
    expect(container.textContent).toContain("Running / waiting");
    expect(container.textContent).toContain("1 / —");
    expect(container.textContent).toContain("Prefix hit");
    expect(container.textContent).toContain("90%");
  });

  it("shows no rate, not Idle, when the stats could not be read, and says why", () => {
    const llm = {
      ...makeSpark().metrics.llm[0],
      backend: "locals" as const,
      available: true,
      generationTps: 0,
      prefillTps: 0,
      measurementValid: false,
      measurementError: "stats endpoint answered 500",
    };
    const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8030} />);
    const metrics = [...container.querySelectorAll(".sp-metric")];
    const tile = (name: string) => metrics.find((el) => el.querySelector(".eyebrow")?.textContent === name);
    expect(tile("Decode")?.textContent).toContain("—");
    expect(tile("Prefill")?.textContent).toContain("—");
    expect(tile("Prefill")?.textContent).not.toContain("tok/s");
    expect(container.textContent).toContain("stats endpoint answered 500");
    expect(container.querySelector("[data-llm-idle]")).toBeNull();
  });
});
