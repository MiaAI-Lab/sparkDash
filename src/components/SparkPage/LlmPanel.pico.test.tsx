import { act } from "react";
import { expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import { LlmPanel } from "./LlmPanel";

vi.mock("./LlmTokenTotals", () => ({ LlmTokenTotals: () => null }));
vi.mock("./LlmDailyChart", () => ({ LlmDailyChart: () => null }));
vi.mock("./LlmTrendChart", () => ({ LlmTrendChart: () => null }));

it("clears Pico's sampled decode figure on the next idle poll", () => {
  const llm = {
    ...makeSpark().metrics.llm[0], backend: "pico" as const,
    generationTps: 42, generationTpsSource: "probe-sample" as const,
    prefillTps: 0, decodeActive: false,
  };
  const { container, root } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8888} />);
  const decode = () => container.querySelector(".sp-decode .big-num");
  expect(decode()?.textContent).toBe("42.0tok/s");
  act(() => root.render(<LlmPanel llm={{ ...llm, generationTps: 0 }} sparkId="fixture" llmPort={8888} />));
  expect(decode()?.textContent).toBe("0.0tok/s");
  expect(container.querySelector("[data-llm-idle]")).not.toBeNull();
});

it("shows Pico's live dashboard stream rate with sampling paused, then clears on idle", () => {
  const llm = {
    ...makeSpark().metrics.llm[0], backend: "pico" as const,
    generationTps: 75, generationTpsSource: "dashboard-stream" as const,
    prefillTps: 0, decodeActive: true,
  };
  const { container, root } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8888} />);
  expect(container.querySelector(".sp-decode .big-num")?.textContent).toBe("75.0tok/s");
  expect(container.textContent).toContain("Dashboard streams");
  expect(container.textContent).not.toContain("sampled");
  expect(container.querySelector("[data-llm-idle]")).toBeNull();
  act(() => root.render(<LlmPanel llm={{ ...llm, generationTps: 0, decodeActive: false }} sparkId="fixture" llmPort={8888} />));
  expect(container.querySelector(".sp-decode .big-num")?.textContent).toBe("0.0tok/s");
  expect(container.querySelector("[data-llm-idle]")).not.toBeNull();
});
