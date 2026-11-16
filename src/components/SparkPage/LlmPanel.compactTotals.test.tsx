import { describe, expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import { LlmPanel } from "./LlmPanel";

vi.mock("./LlmTokenTotals", () => ({ LlmTokenTotals: () => null }));
vi.mock("./LlmDailyChart", () => ({ LlmDailyChart: () => null }));
vi.mock("./LlmTrendChart", () => ({ LlmTrendChart: () => null }));

describe("engine counter tiles", () => {
  it("compacts a billion-scale counter and keeps the exact value in the tile's title", () => {
    const llm = {
      ...makeSpark().metrics.llm[0],
      backend: "vllm" as const,
      available: true,
      totalOutputTokens: 1_248_218_233,
    };
    const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8888} />);
    const tiles = [...container.querySelectorAll(".sp-tile")];
    const generated = tiles.find((tile) => tile.textContent?.includes("1.25B"));
    expect(generated).toBeTruthy();
    expect(generated?.getAttribute("title")).toContain("1,248,218,233");
    expect(container.textContent).not.toContain("1,248,218,233 tokens.");
  });

  it("leaves a small counter exact", () => {
    const llm = {
      ...makeSpark().metrics.llm[0],
      backend: "vllm" as const,
      available: true,
      totalOutputTokens: 4_208,
    };
    const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8888} />);
    expect(container.textContent).toContain("4,208");
  });
});
