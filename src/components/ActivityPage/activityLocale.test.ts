import { afterEach, expect, it } from "vitest";
import { setLocale } from "../../i18n";
import { dayLabel, eventsPerDay, formatClock, localDayKey } from "./activityStats";

afterEach(async () => {
  await setLocale("en", { persist: false });
  localStorage.clear();
});

it("refreshes cached date labels on a language change without changing the day or time zone", async () => {
  const now = Date.UTC(2026, 9, 11, 16, 30);
  const day = "2026-10-07";
  await setLocale("en", { persist: false });
  const english = dayLabel(day, now, "Asia/Shanghai");
  const englishBuckets = eventsPerDay([], now, 7, "Asia/Shanghai");
  expect(english).toMatch(/Wednesday.*Oct/);
  await setLocale("zh-Hans", { persist: false });
  expect(dayLabel(day, now, "Asia/Shanghai")).toBe(new Intl.DateTimeFormat("zh-CN", {
    weekday: "long", month: "short", day: "numeric", timeZone: "UTC",
  }).format(new Date(Date.UTC(2026, 9, 7))));
  const chineseBuckets = eventsPerDay([], now, 7, "Asia/Shanghai");
  expect(chineseBuckets.map((b) => b.key)).toEqual(englishBuckets.map((b) => b.key));
  expect(chineseBuckets[0].label).not.toBe(englishBuckets[0].label);
  expect(localDayKey(now, "Asia/Shanghai")).toBe("2026-10-12");
  expect(formatClock(now, "Asia/Shanghai")).toBe("00:30");
  await setLocale("en", { persist: false });
  expect(dayLabel(day, now, "Asia/Shanghai")).toBe(english);
});
