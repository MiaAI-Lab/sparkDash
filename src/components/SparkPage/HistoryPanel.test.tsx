import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import type { MetricsHistoryData, MetricsHistoryResponse } from "../../api/types";
import { nearestIndex, segmentRuns, yDomain } from "./HistoryChart";
import { HISTORY_POLL_MS, HISTORY_RANGE_KEY, HistoryPanel } from "./HistoryPanel";

vi.mock("../../api/client", () => ({
  getUnitHistory: vi.fn(),
}));

import { getUnitHistory } from "../../api/client";

const fetchHistory = vi.mocked(getUnitHistory);

const STEP = 60_000;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

/** 6 one-minute buckets with the third and fourth missing (unit offline). */
function data(overrides: Partial<MetricsHistoryData> = {}): MetricsHistoryData {
  const at = (i: number) => T0 + i * STEP;
  return {
    enabled: true,
    range: "6h",
    stepMs: STEP,
    from: at(0),
    to: at(6),
    points: [0, 1, 4, 5].map((i) => ({
      t: at(i),
      gpuUtil: { avg: 10 * (i + 1), max: 10 * (i + 2) },
      gpuTemp: { avg: 50 + i, max: 55 + i },
      memFreeMB: { avg: 9_000, max: 9_500, min: 7_000 },
      netRx: { avg: 2048, max: 4096 },
      netTx: { avg: 1024, max: 1024 },
    })),
    llm: [
      {
        port: 8888,
        points: [0, 1].map((i) => ({ t: at(i), genTps: { avg: 40 + i, max: 45 }, kvUsage: { avg: 0.25, max: 0.5 } })),
      },
    ],
    ...overrides,
  };
}

