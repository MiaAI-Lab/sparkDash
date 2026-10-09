import { describe, expect, it } from "vitest";
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

describe("Overview LLM footer", () => {
  it("shows both rates, zeros included, while the endpoint is idle", () => {
    const { container } = render(<OverviewPage sparks={[sparkWithRates(0, 0, NOW - 60_000)]} />);
    const text = container.textContent ?? "";
    expect(text).toMatch(/Decode0\.0tok\/s/);
    expect(text).toMatch(/Prefill0tok\/s/);
    expect(container.textContent).not.toContain("Idle");
  });

  it("shows the live rates while it is serving", () => {
    const { container } = render(<OverviewPage sparks={[sparkWithRates(20, 350, NOW)]} />);
    const text = container.textContent ?? "";
    expect(text).toMatch(/Decode20\.0tok\/s/);
    expect(text).toMatch(/Prefill350tok\/s/);
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
