interface SparklineProps {
  data: readonly number[];
  width?: number;
  height?: number;
  color?: string;
  /** When true, render a soft area-fill under the line. */
  area?: boolean;
}

/**
 * Lightweight inline-SVG sparkline. Optionally renders a translucent area
 * under the polyline so live rates read as a trend rather than a flat line.
 * A faint baseline grid hints at scale without adding chartjunk.
 */
export function Sparkline({
  data,
  width = 84,
  height = 24,
  color = "var(--color-accent)",
  area = true,
}: SparklineProps) {
  if (data.length < 2) {
    return (
      <div
        className="sparkline-box inline-block"
        style={{ ["--spark-w" as string]: `${width}px`, ["--spark-h" as string]: `${height}px` }}
      />
    );
  }

  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const pad = 1.5;

  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - pad - ((v - min) / span) * (height - pad * 2);
    return `${x},${y}`;
  });

  const areaPath = `M0,${height} L${points.join(" L")} L${width},${height} Z`;
  const lineColor = color;
  const fillColor = `color-mix(in srgb, ${color} 16%, transparent)`;

  return (
    <svg width={width} height={height} className="inline-block align-middle">
      {area && (
        <path d={areaPath} fill={fillColor} stroke="none" />
      )}
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke={lineColor}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}