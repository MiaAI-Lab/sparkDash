import { useId, useMemo, useState } from "react";
import { labelIndexes, niceScale } from "./chartScale";
import { useElementWidth } from "./useElementWidth";
import "../../styles/charts.css";

export interface LinePoint {
  key: string;
  label: string;
  title: string;
  /** null = no data for this point (draws a gap). */
  value: number | null;
}

interface LineAreaChartProps {
  points: readonly LinePoint[];
  color?: string;
  height?: number;
  format: (value: number) => string;
  unit?: string;
  empty?: string;
  ariaLabel: string;
}

const PAD = { l: 44, r: 10, t: 10, b: 24 };

/** Single-series area chart with gaps for missing data, nice axis and a hover read-out. */
export function LineAreaChart({
  points,
  color = "var(--color-accent)",
  height = 200,
  format,
  unit,
  empty = "No data in this range yet.",
  ariaLabel,
}: LineAreaChartProps) {
  const gradId = useId();
  const [ref, width] = useElementWidth();
  const [hover, setHover] = useState<number | null>(null);
  const values = points.map((p) => p.value);
  const max = Math.max(0, ...values.filter((v): v is number => v != null));
  const scale = useMemo(() => niceScale(max), [max]);
  const iw = width - PAD.l - PAD.r;
  const ih = height - PAD.t - PAD.b;
  const n = points.length;
  const x = (i: number) => PAD.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => PAD.t + ih - (v / scale.max) * ih;
  const labels = useMemo(() => new Set(labelIndexes(n, iw)), [n, iw]);

  // Split into runs of consecutive non-null points so gaps are drawn as gaps.
  const runs: { i: number; v: number }[][] = [];
  let cur: { i: number; v: number }[] = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (cur.length) runs.push(cur);
      cur = [];
    } else cur.push({ i, v });
  });
  if (cur.length) runs.push(cur);
  const line = (run: { i: number; v: number }[]) => run.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  const hovered = hover != null ? points[hover] : null;

  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.28" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {scale.ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} className={t === 0 ? "chart__axis" : "chart__grid"} />
            <text x={PAD.l - 6} y={y(t) + 3.5} textAnchor="end" className="chart__tick">
              {format(t)}
            </text>
          </g>
        ))}
        {runs.map((run, k) =>
          run.length > 1 ? (
            <g key={k}>
              <path d={`${line(run)} L${x(run.at(-1)!.i)} ${y(0)} L${x(run[0].i)} ${y(0)} Z`} fill={`url(#${gradId})`} />
              <path d={line(run)} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
            </g>
          ) : (
            <circle key={k} cx={x(run[0].i)} cy={y(run[0].v)} r="2.5" fill={color} />
          )
        )}
        {hover != null && points[hover].value != null ? (
          <circle cx={x(hover)} cy={y(points[hover].value as number)} r="4" fill={color} stroke="var(--color-surface)" strokeWidth="2" />
        ) : null}
        {points.map((p, i) => (
          <g key={p.key}>
            <rect
              x={x(i) - Math.max(4, iw / Math.max(1, n) / 2)}
              y={PAD.t}
              width={Math.max(8, iw / Math.max(1, n))}
              height={ih}
              fill="transparent"
              tabIndex={0}
              aria-label={`${p.title}: ${p.value == null ? "no data" : format(p.value)}`}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
            />
            {labels.has(i) ? (
              <text x={x(i)} y={height - 6} textAnchor="middle" className="chart__tick">
                {p.label}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
      {max <= 0 ? <p className="chart__empty">{empty}</p> : null}
      {hovered ? (
        <div className="chart__tip" role="status" style={{ left: Math.min(Math.max(x(hover!), 90), width - 90) }}>
          <b>{hovered.title}</b>
          <span className="chart__tip-total">
            {hovered.value == null ? "No data" : <em>{format(hovered.value)}{unit ? ` ${unit}` : ""}</em>}
          </span>
        </div>
      ) : null}
    </div>
  );
}
