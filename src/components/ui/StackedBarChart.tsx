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
  ariaLabel: string;
}

const PAD = { l: 44, r: 8, t: 10, b: 24 };

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
  ariaLabel,
}: StackedBarChartProps) {
  const [ref, width] = useElementWidth();
  const [hover, setHover] = useState<number | null>(null);

  const totals = useMemo(
    () => buckets.map((b) => series.reduce((sum, s) => sum + (b.values[s.id] || 0), 0)),
    [buckets, series]
  );
  const max = Math.max(0, ...totals);
  const scale = useMemo(() => niceScale(max), [max]);
  const iw = width - PAD.l - PAD.r;
  const ih = height - PAD.t - PAD.b;
  const n = buckets.length;
  const slot = n > 0 ? iw / n : iw;
  const barW = Math.max(2, Math.min(40, slot * 0.68));
  const y = (v: number) => PAD.t + ih - (v / scale.max) * ih;
  const labels = useMemo(() => new Set(labelIndexes(n, iw)), [n, iw]);
  const hasData = max > 0;
  const hovered = hover != null ? buckets[hover] : null;

  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} onMouseLeave={() => setHover(null)}>
        {scale.ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} className={t === 0 ? "chart__axis" : "chart__grid"} />
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
            Total <em>{format(totals[hover])}{unit ? ` ${unit}` : ""}</em>
          </span>
          {footer ? <span className="chart__tip-foot">{footer(hovered)}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
