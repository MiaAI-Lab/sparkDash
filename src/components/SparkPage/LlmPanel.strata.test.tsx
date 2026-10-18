import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import { LlmPanel } from "./LlmPanel";

vi.mock("./LlmTokenTotals", () => ({ LlmTokenTotals: () => null }));
vi.mock("./LlmDailyChart", () => ({ LlmDailyChart: () => null }));
vi.mock("./LlmTrendChart", () => ({ LlmTrendChart: () => null }));

function strata(overrides: Record<string, unknown> = {}) {
  return {
    ...makeSpark().metrics.llm[0],
    backend: "strata" as const,
    slotsActive: 2,
    slotsTotal: 4,
    ...overrides,
  };
}

describe("Strata live metrics", () => {
  it("renders both rates, the Strata badge, and rate provenance", () => {
    const { container } = render(
      <LlmPanel
        llm={strata({ generationTps: 42.5, generationTpsSource: "slot-mean", prefillTps: 1_024 })}
        sparkId="fixture"
        llmPort={8888}
      />,
    );

    expect(container.textContent).toContain("Strata · :8888");
    expect(container.textContent).toContain("42.5");
    expect(container.textContent).toContain("1,024");
    expect(container.textContent).toContain("active-slot mean");
    expect(container.textContent).toContain("last reported mean");
    expect(container.textContent).toContain("2 / 4");
    expect([...container.querySelectorAll(".sp-metric")].find((el) => el.textContent?.includes("Decode"))?.getAttribute("title")).toContain("sliding-window");
    expect([...container.querySelectorAll(".sp-metric")].find((el) => el.textContent?.includes("Prefill"))?.getAttribute("title")).toContain("not an aggregate across slots");
  });

  it("shows concurrent activity without fabricated zero rates, then clears it when idle", () => {
    const first = strata({ generationTps: 0, prefillTps: 0, decodeActive: true, prefillActive: true });
    const { container, root } = render(<LlmPanel llm={first} sparkId="fixture" llmPort={8888} />);

    expect(container.textContent).toContain("decoding");
    expect(container.textContent).toContain("prefilling");
    expect(container.querySelector("[data-llm-idle]")).toBeNull();

    act(() => root.render(<LlmPanel llm={strata({ generationTps: 0, prefillTps: 0, decodeActive: false, prefillActive: false })} sparkId="fixture" llmPort={8888} />));

    expect(container.textContent).not.toContain("decoding");
    expect(container.textContent).not.toContain("prefilling");
    expect(container.querySelector("[data-llm-idle]")?.textContent).toMatch(/^Idle/);
  });

  it("distinguishes running requests from occupied batch slots", () => {
    const { container } = render(<LlmPanel llm={strata({ slotsActive: 0, requestsRunning: 4,
      requestsWaiting: 0, prefillActive: true, prefillTps: 6300 })} sparkId="fixture" llmPort={8888} />);
    expect(container.textContent).toContain("0 / 4");
    expect(container.textContent).toContain("4 / 0");
    expect(container.textContent).toContain("Running / waiting");
  });
});
