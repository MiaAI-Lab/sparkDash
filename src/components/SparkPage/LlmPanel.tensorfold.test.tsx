import { expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import { LlmPanel } from "./LlmPanel";

vi.mock("./LlmTokenTotals", () => ({ LlmTokenTotals: () => null }));
vi.mock("./LlmDailyChart", () => ({ LlmDailyChart: () => null }));
vi.mock("./LlmTrendChart", () => ({ LlmTrendChart: () => null }));

it("TensorFold labels completed decode separately and does not invent zero prefill", () => {
  const llm = { ...makeSpark().metrics.llm[0], backend: "tensorfold" as const, prefillTps: 0, perStreamTps: 40 };
  const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8888} />);
  expect(container.textContent).toContain("Decode · aggregate");
  expect(container.textContent).toContain("40.0 tok/s · last completions");
  expect(container.textContent).toContain("Not measured live");
});

it("TensorFold labels completed effective prefill without claiming live throughput", () => {
  const llm = { ...makeSpark().metrics.llm[0], backend: "tensorfold" as const, prefillTps: 2000, perStreamPrefillTps: 2000, prefillTpsSource: "completed-effective" as const };
  const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8888} />);
  expect(container.textContent).toContain("Prefill · last completed");
  expect(container.textContent).toContain("Effective rate · includes cached tokens");
});

it("a TensorFold-reader front end shows the pool's free and total tokens in the KV tile", () => {
  // Pico serves tensorfold:* counters through the same reader and does show the KV tile.
  // A live idle reading: the fullest stream sits at 0% of its own window while kept
  // prompt states hold the pool rows that the free figure leaves out.
  const llm = {
    ...makeSpark().metrics.llm[0],
    backend: "pico" as const,
    requestsRunning: 0,
    kvCacheUsage: 0,
    kvCacheUsageBasis: "stream" as const,
    kvCacheTokens: 2_101_248,
    kvCacheTokensAvailable: 1_433_600,
  };
  const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8888} />);
  const tile = container.querySelector('[aria-label="KV cache info"]')!.closest(".sp-tile")!;
  expect(tile.querySelector("b")!.textContent).toBe("0%");
  expect(tile.querySelector("small")!.textContent).toBe("1.4M free · 2.1M pool");
});
