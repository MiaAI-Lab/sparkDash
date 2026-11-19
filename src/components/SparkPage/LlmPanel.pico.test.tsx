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

// A front end that serves /metrics (pico-dgx-ds4's dsfront) publishes counters, so the probe derives
// decode from a counter diff and labels it "window". That is a measurement and must be shown: the
// "—" is only for a build that publishes nothing at all.
it("shows Pico's counter-derived window decode rate", () => {
  const llm = {
    ...makeSpark().metrics.llm[0], backend: "pico" as const,
    generationTps: 40, generationTpsSource: "window" as const,
    prefillTps: 0, decodeActive: true,
  };
  const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8888} />);
  expect(container.querySelector(".sp-decode .big-num")?.textContent).toBe("40.0tok/s");
  expect(container.textContent).not.toContain("sampled");
});

it("shows no Pico decode figure when the front end publishes no counters", () => {
  const llm = {
    ...makeSpark().metrics.llm[0], backend: "pico" as const,
    generationTps: 0, generationTpsSource: null,
    prefillTps: 0, decodeActive: false,
  };
  const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8888} />);
  expect(container.querySelector(".sp-decode .big-num")?.textContent).toBe("—");
});

it("shows Pico's measured prefill split and the request gauges from /metrics", () => {
  const llm = {
    ...makeSpark().metrics.llm[0], backend: "pico" as const,
    generationTps: 40, generationTpsSource: "window" as const, decodeActive: true,
    prefillTps: 400, prefillTpsSource: "completed-split" as const,
    uncachedPrefillTps: 400, cachedPrefillTps: 1600,
    requestsRunning: 2, requestsWaiting: 1,
  };
  const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8888} />);
  // The split is computed tokens only, so the label must not claim it includes cached tokens.
  expect(container.textContent).toContain("Computed tokens · cached excluded");
  expect(container.textContent).not.toContain("Effective rate · includes cached tokens");
  expect(container.textContent).toContain("400.0tok/s");
  // The two request gauges are the only engine tiles a counter-only build can fill.
  expect(container.textContent).toContain("2 / 1");
});
