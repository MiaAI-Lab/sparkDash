import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGpuHistory } from "../../api/client";
import { _resetStore, ingestSnapshots } from "../../hooks/metricsStore";
import { setLocale } from "../../i18n";
import type { GpuDevice, GpuMetrics } from "../../api/types";
import { makeSpark } from "../../testing/fixtures";
import { flush, render } from "../../testing/render";
import { GpuHistoryChart } from "./GpuHistoryChart";

vi.mock("../../api/client", () => ({
  getGpuHistory: vi.fn(() => Promise.resolve({ t: [], u: [], c: [], p: [] })),
}));

const device = (index: number, usage: number): GpuDevice => ({
  index,
  physicalIndex: index + 6,
  vendor: index === 1 ? "amd" : "nvidia",
  name: index === 1 ? "Raw AMD card / 7" : "Raw NVIDIA card / 6",
  uuid: null,
  temperature: 40 + index,
  usage,
  power: { draw: 10, limit: 100 },
  vram: { used: 1, total: 2, percentage: 50, available: 1 },
});

function feed(devices: GpuDevice[]): GpuMetrics {
  const spark = makeSpark("gpu-i18n");
  const gpu = spark.metrics.gpu!;
  gpu.gpus = devices;
  for (let i = 0; i < 4; i++) {
    devices.forEach((d, k) => (d.usage = 10 + i * 5 + k));
    gpu.usage = 10 + i * 5;
    ingestSnapshots([spark], 1_000 + i * 2_000);
  }
  return gpu;
}

const chartPaths = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("svg path[stroke]"), (path) => path.getAttribute("d"));

const chartStorageWrites = (calls: unknown[][]) =>
  calls.filter(([key]) => typeof key === "string" && key.startsWith("sparkdash.gpuChart."));

describe("GpuHistoryChart i18n", () => {
  beforeEach(async () => {
    _resetStore();
    localStorage.clear();
    vi.clearAllMocks();
    await act(() => setLocale("en"));
  });

  afterEach(async () => {
    await act(() => setLocale("en"));
  });

  it("localizes its presentation without changing selected data, geometry, requests, or raw card names", async () => {
    const storageSet = vi.spyOn(Storage.prototype, "setItem");
    const gpu = feed([device(0, 10), device(1, 20)]);
    const { container } = render(<GpuHistoryChart sparkId="gpu-i18n" gpu={gpu} windowMs={60_000} />);
    await flush();

    const all = Array.from(container.querySelectorAll<HTMLButtonElement>(".seg button")).find((button) => button.textContent === "All GPUs")!;
    act(() => all.click());
    const power = Array.from(container.querySelectorAll<HTMLButtonElement>(".seg button")).find((button) => button.textContent === "Power")!;
    act(() => power.click());
    const paths = chartPaths(container);
    const requests = vi.mocked(getGpuHistory).mock.calls.length;
    expect(localStorage.getItem("sparkdash.gpuChart.view")).toBe("all");
    expect(localStorage.getItem("sparkdash.gpuChart.metric")).toBe("powerPct");
    expect(container.querySelector('button[title="Raw AMD card / 7"]')?.textContent).toBe("AMD GPU 7");

    storageSet.mockClear();
    await act(() => setLocale("zh-CN"));
    expect(container.textContent).toContain("所有 GPU");
    expect(container.textContent).toContain("功耗");
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("GPU 利用率、功耗和温度历史");
    expect(container.querySelector('button[title="Raw AMD card / 7"]')?.textContent).toBe("AMD GPU 7");
    expect(chartPaths(container)).toEqual(paths);
    expect(localStorage.getItem("sparkdash.gpuChart.view")).toBe("all");
    expect(localStorage.getItem("sparkdash.gpuChart.metric")).toBe("powerPct");
    expect(vi.mocked(getGpuHistory).mock.calls).toHaveLength(requests);
    expect(chartStorageWrites(storageSet.mock.calls)).toEqual([]);

    storageSet.mockClear();
    await act(() => setLocale("en"));
    expect(container.textContent).toContain("All GPUs");
    expect(container.textContent).toContain("Power");
    expect(chartPaths(container)).toEqual(paths);
    expect(vi.mocked(getGpuHistory).mock.calls).toHaveLength(requests);
    expect(chartStorageWrites(storageSet.mock.calls)).toEqual([]);
  });
});
