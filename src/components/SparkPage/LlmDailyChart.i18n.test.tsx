import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import { fetchLlmDaily } from "../../api/client";
import type { LlmDailyDay } from "../../api/types";
import { flush, render } from "../../testing/render";
import { LlmDailyChart } from "./LlmDailyChart";

vi.mock("../../api/client", () => ({ fetchLlmDaily: vi.fn() }));

const fetchDaily = vi.mocked(fetchLlmDaily);

function day(date: string, decodeMax: number, prefillMax: number): LlmDailyDay {
  return { date, decodeMax, decodeAvg: decodeMax ? decodeMax / 4 : null, prefillMax, prefillAvg: prefillMax ? prefillMax / 8 : null, cachedPrefillMax: null, cachedPrefillAvg: null, uncachedPrefillMax: null, uncachedPrefillAvg: null };
}

const DAYS = [day("2026-10-04", 96, 0), day("2026-10-05", 0, 0), day("2026-10-06", 120, 80)];
const geometry = (container: HTMLElement) => [...container.querySelectorAll<SVGRectElement>('rect[data-series]')]
  .map(rect => [rect.dataset.series, rect.getAttribute("x"), rect.getAttribute("y"), rect.getAttribute("width"), rect.getAttribute("height")]);
const tooltip = (container: HTMLElement) => [...container.querySelectorAll('[role="status"] > div')].map(element => element.textContent);

beforeEach(async () => {
  fetchDaily.mockReset();
  await act(() => setLocale("en"));
});
afterEach(async () => {
  await act(() => setLocale("en"));
  vi.restoreAllMocks();
});

it("switches a selected day EN → zh → EN without changing bars, focus, or polling", async () => {
  fetchDaily.mockResolvedValue({ sparkId: "locale-daily", port: 8888, days: DAYS });
  const { container } = render(<LlmDailyChart sparkId="locale-daily" llmPort={8888} />);
  await flush();
  const group = container.querySelector<HTMLElement>('[role="group"]')!;
  const before = geometry(container);
  act(() => group.focus());
  act(() => group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
  expect(tooltip(container)).toEqual(["2026-10-05", "Decode peak 0.0 tok/s (avg —)", "Prefill peak 0.0 tok/s (avg —)"]);
  const tooltipId = group.getAttribute("aria-describedby");

  await act(() => setLocale("zh-CN"));
  expect(container.textContent).toContain("每日峰值 tok/s");
  expect(group.getAttribute("aria-label")).toContain("使用方向键");
  expect(tooltip(container)).toEqual(["2026-10-05", "解码峰值 0.0 tok/s（平均 —）", "预填充峰值 0.0 tok/s（平均 —）"]);
  expect(geometry(container)).toEqual(before);
  expect(document.activeElement).toBe(group);
  expect(group.getAttribute("aria-describedby")).toBe(tooltipId);
  expect(fetchDaily).toHaveBeenCalledTimes(1);

  await act(() => setLocale("en"));
  expect(tooltip(container)[0]).toBe("2026-10-05");
  expect(geometry(container)).toEqual(before);
  expect(document.activeElement).toBe(group);
  expect(fetchDaily).toHaveBeenCalledTimes(1);
});

it("keeps split cache lines and null-versus-zero measurements distinct when localized", async () => {
  const split: LlmDailyDay = { ...day("2026-10-06", 120, 900), uncachedPrefillMax: 0, uncachedPrefillAvg: null, cachedPrefillMax: null, cachedPrefillAvg: 0 };
  fetchDaily.mockResolvedValue({ sparkId: "split-daily", port: 8888, days: [split] });
  const { container } = render(<LlmDailyChart sparkId="split-daily" llmPort={8888} />);
  await flush();
  act(() => container.querySelector<HTMLElement>('[role="group"]')!.focus());
  expect(tooltip(container)).toEqual(["2026-10-06", "Decode peak 120 tok/s (avg 30.0)", "Uncached prefill peak 0.0 tok/s (avg —)", "Cached prefill peak — tok/s (avg 0.0)"]);
  await act(() => setLocale("zh-CN"));
  expect(tooltip(container)).toEqual(["2026-10-06", "解码峰值 120 tok/s（平均 30.0）", "未缓存预填充峰值 0.0 tok/s（平均 —）", "缓存预填充峰值 — tok/s（平均 0.0）"]);
  expect(fetchDaily).toHaveBeenCalledTimes(1);
});

it("keeps empty history hidden while translating an observed idle window", async () => {
  fetchDaily.mockResolvedValue({ sparkId: "hidden-daily", port: 8888, days: [] });
  const hidden = render(<LlmDailyChart sparkId="hidden-daily" llmPort={8888} />);
  await flush();
  expect(hidden.container.textContent).toBe("");
  await act(() => setLocale("zh-CN"));
  expect(hidden.container.textContent).toBe("");

  fetchDaily.mockResolvedValue({ sparkId: "idle-daily", port: 8888, days: [day("2026-10-06", 0, 0)] });
  const idle = render(<LlmDailyChart sparkId="idle-daily" llmPort={8888} />);
  await flush();
  expect(idle.container.textContent).toContain("最近 14 天没有繁忙采样。");
  expect(idle.container.querySelector("svg")).toBeNull();
  await act(() => setLocale("en"));
  expect(idle.container.textContent).toContain("No busy samples in the last 14 days.");
  expect(fetchDaily).toHaveBeenCalledTimes(2);
});
