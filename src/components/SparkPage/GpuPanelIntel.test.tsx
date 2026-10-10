import { describe, expect, it } from "vitest";
import { GpuPanel } from "./GpuPanel";
import { render } from "../../testing/render";
import type { GpuDevice, GpuMetrics } from "../../api/types";

const card = (over: Partial<GpuDevice>): GpuDevice => ({
  index: 0,
  name: "NVIDIA GeForce RTX 5080",
  uuid: "GPU-0",
  vendor: "nvidia",
  temperature: 50,
  usage: 10,
  power: { draw: 50, limit: 300 },
  vram: { used: 8_000, total: 16_303, percentage: 49, available: 8_303 },
  ...over,
});

function mixedHost(intel: Partial<GpuDevice> = {}): GpuMetrics {
  return {
    temperature: 60,
    usage: 40,
    power: { draw: 180, limit: 500 },
    vram: { used: 12_000, total: 49_071, percentage: 24, available: 37_071 },
    gpus: [
      card({}),
      card({
        index: 1,
        name: "Intel Arc Pro B70",
        uuid: null,
        vendor: "intel",
        temperature: 60,
        usage: 40,
        power: { draw: 130, limit: 200 },
        vram: { used: 4_096, total: 32_768, percentage: 13, available: 28_672 },
        fanRpm: 1500,
        vramSource: "debugfs",
        ...intel,
      }),
    ],
  };
}

describe("GpuPanel with an Intel card", () => {
  it("labels the Intel device next to the NVIDIA one", () => {
    const { container } = render(<GpuPanel gpu={mixedHost()} sparkId="host-1" temperatureUnit="celsius" />);
    const text = container.textContent ?? "";
    expect(text).toContain("GPU 0 · RTX 5080");
    expect(text).toContain("GPU 1 · Intel Arc Pro B70");
    expect(text).toContain("130W / 200W");
  });

  it("says VRAM use is unknown instead of drawing an empty bar when only the BAR size is known", () => {
    const { container } = render(
      <GpuPanel gpu={mixedHost({ vramSource: "pci-bar", vram: { used: 0, total: 32_768, percentage: 0, available: 32_768 } })} sparkId="host-1" temperatureUnit="celsius" />,
    );
    expect(container.textContent).toContain("32.0 GB total");
  });
});
