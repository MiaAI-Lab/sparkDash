import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";
import type { CpuMetrics, UnifiedMemoryMetrics } from "../../api/types";
import { CpuPanel } from "./CpuPanel";
import { RamPanel } from "./RamPanel";
import { UnifiedMemoryPanel } from "./UnifiedMemoryPanel";

vi.mock("../../hooks/metricsStore", () => ({
  useMetricsHistoryTail: (_id: string, key: string) => key === "cpu.temp" ? [40, 45] : [20, 25],
}));

beforeEach(async () => {
  await act(() => setLocale("en"));
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  await act(() => setLocale("en"));
  vi.unstubAllGlobals();
});

it("switches CPU labels and sensor guidance without changing telemetry or hardware identity", async () => {
  const hardware = { ...makeSpark("cpu").hardware, cpuModel: "Raw CPU / X20" };
  const cpu: CpuMetrics = { usage: 25, temperature: 45, temperatureLabel: "SoC", temperatureSource: "acpitz", draw: 12, tdp: 30 };
  const { container, root } = render(<CpuPanel cpu={cpu} hardware={hardware} sparkId="cpu" temperatureUnit="celsius" />);
  const original = container.textContent;
  expect(original).toContain("Temperature (SoC)");
  expect(original).toContain("45°C");
  const history = Array.from(container.querySelectorAll("svg path"), p => p.getAttribute("d"));

  await act(() => setLocale("zh-CN"));
  expect(container.textContent).toContain("使用率25%");
  expect(container.textContent).toContain("温度（SoC）45°C");
  expect(container.textContent).toContain("CPU 功耗12W / 30W");
  expect(container.textContent).toContain("Raw CPU / X20 · 20 核");
  expect(container.querySelector(".panel-title")?.getAttribute("title")).toContain("ACPI");
  expect(container.querySelector('.eyebrow[title]')?.getAttribute("title")).toBe("读数来自 acpitz — ACPI/主板温区，并非 CPU 封装传感器");
  expect(Array.from(container.querySelectorAll("svg path"), p => p.getAttribute("d"))).toEqual(history);

  await act(() => setLocale("en"));
  expect(container.textContent).toBe(original);
  act(() => root.render(<CpuPanel cpu={cpu} hardware={hardware} sparkId="cpu" temperatureUnit="fahrenheit" />));
  expect(container.textContent).toContain("113°F");
});

it("keeps an absent CPU sensor unknown and a reported zero measurable in both locales", async () => {
  const cpu: CpuMetrics = { usage: 0, temperature: 0, draw: 0, tdp: 0 };
  const { container, root } = render(<CpuPanel cpu={cpu} sparkId="cpu" temperatureUnit="celsius" />);
  const temperature = () => container.querySelectorAll(".sp-metric .big-num")[1]?.textContent;
  expect(temperature()).toBe("—");
  await act(() => setLocale("zh-CN"));
  expect(temperature()).toBe("—");
  act(() => root.render(<CpuPanel cpu={{ ...cpu, temperatureSource: "coretemp", temperatureLabel: "CPU" }} sparkId="cpu" temperatureUnit="celsius" />));
  expect(temperature()).toBe("0°C");
  expect(container.querySelector('.eyebrow[title]')?.getAttribute("title")).toBe("读数来自 coretemp — CPU 封装传感器");
  await act(() => setLocale("en"));
  expect(temperature()).toBe("0°C");
  expect(container.querySelector('.eyebrow[title]')?.getAttribute("title")).toBe("Reading from coretemp — the CPU package sensor");
});