function chart(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-chart="${id}"]`);
  if (!el) throw new Error(`no chart ${id}`);
  return el;
}

/** Charts with something to draw (empty ones show "No data in this range"). */
function chartsWithData(container: HTMLElement) {
  return [...container.querySelectorAll("[data-chart]")].filter(
    (c) => !c.textContent!.includes("No data in this range"),
  );
}

function plot(container: HTMLElement, id: string): HTMLElement {
  return chart(container, id).querySelector<HTMLElement>('[role="group"]')!;
}

function key(el: HTMLElement, k: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
}

async function mount(response: MetricsHistoryResponse = data()) {
  fetchHistory.mockResolvedValue(response);
  const result = render(<HistoryPanel sparkId="spark-1" kind="spark" temperatureUnit="celsius" />);
  await flush();
  return result;
}

beforeEach(() => {
  localStorage.clear();
  fetchHistory.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("HistoryChart helpers", () => {
  it("breaks lines at missing buckets and at jumps longer than a step", () => {
    const v = { avg: 1, max: 1 };
    expect(segmentRuns([0, 60, 120, 300, 360], [v, v, null, v, v], 60)).toEqual([[0, 1], [3, 4]]);
    expect(segmentRuns([0, 60, 300, 360], [v, v, v, v], 60)).toEqual([[0, 1], [2, 3]]);
  });

  it("finds the nearest bucket", () => {
    expect(nearestIndex([0, 10, 20], 14)).toBe(1);
    expect(nearestIndex([0, 10, 20], 16)).toBe(2);
    expect(nearestIndex([0, 10, 20], -5)).toBe(0);
    expect(nearestIndex([], 5)).toBe(-1);
  });

  it("covers the band and thresholds in the y range, with room above the highest threshold", () => {
    const d = yDomain(
      [{ key: "m", label: "m", color: "x", band: "min", values: [{ avg: 7_700, max: 7_800, min: 7_600 }] }],
      0,
      undefined,
      [
        { value: 8192, label: "low", color: "x" },
        { value: 4096, label: "critical", color: "x" },
      ],
      1024,
    )!;
    expect(d.lo).toBe(0);
    expect(d.hi).toBeGreaterThanOrEqual(8192 * 1.25);
    expect(yDomain([{ key: "a", label: "a", color: "x", values: [null] }])).toBeNull();
  });
});

describe("HistoryPanel", () => {
  it("defaults to 1h, and the range chips refetch and are remembered", async () => {
    const { container } = await mount();
    expect(fetchHistory).toHaveBeenLastCalledWith("spark-1", "1h");
    const chip = [...container.querySelectorAll(".seg button")].find((b) => b.textContent === "24h") as HTMLButtonElement;
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    act(() => chip.click());
    await flush();
    expect(fetchHistory).toHaveBeenLastCalledWith("spark-1", "24h");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(chip.className).toContain("is-on");
    expect(localStorage.getItem(HISTORY_RANGE_KEY)).toBe("24h");
    expect(container.querySelector(".panel-title")!.textContent).toContain("History · last 24 hours");

    fetchHistory.mockClear();
    render(<HistoryPanel sparkId="spark-1" temperatureUnit="celsius" />);
    await flush();
    expect(fetchHistory).toHaveBeenLastCalledWith("spark-1", "24h");
  });

  it("draws an offline stretch as a gap, not a line across it", async () => {
    const { container } = await mount();
    const gpu = chart(container, "gpuUtil");
    expect(gpu.querySelectorAll('polyline[data-series="gpuUtil"]')).toHaveLength(2);
    expect(gpu.querySelectorAll('polygon[data-band="gpuUtil"]')).toHaveLength(2);
    expect(gpu.querySelector('[data-axis="ymax"]')!.textContent).toBe("100%");
    expect(gpu.querySelector('[data-axis="ymin"]')!.textContent).toBe("0.0%");
    expect(gpu.querySelector('[data-axis="xstart"]')!.textContent).not.toBe("");
    expect(gpu.querySelector('[data-axis="xend"]')!.textContent).not.toBe("");
  });

  it("shows the headroom thresholds on the free-memory chart", async () => {
    const { container } = await mount();
    const mem = chart(container, "memFree");
    expect(mem.textContent).toContain("Memory free (unified)");
    expect(mem.querySelectorAll("[data-threshold]")).toHaveLength(2);
    expect(mem.textContent).toContain("low 8.0 GB");
    expect(mem.textContent).toContain("critical 4.0 GB");
  });

  it("uses the discrete thresholds on a GPU host", async () => {
    fetchHistory.mockResolvedValue(data());
    const { container } = render(<HistoryPanel sparkId="h" kind="host" temperatureUnit="celsius" />);
    await flush();
    const mem = chart(container, "memFree");
    expect(mem.textContent).toContain("VRAM free");
    expect(mem.textContent).toContain("low 2.0 GB");
  });

  it("adds a RAM chart on a discrete host, but not on a Mac, whose RAM is the unified pool", async () => {
    const withRam = data();
    withRam.points = withRam.points.map((p) => ({ ...p, ramUsedMB: { avg: 40_000, max: 41_000 } }));
    fetchHistory.mockResolvedValue(withRam);
    const linux = render(<HistoryPanel sparkId="h" kind="host" platform="linux" temperatureUnit="celsius" />);
    await flush();
    expect(chart(linux.container, "ramUsed").textContent).toContain("RAM used");

    const mac = render(<HistoryPanel sparkId="m" kind="host" platform="darwin" temperatureUnit="celsius" />);
    await flush();
    expect(mac.container.querySelector('[data-chart="ramUsed"]')).toBeNull();
    expect(chart(mac.container, "memFree").textContent).toContain("Memory free (unified)");
  });

  it("charts each LLM endpoint, KV only when reported", async () => {
    const { container } = await mount();
    expect(chart(container, "llm-8888-gen")).toBeTruthy();
    expect(chart(container, "llm-8888-prefill").textContent).toContain("No data in this range");
    expect(chart(container, "llm-8888-kv")).toBeTruthy();
  });

  it("moves one crosshair across every chart from the keyboard, with a tooltip", async () => {
    const { container } = await mount();
    const gpu = plot(container, "gpuUtil");
    act(() => gpu.focus());
    // Focus lands on the newest bucket; every chart with data draws the crosshair there.
    expect(chartsWithData(container).length).toBe(6);
    expect(container.querySelectorAll("[data-crosshair]")).toHaveLength(6);
    const tooltips = () => container.querySelectorAll("[data-tooltip]");
    expect(tooltips()).toHaveLength(1);
    expect(tooltips()[0].className).toContain("chart__tip");
    expect(tooltips()[0].textContent).toContain("60%");
    expect(tooltips()[0].textContent).toContain("max 70%");

    key(gpu, "ArrowLeft");
    expect(tooltips()[0].textContent).toContain("50%");
    // Other charts read out the same timestamp.
    expect(chart(container, "gpuTemp").querySelector('[data-readout="gpuTemp"]')!.textContent).toBe("54°C");

    key(gpu, "Home");
    expect(tooltips()[0].textContent).toContain("10%");
    expect(chart(container, "llm-8888-gen").querySelector('[data-readout="genTps"]')!.textContent).toBe("40.0");
    key(gpu, "ArrowRight");
    expect(tooltips()[0].textContent).toContain("20%");

    key(gpu, "Escape");
    expect(container.querySelectorAll("[data-crosshair]")).toHaveLength(0);
    expect(tooltips()).toHaveLength(0);
  });

  it("follows the pointer to the nearest bucket on every chart", async () => {
    const { container } = await mount();
    const net = plot(container, "network");
    net.getBoundingClientRect = () => ({ left: 0, width: 600, top: 0, height: 90, right: 600, bottom: 90, x: 0, y: 0, toJSON: () => ({}) });
    // 600 px for 6 minutes: x = 150 sits over the second bucket's middle.
    act(() => {
      net.dispatchEvent(new MouseEvent("pointermove", { clientX: 150, bubbles: true }));
    });
    const tip = container.querySelector("[data-tooltip]")!;
    expect(tip.textContent).toContain("↓ rx2.0 KB/s");
    expect(tip.textContent).toContain("↑ tx1.0 KB/s");
    expect(container.querySelectorAll("[data-crosshair]").length).toBe(chartsWithData(container).length);
    expect(chart(container, "gpuUtil").querySelector('[data-readout="gpuUtil"]')!.textContent).toBe("20%");
    act(() => {
      net.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    });
    expect(container.querySelectorAll("[data-crosshair]")).toHaveLength(0);
  });

  it("converts temperatures to °F when asked", async () => {
    fetchHistory.mockResolvedValue(data());
    const { container } = render(<HistoryPanel sparkId="spark-1" temperatureUnit="fahrenheit" />);
    await flush();
    expect(chart(container, "gpuTemp").querySelector('[data-readout="gpuTemp"]')!.textContent).toBe("131°F");
  });

  it("says when the server has the setting off", async () => {
    const { container } = await mount({ enabled: false });
    expect(container.textContent).toContain("Metrics history is off on the server");
    expect(container.querySelector("[data-chart]")).toBeNull();
  });

  it("polls every 30 s and pauses while the tab is hidden", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    await mount();
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(HISTORY_POLL_MS);
    });
    expect(fetchHistory).toHaveBeenCalledTimes(2);

    visibility = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      vi.advanceTimersByTime(HISTORY_POLL_MS * 3);
    });
    expect(fetchHistory).toHaveBeenCalledTimes(2);

    visibility = "visible";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fetchHistory).toHaveBeenCalledTimes(3);
  });

  it("keeps the last data after a failed refresh but says it is stale, until a refresh succeeds", async () => {
    vi.useFakeTimers();
    const { container } = await mount();
    expect(container.textContent).not.toContain("Stale");
    fetchHistory.mockRejectedValueOnce(new Error("HTTP 502"));
    await act(async () => {
      vi.advanceTimersByTime(HISTORY_POLL_MS);
    });
    await flush();
    const note = container.querySelector('[role="status"]');
    expect(note?.textContent).toMatch(/^Stale: could not refresh \(HTTP 502\)\. Showing data from .+\.$/);
    expect(chartsWithData(container).length).toBeGreaterThan(0);
    await act(async () => {
      vi.advanceTimersByTime(HISTORY_POLL_MS);
    });
    await flush();
    expect(container.textContent).not.toContain("Stale");
  });

  it("does not poll while the panel is scrolled off screen", async () => {
    let notify: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
          notify = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    fetchHistory.mockResolvedValue(data());
    const { container } = render(<HistoryPanel sparkId="spark-1" temperatureUnit="celsius" />);
    await flush();
    expect(fetchHistory).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Loading history");
    act(() => notify!([{ isIntersecting: true }]));
    await flush();
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-chart]")).not.toBeNull();
    act(() => notify!([{ isIntersecting: false }]));
    expect(container.querySelector("[data-chart]")).not.toBeNull(); // the last answer stays
  });
});
