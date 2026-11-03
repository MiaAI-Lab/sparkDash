import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import { getGpuHistory } from "../../api/client";
import type { GpuDevice, GpuMetrics, GpuThrottle } from "../../api/types";
import { makeSpark } from "../../testing/fixtures";
import { flush, render } from "../../testing/render";
import { GpuPanel } from "./GpuPanel";

vi.mock("../../api/client", () => ({
  getGpuHistory: vi.fn(() => Promise.resolve({ t: [], u: [], c: [], p: [] })),
}));

beforeEach(async () => {
  localStorage.clear();
  await act(() => setLocale("en"));
  vi.clearAllMocks();
});
afterEach(async () => { await act(() => setLocale("en")); });

function throttle(reason: GpuThrottle["reason"]): GpuThrottle {
  return {
    thermal: reason === "thermal", hwSlowdown: reason === "hw", powerCap: reason === "power",
    active: reason !== "ok", reason, smClockMHz: 1200, smClockMaxMHz: 2000, smClockPct: 60,
    clockCapMHz: 1400, detail: "RAW throttle / SW Power Cap",
  };
}

it("localizes GPU metrics and time ranges while retaining selection, units and raw diagnostics", async () => {
  const gpu: GpuMetrics = {
    ...makeSpark().metrics.gpu!, temperature: 87,
    power: { draw: 50, limit: 100, systemDraw: 210 },
    throttle: throttle("thermal"), nvErrNoMemory: 3,
  };
  const { container } = render(<GpuPanel gpu={gpu} sparkId="gpu-locale-single" temperatureUnit="fahrenheit" chip="Raw Chip 01" />);
  await flush();
  const eightHours = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === "8 h")!;
  act(() => eightHours.click());
  const original = container.textContent;
  const backfillCalls = vi.mocked(getGpuHistory).mock.calls.length;
  expect(original).toContain("189°FHot");
  expect(original).toContain("Thermal throttle");
  expect(original).toContain("Temperature °C");

  await act(() => setLocale("zh-CN"));
  expect(container.querySelector("h3")?.textContent).toBe("GPU · Raw Chip 01");
  expect(eightHours.textContent).toBe("8 小时");
  expect(eightHours.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("图表时间范围");
  expect(container.textContent).toContain("189°F高温");
  expect(container.textContent).toContain("系统 ≈ 210 W");
  expect(container.textContent).toContain("SM 频率1.20GHz温度降频");
  expect(container.textContent).toContain("上限 1400 MHz");
  expect(container.querySelector('[title="通过 nvidia-smi -lgc 锁定"]')).not.toBeNull();
  expect(container.querySelector('.sp-stat[title]')?.getAttribute("title")).toBe(gpu.throttle!.detail);
  expect(container.querySelector(".legend")?.textContent).toContain("温度 °C");
  expect(container.textContent).toContain("自启动以来 GPU 内存分配错误3");
  expect(container.querySelector('[title*="NV_ERR_NO_MEMORY"]')).not.toBeNull();
  expect(getGpuHistory).toHaveBeenCalledTimes(backfillCalls);
  await act(() => setLocale("en"));
  expect(container.textContent).toBe(original);
  expect(eightHours.getAttribute("aria-pressed")).toBe("true");
});

const device = (index: number, overrides: Partial<GpuDevice> = {}): GpuDevice => ({
  index, uuid: null, name: `Raw Card ${index}`, vendor: "nvidia", temperature: 50, usage: 10,
  power: { draw: 50, limit: 100 }, vram: { used: 1024, total: 4096, available: 3072, percentage: 25 },
  ...overrides,
});

it("translates per-card states without changing physical identities or unavailable measurements", async () => {
  const gpu: GpuMetrics = {
    ...makeSpark().metrics.gpu!, temperature: 70,
    gpus: [
      device(0, { throttle: throttle("power") }),
      device(1000, { physicalIndex: 0, vendor: "amd", name: "AMD Raw Card", throttle: throttle("hw") }),
      device(2, {
        vendor: "intel", name: "Intel Raw Card", throttle: throttle("unknown"),
        vramSource: "pci-bar", vram: { used: 0, total: 32768, available: 32768, percentage: 0 },
        metricAvailability: { usage: false, temperature: false, powerDraw: false, powerLimit: false, vramUsed: false, vramTotal: true },
      }),
      device(3),
    ],
  };
  const { container } = render(<GpuPanel gpu={gpu} sparkId="gpu-locale-multi" temperatureUnit="celsius" />);
  await flush();
  const original = container.textContent;
  const rows = Array.from(container.querySelectorAll<HTMLElement>(".sp-device"));
  expect(rows[2].textContent).toContain("32.0 GB total");
  await act(() => setLocale("zh-CN"));
  expect(container.textContent).toContain("功耗（所有显卡）");
  expect(container.textContent).toContain("4 块 GPU");
  expect(container.textContent).toContain("偏热");
  expect(rows[0].textContent).toContain("功耗限制");
  expect(rows[1].textContent).toContain("AMD GPU 0");
  expect(rows[1].textContent).toContain("硬件降频");
  expect(rows[1].querySelector('[title="AMD Raw Card"]')).not.toBeNull();
  expect(rows[2].textContent).toContain("已限频");
  expect(rows[2].textContent).toContain("利用率—温度—功耗— / —");
  expect(rows[2].textContent).toContain("总计 32.0 GB");
  expect(rows[2].querySelector('[title="无法读取此显卡的显存用量"]')).not.toBeNull();
  expect(rows[2].querySelector(".metric-bar")).toBeNull();
  expect(rows[3].textContent).toContain("无限频");
  expect(rows[0].getAttribute("title")).toBe("RAW throttle / SW Power Cap");
  await act(() => setLocale("en"));
  expect(container.textContent).toBe(original);
});

it("retains unknown GPU placeholders and localizes the used-only memory fallback", async () => {
  const gpu: GpuMetrics = {
    ...makeSpark().metrics.gpu!,
    metricAvailability: { usage: false, temperature: false, powerDraw: false, powerLimit: false, vramUsed: false, vramTotal: false },
  };
  const { container, root } = render(<GpuPanel gpu={gpu} sparkId="gpu-locale-missing" temperatureUnit="fahrenheit" />);
  await flush();
  await act(() => setLocale("zh-CN"));
  expect(container.querySelector(".sp-gpu-top__ring")?.textContent).toContain("—");
  expect(container.querySelector(".sp-gpu-top__ring")?.textContent).not.toContain("42%");
  expect(container.querySelectorAll(".sp-stat .big-num")[0].textContent).toBe("—");
  expect(container.querySelectorAll(".sp-stat .big-num")[1].textContent).toBe("—");
  expect(container.querySelector(".sp-section")?.textContent).toBe("显存—");
  const usedOnly = { ...gpu, metricAvailability: undefined, vram: { used: 512, total: 0, available: 0, percentage: 0 } };
  act(() => root.render(<GpuPanel gpu={usedOnly} sparkId="gpu-locale-missing" temperatureUnit="celsius" />));
  expect(container.querySelector(".sp-section")?.textContent).toBe("显存已用 512 MB");
  await act(() => setLocale("en"));
  expect(container.querySelector(".sp-section")?.textContent).toBe("VRAM512 MB used");
});
