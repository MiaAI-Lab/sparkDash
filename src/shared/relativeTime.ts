/**
 * How long ago a file or folder last changed, in plain words: "today", "yesterday", "3 days ago",
 * "5 months ago", "2 years ago". Days and months are calendar ones in this browser's time zone, so
 * something changed late yesterday reads "yesterday", not "today".
 */

/** 1980-01-01 UTC. Earlier times are placeholders (an unset clock, a normalized archive), not real dates. */
export const EARLIEST_REAL_SECONDS = 315_532_800;

const DAY_MS = 86_400_000;

/** The time itself when it is usable, or null (missing, not a number, or before 1980). */
export function usableSeconds(epochSeconds: number | null | undefined): number | null {
  return epochSeconds == null || !Number.isFinite(epochSeconds) || epochSeconds < EARLIEST_REAL_SECONDS ? null : epochSeconds;
}

function realMs(epochSeconds: number | null | undefined): number | null {
  const s = usableSeconds(epochSeconds);
  return s == null ? null : s * 1000;
}

/** Calendar days and months from `then` to `now`, both local dates. */
function calendarGap(thenMs: number, nowMs: number): { days: number; months: number } {
  const then = new Date(thenMs);
  const now = new Date(nowMs);
  // Local midnights compared as UTC dates: a day is a day across a daylight-saving change.
  const days = Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(then.getFullYear(), then.getMonth(), then.getDate())) / DAY_MS);
  const months = (now.getFullYear() - then.getFullYear()) * 12 + now.getMonth() - then.getMonth() - (now.getDate() < then.getDate() ? 1 : 0);
  return { days, months };
}

/**
 * `epochSeconds` (whole seconds since 1970) as words relative to `nowMs`, or null when there is no usable
 * time. A time in the future (another machine's clock running ahead) reads "today".
 */
export function relativeTime(epochSeconds: number | null | undefined, nowMs: number = Date.now()): string | null {
  const ms = realMs(epochSeconds);
  if (ms == null) return null;
  const { days, months } = calendarGap(Math.min(ms, nowMs), nowMs);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const m = Math.max(1, months);
  if (m < 12) return m === 1 ? "1 month ago" : `${m} months ago`;
  const years = Math.floor(m / 12);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

/** Not changed for a year or more: worth a second look when freeing space. False when unknown. */
export function isStale(epochSeconds: number | null | undefined, nowMs: number = Date.now()): boolean {
  const ms = realMs(epochSeconds);
  return ms != null && nowMs - ms >= 365 * DAY_MS;
}
