import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GpuHistoryChart } from "./GpuHistoryChart";
import { flush, render } from "../../testing/render";
import { _resetStore, ingestSnapshots } from "../../hooks/metricsStore";
import { makeSpark } from "../../testing/fixtures";
import type { GpuDevice, GpuMetrics } from "../../api/types";

vi.mock("../../api/client", () => ({
  getGpuHistory: vi.fn(() => Promise.resolve({ t: [], u: [], c: [], p: [] })),
}));

const dev = (index: number, usage: number): GpuDevice => ({
  index,
  name: `Card ${index}`,
  uuid: null,
  temperature: 40 + index,
  usage,
  power: { draw: 10, limit: 100 },
  vram: { used: 1, total: 2, percentage: 50, available: 1 },
});

function feed(devices: GpuDevice[]): GpuMetrics {
  const spark = makeSpark();
  const gpu = spark.metrics.gpu!;
  gpu.gpus = devices;
  for (let i = 0; i < 4; i++) {
    devices.forEach((d, k) => (d.usage = 10 + i * 5 + k));
    gpu.usage = 10 + i * 5;
    ingestSnapshots([spark], 1_000 + i * 2_000);
  }
  return gpu;
}

const buttons = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLButtonElement>(".seg button")).map((b) => b.textContent);

describe("GpuHistoryChart", () => {
  beforeEach(() => {
    _resetStore();
    localStorage.clear();
  });

  it("shows no toggle for a single GPU", async () => {
    const gpu = feed([dev(0, 10)]);
    const { container } = render(<GpuHistoryChart sparkId="spark-1" gpu={gpu} windowMs={60_000} />);
    await flush();
    expect(container.querySelector(".seg")).toBeNull();
    expect(container.querySelectorAll("svg path[stroke]").length).toBe(3);
  });

  it("offers Combined / All GPUs / per-card buttons and draws a line per card", async () => {
    const gpu = feed([dev(0, 10), dev(1, 20)]);
    const { container } = render(<GpuHistoryChart sparkId="spark-1" gpu={gpu} windowMs={60_000} />);
    await flush();
    expect(buttons(container).slice(0, 4)).toEqual(["Combined", "All GPUs", "GPU 0", "GPU 1"]);
    const stroked = () => Array.from(container.querySelectorAll("svg path[stroke]")).map((p) => p.getAttribute("stroke"));
    expect(new Set(stroked()).size).toBe(2);
    expect(container.querySelector(".legend")?.textContent).toContain("GPU 1");
  });

  it("switching to one card plots its three metrics and remembers the choice", async () => {
    const gpu = feed([dev(0, 10), dev(1, 20)]);
    const { container } = render(<GpuHistoryChart sparkId="spark-1" gpu={gpu} windowMs={60_000} />);
    await flush();
    const gpu1 = Array.from(container.querySelectorAll<HTMLButtonElement>(".seg button")).find((b) => b.textContent === "GPU 1")!;
    act(() => gpu1.click());
    expect(gpu1.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("sparkdash.gpuChart.view")).toBe("1");
    expect(container.querySelector(".legend")?.textContent).toContain("Power % of limit");
  });
});
