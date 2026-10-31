import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TokenHistory, TokenHistoryRow } from "../../api/types";
import { setLocale } from "../../i18n";
import { makeSpark } from "../../testing/fixtures";
import { flush, render } from "../../testing/render";
import { bucketKeys } from "./tokenStats";
import { TokensPage } from "./TokensPage";

const { fetchHistory, fetchTotals } = vi.hoisted(() => ({ fetchHistory: vi.fn(), fetchTotals: vi.fn() }));
vi.mock("../../api/client", () => ({ fetchTokenHistory: fetchHistory, resetTokenTotals: vi.fn() }));
vi.mock("../../api/llmTokenClient", () => ({ fetchLlmTokenTotals: fetchTotals }));

const row = (t: string): TokenHistoryRow => ({
  t, sparkId: "spark-1", port: 8888, modelId: "raw/model:Q4", promptTokens: 1_000,
  completionTokens: 100, cachedTokens: 0, cacheReported: false, unreportedPromptTokens: 1_000,
});
const button = (container: HTMLElement, text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text)!;
const geometry = (container: HTMLElement) => [...container.querySelectorAll(".chart svg rect")].map((n) => ["x", "y", "width", "height"].map((a) => n.getAttribute(a)));

beforeEach(async () => {
  const now = Date.now();
  const history: TokenHistory = {
    generatedAt: now, retention: { days: 35, hours: 72 }, firstDay: null, firstHour: null,
    day: [row(bucketKeys("day", 1, now)[0])], hour: [row(bucketKeys("hour", 1, now)[0])],
  };
  fetchHistory.mockReset().mockResolvedValue(history);
  fetchTotals.mockReset().mockResolvedValue({ range: "all", series: [] });
  await act(() => setLocale("en"));
});
afterEach(async () => { await act(() => setLocale("en")); });

it("keeps token range, grouping, chart geometry, raw model and unreported-cache semantics across a locale round-trip without reloading", async () => {
  const { container } = render(<TokensPage sparks={[makeSpark()]} />);
  await flush();
  act(() => button(container, "Last 24 h").click());
  act(() => button(container, "Model").click());
  expect(container.textContent).toContain("Over 1 hour tracked");
  const before = geometry(container);
  expect(container.textContent).toContain("raw/model:Q4");
  expect(container.textContent).toContain("does not report prefix-cache hits");
  expect(fetchHistory).toHaveBeenCalledTimes(1);
  expect(fetchTotals).toHaveBeenCalledTimes(1);

  await act(() => setLocale("zh-CN"));
  expect(container.querySelector('[aria-label="时间范围"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="图表分组方式"]')).not.toBeNull();
  expect(container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2);
  expect(container.textContent).toContain("raw/model:Q4");
  expect(container.textContent).toContain("不报告前缀缓存命中");
  expect(geometry(container)).toEqual(before);
  expect(fetchHistory).toHaveBeenCalledTimes(1);
  expect(fetchTotals).toHaveBeenCalledTimes(1);

  await act(() => setLocale("en"));
  expect(button(container, "Last 24 h").getAttribute("aria-pressed")).toBe("true");
  expect(button(container, "Model").getAttribute("aria-pressed")).toBe("true");
  expect(geometry(container)).toEqual(before);
  expect(fetchHistory).toHaveBeenCalledTimes(1);
  expect(fetchTotals).toHaveBeenCalledTimes(1);
});

it("pluralizes comparison and tracked periods without changing the selected window", async () => {
  const now = Date.now();
  fetchHistory.mockResolvedValue({
    generatedAt: now, retention: { days: 35, hours: 72 }, firstDay: null, firstHour: null,
    day: bucketKeys("day", 14, now).map(row), hour: bucketKeys("hour", 48, now).map(row),
  });
  const { container } = render(<TokensPage sparks={[makeSpark()]} />);
  await flush();
  expect(container.textContent).toContain("vs previous 7 days");
  expect(container.textContent).toContain("Over 7 days tracked");
  act(() => button(container, "Last 24 h").click());
  expect(container.textContent).toContain("vs previous 24 hours");
  expect(container.textContent).toContain("Over 24 hours tracked");
  await act(() => setLocale("zh-CN"));
  expect(container.textContent).toContain("已跟踪 24 小时");
  expect(fetchHistory).toHaveBeenCalledTimes(1);
});
