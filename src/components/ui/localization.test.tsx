import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { setLocale } from "../../i18n";
import { render } from "../../testing/render";
import { TerminalCard } from "../ShowcasePage/TerminalCard";
import { promptTypeText, showcaseError } from "../ShowcasePage/showcaseText";
import { bucketLabel, bucketTitle, formatAgo, groupBuckets, localizedRange, previousRangePhrase } from "../TokensPage/tokenStats";
import { fixedTz, formatLocalDay, formatLocalHour } from "../EnergyPage/energyStats";
import { monthLabel, yearBars } from "../EnergyPage/monthlyStats";
import { ConnectionBanner } from "./ConnectionBanner";
import { HealthList } from "./HealthFindings";
import type { HealthFinding } from "../../api/types";

afterEach(async () => {
  await act(async () => { await setLocale("en", { persist: false }); });
});

it("switches existing terminal controls and status without altering model output", async () => {
  const { container } = render(<TerminalCard label="My prompt" status="completed" liveTokPerSec={3} peakTokPerSec={5} content="Model output stays English." reasoning="Raw reasoning" error={null} onCopy={() => {}} />);
  expect(container.querySelector('[title="Copy this terminal"]')).toBeTruthy();
  await act(async () => { await setLocale("zh-Hans", { persist: false }); });
  expect(container.querySelector('[title="复制此终端"]')).toBeTruthy();
  expect(container.querySelector('.showcase-term__status')?.textContent).toBe("已完成");
  expect(container.textContent).toContain("推理");
  expect(container.textContent).toContain("My prompt");
  expect(container.textContent).toContain("Model output stays English.");
  expect(promptTypeText("mixed").hint).toContain("结构化");
  expect(showcaseError("Use between 1 and 32 non-empty prompts")).toBe("请输入 1 至 32 条非空提示词");
  await act(async () => { await setLocale("en", { persist: false }); });
  expect(container.querySelector('[title="Copy this terminal"]')).toBeTruthy();
});

it("refreshes time, range and series helpers using the current language", async () => {
  const when = Date.UTC(2026, 9, 11, 12);
  expect(monthLabel("2026-10")).toBe("October 2026");
  expect(formatAgo(when - 600_000, when)).toBe("10 min ago");
  await setLocale("zh-Hans", { persist: false });
  expect(localizedRange("7d").phrase).toBe("最近 7 天");
  expect(previousRangePhrase("24h")).toBe("前一个 24 小时");
  expect(bucketLabel("2026-10-11", "day")).toContain("10月");
  expect(bucketTitle("2026-10-11T12", "hour", 0)).toContain("本地时间");
  expect(formatAgo(when - 600_000, when)).toBe("10 分钟前");
  expect(groupBuckets([], ["2026-10-11"], "type").series.map((s) => s.label)).toEqual(["已生成", "缓存预填充", "计算预填充"]);
  expect(formatLocalDay(when, fixedTz(0))).toContain("10月");
  expect(formatLocalHour(when, fixedTz(0))).toContain("周日");
  expect(monthLabel("2026-10")).toBe("2026年10月");
  expect(yearBars([], 2026)[9].label).toBe("10月");
  await setLocale("en", { persist: false });
  expect(monthLabel("2026-10")).toBe("October 2026");
});

it("updates mounted telemetry and server health text when the language changes", async () => {
  const finding: HealthFinding = { id: "memory", severity: "warn", title: "Unified memory is running low", detail: "operator evidence", hint: "operator hint", i18n: { title: { key: "health.memory.title.warn" }, detail: { key: "unknown.detail" }, hint: { key: "unknown.hint" } } };
  const { container } = render(<><ConnectionBanner connected={false} snapshotError={null} stale={false} now={25_000} lastValidSnapshotAt={10_000} /><HealthList findings={[finding]} /></>);
  expect(container.textContent).toContain("Showing data from 15s ago");
  await act(async () => { await setLocale("zh-Hans", { persist: false }); });
  expect(container.textContent).toContain("15秒前");
  expect(container.querySelector('.health-item__title')?.textContent).toContain("统一内存");
  expect(container.textContent).toContain("operator evidence");
});
