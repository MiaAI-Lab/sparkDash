import { useMemo, useState, type ReactNode } from "react";
import { labelIndexes, niceScale } from "./chartScale";
import { useElementWidth } from "./useElementWidth";
import "../../styles/charts.css";

export interface BarSeries {
  id: string;
  label: string;
  /** Any CSS colour, e.g. "var(--color-accent)". */
  color: string;
}

export interface BarBucket {
  /** Stable key (a date, an hour…). */
  key: string;
  /** Short x-axis label. */
  label: string;
  /** Heading of the hover tooltip. */
  title: string;
  /** Value per series id; missing = 0. */
  values: Record<string, number>;
}

/** A line drawn over the bars against its own scale on the right-hand axis. */
export interface BarLine {
  label: string;
  /** Any CSS colour. */
  color: string;
  /** One value per bucket; null leaves a gap in the line. */
  values: readonly (number | null)[];
  /** Formats the right-hand axis ticks and the tooltip value. */
  format: (value: number) => string;
  /** Extra tooltip line for a bucket (e.g. the price behind the value). */
  detail?: (index: number) => ReactNode;
}

interface StackedBarChartProps {
  buckets: readonly BarBucket[];
  series: readonly BarSeries[];
  height?: number;
  /** Formats axis ticks and tooltip numbers (e.g. compact tokens, kWh). */
  format: (value: number) => string;
  /** Shown under the tooltip total, e.g. "tokens". */
  unit?: string;
  /** Extra tooltip line for a bucket (e.g. coverage note). */
  footer?: (bucket: BarBucket) => ReactNode;
  /** Message when every value is zero. */
  empty?: string;
  totalLabel?: string;
  ariaLabel: string;
  /** Optional line with its own axis on the right. */
  line?: BarLine;
}

const PAD = { l: 44, r: 8, t: 10, b: 24 };
/** Right padding when a line brings its own axis. */
const PAD_R_LINE = 48;

/**
 * Responsive stacked bar chart: axis ticks from a nice scale, one stack per bucket,
 * a hover/focus tooltip listing each series, and x labels thinned to fit. Colours come
 * from the caller (theme tokens), text colours from the page theme.
 */
