interface SparklineProps {
  data: readonly number[];
  /**
   * Fixed y-domain [min, max]. When given, it never adapts to the data
   * (invariant I-1): the domain is identical for this metric on every card,
   * so deflections are honestly comparable. Values outside the domain clamp
   * at the edge; disclose the truncation via `axisLabel`.
   *
   * When omitted, the domain auto-scales to the data
   * (`max = Math.max(...data, 1)`, `min = Math.min(...data, 0)`) — the
   * legacy behaviour used by the per-node panels.
   */
  domain?: readonly [number, number];
  width?: number;
  height?: number;
  /** Stretch to the container's full width (viewBox-scaled, e.g. card rows). */
  fullWidth?: boolean;
  color?: string;
  /** When true, render a soft area-fill under the line. */
  area?: boolean;
  /** Shaded warn band [from, to] within the domain (e.g. temperature band). */
  warnBand?: readonly [number, number] | null;
  /** 1 px horizontal rule at this value (e.g. thermal throttle line). */
  ruleAt?: number | null;
  /** Axis disclosure, e.g. "axis 20–95 °C" — the truncation must be stated. */
  axisLabel?: string;
  /**
   * Visually-hidden text summary for assistive tech (the numeral beside the
   * label is the semantic source; the SVG itself is aria-hidden, I-6).
   */
  summary?: string;
}

const yFor = (
  v: number,
  lo: number,
  hi: number,
  height: number,
  pad: number
): number => {
  const frac = Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1)));
  return height - pad - frac * (height - pad * 2);
};

/**
 * Lightweight inline-SVG sparkline. With a fixed `domain` it renders a
 * translucent area-fill under the line, a shaded warn band, and a 1 px rule
 * (e.g. thermal throttle); the domain never auto-scales. Without `domain`,
 * the y-range adapts to the data (max = Math.max(...data, 1),
 * min = Math.min(...data, 0)) for panels that manage their own context.
 */
export function Sparkline({
  data,
  domain,
  width = 84,
  height = 24,
  fullWidth = false,
  color = "var(--color-accent)",
  area = true,
  warnBand = null,
  ruleAt = null,
  axisLabel,
  summary,
}: SparklineProps) {
  const [lo, hi] = domain ?? [
    data.length > 0 ? Math.min(...data, 0) : 0,
    data.length > 0 ? Math.max(...data, 1) : 1,
  ];
  const pad = 1.5;

  const body = (
    <svg
      width={fullWidth ? undefined : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={fullWidth ? "none" : undefined}
      className={fullWidth ? "block h-auto w-full" : "inline-block align-middle"}
      aria-hidden="true"
      {...(axisLabel ? { role: "img" } : {})}
    >
      {/* warn band, mapped into the fixed domain */}
      {warnBand && (
        <rect
          x={0}
          y={yFor(Math.min(warnBand[1], hi), lo, hi, height, pad)}
          width={width}
          height={Math.max(
            0,
            yFor(Math.max(warnBand[0], lo), lo, hi, height, pad) -
              yFor(Math.min(warnBand[1], hi), lo, hi, height, pad)
          )}
          fill="var(--color-warning)"
          opacity={0.18}
        />
      )}
      {/* throttle / threshold rule */}
      {ruleAt != null && ruleAt >= lo && ruleAt <= hi && (
        <line
          x1={0}
          x2={width}
          y1={yFor(ruleAt, lo, hi, height, pad)}
          y2={yFor(ruleAt, lo, hi, height, pad)}
          stroke="var(--color-danger)"
          strokeWidth={1}
        />
      )}
      {data.length >= 2 && (() => {
        const points = data.map((v, i) => {
          const x = (i / (data.length - 1)) * width;
          const y = yFor(v, lo, hi, height, pad);
          return `${x},${y}`;
        });
        const areaPath = `M0,${height} L${points.join(" L")} L${width},${height} Z`;
        return (
          <>
            {area && <path d={areaPath} fill={`color-mix(in srgb, ${color} 16%, transparent)`} stroke="none" />}
            <polyline
              points={points.join(" ")}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        );
      })()}
    </svg>
  );

  return (
    <span className="inline-block" title={axisLabel}>
      {body}
      {summary && <span className="sr-only">{summary}</span>}
    </span>
  );
}
