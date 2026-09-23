/**
 * Relative-time label for a ms-epoch timestamp (seam convention: all
 * timestamps are ms epoch, see shared/types.ts).
 *
 * - diff < 5s    -> "just now"
 * - diff < 60s   -> "Ns ago"
 * - diff < 60m   -> "Nm ago"
 * - diff < 24h   -> "Nh ago"
 * - otherwise    -> "Nd ago"
 * - non-finite / <= 0 -> "—"
 *
 * Future timestamps clamp to "just now" (never a negative label).
 */
export function timeAgo(polledAt: number, now: number = Date.now()): string {
  if (!Number.isFinite(polledAt) || polledAt <= 0) return "—";
  const diffMs = Math.max(0, now - polledAt);
  const s = Math.floor(diffMs / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
