import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent, AlertInstance } from "../../api/types";
import { setLocale } from "../../i18n";
import { makeSpark } from "../../testing/fixtures";
import { flush, render } from "../../testing/render";
import { ActivityFeed } from "./ActivityFeed";
import { FleetAlertStrip, deriveAlerts } from "./FleetAlertStrip";

vi.mock("../../api/client", () => ({ fetchEvents: vi.fn() }));
import { fetchEvents } from "../../api/client";

const now = new Date("2026-10-31T12:00:00Z").getTime();

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(now);
  vi.clearAllMocks();
  await setLocale("en");
});

afterEach(async () => {
  await act(async () => setLocale("en"));
  vi.useRealTimers();
});

describe("Overview activity and alerts localization", () => {
  it("localizes activity chrome and time while preserving event messages, names and polling", async () => {
    const event: ActivityEvent = {
      id: 1, ts: now - 120_000, type: "gpu.throttle.thermal", severity: "warn",
      sparkId: "alpha", sparkName: "Raw 主机", message: "Raw 主机: original event <details>",
    };
    vi.mocked(fetchEvents).mockResolvedValue([event]);
    const onSelect = vi.fn();
    const { container } = render(<ActivityFeed onSelectSpark={onSelect} onViewAll={() => {}} />);
    await flush();
    expect(container.querySelector("time")?.textContent).toBe("2m");

    await act(async () => setLocale("zh-CN"));
    expect(container.querySelector("h3")?.textContent).toBe("最近活动");
    expect(container.querySelector("time")?.textContent).toBe("2分");
    expect(container.textContent).toContain(event.message);
    expect(container.querySelector('[aria-label="警告"]')).not.toBeNull();
    act(() => container.querySelector<HTMLAnchorElement>('a[href="/spark/alpha"]')!.click());
    expect(onSelect).toHaveBeenCalledWith("alpha");

    await act(async () => setLocale("en"));
    expect(container.querySelector("time")?.textContent).toBe("2m");
    expect(container.textContent).toContain(event.message);
    expect(fetchEvents).toHaveBeenCalledOnce();
  });

  it("translates locally derived alert text without changing rules, raw diagnostics, temperature or active duration", async () => {
    const spark = makeSpark("alpha");
    spark.metrics.gpu!.temperature = 88;
    spark.metrics.gpu!.throttle = { active: true, reason: "thermal", thermal: true, hwSlowdown: false, powerCap: false, detail: "HW thermal slowdown <raw>", smClockMHz: 1200, smClockMaxMHz: 3000, smClockPct: 40 };
    const original = deriveAlerts([spark], "fahrenheit");
    const onSelect = vi.fn();
    const { container } = render(<FleetAlertStrip sparks={[spark]} temperatureUnit="fahrenheit" onSelect={onSelect} />);
    act(() => vi.advanceTimersByTime(120_000));
    await act(async () => setLocale("zh-CN"));
    expect(container.textContent).toContain("正在因温度过高而降频");
    expect(container.textContent).toContain("HW thermal slowdown <raw> · GPU 温度为 190°F · SM 时钟 1.2 GHz（最大值的 40%）");
    expect(container.textContent).toContain("已持续 2 分钟");
    act(() => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(onSelect).toHaveBeenCalledWith("alpha");
    expect(deriveAlerts([spark], "fahrenheit")).toEqual(original);
    await act(async () => setLocale("en"));
    expect(container.textContent).toContain("HW thermal slowdown <raw> · GPU at 190°F · SM clock 1.2 GHz (40% of max)");
    expect(container.textContent).toContain("2m active");
  });

  it("leaves server-only alert wording and its start time untouched", async () => {
    const alert: AlertInstance = {
      key: "alpha:memory", ruleId: "memory", ruleName: "Memory low", unitId: "alpha", unitName: "Raw 主机",
      severity: "warning", state: "firing", label: "Server diagnostic", summary: "Original detail: 2.8 GB <raw>",
      startsAt: now - 125 * 60_000, firingAt: now - 124 * 60_000,
    };
    const { container } = render(<FleetAlertStrip sparks={[makeSpark("alpha")]} alertsEnabled serverAlerts={[alert]} />);
    await act(async () => setLocale("zh-CN"));
    expect(container.textContent).toContain("Raw 主机 Server diagnostic.");
    expect(container.textContent).toContain("Original detail: 2.8 GB <raw> · 已持续 125 分钟");
    expect(container.querySelector("button")?.textContent).toBe("打开 Raw 主机");
  });
});