export function StackedBarChart({
  buckets,
  series,
  height = 220,
  format,
  unit,
  footer,
  empty = "No data in this range yet.",
  totalLabel = "Total",
  ariaLabel,
  line,
}: StackedBarChartProps) {
  const [ref, width] = useElementWidth();
  const [hover, setHover] = useState<number | null>(null);

  const totals = useMemo(
    () => buckets.map((b) => series.reduce((sum, s) => sum + (b.values[s.id] || 0), 0)),
    [buckets, series]
  );
  const max = Math.max(0, ...totals);
  const scale = useMemo(() => niceScale(max), [max]);
  const padR = line ? PAD_R_LINE : PAD.r;
  const lineMax = line ? Math.max(0, ...line.values.filter((v): v is number => v != null && Number.isFinite(v))) : 0;
  const lineScale = useMemo(() => niceScale(lineMax), [lineMax]);
  const iw = width - PAD.l - padR;
  const ih = height - PAD.t - PAD.b;
  const n = buckets.length;
  const slot = n > 0 ? iw / n : iw;
  const barW = Math.max(2, Math.min(40, slot * 0.68));
  const y = (v: number) => PAD.t + ih - (v / scale.max) * ih;
  const y2 = (v: number) => PAD.t + ih - (v / lineScale.max) * ih;
  const cxOf = (i: number) => PAD.l + slot * i + slot / 2;
  // Unbroken stretches of the line, so a missing value leaves a gap.
  const lineRuns = useMemo(() => {
    const runs: { i: number; v: number }[][] = [];
    let run: { i: number; v: number }[] = [];
    (line?.values ?? []).forEach((v, i) => {
      if (v != null && Number.isFinite(v)) run.push({ i, v });
      else if (run.length) {
        runs.push(run);
        run = [];
      }
    });
    if (run.length) runs.push(run);
    return runs;
  }, [line?.values]);
  const lineValue = hover != null ? line?.values[hover] ?? null : null;
  const labels = useMemo(() => new Set(labelIndexes(n, iw)), [n, iw]);
  const hasData = max > 0;
  const hovered = hover != null ? buckets[hover] : null;

  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} onMouseLeave={() => setHover(null)}>
        {scale.ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={width - padR} y1={y(t)} y2={y(t)} className={t === 0 ? "chart__axis" : "chart__grid"} />
            <text x={PAD.l - 6} y={y(t) + 3.5} textAnchor="end" className="chart__tick">
              {format(t)}
            </text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const cx = PAD.l + slot * i + slot / 2;
          let acc = 0;
          return (
            <g key={b.key}>
              {/* wide invisible hit area so thin bars are easy to hover */}
              <rect
                x={PAD.l + slot * i}
                y={PAD.t}
                width={slot}
                height={ih}
                fill="transparent"
                tabIndex={0}
                aria-label={`${b.title}: ${format(totals[i])}${unit ? ` ${unit}` : ""}`}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              />
              {hover === i ? <rect x={PAD.l + slot * i} y={PAD.t} width={slot} height={ih} className="chart__hover" pointerEvents="none" /> : null}
              {series.map((s) => {
                const v = b.values[s.id] || 0;
                if (v <= 0) return null;
                const y1 = y(acc + v);
                const y0 = y(acc);
                acc += v;
                return <rect key={s.id} x={cx - barW / 2} y={y1} width={barW} height={Math.max(0.5, y0 - y1)} fill={s.color} pointerEvents="none" />;
              })}
              {labels.has(i) ? (
                <text x={cx} y={height - 6} textAnchor="middle" className="chart__tick">
                  {b.label}
                </text>
              ) : null}
            </g>
          );
        })}
        {line && lineMax > 0 ? (
          <g pointerEvents="none">
            {lineScale.ticks.map((t) => (
              <text key={t} x={width - padR + 6} y={y2(t) + 3.5} textAnchor="start" className="chart__tick">
                {line.format(t)}
              </text>
            ))}
            {lineRuns.map((run, k) =>
              run.length > 1 ? (
                <path
                  key={k}
                  d={run.map((p, j) => `${j ? "L" : "M"}${cxOf(p.i).toFixed(1)},${y2(p.v).toFixed(1)}`).join(" ")}
                  fill="none"
                  stroke={line.color}
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
              ) : (
                <circle key={k} cx={cxOf(run[0].i)} cy={y2(run[0].v)} r="2.5" fill={line.color} />
              )
            )}
            {lineValue != null && hover != null ? (
              <circle cx={cxOf(hover)} cy={y2(lineValue)} r="4" fill={line.color} stroke="var(--color-surface)" strokeWidth="2" />
            ) : null}
          </g>
        ) : null}
      </svg>
      {!hasData ? <p className="chart__empty">{empty}</p> : null}
      {hovered && hover != null ? (
        <div
          className="chart__tip"
          role="status"
          style={{ left: Math.min(Math.max(PAD.l + slot * hover + slot / 2, 90), width - 90) }}
        >
          <b>{hovered.title}</b>
          {series
            .filter((s) => (hovered.values[s.id] || 0) > 0)
            .map((s) => (
              <span key={s.id} className="chart__tip-row">
                <i style={{ background: s.color }} />
                {s.label}
                <em>{format(hovered.values[s.id] || 0)}</em>
              </span>
            ))}
          <span className="chart__tip-total">
            {totalLabel} <em>{format(totals[hover])}{unit ? ` ${unit}` : ""}</em>
          </span>
          {line && lineValue != null ? (
            <span className="chart__tip-row">
              <i style={{ background: line.color }} />
              {line.label}
              <em>{line.format(lineValue)}</em>
            </span>
          ) : null}
          {line?.detail ? <span className="chart__tip-foot">{line.detail(hover)}</span> : null}
          {footer ? <span className="chart__tip-foot">{footer(hovered)}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
