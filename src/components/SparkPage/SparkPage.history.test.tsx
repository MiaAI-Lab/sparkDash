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
vi.mock("./LlmModelsPanel", () => ({ LlmModelsPanel: () => null }));
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
  vi.mocked(getUnitHistory).mockClear();
});

describe("SparkPage History panel", () => {
  it("is absent while the setting is off — the page is unchanged", async () => {
    const { container } = render(<SparkPage spark={makeSpark()} temperatureUnit="celsius" />);
    await flush();
    expect(container.textContent).not.toContain("History");
    expect(getUnitHistory).not.toHaveBeenCalled();
  });

  it("appears under both columns, full width, with the setting on", async () => {
    const { container } = render(<SparkPage spark={makeSpark()} temperatureUnit="celsius" metricsHistory />);
    await flush();
    const page = container.querySelector(".sp")!;
    const panel = [...page.children].at(-1)!;
    expect(panel.previousElementSibling?.className).toBe("sp-cols");
    expect(panel.querySelector(".panel-title")!.textContent).toContain("History · last hour");
    expect(getUnitHistory).toHaveBeenCalledWith("spark-1", "1h");
    expect(container.textContent).toContain("Metrics history is off on the server");
  });
});
