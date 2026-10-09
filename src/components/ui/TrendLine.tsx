import { useId } from "react";

interface TrendLineProps {
  data: readonly number[];
  height?: number;
  color?: string;
  /** Fixed scale bounds (default: data min/max). */
  min?: number;
  max?: number;
  className?: string;
}

/**
 * Fluid-width sparkline: gradient area fill, a crisp line, and an emphasised
 * endpoint dot. Stretches to its container's width (preserveAspectRatio none),
 * so the endpoint is an HTML dot positioned by percentage.
 */
export function TrendLine({ data, height = 32, color = "var(--color-accent)", min, max, className = "" }: TrendLineProps) {
  const id = useId();
  const W = 200;
  if (data.length < 2) return <div className={className} style={{ height }} />;
  const lo = min ?? Math.min(...data);
  let hi = max ?? Math.max(...data);
  if (hi === lo) hi = lo + 1;
  const pts = data.map((v, i) => {
    const y = height - 3 - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (height - 8);
    return [(i / (data.length - 1)) * W, y] as const;
  });
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <div className={`relative w-full ${className}`} style={{ height, color }} aria-hidden>
      <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="h-full w-full overflow-visible">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.28" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${d} L${W} ${height} L0 ${height} Z`} fill={`url(#${id})`} />
        <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <i
        className="absolute rounded-full"
        style={{
          right: -3,
          top: `${(last[1] / height) * 100}%`,
          width: 7,
          height: 7,
          marginTop: -3.5,
          background: "currentColor",
          boxShadow: "0 0 0 3px color-mix(in srgb, currentColor 25%, transparent)",
        }}
      />
    </div>
  );
}
