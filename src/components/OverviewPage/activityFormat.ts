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

/** Front-end mapping for known server-generated event messages. */
export function localizeEventMessage(
  type: string,
  message: string,
  t: (k: string, o?: Record<string, unknown>) => string
): string {
  const bench = message.match(/^(Decode|Prefill|Quality) bench (finished|failed|cancelled) on (.+?)(: .+)?$/);
  if (bench) {
    const kind = bench[1].toLowerCase();
    const key =
      bench[2] === "finished" ? "activity.bench_finished" : bench[2] === "failed" ? "activity.bench_failed" : "activity.bench_cancelled";
    const rawDetail = (bench[4] ?? "").replace(/^:\s*/, "");
    const detail =
      rawDetail === "Interrupted — server restarted while the benchmark was running"
        ? `: ${t("bench.interrupted")}`
        : rawDetail
          ? `: ${rawDetail}`
          : "";
    return t(key, { kind: t(`bench.name_${kind}`), spark: bench[3], detail });
  }
  const hermes = message.match(/^Hermes update failed on (.+)$/);
  if (hermes) return t("activity.hermes_failed", { spark: hermes[1] });
  return message;
}
