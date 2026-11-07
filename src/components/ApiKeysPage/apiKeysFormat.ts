/** Formatting for the API Keys page. A missing value is "unknown", never a fabricated 0. */
export const UNKNOWN = "unknown";
export interface ApiKeysFormatLabels {
  unknown?: string;
  unlimited?: string;
}

export function fmtUsd(v: number | null | undefined, labels: ApiKeysFormatLabels = {}): string {
  if (v == null || !Number.isFinite(v)) return labels.unknown ?? UNKNOWN;
  return `$${v < 1 ? v.toFixed(4) : v.toFixed(2)}`;
}

export function fmtBudget(max: number | null, duration: string | null, labels: ApiKeysFormatLabels = {}): string {
  if (max == null) return labels.unlimited ?? "no limit";
  return duration ? `${fmtUsd(max, labels)} / ${duration}` : fmtUsd(max, labels);
}

export function fmtLimit(v: number | null): string {
  return v == null ? "—" : String(v);
}

export function fmtDate(v: string | null, labels: ApiKeysFormatLabels = {}): string {
  if (!v) return "—";
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace("T", " ") : labels.unknown ?? UNKNOWN;
}

/** Short, non-secret handle for a hashed key id. */
export function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}
