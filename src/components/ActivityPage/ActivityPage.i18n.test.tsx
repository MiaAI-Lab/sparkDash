import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ActivityEvent } from "../../api/types";
import { setLocale } from "../../i18n";
import { flush, render } from "../../testing/render";
import { ActivityPage } from "./ActivityPage";
import { exportText } from "./activityStats";
import { useActivityFeed } from "./useActivityFeed";

vi.mock("./useActivityFeed", () => ({ useActivityFeed: vi.fn() }));
const now = Date.UTC(2026, 9, 31, 12);
const events: ActivityEvent[] = [
  { id: 2, ts: now - 120_000, type: "spark.offline", severity: "error", sparkId: "raw-id", sparkName: "Raw <host>", message: "Raw <host> offline: E_CONN", data: { diagnostic: "Raw error", count: 0 } },
  { id: 1, ts: now - 240_000, type: "spark.online", severity: "info", sparkId: "other-id", sparkName: "Other", message: "Other online" },
];
const clear = vi.fn();
const refresh = vi.fn();
const writeText = vi.fn().mockResolvedValue(undefined);
const button = (container: HTMLElement, text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === text)!;
const chart = (container: HTMLElement) => [...container.querySelectorAll(".chart svg rect")].map(n => ["x", "y", "width", "height"].map(a => n.getAttribute(a)));

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  clear.mockReset().mockResolvedValue(2);
  refresh.mockReset();
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  vi.mocked(useActivityFeed).mockReturnValue({
    events, status: "ready", error: null, reload: vi.fn(), refresh, clear, refreshing: false,
    paused: false, pollError: false, lastUpdated: now, fresh: new Set(), loadOlder: vi.fn(),
    loadingMore: false, moreError: null, reachedOldest: true,
  });
  await act(() => setLocale("en"));
});
afterEach(async () => { await act(() => setLocale("en")); vi.restoreAllMocks(); });

it("retains filters, expanded raw event data and chart geometry across a language round-trip", async () => {
  const { container } = render(<ActivityPage sparks={[]} />);
  act(() => (container.querySelector('[title="Error events"]') as HTMLButtonElement).click());
  act(() => (container.querySelector('.ac-row__toggle') as HTMLButtonElement).click());
  expect(container.querySelectorAll('.ac-row')).toHaveLength(1);
  const geometry = chart(container);
  const original = container.textContent;
  await act(() => setLocale("zh-CN"));
  expect(container.querySelector("h1")?.textContent).toBe("活动");
  expect(container.querySelector('[title="错误事件"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector('.ac-row__toggle')?.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector('.ac-detail__data')?.textContent).toContain('"count": 0');
  expect(container.textContent).toContain("Raw <host> offline: E_CONN");
  expect(chart(container)).toEqual(geometry);
  await act(async () => button(container, "复制为文本").click());
  expect(writeText).toHaveBeenCalledWith(exportText(events.slice(0, 1)));
  expect(container.textContent).toContain("已复制 1 条事件");
  expect(refresh).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
  await act(() => setLocale("en"));
  expect(container.querySelector('.ac-row__toggle')?.getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent?.replace("Copied 1 event", "")).toBe(original);
});

it("updates an open deletion choice and pending result without changing its argument or sending an extra operation", async () => {
  let finish!: (n: number) => void;
  clear.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { container } = render(<ActivityPage sparks={[]} />);
  act(() => button(container, "Clear history…").click());
  act(() => button(container, "Older than 7 days").click());
  await act(() => setLocale("zh-CN"));
  expect(container.textContent).toContain("删除早于 7 天的事件？");
  expect(clear).not.toHaveBeenCalled();
  act(() => button(container, "删除").click());
  expect(clear).toHaveBeenCalledExactlyOnceWith(7 * 86_400_000);
  await act(() => setLocale("en"));
  expect(button(container, "Deleting…").disabled).toBe(true);
  await act(async () => finish(2));
  await flush();
  expect(container.textContent).toContain("Deleted 2 events");
  await act(() => setLocale("zh-CN"));
  expect(container.textContent).toContain("已删除 2 条事件");
  expect(clear).toHaveBeenCalledTimes(1);
});
