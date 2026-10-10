import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { benchmark } = vi.hoisted(() => ({ benchmark: vi.fn((_props: { liveTps: number | null; modelId: string | null }) => null) }));
vi.mock("./BenchmarkDialog", () => ({ BenchmarkDialog: benchmark }));
vi.mock("./PrefillBenchDialog", () => ({ PrefillBenchDialog: () => null }));
vi.mock("./QualityBenchDialog", () => ({ QualityBenchDialog: () => null }));
vi.mock("./LlmDailyChart", () => ({ LlmDailyChart: () => null }));
vi.mock("./LlmTokenTotals", () => ({ LlmTokenTotals: () => null }));

import { LlmPanel } from "./LlmPanel";
import { _resetStore, ingestSnapshots } from "../../hooks/metricsStore";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";

describe("LlmPanel live-rate availability", () => {
  beforeEach(() => {
    _resetStore();
    benchmark.mockClear();
  });

  function withHistory() {
    const spark = makeSpark();
    ingestSnapshots([spark], 1_000);
    spark.metrics.llm[0].generationTps = 40;
    spark.metrics.llm[0].prefillTps = 400;
    ingestSnapshots([spark], 2_000);
    return spark;
  }

  it("shows unknown live rates without stale averages or idle claims and keeps Decode available", () => {
    const spark = withHistory();
    Object.assign(spark.metrics.llm[0], { backend: "ollama", liveRatesAvailable: false, generationTps: 0, prefillTps: 0, totalOutputTokens: null });
    const { container } = render(<LlmPanel llm={spark.metrics.llm[0]} sparkId={spark.id} llmPort={8888} />);
    const rates = container.querySelector(".sp-decode")!;
    expect([...rates.querySelectorAll(".big-num")].map((el) => el.textContent)).toEqual(["—tok/s", "—tok/s"]);
    expect(rates.querySelector("svg")).toBeNull();
    expect(rates.querySelector(".sp-avg")).toBeNull();
    expect(container.querySelector("[data-llm-idle]")).toBeNull();
    const counter = [...container.querySelectorAll(".sp-tile")].find((el) => el.textContent?.includes("Generated (engine)"));
    expect(counter?.querySelector("b")?.textContent).toBe("—");
    expect(benchmark.mock.calls.at(-1)?.[0]).toMatchObject({ liveTps: null, modelId: "fixture-model" });
    const decode = [...container.querySelectorAll("button")].find((el) => el.textContent === "Decode")!;
    expect(decode.disabled).toBe(false);
    const onNavigate = vi.fn();
    window.addEventListener("sparkdash:navigate", onNavigate);
    try {
      act(() => decode.click());
      expect(onNavigate.mock.calls[0][0].detail).toEqual({ id: "__bench__:decode", spark: spark.id });
    } finally {
      window.removeEventListener("sparkdash:navigate", onNavigate);
    }
  });

  it("retains measured-backend rates, history and benchmark throughput", () => {
    const spark = withHistory();
    const { container } = render(<LlmPanel llm={spark.metrics.llm[0]} sparkId={spark.id} llmPort={8888} />);
    const rates = container.querySelector(".sp-decode")!;
    expect([...rates.querySelectorAll(".big-num")].map((el) => el.textContent)).toEqual(["40.0tok/s", "400.0tok/s"]);
    expect(rates.querySelector("svg")).not.toBeNull();
    expect(rates.textContent).toContain("avg 30.0");
    expect(benchmark.mock.calls.at(-1)?.[0]).toMatchObject({ liveTps: 40 });
  });
});
