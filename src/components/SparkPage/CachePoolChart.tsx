import type { MetricsHistoryCachePoint, MetricsHistoryCacheEvent } from "../../api/types";

/**
 * The shared pool over time, as stacked categories in positions.
 *
 * The four categories are a partition of the capacity the engine reported, so the stack's full
 * height is the pool, not a fill percentage: a pool that is 80% kept prefixes is healthy reuse, and
 * only the "active" band competes with new requests. A bucket the engine did not report breaks the
 * stack (a gap), and a capacity change is drawn as a step marker because a mean of two capacities
 * is not a capacity.
 */

const VIEW_W = 300;
const VIEW_H = 90;
const PAD_Y = 3;
const GAP_STEPS = 1.5;

const BANDS = [
  { key: "unclaimed", label: "Unclaimed", color: "var(--color-mem-other)" },
  { key: "growth", label: "Reclaimable", color: "var(--color-mem-system)" },
  { key: "prefix", label: "Kept prefixes", color: "var(--color-accent)" },
  { key: "active", label: "Active", color: "var(--color-mem-engine)" },
] as const;

const positions = (n: number): string => {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
};

/** Contiguous runs of indices with a complete pool observation, breaking on gaps. */
function runsOf(timeline: readonly number[], points: ReadonlyArray<MetricsHistoryCachePoint | undefined>, stepMs: number, events: readonly MetricsHistoryCacheEvent[]): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  let previousT: number | null = null;
  for (let i = 0; i < timeline.length; i += 1) {
    const p = points[i];
    const complete = p?.pool && p.pool.active != null && p.pool.prefix != null && p.pool.growth != null && p.pool.unclaimed != null;
    if (!complete) {
      if (run.length) runs.push(run);
      run = [];
      previousT = null;
      continue;
    }
    const t = timeline[i];
    if (previousT != null && (t - previousT > stepMs * GAP_STEPS || events.some((e) =>
      e.kind !== "cache_pressure" && e.t >= previousT! && e.t < t + stepMs))) {
      if (run.length) runs.push(run);
      run = [];
    }
    run.push(i);
    previousT = t;
  }
  if (run.length) runs.push(run);
  return runs;
}

export function CachePoolChart({
  timeline,
  stepMs,
  points,
  formatTime,
  events = [],
  from = timeline[0],
  to = timeline[timeline.length - 1],
}: {
  timeline: readonly number[];
  stepMs: number;
  points: ReadonlyArray<MetricsHistoryCachePoint | undefined>;
  formatTime: (t: number) => string;
  events?: readonly MetricsHistoryCacheEvent[];
  from?: number;
  to?: number;
}) {
  const present = points.filter((p): p is MetricsHistoryCachePoint => p?.pool != null);
  if (present.length === 0) return null;
  const capacity = Math.max(...present.map((p) => p.pool!.capacity));
  const y = (v: number) => VIEW_H - PAD_Y - (Math.max(0, Math.min(v, capacity)) / capacity) * (VIEW_H - PAD_Y * 2);
  const timeX = (t: number) => to <= from ? VIEW_W / 2 : Math.max(0, Math.min(VIEW_W, (t - from) / (to - from) * VIEW_W));
  const x = (i: number) => timeX(timeline[i]);
  const runs = runsOf(timeline, points, stepMs, events);
  const latest = present[present.length - 1];
  const last = latest.pool!;
  const summary = `Shared pool over ${present.length} buckets, scale maximum ${positions(capacity)} positions: active ${positions(last.active ?? NaN)}, kept prefixes ${positions(last.prefix ?? NaN)}, reclaimable ${positions(last.growth ?? NaN)}, unclaimed ${positions(last.unclaimed ?? NaN)}`;

  return (
    <div className="sp-cachepool" data-cache-pool-chart>
      <div className="sp-cachepool__head">
        <span>Shared pool</span>
        <span className="sp-cachepool__cap font-tabular">{positions(capacity)} positions</span>
      </div>
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
        className="sp-cachepool__svg"
      >
        <title>{summary}</title>
        {runs.map((run, ri) => {
          // Cumulative stack per band, so each area sits on the one below it.
          const cumulative = BANDS.map(() => [] as number[]);
          for (const i of run) {
            const p = points[i]!.pool!;
            let acc = 0;
            BANDS.forEach((band, bi) => {
              acc += (p[band.key] as number | null) ?? 0;
              cumulative[bi].push(acc);
            });
          }
          return BANDS.map((band, bi) => {
            const outline = (values: number[]) => {
              const path = run.flatMap((i, k) => k === 0 ? [`${x(i)},${y(values[k])}`]
                : [`${x(i)},${y(values[k - 1])}`, `${x(i)},${y(values[k])}`]);
              const last = run[run.length - 1];
              path.push(`${timeX(Math.min(to, timeline[last] + stepMs))},${y(values[values.length - 1])}`);
              return path;
            };
            const upper = outline(cumulative[bi]).join(" ");
            const lower = outline(bi === 0 ? run.map(() => 0) : cumulative[bi - 1]).reverse().join(" ");
            return (
              <polygon
                key={`${ri}-${band.key}`}
                data-band={band.key}
                points={`${upper} ${lower}`}
                fill={band.color}
                fillOpacity={band.key === "unclaimed" ? 0.18 : 0.55}
                stroke="none"
              />
            );
          });
        })}
        {events.map((event, i) => <line key={`event-${i}`} data-cache-event={event.kind}
          x1={timeX(event.t)} x2={timeX(event.t)} y1={0} y2={VIEW_H}
          stroke={event.kind === "cache_pressure" ? "var(--color-warning)" : "var(--color-danger)"}
          strokeDasharray="3 2" strokeWidth={1} vectorEffect="non-scaling-stroke">
          <title>{formatTime(event.t)} · {event.kind.replaceAll("_", " ")}</title>
        </line>)}
        {present
          .filter((p) => p.capacityChanged || p.budgetChanged)
          .map((p) => {
            const i = timeline.indexOf(p.t);
            if (i < 0) return null;
            return (
              <line
                key={`cap-${p.t}`}
                x1={x(i)}
                x2={x(i)}
                y1={0}
                y2={VIEW_H}
                stroke="var(--color-warning)"
                strokeDasharray="2 2"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
      </svg>
      <div className="sp-cachepool__legend">
        {[...BANDS].reverse().map((band) => (
          <span key={band.key}>
            <span aria-hidden className="sp-cachepool__swatch" style={{ background: band.color }} />
            {band.label}
          </span>
        ))}
        {events.length > 0 && <span>Dashed markers: restart/reset, gaps or pressure (details below)</span>}
        <span className="sp-cachepool__time">
          {formatTime(timeline[0])} – {formatTime(timeline[timeline.length - 1])}
        </span>
      </div>
    </div>
  );
}