it("localizes RAM usage and its empty state while retaining the same capacity and history", async () => {
  const { container, root } = render(<RamPanel ram={{ used: 2048, total: 8192, percentage: 25 }} sparkId="ram" />);
  const original = container.textContent;
  const bar = container.querySelector(".metric-bar-fill")?.getAttribute("style");
  await act(() => setLocale("zh-CN"));
  expect(container.querySelector("h3")?.textContent).toBe("系统内存");
  expect(container.textContent).toContain("2.0 / 8.0 GB");
  expect(container.textContent).toContain("使用率25%");
  expect(container.querySelector(".metric-bar-fill")?.getAttribute("style")).toBe(bar);
  await act(() => setLocale("en"));
  expect(container.textContent).toBe(original);
  act(() => root.render(<RamPanel ram={null} sparkId="ram" />));
  expect(container.textContent).toBe("RAMRAM—");
  await act(() => setLocale("zh-CN"));
  expect(container.textContent).toBe("系统内存系统内存—");
  expect(container.querySelector(".metric-bar")).toBeNull();
});

const memory: UnifiedMemoryMetrics = {
  total: 8192, gpuUsed: 4096, cpuUsed: 1024, used: 5120, available: 3072,
  percentage: 62.5, oomRisk: "high", bandwidth: { current: 12.5, peak: 100 },
};

it("translates unified-memory labels live while preserving segments, process rows and risk", async () => {
  const spark = makeSpark("memory");
  const gpu = { ...spark.metrics.gpu!, processes: [{ pid: 8123, name: "/opt/raw/worker.py --model=raw", vramMB: 2048 }] };
  const llm = [{ ...spark.metrics.llm![0], kvCacheMemoryBytes: 1024 ** 3 }];
  const { container } = render(<UnifiedMemoryPanel um={memory} gpu={gpu} llm={llm} />);
  const original = container.textContent;
  const bars = () => Array.from(container.querySelectorAll(".sp-seg"), e => e.getAttribute("style"));
  expect(bars()).toEqual(["width: 37.5%;", "width: 12.5%;", "width: 12.5%;", "width: 37.5%;"]);
  expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Unified memory 62.5% used");

  await act(() => setLocale("zh-CN"));
  expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("统一内存已用 62.5%");
  expect(container.querySelector(".panel-actions")?.textContent).toBe("已用 5.0 GB / 8.0 GB · 62.5%");
  expect(container.querySelector(".legend")?.textContent).toBe("模型权重 3.0 GBKV 缓存 1.0 GB系统 1.0 GB可用 3.0 GB");
  expect(container.querySelector(".sp-seg--weights")?.getAttribute("title")).toBe("模型权重 3.0 GB");
  expect(container.textContent).toContain("OOM 风险：高");
  expect(container.querySelector('[title="GPU 内存带宽（nvidia-smi dmon）"]')?.textContent).toBe("12.5 / 100 GB/s");
  expect(container.querySelector("thead")?.textContent).toBe("PID进程内存");
  expect(container.querySelector("tbody")?.textContent).toBe("8123worker.py2.0 GB");
  expect(container.querySelector("td[title]")?.getAttribute("title")).toBe("/opt/raw/worker.py --model=raw (PID 8123)");
  expect(bars()).toEqual(["width: 37.5%;", "width: 12.5%;", "width: 12.5%;", "width: 37.5%;"]);
  await act(() => setLocale("en"));
  expect(container.textContent).toBe(original);
});

it("retains the GPU-only, pressure and waiting states without inventing missing readings", async () => {
  const { container, root } = render(<UnifiedMemoryPanel um={{ ...memory, oomRisk: "medium" }} gpu={null} llm={[]} />);
  await act(() => setLocale("zh-CN"));
  expect(container.textContent).toContain("GPU 进程 4.0 GB");
  expect(container.textContent).toContain("内存压力");
  expect(container.textContent).not.toContain("模型权重");
  expect(container.textContent).not.toContain("KV 缓存");
  act(() => root.render(<UnifiedMemoryPanel um={null} gpu={null} llm={[]} />));
  expect(container.textContent).toBe("统一内存等待内存读数…");
  expect(container.querySelector('[role="img"]')).toBeNull();
  await act(() => setLocale("en"));
  expect(container.textContent).toBe("Unified memoryWaiting for memory reading…");
});
