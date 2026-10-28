import { describe, expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import { LlmPanel } from "./LlmPanel";

vi.mock("./LlmTokenTotals", () => ({ LlmTokenTotals: () => null }));
vi.mock("./LlmDailyChart", () => ({ LlmDailyChart: () => null }));
vi.mock("./LlmTrendChart", () => ({ LlmTrendChart: () => null }));

describe("TensorFold slot tile", () => {
  it.each([null, 0, 8])("renders occupancy %s with known capacity", (active) => {
    const llm = { ...makeSpark().metrics.llm[0], backend: "tensorfold" as const, slotsActive: active, slotsTotal: 8 };
    const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8888} />);
    const tile = [...container.querySelectorAll(".sp-tile")].find((el) => el.querySelector("span")?.textContent === "Slots");
    expect(tile?.querySelector("b")?.textContent).toBe(`${active ?? "?"} / 8`);
  });
});

describe("TensorFold with no published stream count", () => {
  it("shows the running streams, not a made-up total", () => {
    const llm = { ...makeSpark().metrics.llm[0], backend: "tensorfold" as const, slotsActive: 3, slotsTotal: 0 };
    const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8888} />);
    const tile = [...container.querySelectorAll(".sp-tile")].find((el) => el.querySelector("span")?.textContent === "Slots");
    expect(tile?.querySelector("b")?.textContent).toBe("3 running");
  });
});

describe("TensorFold prefill tile", () => {
  it("names the computed rate and the cached rate beside it", () => {
    const llm = {
      ...makeSpark().metrics.llm[0], backend: "tensorfold" as const,
      prefillTps: 1156.25, uncachedPrefillTps: 1156.25, cachedPrefillTps: 31343.75, perStreamPrefillTps: null,
    };
    const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8888} />);
    const prefill = [...container.querySelectorAll(".sp-metric")].find((el) => el.textContent?.includes("Prefill") && el.getAttribute("title"));
    expect(prefill?.getAttribute("title")).toContain("computed per second of prefill time");
    expect(container.textContent).toContain("Cached prefill");
    expect(container.textContent).toContain("Uncached prefill");
    expect(container.textContent).not.toContain("effective (incl. cached tokens)");
  });
});

describe("Radiance engine tiles", () => {
  it("shows the vLLM-format KV cache tile", () => {
    const llm = { ...makeSpark().metrics.llm[0], backend: "radiance" as const, kvCacheUsage: 0.25, kvCacheTokens: 1_087_768, ttftP95Seconds: 0.4 };
    const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8888} />);
    const labels = [...container.querySelectorAll(".sp-tile")].map((el) => el.querySelector("span")?.textContent);
    expect(labels).toContain("KV cache");
    expect(labels).toContain("TTFT p95");
  });
});
