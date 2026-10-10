import type { ActivityEvent } from "../../api/types";
import { tzOffsetMinutes } from "../../shared/timeZone";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Compact relative time: "now", "2m", "3h", "5d", then "Oct 5" after a week. */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${Math.max(1, min)}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  // Month and day in the Settings time zone (else the browser's), via the same offset the charts use.
  const d = new Date(ts + tzOffsetMinutes(ts) * 60_000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
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
