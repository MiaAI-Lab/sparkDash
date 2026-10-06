import { afterEach, describe, expect, it, vi } from "vitest";
import { OverviewPage } from "./OverviewPage";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import { idleLabel, isLlmIdle } from "../../shared/llmIdle";

const NOW = 1_800_000_000_000;

function sparkWithRates(generationTps: number, prefillTps: number, lastActiveAt: number | null) {
  const spark = makeSpark();
  Object.assign(spark.metrics.llm[0], { generationTps, prefillTps, lastActiveAt });
  return spark;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Overview LLM footer", () => {
  it("renders the two rates exactly as before while the endpoint is serving", () => {
    const { container } = render(<OverviewPage sparks={[sparkWithRates(20, 0, NOW)]} />);
    const rates = container.querySelector<HTMLElement>("[data-llm-rates]");
    expect(rates?.className).not.toContain("invisible");
    expect(rates?.getAttribute("aria-hidden")).toBeNull();
    expect(rates?.textContent).toBe("20 tok/s0 prefill");
    expect(container.querySelector("[data-llm-idle]")).toBeNull();
  });

  it("counts prefill alone as serving", () => {
    const { container } = render(<OverviewPage sparks={[sparkWithRates(0, 350, null)]} />);
    expect(container.querySelector("[data-llm-idle]")).toBeNull();
    expect(container.querySelector("[data-llm-rates]")?.textContent).toContain("350");
  });

  it("replaces the two zeros with when it last served", () => {
    vi.useFakeTimers({ now: NOW });
    const { container } = render(
      <OverviewPage sparks={[sparkWithRates(0, 0, NOW - 12 * 60_000 - 5_000)]} />,
    );
    expect(container.querySelector("[data-llm-idle]")?.textContent).toBe(
      "Idle · last served 12m ago",
    );
    // The rate row stays in the layout (hidden) so the card does not change height.
    const rates = container.querySelector<HTMLElement>("[data-llm-rates]");
    expect(rates?.className).toContain("invisible");
    expect(rates?.getAttribute("aria-hidden")).toBe("true");
  });

  it("says just Idle when the server has not seen it serve since it started", () => {
    const { container } = render(<OverviewPage sparks={[sparkWithRates(0, 0, null)]} />);
    expect(container.querySelector("[data-llm-idle]")?.textContent).toBe("Idle");
  });
});

describe("llm idle helpers", () => {
  it("treats only positive finite rates as serving", () => {
    expect(isLlmIdle({ generationTps: 0, prefillTps: 0 })).toBe(true);
    expect(isLlmIdle({ generationTps: Number.NaN, prefillTps: 0 })).toBe(true);
    expect(isLlmIdle({ generationTps: 0.2, prefillTps: 0 })).toBe(false);
    expect(isLlmIdle({ generationTps: 0, prefillTps: 1 })).toBe(false);
  });

  it("labels the idle state", () => {
    expect(idleLabel(NOW - 30_000, NOW)).toBe("Idle · last served 30s ago");
    expect(idleLabel(NOW - 3 * 3_600_000, NOW)).toBe("Idle · last served 3h ago");
    expect(idleLabel(null, NOW)).toBe("Idle");
    expect(idleLabel(undefined, NOW)).toBe("Idle");
  });
});
