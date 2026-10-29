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
