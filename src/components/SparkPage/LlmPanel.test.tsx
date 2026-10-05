import { describe, expect, it, vi } from "vitest";
import type { LlmMetrics } from "../../api/types";
import { render } from "../../testing/render";
import { backendLabel } from "../../shared/llmBackends.js";
import { LlmPanel } from "./LlmPanel";

vi.mock("../../hooks/metricsStore", () => ({
  useMetricsHistory: () => [],
  useMetricsHistoryTail: () => [],
  avgPositive: () => null,
}));
vi.mock("./BenchmarkDialog", () => ({ BenchmarkDialog: () => null }));
vi.mock("./PrefillBenchDialog", () => ({ PrefillBenchDialog: () => null }));
vi.mock("./LlmDailyChart", () => ({ LlmDailyChart: () => null }));
vi.mock("./LlmTrendChart", () => ({ LlmTrendChart: () => null }));
vi.mock("./LlmTokenTotals", () => ({ LlmTokenTotals: () => null }));

function metrics(overrides: Partial<LlmMetrics> = {}): LlmMetrics {
  return {
    available: true,
    backend: "freetoken",
    modelId: "example-model",
    modelPath: null,
    contextLength: 131072,
    gpuMemoryUtilization: null,
    slotsActive: 2,
    slotsTotal: null,
    generationTps: 42.5,
    prefillTps: 850,
    totalOutputTokens: 2000,
    totalPromptTokens: 10000,
    totalCachedTokens: null,
    kvCacheUsage: 0.25,
    requestsRunning: 2,
    requestsWaiting: null,
    ttftSeconds: 0.321,
    ttftP95Seconds: null,
    e2eP95Seconds: 1.234,
    preemptionsTotal: null,
    prefixCacheHitRate: null,
    itlP95Seconds: null,
    mtpAcceptanceRate: null,
    error: null,
    ...overrides,
  };
}

function panel(overrides: Partial<LlmMetrics> = {}) {
  return render(<LlmPanel llm={metrics(overrides)} sparkId="test-spark" llmPort={1919} />).container;
}

function cell(container: HTMLElement, label: string) {
  const heading = [...container.querySelectorAll("span, div")].find((element) => element.textContent === label);
  return heading?.closest('[class*="space-y-0.5"]')?.textContent;
}

describe("FreeToken LLM panel", () => {
  it("uses the shared FreeToken label and displays native telemetry", () => {
    expect(backendLabel("freetoken")).toBe("FreeToken");
    const container = panel();
    expect(container.textContent).toContain("FreeToken");
    expect(cell(container, "KV Cache")).toContain("25.0%");
    expect(cell(container, "Requests")).toContain("2 run");
    expect(cell(container, "E2E p95")).toContain("1.234s");
  });

  it("labels TTFT mean without presenting it as a percentile", () => {
    const container = panel();
    expect(cell(container, "TTFT avg")).toContain("0.321s");
    expect(container.textContent).not.toContain("TTFT p95");
  });

  it("describes the native prefill window independently of dashboard polling", () => {
    const container = panel();
    const label = [...container.querySelectorAll("span")].find((element) => element.textContent === "Prefill tok/s");
    expect(label?.parentElement?.title).toContain("five-second sliding window");
    expect(label?.parentElement?.title).not.toContain("last poll window");
  });

  it("does not invent capacity, queue length, or unsupported metrics", () => {
    const container = panel();
    expect(cell(container, "Slots")).toContain("2 running");
    expect(cell(container, "Slots")).not.toContain(" / ");
    expect(cell(container, "Requests")).not.toContain("wait");
    for (const label of ["Preempts", "Prefix Cache", "ITL p95", "MTP Accept"]) {
      expect(cell(container, label)).toContain("—");
    }
  });

  it("keeps missing optional telemetry unavailable", () => {
    const container = panel({ kvCacheUsage: null, ttftSeconds: null, e2eP95Seconds: null });
    for (const label of ["KV Cache", "TTFT avg", "E2E p95"]) {
      expect(cell(container, label)).toContain("—");
    }
  });

  it("does not render stale telemetry when the probe is unavailable", () => {
    const container = panel({ available: false, error: "FreeToken stats unavailable" });
    expect(container.textContent).toContain("No model loaded");
    expect(container.textContent).not.toContain("42.5");
    expect(container.textContent).not.toContain("TTFT avg");
  });

  it("preserves the vLLM percentile and capacity display", () => {
    const container = panel({ backend: "vllm", slotsTotal: 4, requestsWaiting: 0, ttftP95Seconds: 1.5 });
    expect(cell(container, "Slots")).toContain("2 / 4");
    expect(cell(container, "Requests")).toContain("2 run / 0 wait");
    expect(cell(container, "TTFT p95")).toContain("1.500s");
    expect(container.textContent).not.toContain("TTFT avg");
  });
});
