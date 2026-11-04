import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wakeSpark = vi.fn();
vi.mock("../../api/client", () => ({ wakeSpark: (...args: unknown[]) => wakeSpark(...args) }));
import type { GpuDevice } from "../../api/types";
import { SparkCard } from "./SparkCard";
import { i18n, setLocale } from "../../i18n";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";

describe("SparkCard locale changes", () => {
  beforeEach(async () => {
    wakeSpark.mockReset();
    await setLocale("en");
  });

  it("retranslates local wake feedback but preserves a raw wake diagnostic", async () => {
    const spark = makeSpark("wakeable", false);
    spark.kind = "host";
    wakeSpark.mockResolvedValueOnce({ success: true });
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    const wake = container.querySelector<HTMLButtonElement>("button")!;
    await act(async () => wake.click());
    expect(container.textContent).toContain("Wake packet sent");
    await act(async () => setLocale("zh-CN"));
    expect(container.textContent).toContain("唤醒数据包已发送");
    expect(wakeSpark).toHaveBeenCalledTimes(1);

    wakeSpark.mockResolvedValueOnce({ success: false, error: "raw gateway diagnostic" });
    await act(async () => wake.click());
    expect(container.textContent).toContain("raw gateway diagnostic");
    await act(async () => setLocale("en"));
    expect(container.textContent).toContain("raw gateway diagnostic");
  });
  afterEach(async () => {
    await act(() => setLocale("en"));
  });

  it("updates memoized card and VRAM presentation both ways while retaining raw measurements and diagnostics", async () => {
    const spark = makeSpark("raw-unit");
    const rawModel = "org/raw-model:Q4_K_M";
    const rawError = "collector: original upstream diagnostic";
    spark.metrics.gpu!.vram = { used: 101_008, total: 124_610, available: 7_412, percentage: 81 };
    spark.metrics.gpu!.processes = [{ pid: 92_271, name: "/usr/bin/python3", vramMB: 101_008 }];
    spark.metrics.gpu!.metricAvailability = { usage: true, temperature: false, powerDraw: true, powerLimit: true, vramUsed: true, vramTotal: true };
    spark.metrics.unifiedMemory = { total: 124_610, gpuUsed: 101_008, cpuUsed: 16_190, used: 117_198, available: 7_412, percentage: 94, oomRisk: "high", bandwidth: { current: 0, peak: 400 } };
    Object.assign(spark.metrics.llm[0], { modelId: rawModel, measurementValid: false, measurementError: rawError, kvCacheUsage: 0.0549 });

    const { container } = render(
      <SparkCard
        spark={spark}
        temperatureUnit="celsius"
        vramContext={{ model: "unified", unified: spark.metrics.unifiedMemory, serving: true, endpoint: spark.metrics.llm[0] }}
      />,
    );
    const bar = container.querySelector<HTMLElement>("[data-vram-breakdown]")!;
    await act(async () => bar.focus());
    expect(bar.textContent).toContain("Unified memory");
    expect(container.textContent).toContain(rawModel);
    expect(container.textContent).toContain("GPU temp");
    expect(container.textContent).toContain("—");
    expect(bar.querySelector('[role="tooltip"]')?.textContent).toContain("python3 · pid 92271");
    expect(container.querySelector('[title="collector: original upstream diagnostic"]')).not.toBeNull();

    await act(async () => setLocale("zh-CN"));
    expect(i18n.resolvedLanguage).toBe("zh-CN");
    expect(bar.textContent).toContain("统一内存");
    expect(container.textContent).toContain("GPU 温度");
    expect(container.textContent).toContain(rawModel);
    expect(container.textContent).toContain("—");
    expect(bar.querySelector('[role="tooltip"]')?.textContent).toContain("python3 · pid 92271");
    expect(container.querySelector('[title="collector: original upstream diagnostic"]')).not.toBeNull();

    await act(async () => setLocale("en"));
    expect(bar.textContent).toContain("Unified memory");
    expect(container.textContent).toContain("GPU temp");
    expect(container.textContent).toContain(rawModel);
  });
  it("localizes the retained multi-GPU footer labels", async () => {
    const spark = makeSpark("multi-gpu");
    const cards: GpuDevice[] = [0, 1].map((index) => ({
      index,
      physicalIndex: index,
      uuid: `gpu-${index}`,
      name: `GPU ${index}`,
      usage: 42,
      temperature: 55,
      power: { draw: 50, limit: 100 },
      vram: { used: 1024, total: 4096, available: 3072, percentage: 25 },
    }));
    spark.metrics.gpu!.gpus = cards;
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.textContent).toContain("Load");
    expect(container.textContent).toContain("Temp");
    expect(container.querySelector(".ov-gpu-stats")?.textContent).toContain("Power");
    expect(container.querySelector(".ov-gpu-stats")?.textContent).not.toContain("GPU power");

    await act(async () => setLocale("zh-CN"));
    expect(container.textContent).toContain("负载");
    expect(container.textContent).toContain("温度");
    expect(container.querySelector(".ov-gpu-stats")?.textContent).toContain("功耗");
  });
  it("keeps completion-based measurements distinct from live throughput across locales", async () => {
    const spark = makeSpark("tensorfold");
    Object.assign(spark.metrics.llm[0], { available: true, backend: "tensorfold", measurementValid: true, generationTps: 25, perStreamTps: 8, prefillTps: 1000, prefillTpsSource: "completed-metrics" });
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.textContent).toContain("Decode · aggregate");
    expect(container.textContent).toContain("Prefill · last completed");
    expect(container.textContent).toContain("Effective rate · includes cached tokens");
    await act(async () => setLocale("zh-CN"));
    expect(container.textContent).toContain("解码 · 总计");
    expect(container.textContent).toContain("预填充 · 最近完成");
    expect(container.textContent).toContain("有效速率 · 包含缓存 Token");
    expect(container.textContent).toContain("25.0");
  });
});
