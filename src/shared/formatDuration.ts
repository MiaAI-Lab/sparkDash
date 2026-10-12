import { i18next } from "../i18n";

/** Bench and share-card duration. Seconds roll into the next minute instead of printing 60. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "\u2014";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) {
    const text = seconds.toFixed(1);
    if (text === "60.0") return i18next.t("common.duration.minuteSeconds", "{minutes}m {seconds}s", { minutes: 1, seconds: 0 });
    return `${text} s`;
  }
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rem = total % 60;
  return i18next.t("common.duration.minuteSeconds", "{minutes}m {seconds}s", { minutes, seconds: rem });
}
