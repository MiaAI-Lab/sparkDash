import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";

// The panels are covered by their own tests; only the History section is under test here.
vi.mock("./GpuPanel", () => ({ GpuPanel: () => null }));
vi.mock("./CpuPanel", () => ({ CpuPanel: () => null }));
vi.mock("./RamPanel", () => ({ RamPanel: () => null }));
vi.mock("./StoragePanel", () => ({ StoragePanel: () => null }));
vi.mock("./NetworkPanel", () => ({ NetworkPanel: () => null }));
vi.mock("./TailscalePanel", () => ({ TailscalePanel: () => null }));
vi.mock("./LlmPanel", () => ({ LlmPanel: () => null }));
vi.mock("./ComfyPanel", () => ({ ComfyPanel: () => null }));
vi.mock("./SparkHeader", () => ({ SparkHeader: () => null }));
vi.mock("./SparkActions", () => ({ SparkActions: () => null }));
vi.mock("../../api/client", () => ({
  fetchMetricsHistory: vi.fn(() => Promise.resolve({ enabled: false })),
  updateSpark: vi.fn(),
  refreshSparkMetric: vi.fn(),
  addLlmPort: vi.fn(),
  removeLlmPort: vi.fn(),
}));

import { fetchMetricsHistory } from "../../api/client";
import { SparkPage } from "./SparkPage";

const headings = (container: HTMLElement) =>
  [...container.querySelectorAll("button[aria-expanded]")].map((b) => b.textContent);

beforeEach(() => localStorage.clear());

describe("SparkPage History section", () => {
  it("is absent while the setting is off — the page is unchanged", async () => {
    const { container } = render(<SparkPage spark={makeSpark()} temperatureUnit="celsius" />);
    await flush();
    expect(headings(container)).toEqual(["Resources", "Services"]);
    expect(fetchMetricsHistory).not.toHaveBeenCalled();
  });

  it("appears with the setting on, and collapsing it stops fetching and is remembered", async () => {
    const { container } = render(
      <SparkPage spark={makeSpark()} temperatureUnit="celsius" metricsHistory />,
    );
    await flush();
    expect(headings(container)).toEqual(["Resources", "Services", "History"]);
    expect(fetchMetricsHistory).toHaveBeenCalledWith("spark-1", "1h");
    expect(container.textContent).toContain("Metrics history is off on the server");

    const toggle = [...container.querySelectorAll("button[aria-expanded]")].find(
      (b) => b.textContent === "History",
    )!;
    act(() => (toggle as HTMLButtonElement).click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Metrics history is off on the server");
    expect(localStorage.getItem("sparkdash.ui.section.history")).toBe("0");
  });
});
