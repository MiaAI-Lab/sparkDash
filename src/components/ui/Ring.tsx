import type { ReactNode } from "react";

interface RingProps {
  /** 0–100 */
  value: number;
  size?: number;
  strokeWidth?: number;
  /** Any CSS color, e.g. "var(--color-accent)". */
  color?: string;
  /** Large text in the middle (defaults to the rounded percentage). */
  label?: ReactNode;
  /** Small caption under the label. */
  caption?: ReactNode;
  /** Font size of the centre label in px (default: a third of the ring). */
  labelSize?: number;
  className?: string;
}

/** Circular gauge: track + arc with the value and an optional caption in the centre. */
export function Ring({
  value,
  size = 104,
  strokeWidth = 9,
  color = "var(--color-accent)",
  label,
  caption,
  labelSize,
  className = "",
}: RingProps) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className={`flex shrink-0 flex-col items-center gap-1.5 ${className}`}>
      {/* The caption sits above the circle, outside it. */}
      {caption ? <span className="text-xs font-medium leading-none text-muted">{caption}</span> : null}
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="ui-ring" aria-hidden>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-surface-hover)" strokeWidth={strokeWidth} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - pct / 100)}
            className="ui-ring__arc"
          />
        </svg>
        <div className="absolute inset-0 grid place-items-center">
          <b
            className="font-tabular font-semibold leading-none tracking-tight text-text-strong"
            style={{ fontSize: labelSize ?? Math.round(size * 0.32) }}
          >
            {label ?? `${Math.round(pct)}%`}
          </b>
        </div>
      </div>
    </div>
  );
}
