import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanupRenders, render } from "../testing/render";
import { AppSidebar } from "../components/shell/AppSidebar";
import { setLocale } from ".";
import { formatSince } from "../shared/formatSince";
import { formatDuration } from "../shared/formatDuration";
import { idleLabel } from "../shared/llmIdle";
import { segmentLabel, verdict, type VramBreakdown } from "../shared/vramBreakdown";
import { SparkHeader } from "../components/SparkPage/SparkHeader";
import { makeSpark } from "../testing/fixtures";
import { fmtDuration } from "../components/bench/tooleval/format";

afterEach(async () => { cleanupRenders(); await setLocale("en", { persist: false }); });

it("updates expanded benchmark navigation and tooltips both ways without remounting", async () => {
  await setLocale("en", { persist: false });
  render(<AppSidebar sparks={[]} activeId={null} connected onSelect={() => {}} onAdd={() => {}} onOpenSettings={() => {}} onOpenSearch={() => {}} benchType="decode" onSelectBench={() => {}} />);
  const name = () => document.querySelector('a[href="/bench/decode"] .rail-item__name')?.textContent;
  expect(name()).toBe("Decode");
  await act(async () => { await setLocale("zh-Hans", { persist: false }); });
  expect(name()).toBe("解码");
  expect(document.querySelector('a[href="/bench/decode"]')?.getAttribute("title")).not.toContain("Generation speed");
  expect(document.body.textContent).toContain("基准测试");
  await act(async () => { await setLocale("en", { persist: false }); });
  expect(name()).toBe("Decode");
});

it("formats shared idle, duration and memory explanation in the selected language", async () => {
  const now = 1_000_000;
  await setLocale("en", { persist: false });
  expect(formatSince(now - 120_000, now)).toBe("2m");
  expect(formatDuration(120_000)).toBe("2m 0s");
  expect(idleLabel(now - 120_000, now)).toBe("Idle · last served 2m ago");
  const finding = { tone: "low", model: "unified" } as VramBreakdown;
  expect(verdict(finding)).toBe("Low headroom: CPU-side growth could trigger the OOM killer");
  await setLocale("zh-Hans", { persist: false });
  expect(formatSince(now - 120_000, now)).toBe("2分钟");
  expect(formatDuration(120_000)).toBe("2分 0秒");
  expect(idleLabel(now - 120_000, now)).toContain("空闲");
  expect(segmentLabel("engine")).toBe("模型");
  expect(verdict(finding)).toContain("CPU 内存增长");
  expect(verdict(finding)).not.toContain("could trigger");
});

it("refreshes uptime and benchmark elapsed time without remounting", async () => {
  await setLocale("en", { persist: false });
  render(<SparkHeader spark={{ ...makeSpark(), uptime: 90000 }} />);
  expect(document.body.textContent).toContain("up 1d 1h");
  expect(fmtDuration(75)).toBe("1m 15s");
  expect(fmtDuration(3700)).toBe("1h 01m");
  await act(async () => { await setLocale("zh-Hans", { persist: false }); });
  expect(document.body.textContent).toContain("1天 1小时");
  expect(fmtDuration(75)).toBe("1分 15秒");
  expect(fmtDuration(3700)).toBe("1小时 01分");
  await act(async () => { await setLocale("en", { persist: false }); });
  expect(document.body.textContent).toContain("up 1d 1h");
});
