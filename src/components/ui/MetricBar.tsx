interface BandOptions {
  /** Percent at/above which the bar takes the warn colour. null/omitted = never. */
  warnAt?: number | null;
  /** Percent at/above which the bar takes the risk colour. null/omitted = never. */
  riskAt?: number | null;
  /** Neutral fill when no threshold is crossed (default bg-accent). */
  base?: string;
}

/**
 * Color band for capacity bars only. Compute utilisation (usage %, tok/s,
 * lanes) NEVER takes the risk colour — busy compute is success, not danger
 * (invariant I-3). Callers opt into warn/risk explicitly with thresholds,
 * which is capacity semantics: full capacity is a risk.
 */
export function bandColor(pct: number, opts: BandOptions = {}): string {
  const { warnAt = null, riskAt = null, base = "bg-accent" } = opts;
  if (riskAt != null && pct >= riskAt) return "bg-danger";
  if (warnAt != null && pct >= warnAt) return "bg-warning";
  return base;
}

interface MetricBarProps {
  label: string;
  value: number;
  max: number;
  color?: string;
  caption?: string;
  /** Optional second caption line shown below the bar. */
  subCaption?: string;
  /** Capacity thresholds (percent) — pass for capacity bars (VRAM/storage). */
  warnAt?: number | null;
  riskAt?: number | null;
}

/**
 * Horizontal progress bar. Used in the detail panels (GpuPanel) and the
 * overview cards to show capacity at a glance. Without warnAt/riskAt the
 * fill is always the neutral accent — never red for utilisation.
 */
export function MetricBar({
  label,
  value,
  max,
  color = "bg-accent",
  caption,
  subCaption,
  warnAt = null,
  riskAt = null,
}: MetricBarProps) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const barColor = bandColor(pct, { warnAt, riskAt, base: color });

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted">{label}</span>
        <span className="font-tabular text-sm text-text">{caption ?? `${pct}%`}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-border">
        <div
          className={`metric-bar-fill h-full rounded-full transition-[width] duration-300 ease-out ${barColor}`}
          style={{ ["--bar-pct" as string]: `${pct}%` }}
        />
      </div>
      {subCaption && (
        <div className="text-right text-xs text-muted">{subCaption}</div>
      )}
    </div>
  );
}
