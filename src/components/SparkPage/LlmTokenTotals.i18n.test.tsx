import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import { fetchLlmTokenTotals } from "../../api/llmTokenClient";
import type { LlmTokenTotalsResponse } from "../../api/llmTokenTypes";
import { flush, render } from "../../testing/render";
import { LlmTokenTotals } from "./LlmTokenTotals";

vi.mock("../../api/llmTokenClient", () => ({ fetchLlmTokenTotals: vi.fn() }));

const response = (): LlmTokenTotalsResponse => ({
  range: "all",
  series: [{
    sparkId: "token-locale", port: 8888, updatedAt: 1_000_000, lastModelId: "Raw/model <v1>",
    totals: { promptTokens: 3600, cachedTokens: 800, completionTokens: 30, unreportedPromptTokens: 2600 },
    models: [
      { modelId: "Raw/model <v1>", promptTokens: 3000, cachedTokens: 800, completionTokens: 30, unreportedPromptTokens: 2000, lastSeenAt: 880_000 },
      { modelId: "Raw legacy", promptTokens: 600, cachedTokens: 0, completionTokens: 0, cacheReported: false, lastSeenAt: 0 },
    ],
  }, {
    sparkId: "token-locale", port: 9000, updatedAt: 1, lastModelId: "Other port",
    totals: { promptTokens: 9999, cachedTokens: 0, completionTokens: 0 },
    models: [{ modelId: "Other port", promptTokens: 9999, cachedTokens: 0, completionTokens: 0, lastSeenAt: 1 }],
  }],
});

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  vi.mocked(fetchLlmTokenTotals).mockReset().mockResolvedValue(response());
  await act(() => setLocale("en"));
});
afterEach(async () => {
  await act(() => setLocale("en"));
  vi.restoreAllMocks();
});
const choose = (select: HTMLSelectElement, range: string) => act(() => {
  select.value = range;
  select.dispatchEvent(new Event("change", { bubbles: true }));
});
const values = (container: HTMLElement) => [...container.querySelectorAll(".sp-tok-rows .font-tabular > span")].map(e => e.textContent);

it("translates totals and range labels without changing raw models, cache accounting or API range values", async () => {
  const { container } = render(<LlmTokenTotals sparkId="token-locale" llmPort={8888} />);
  await flush();
  const select = container.querySelector("select")!;
  choose(select, "14d");
  await flush();
  expect(fetchLlmTokenTotals).toHaveBeenLastCalledWith("14d");
  const original = container.textContent;
  const originalValues = values(container);
  expect(originalValues).toEqual(["800", "200", "30", "—", "0", "0"]);
  expect(original).not.toContain("Other port");
  const rows = [...container.querySelectorAll<HTMLElement>(".sp-tok-rows > div")];
  expect(rows[0].title).toBe("3,000 prompt · 800 cached · 200 prefill · 2,000 not reported · 30 generated · 2m ago");
  expect(rows[1].title).toBe("600 prompt · 0 cached · 0 prefill · 600 not reported · 0 generated");
  await act(() => setLocale("zh-CN"));
  expect(container.textContent).toContain("按模型累计 Token");
  expect(container.querySelector(".sp-section__head [title]")?.getAttribute("title")).toContain("引擎重启后仍保留");
  expect(select.getAttribute("aria-label")).toBe("Token 累计时间范围");
  expect(select.value).toBe("14d");
  expect([...select.options].map(o => [o.value, o.text])).toEqual([
    ["all", "全部时间"], ["today", "最近 24 小时"], ["6h", "最近 6 小时"],
    ["1h", "最近 1 小时"], ["7d", "最近 7 天"], ["14d", "最近 14 天"], ["30d", "最近一个月"],
  ]);
  expect(rows[0].title).toBe("3,000 提示词 · 800 缓存 · 200 预填充 · 2,000 未报告 · 30 已生成 · 2m 前");
  expect(rows[1].title).toContain("600 未报告");
  expect(rows[0].querySelector('[title="Raw/model <v1>"]')?.textContent).toBe("Raw/model <v1>");
  expect(values(container)).toEqual(originalValues);
  expect(fetchLlmTokenTotals).toHaveBeenCalledTimes(2);
  await act(() => setLocale("en"));
  expect(container.textContent).toBe(original);
  expect(select.value).toBe("14d");
  expect(fetchLlmTokenTotals).toHaveBeenCalledTimes(2);
});

it("retains a pending range request, localizes its empty result and keeps failed reads hidden", async () => {
  const { container } = render(<LlmTokenTotals sparkId="token-locale" llmPort={8888} />);
  await flush();
  const select = container.querySelector("select")!;
  let finish!: (value: LlmTokenTotalsResponse) => void;
  vi.mocked(fetchLlmTokenTotals).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  choose(select, "today");
  await act(() => setLocale("zh-CN"));
  expect(select.value).toBe("today");
  expect(fetchLlmTokenTotals).toHaveBeenCalledTimes(2);
  await act(async () => finish({ range: "today", series: response().series.slice(1) }));
  expect(container.textContent).toContain("此时间段没有 Token 记录。");
  expect(container.querySelectorAll(".sp-tok-rows > div")).toHaveLength(0);
  await act(() => setLocale("en"));
  expect(container.textContent).toContain("No tokens recorded in this period.");
  expect(fetchLlmTokenTotals).toHaveBeenCalledTimes(2);
  vi.mocked(fetchLlmTokenTotals).mockRejectedValueOnce(new Error("RAW fetch failure"));
  choose(select, "1h");
  await flush();
  expect(container.textContent).toBe("");
  expect(fetchLlmTokenTotals).toHaveBeenLastCalledWith("1h");
});
