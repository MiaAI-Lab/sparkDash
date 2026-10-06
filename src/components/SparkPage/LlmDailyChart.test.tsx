import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { LlmDailyChart, barHeight, dailyTooltipLines, formatAxisMax } from "./LlmDailyChart";
import { flush, render } from "../../testing/render";
import type { LlmDailyDay } from "../../api/types";

vi.mock("../../api/client", () => ({
  fetchLlmDaily: vi.fn(),
}));

import { fetchLlmDaily } from "../../api/client";

const fetchDaily = vi.mocked(fetchLlmDaily);

function day(date: string, decodeMax: number, prefillMax: number): LlmDailyDay {
  return {
    date,
    decodeMax,
    decodeAvg: decodeMax ? decodeMax / 4 : null,
    prefillMax,
    prefillAvg: prefillMax ? prefillMax / 8 : null,
    cachedPrefillMax: null,
    cachedPrefillAvg: null,
    uncachedPrefillMax: null,
    uncachedPrefillAvg: null,
  };
}

const DAYS = [day("2026-10-04", 96, 0), day("2026-10-05", 0, 0), day("2026-10-06", 120, 80)];

async function renderChart(days: LlmDailyDay[] = DAYS) {
  fetchDaily.mockResolvedValue({ sparkId: "spark-1", port: 8888, days });
  const view = render(<LlmDailyChart sparkId="spark-1" llmPort={8888} />);
  await flush();
  return view;
}

function tooltip(container: HTMLElement): string[] {
  const tip = container.querySelector('[role="status"]');
  return tip ? [...tip.children].map((el) => el.textContent ?? "") : [];
}

describe("formatAxisMax", () => {
  it("labels the top of the scale in tok/s, compact for prefill-sized peaks", () => {
    expect(formatAxisMax(120)).toBe("120 tok/s");
    expect(formatAxisMax(42.25)).toBe("42.3 tok/s");
    expect(formatAxisMax(2500)).toBe("2.5k tok/s");
    expect(formatAxisMax(50_010.01)).toBe("50k tok/s");
  });
});

describe("barHeight", () => {
  it("scales a value against its own series max", () => {
    expect(barHeight(100, 200, 34)).toBe(17);
    expect(barHeight(200, 200, 34)).toBe(34);
    expect(barHeight(0, 200, 34)).toBe(0);
    expect(barHeight(5, 0, 34)).toBe(0);
  });
});

describe("dailyTooltipLines", () => {
  it("gives the cached split its own line when the backend reports it", () => {
    const split: LlmDailyDay = {
      ...day("2026-10-06", 120, 900),
      uncachedPrefillMax: 700,
      uncachedPrefillAvg: 300,
      cachedPrefillMax: 4000,
      cachedPrefillAvg: 1500,
    };
    expect(dailyTooltipLines(split, true)).toEqual([
      "2026-10-06",
      "Decode peak 120 tok/s (avg 30.0)",
      "Uncached prefill peak 700 tok/s (avg 300)",
      "Cached prefill peak 4000 tok/s (avg 1500)",
    ]);
  });
});

describe("LlmDailyChart", () => {
  it("labels the top of each series' own scale", async () => {
    const { container } = await renderChart();
    expect(container.querySelector('[data-testid="daily-chart-ymax-decode"]')?.textContent).toBe("120 tok/s");
    expect(container.querySelector('[data-testid="daily-chart-ymax-prefill"]')?.textContent).toBe("80.0 tok/s");
  });

  it("keeps decode bars visible next to prefill peaks 250x larger", async () => {
    // spark-1's live window: decode peaks ~100–200 tok/s, prefill ~50k tok/s.
    // On one shared scale the decode bars were under 0.2px tall.
    const { container } = await renderChart([
      day("2026-10-04", 204.52, 50_010.01),
      day("2026-10-05", 0, 0),
      day("2026-10-06", 102.26, 49_996),
    ]);
    expect(container.querySelector('[data-testid="daily-chart-ymax-decode"]')?.textContent).toBe("205 tok/s");
    expect(container.querySelector('[data-testid="daily-chart-ymax-prefill"]')?.textContent).toBe("50k tok/s");
    const heights = (series: string) =>
      [...container.querySelectorAll(`rect[data-series="${series}"]`)].map((r) =>
        Number(r.getAttribute("height"))
      );
    const decode = heights("decode");
    const prefill = heights("prefill");
    // The day holding each series' max fills the chart (CHART_H − 2 = 34).
    expect(decode[0]).toBeCloseTo(34);
    expect(prefill[0]).toBeCloseTo(34);
    // Half the decode max is half the height — proportional to decode's own max.
    expect(decode[2]).toBeCloseTo(17);
    expect(decode[2]).toBeGreaterThan(1);
    expect(decode[1]).toBe(0);
    // The tooltip still reports real values, not scaled ones.
    const bar = container.querySelector('[data-day="2026-10-06"]')!;
    act(() => {
      bar.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(tooltip(container).slice(1, 3)).toEqual([
      "Decode peak 102 tok/s (avg 25.6)",
      "Prefill peak 49996 tok/s (avg 6250)",
    ]);
  });

  it("shows date, decode peak and prefill peak for the hovered day", async () => {
    const { container } = await renderChart();
    expect(tooltip(container)).toEqual([]);
    const bar = container.querySelector('[data-day="2026-10-04"]')!;
    act(() => {
      bar.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(tooltip(container)).toEqual([
      "2026-10-04",
      "Decode peak 96.0 tok/s (avg 24.0)",
      "Prefill peak 0.0 tok/s (avg —)",
    ]);
  });

  it("reads each day from the keyboard, starting at today", async () => {
    const { container } = await renderChart();
    const group = container.querySelector<HTMLElement>('[role="group"]')!;
    expect(group.tabIndex).toBe(0);
    act(() => group.focus());
    expect(tooltip(container)[0]).toBe("2026-10-06");
    expect(group.getAttribute("aria-describedby")).toBe(
      container.querySelector('[role="status"]')?.id
    );
    act(() => {
      group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(tooltip(container)[0]).toBe("2026-10-05");
    act(() => {
      group.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(tooltip(container)[0]).toBe("2026-10-04");
    act(() => group.blur());
    expect(tooltip(container)).toEqual([]);
  });
});
