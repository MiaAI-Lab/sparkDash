import { describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";

// Only which memory panel the page picks is under test here.
vi.mock("./GpuPanel", () => ({ GpuPanel: ({ hideMemory }: { hideMemory?: boolean }) => <div data-panel="gpu" data-hide-memory={String(Boolean(hideMemory))} /> }));
vi.mock("./CpuPanel", () => ({ CpuPanel: () => null }));
vi.mock("./RamPanel", () => ({ RamPanel: () => <div data-panel="ram" /> }));
vi.mock("./UnifiedMemoryPanel", () => ({ UnifiedMemoryPanel: () => <div data-panel="unified" /> }));
vi.mock("./StoragePanel", () => ({ StoragePanel: () => null }));
vi.mock("./NetworkPanel", () => ({ NetworkPanel: () => null }));
vi.mock("./TailscalePanel", () => ({ TailscalePanel: () => null }));
vi.mock("./LlmPanel", () => ({ LlmPanel: () => null }));
vi.mock("./ComfyPanel", () => ({ ComfyPanel: () => null }));
vi.mock("./LlmModelsPanel", () => ({ LlmModelsPanel: () => null }));
vi.mock("./RocePanel", () => ({ RocePanel: () => null }));
vi.mock("./SparkHeader", () => ({ SparkHeader: () => null }));
vi.mock("./SparkActions", () => ({ SparkActions: () => null }));
vi.mock("../../api/client", () => ({
  getUnitHistory: vi.fn(() => Promise.resolve({ enabled: false })),
  updateSpark: vi.fn(),
  refreshSparkMetric: vi.fn(),
  addLlmPort: vi.fn(),
  removeLlmPort: vi.fn(),
}));

import { SparkPage } from "./SparkPage";

const pool = { total: 262_144, used: 69_560, gpuUsed: 3_575, cpuUsed: 65_985, available: 190_000 };

function host(platform: string, unified: typeof pool | null) {
  const spark = makeSpark("h");
  spark.kind = "host";
  spark.platform = platform as never;
  spark.metrics.unifiedMemory = unified as never;
  return spark;
}

async function panels(spark: ReturnType<typeof makeSpark>) {
  const { container } = render(<SparkPage spark={spark} temperatureUnit="celsius" />);
  await flush();
  return {
    shown: [...container.querySelectorAll("[data-panel]")].map((el) => el.getAttribute("data-panel")),
    gpuHidesMemory: container.querySelector('[data-panel="gpu"]')!.getAttribute("data-hide-memory"),
  };
}

describe("SparkPage memory panels", () => {
  it("gives a Mac host the unified memory panel, as on a Spark, and no separate RAM panel", async () => {
    const { shown, gpuHidesMemory } = await panels(host("darwin", pool));
    expect(shown).toContain("unified");
    expect(shown).not.toContain("ram");
    expect(gpuHidesMemory).toBe("true");
  });

  it("keeps the RAM panel on a Mac whose pool is not reported", async () => {
    const { shown, gpuHidesMemory } = await panels(host("darwin", null));
    expect(shown).not.toContain("unified");
    expect(shown).toContain("ram");
    expect(gpuHidesMemory).toBe("false");
  });

  it("keeps VRAM in the GPU panel and RAM beside the CPU on a discrete host", async () => {
    const { shown, gpuHidesMemory } = await panels(host("linux", pool));
    expect(shown).not.toContain("unified");
    expect(shown).toContain("ram");
    expect(gpuHidesMemory).toBe("false");
  });
});
