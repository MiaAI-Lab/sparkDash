import { describe, expect, it } from "vitest";
import { GpuPanel } from "./GpuPanel";
import { MetricBar } from "../ui/MetricBar";
import { render } from "../../testing/render";
import type { GpuMetrics } from "../../api/types";
import type { VramBreakdownContext } from "../../shared/vramBreakdown";

const SPARK1_UM = { total: 124_610, gpuUsed: 101_008, cpuUsed: 16_190, available: 7_412 };

function spark1Gpu(): GpuMetrics {
  return {
    temperature: 43,
    usage: 0,
    power: { draw: 7, limit: 100 },
    vram: { used: 101_008, total: 124_610, percentage: 81, available: 7_412 },
    processes: [{ pid: 92_271, name: "python3", vramMB: 101_008 }],
  };
}

/** Two-card host: llama.cpp split across both cards, plus a small helper on card 1. */
function twoCardGpu(): GpuMetrics {
  const card = (index: number, used: number, processes: GpuMetrics["processes"]) => ({
    index,
    name: index === 0 ? "NVIDIA GeForce RTX 5080" : "NVIDIA GeForce RTX 5060 Ti",
    uuid: `GPU-${index}`,
    temperature: 50,
    usage: 10,
    power: { draw: 50, limit: 300 },
    vram: { used, total: 16_303, percentage: Math.round((used / 16_303) * 100), available: 16_303 - used },
    processes,
  });
  return {
    temperature: 50,
    usage: 10,
    power: { draw: 100, limit: 600 },
    vram: { used: 30_100, total: 32_606, percentage: 92, available: 2_506 },
    processes: [
      { pid: 10, name: "llama-server", vramMB: 29_600 },
      { pid: 11, name: "python", vramMB: 500 },
    ],
    gpus: [
      card(0, 15_300, [{ pid: 10, name: "llama-server", vramMB: 15_300 }]),
      card(1, 14_800, [
        { pid: 10, name: "llama-server", vramMB: 14_300 },
        { pid: 11, name: "python", vramMB: 500 },
      ]),
    ],
  };
}

const ctx = (over: Partial<VramBreakdownContext>): VramBreakdownContext => ({
  model: "unified",
  unified: null,
  serving: true,
  endpoint: null,
  ...over,
});

describe("GpuPanel VRAM", () => {
  it("draws spark-1's unified pool with the legend and the Available row toned by headroom", () => {
    const { container } = render(
      <GpuPanel
        gpu={spark1Gpu()}
        sparkId="spark-1"
        temperatureUnit="celsius"
        vramContext={ctx({
          unified: SPARK1_UM,
          endpoint: { available: true, backend: "tensorfold", kvCacheUsage: 0.0549 },
        })}
      />,
    );
    const bar = container.querySelector<HTMLElement>("[data-vram-breakdown]")!;
    expect(bar.textContent).toContain("Unified memory");
    expect(bar.querySelector("[data-legend]")?.textContent).toBe(
      "Engine 98.6 · System 15.8 · Free 7.2 GB · KV 5%",
    );
    const availLabel = Array.from(container.querySelectorAll("span")).find(
      (s) => s.textContent === "Available",
    )!;
    const avail = availLabel.nextElementSibling as HTMLElement;
    expect(avail.textContent).toBe("7.2 GB");
    expect(avail.className).toContain("text-warning");
  });

  it("splits each card by its own processes, without a KV line", () => {
    const { container } = render(
      <GpuPanel
        gpu={twoCardGpu()}
        sparkId="multi"
        temperatureUnit="celsius"
        vramContext={ctx({
          model: "discrete",
          endpoint: { available: true, backend: "llama.cpp", kvCacheUsage: 0.5 },
        })}
      />,
    );
    const bars = Array.from(container.querySelectorAll<HTMLElement>("[data-vram-breakdown]"));
    expect(bars).toHaveLength(3); // two cards + the all-cards aggregate
    const [card0, card1, all] = bars;
    expect(card0.querySelector("[data-legend]")?.textContent).toBe("Engine 14.9 · Free 1.0 GB");
    expect(card0.querySelector("[data-headroom]")?.className).toContain("text-danger"); // 1003 MB < 1 GB
    expect(card1.querySelector("[data-legend]")?.textContent).toBe(
      "Engine 14.0 · Other 0.5 · Free 1.5 GB",
    );
    expect(card1.querySelector('[role="tooltip"]')?.textContent).not.toContain("KV");
    expect(all.textContent).toContain("VRAM (all cards)");
    expect(all.querySelector('[role="tooltip"]')?.textContent).toContain("KV in use 50%");
  });

  it("without a breakdown context renders today's plain bars", () => {
    const { container } = render(
      <GpuPanel gpu={spark1Gpu()} sparkId="spark-1" temperatureUnit="celsius" />,
    );
    expect(container.querySelector("[data-vram-breakdown]")).toBeNull();
    const expected = render(
      <MetricBar label="VRAM" value={101_008} max={124_610} caption="98.6 / 121.7 GB" />,
    ).container.firstElementChild!.outerHTML;
    const vramBlock = Array.from(container.querySelectorAll("span"))
      .find((s) => s.textContent === "VRAM")!
      .closest(".space-y-1")!;
    expect(vramBlock.outerHTML).toBe(expected);
    const avail = Array.from(container.querySelectorAll("span")).find(
      (s) => s.textContent === "Available",
    )!.nextElementSibling as HTMLElement;
    expect(avail.className).toBe("font-tabular text-text");
  });
});
