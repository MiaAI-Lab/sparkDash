/**
 * Compact age of an epoch-ms timestamp: "42s", "12m", "5h", "3d".
 * Each unit runs to 1.5× the next before rolling over (90s, 90m, 48h), so
 * "75s" and "80m" stay precise where a rounded "1m" / "1h" would mislead.
 * Returns null when there is no timestamp (null, undefined, ≤ 0, non-finite).
 * A timestamp slightly in the future (clock skew) reads as "0s".
 */
export function formatSince(epochMs: number | null | undefined, now: number = Date.now()): string | null {
  if (epochMs == null || !Number.isFinite(epochMs) || epochMs <= 0) return null;
  const s = Math.max(0, Math.floor((now - epochMs) / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
