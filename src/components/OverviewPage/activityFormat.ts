import type { ActivityEvent } from "../../api/types";
import { tzOffsetMinutes } from "../../shared/timeZone";
import { activeLocale, i18next } from "../../i18n";

/** Compact relative time: "now", "2m", "3h", "5d", then "Oct 5" after a week. */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return i18next.t("activity.relative.now", "now");
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return i18next.t("activity.relative.now", "now");
  const min = Math.floor(sec / 60);
  if (min < 60) return i18next.t("activity.relative.minutes", "{count}m", { count: Math.max(1, min) });
  const hr = Math.floor(min / 60);
  if (hr < 24) return i18next.t("activity.relative.hours", "{count}h", { count: hr });
  const day = Math.floor(hr / 24);
  if (day < 7) return i18next.t("activity.relative.days", "{count}d", { count: day });
  // Month and day in the Settings time zone (else the browser's), via the same offset the charts use.
  const d = new Date(ts + tzOffsetMinutes(ts) * 60_000);
  return new Intl.DateTimeFormat(activeLocale() === "en" ? "en-US" : activeLocale(), { month: "short", day: "numeric", timeZone: "UTC" }).format(d);
}

export function severityDotClass(severity: ActivityEvent["severity"]): string {
  switch (severity) {
    case "success":
      return "bg-success";
    case "warn":
      return "bg-warning";
    case "error":
      return "bg-danger";
    case "info":
      return "bg-accent";
    default:
      return "bg-muted";
  }
}

/** Split a message around the first occurrence of the spark name. */
export function splitMessage(
  message: string,
  sparkName?: string | null
): { before: string; name: string; after: string } {
  if (sparkName) {
    const i = message.indexOf(sparkName);
    if (i >= 0) {
      return {
        before: message.slice(0, i),
        name: sparkName,
        after: message.slice(i + sparkName.length),
      };
    }
  }
  return { before: message, name: "", after: "" };
}
