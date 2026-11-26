import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";

// The panels are covered by their own tests; only the History panel's placement is under test here.
vi.mock("./GpuPanel", () => ({ GpuPanel: () => null }));
vi.mock("./CpuPanel", () => ({ CpuPanel: () => null }));
vi.mock("./RamPanel", () => ({ RamPanel: () => null }));
vi.mock("./StoragePanel", () => ({ StoragePanel: () => null }));
vi.mock("./NetworkPanel", () => ({ NetworkPanel: () => null }));
vi.mock("./TailscalePanel", () => ({ TailscalePanel: () => null }));
vi.mock("./LlmPanel", () => ({ LlmPanel: () => null }));
vi.mock("./ComfyPanel", () => ({ ComfyPanel: () => null }));
vi.mock("./LlmModelsPanel", () => ({ LlmModelsPanel: () => <section data-testid="models" /> }));
vi.mock("./RocePanel", () => ({ RocePanel: () => null }));
vi.mock("./UnifiedMemoryPanel", () => ({ UnifiedMemoryPanel: () => null }));
vi.mock("./SparkHeader", () => ({ SparkHeader: () => null }));
vi.mock("./SparkActions", () => ({ SparkActions: () => null }));
vi.mock("../../api/client", () => ({
  getUnitHistory: vi.fn(() => Promise.resolve({ enabled: false })),
  updateSpark: vi.fn(),
  refreshSparkMetric: vi.fn(),
  addLlmPort: vi.fn(),
  removeLlmPort: vi.fn(),
}));

import { getUnitHistory } from "../../api/client";
import { SparkPage } from "./SparkPage";

beforeEach(() => {
  localStorage.clear();
  vi.mocked(getUnitHistory).mockReset();
  vi.mocked(getUnitHistory).mockResolvedValue({ enabled: false });
});

describe("SparkPage History panel", () => {
  it("places one Models control surface on an agent Mac", async () => {
    const spark = { ...makeSpark(), kind: "mac" as const, macTransport: "agent" as const };
    const { container } = render(<SparkPage spark={spark} temperatureUnit="celsius" />);
    await flush();
    expect(container.querySelectorAll('[data-testid="models"]')).toHaveLength(1);
    expect(container.textContent).not.toContain("Runtime launcher");
  });
  it("is absent while the setting is off — the page is unchanged", async () => {
    const { container } = render(<SparkPage spark={makeSpark()} temperatureUnit="celsius" />);
    await flush();
    expect(container.textContent).not.toContain("History");
    expect(getUnitHistory).not.toHaveBeenCalled();
  });

  it("closes the hardware column with the setting on, last when the columns stack", async () => {
    const { container } = render(<SparkPage spark={makeSpark()} temperatureUnit="celsius" metricsHistory />);
    await flush();
    const [hardware] = container.querySelectorAll(".sp-cols > .sp-col");
    const item = hardware.lastElementChild as HTMLElement;
    const panel = item.querySelector(".sp-hist")!;
    expect(panel).not.toBeNull();
    const orders = [...container.querySelectorAll<HTMLElement>(".sp-item")].map((el) => Number(el.style.getPropertyValue("--o")));
    expect(Number(item.style.getPropertyValue("--o"))).toBe(Math.max(...orders));
    expect(panel.querySelector(".panel-title")!.textContent).toContain("History · last hour");
    expect(getUnitHistory).toHaveBeenCalledWith("spark-1", "1h");
    expect(container.textContent).toContain("Metrics history is off on the server");
  });

  it("passes liveLlm to HistoryPanel only when the unit is online and LLM monitoring is enabled", async () => {
    vi.mocked(getUnitHistory).mockResolvedValue({
      enabled: true,
      range: "1h",
      stepMs: 60_000,
      from: 0,
      to: 60_000,
      points: [{ t: 0, gpuUtil: { avg: 10, max: 10 } }],
      llm: [{ port: 8888, points: [{ t: 0, kvUsage: { avg: 0.25, max: 0.25 } }] }],
    });
    const base = makeSpark();
    const liveLlm = [{ ...base.metrics.llm[0], port: 8888, kvCacheTokens: 6_291_456, kvCacheUsageBasis: "pool" as const }];
    const online = { ...base, online: true, llmMonitoring: true, metrics: { ...base.metrics, llm: liveLlm } };
    const { container, root } = render(<SparkPage spark={online} temperatureUnit="celsius" metricsHistory />);
    await flush();
    expect(container.querySelector('[data-chart="llm-8888-kv"] [data-tokens]')?.textContent).toBe("1.6M / 6.3M tok (at current pool size)");

    const offline = { ...online, online: false };
    act(() => root.render(<SparkPage spark={offline} temperatureUnit="celsius" metricsHistory />));
    await flush();
    expect(container.querySelector('[data-chart="llm-8888-kv"] [data-tokens]')).toBeNull();

    const llmOff = { ...online, llmMonitoring: false };
    act(() => root.render(<SparkPage spark={llmOff} temperatureUnit="celsius" metricsHistory />));
    await flush();
    expect(container.querySelector('[data-chart="llm-8888-kv"] [data-tokens]')).toBeNull();
  });
});
