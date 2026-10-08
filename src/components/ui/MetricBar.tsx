/** Color band for metric bars — green normal, amber elevated, red critical. */
export function bandColor(pct: number, base = "bg-accent"): string {
  if (pct > 85) return "bg-danger";
  if (pct > 60) return "bg-warning";
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
  /** Tooltip for a label that is easy to misread. */
  title?: string;
}

/**
 * Horizontal progress bar. Used in the detail panels (GpuPanel) and the
 * overview cards to show usage, temperature, and allocation at a glance.
 */
export function MetricBar({
  label,
  value,
  max,
  color = "bg-accent",
  caption,
  subCaption,
  title,
}: MetricBarProps) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const barColor = bandColor(pct, color);

  return (
    <div className="metric-bar space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12.5px] text-muted" title={title}>{label}</span>
        <span className="mono text-[12.5px] font-medium text-text-strong">{caption ?? `${pct}%`}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-hover">
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