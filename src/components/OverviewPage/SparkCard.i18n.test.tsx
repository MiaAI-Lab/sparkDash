import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wakeSpark = vi.fn();
vi.mock("../../api/client", () => ({ wakeSpark: (...args: unknown[]) => wakeSpark(...args) }));
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
});
