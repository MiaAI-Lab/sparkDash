import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { SparkCard } from "./SparkCard";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";

vi.mock("../../api/client", () => ({
  fetchLaunchers: () => new Promise(() => {}),
  runLauncher: vi.fn(),
  wakeSpark: vi.fn(),
}));

function strata(overrides: Record<string, unknown> = {}) {
  const spark = makeSpark();
  Object.assign(spark.metrics.llm[0], {
    backend: "strata",
    slotsActive: 2,
    slotsTotal: 4,
    ...overrides,
  });
  return spark;
}

describe("SparkCard Strata throughput", () => {
  it("shows the shared engine context for Strata model aliases", () => {
    const { container } = render(<SparkCard spark={strata({
      contextLength: 262144,
      models: ["fixture-model", "fixture-alias", "fixture-quant", "fixture-version"],
    })} temperatureUnit="celsius" />);
    expect(container.textContent).toContain("256k ctx");
  });

  it("shows positive rates and makes their provenance clear", () => {
    const { container } = render(
      <SparkCard
        spark={strata({ generationTps: 42.5, generationTpsSource: "slot-mean", prefillTps: 1_024 })}
        temperatureUnit="celsius"
      />,
    );

    expect(container.textContent).toContain("43 tok/s");
    expect(container.textContent).toMatch(/prefill 1024/);
    expect(container.textContent).toContain("active-slot mean");
    expect(container.textContent).toContain("last reported mean");
    expect(container.querySelector('.ov-llm-footer [title*="sliding-window"]')).not.toBeNull();
    expect(container.querySelector('.ov-llm-footer [title*="not an aggregate across slots"]')).not.toBeNull();
  });

  it("shows simultaneous active work without zero rates, then clears it when idle", () => {
    const { container, root } = render(
      <SparkCard spark={strata({ generationTps: 0, prefillTps: 0, decodeActive: true, prefillActive: true })} temperatureUnit="celsius" />,
    );

    expect(container.textContent).toContain("decoding");
    expect(container.textContent).toContain("prefilling");

    act(() => root.render(<SparkCard spark={strata({ generationTps: 0, prefillTps: 0, decodeActive: false, prefillActive: false })} temperatureUnit="celsius" />));

    expect(container.textContent).not.toContain("decoding");
    expect(container.textContent).not.toContain("prefilling");
    expect(container.textContent).toContain("0 tok/s");
    expect(container.textContent).toMatch(/prefill 0/);
  });
});
