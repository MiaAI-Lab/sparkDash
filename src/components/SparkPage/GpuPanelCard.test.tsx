import { describe, expect, it } from "vitest";
import { GpuPanel } from "./GpuPanel";
import { render } from "../../testing/render";
import type { GpuDevice, GpuMetrics } from "../../api/types";

const throttle = (over: Partial<NonNullable<GpuDevice["throttle"]>> = {}): NonNullable<GpuDevice["throttle"]> => ({
  thermal: false,
  hwSlowdown: false,
  powerCap: false,
  active: false,
  reason: "ok",
  smClockMHz: 1755,
  smClockMaxMHz: 2115,
  smClockPct: 83,
  detail: "Clocks not limited",
  ...over,
});

const card = (over: Partial<GpuDevice> = {}): GpuDevice => ({
  index: 0,
  name: "NVIDIA GeForce RTX 3090",
  uuid: "GPU-0",
  temperature: 47,
  usage: 4,
  power: { draw: 76.4, limit: 370 },
  vram: { used: 1100, total: 24_576, percentage: 4, available: 23_476 },
  throttle: throttle(),
  fanPct: 0,
  pcie: { gen: 3, genMax: 3, width: 16, widthMax: 16 },
  ...over,
});

const host = (gpus: GpuDevice[]): GpuMetrics => ({
  temperature: 47,
  usage: 4,
  power: { draw: 76.4, limit: 370 },
  vram: { used: 1100, total: 24_576, percentage: 4, available: 23_476 },
  throttle: throttle(),
  gpus,
});

const text = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

describe("GpuPanel card details", () => {
  it("a single card shows its name, fan, PCIe link and throttle reasons", () => {
    const { container } = render(<GpuPanel gpu={host([card()])} sparkId="llm-01" temperatureUnit="celsius" />);
    expect(container.querySelector('[data-testid="gpu-card"]')?.textContent).toContain("NVIDIA GeForce RTX 3090");
    expect(text(container, "gpu-fan")).toBe("Fan0 %");
    expect(text(container, "gpu-pcie")).toBe("PCIe linkGen 3 x16");
    expect(text(container, "gpu-throttle-reasons")).toBe("Throttle reasonsNone");
  });

  it("an active throttle is named, and a parked PCIe link shows the best one", () => {
    const gpu = host([
      card({
        fanPct: 30,
        pcie: { gen: 1, genMax: 5, width: 16, widthMax: 16 },
        throttle: throttle({ active: true, powerCap: true, reason: "power", detail: "SW power cap" }),
      }),
    ]);
    const { container } = render(<GpuPanel gpu={gpu} sparkId="llm-02" temperatureUnit="celsius" />);
    expect(text(container, "gpu-fan")).toBe("Fan30 %");
    expect(text(container, "gpu-pcie")).toBe("PCIe linkGen 1 x16 (best Gen 5 x16)");
    expect(text(container, "gpu-throttle-reasons")).toBe("Throttle reasonsPower cap");
  });

  it("a GB10 shows dashes for fan and PCIe", () => {
    const { container } = render(
      <GpuPanel gpu={host([card({ name: "NVIDIA GB10", fanPct: null, pcie: null })])} sparkId="spark" temperatureUnit="celsius" />,
    );
    expect(text(container, "gpu-fan")).toBe("Fan—");
    expect(text(container, "gpu-pcie")).toBe("PCIe link—");
  });

  it("each card of a multi-GPU host shows its own fan and link", () => {
    const gpu = host([card({ index: 0, fanPct: 10 }), card({ index: 1, uuid: "GPU-1", fanPct: 55 })]);
    const { container } = render(<GpuPanel gpu={gpu} sparkId="multi" temperatureUnit="celsius" />);
    const fans = Array.from(container.querySelectorAll('[data-testid="gpu-fan"]')).map((e) => e.textContent);
    expect(fans).toEqual(["Fan10 %", "Fan55 %"]);
    expect(container.querySelector('[data-testid="gpu-card"]')).toBeNull();
  });

  it("a card from an older server (no fan or PCIe fields) shows only the throttle reasons row", () => {
    const old = card();
    delete old.fanPct;
    delete old.pcie;
    const { container } = render(<GpuPanel gpu={host([old])} sparkId="old" temperatureUnit="celsius" />);
    expect(container.querySelector('[data-testid="gpu-fan"]')).toBeNull();
    expect(container.querySelector('[data-testid="gpu-pcie"]')).toBeNull();
    expect(text(container, "gpu-throttle-reasons")).toBe("Throttle reasonsNone");
  });
});
