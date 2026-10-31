import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchGpuClock, fetchSparks, resetFleetGpuClock, setFleetGpuClock } from "../api/client";
import type { FleetGpuClockResult, GpuClockStatus, SparkConfig } from "../api/types";
import { setLocale } from "../i18n";
import { cleanupRenders, flush, render } from "../testing/render";
import { FleetGpuClock, type FleetGpuClockApi } from "./FleetGpuClock";

vi.mock("../api/client", () => ({
  fetchSparks: vi.fn(), fetchGpuClock: vi.fn(), setFleetGpuClock: vi.fn(), resetFleetGpuClock: vi.fn(),
}));

const statusApi = vi.mocked(fetchGpuClock);
const setApi = vi.mocked(setFleetGpuClock);
const button = (container: HTMLElement, text: string) => [...container.querySelectorAll("button")]
  .find((el) => el.textContent?.includes(text)) as HTMLButtonElement;
const ready: Extract<GpuClockStatus, { supported: true }> = {
  supported: true, hwMaxMHz: 3003, capMHz: 2100, sudo: "yes", persistKind: "unit",
  service: { installed: false, clocks: null, enabled: null, active: null },
  cron: { installed: false, clocks: null, failed: false },
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((res) => { resolve = res; }), resolve };
};

beforeEach(async () => {
  await setLocale("en");
  vi.mocked(fetchSparks).mockResolvedValue({
    sparks: [{ id: "spark1", kind: "spark" }, { id: "spark2", kind: "spark" }] as SparkConfig[],
  });
  statusApi.mockResolvedValue(ready);
  vi.mocked(resetFleetGpuClock).mockReset();
  setApi.mockReset();
});
afterEach(async () => {
  cleanupRenders();
  vi.clearAllMocks();
  await act(() => setLocale("en"));
});

it("retranslates an in-flight partial fleet result while preserving MHz, counts, and raw diagnostics", async () => {
  const response = deferred<{ success: boolean; applied: number; results: FleetGpuClockResult[] }>();
  setApi.mockReturnValue(response.promise);
  const ref = { current: null as FleetGpuClockApi | null };
  const { container } = render(<FleetGpuClock apiRef={ref} />);
  for (let i = 0; i < 6; i += 1) await flush();

  await act(async () => button(container, "1800 MHz").click());
  let applying!: Promise<boolean>;
  act(() => { applying = ref.current!.apply(); });
  await flush();
  expect(container.textContent).toContain("Applying…");
  await act(() => setLocale("zh-CN"));
  expect(container.textContent).toContain("正在应用…");

  await act(async () => {
    response.resolve({ success: false, applied: 1, results: [
      { id: "spark1", ok: true, capMHz: 1800, persistKind: "unit" },
      { id: "spark2", ok: false, error: "raw refusal from unit" },
    ] });
    await applying;
  });
  const result = container.querySelector('[role="status"]')!;
  expect(result.textContent).toContain("1800 MHz");
  expect(result.textContent).toContain("1/2");
  expect(result.textContent).toContain("raw refusal from unit");
  expect(result.className).toContain("is-err");
  expect(ref.current!.pending()).toBe(true);

  await act(() => setLocale("en"));
  expect(result.textContent).toContain("Capped at 1800 MHz — 1 of 2 units");
  expect(result.textContent).toContain("raw refusal from unit");
});

it("retranslates skipped and fallback request failures without another read or apply", async () => {
  setApi.mockResolvedValueOnce({ success: true, applied: 1, results: [
    { id: "spark1", ok: true, capMHz: 1800, persistKind: "unit" },
    { id: "spark2", ok: true, supported: false, reason: "nvidia-smi missing" },
  ] });
  const ref = { current: null as FleetGpuClockApi | null };
  const { container } = render(<FleetGpuClock apiRef={ref} />);
  for (let i = 0; i < 6; i += 1) await flush();
  const reads = statusApi.mock.calls.length;
  await act(async () => button(container, "1800 MHz").click());
  await act(async () => { await ref.current!.apply(); });
  await act(() => setLocale("zh-CN"));
  expect(container.querySelector('[role="status"]')?.textContent).toContain("nvidia-smi missing");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("已跳过 1 台");
  expect(statusApi).toHaveBeenCalledTimes(reads + 2); // the completed apply refreshes once; locale changes do not.
  const applies = setApi.mock.calls.length;

  await act(async () => button(container, "1900 MHz").click());
  setApi.mockRejectedValueOnce("not an Error");
  await act(async () => { await ref.current!.apply(); });
  await act(() => setLocale("en"));
  expect(container.querySelector('[role="status"]')?.textContent).toContain("GPU clock request failed");
  expect(setApi).toHaveBeenCalledTimes(applies + 1);
});
