import type { MetricsHistoryCachePoint } from "../../api/types";

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
function runsOf(timeline: readonly number[], points: ReadonlyArray<MetricsHistoryCachePoint | undefined>, stepMs: number): number[][] {
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
    if (previousT != null && t - previousT > stepMs * GAP_STEPS) {
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
}: {
  timeline: readonly number[];
  stepMs: number;
  points: ReadonlyArray<MetricsHistoryCachePoint | undefined>;
  formatTime: (t: number) => string;
}) {
  const present = points.filter((p): p is MetricsHistoryCachePoint => p?.pool != null);
  if (present.length === 0) return null;
  const capacity = Math.max(...present.map((p) => p.pool!.capacity));
  const y = (v: number) => VIEW_H - PAD_Y - (Math.max(0, Math.min(v, capacity)) / capacity) * (VIEW_H - PAD_Y * 2);
  const x = (i: number) => (timeline.length <= 1 ? VIEW_W / 2 : (i / (timeline.length - 1)) * VIEW_W);
  const runs = runsOf(timeline, points, stepMs);
  const latest = present[present.length - 1];
  const last = latest.pool!;
  const summary = `Shared pool over ${present.length} buckets, ${positions(capacity)} positions: active ${positions(last.active ?? 0)}, kept prefixes ${positions(last.prefix ?? 0)}, reclaimable ${positions(last.growth ?? 0)}, unclaimed ${positions(last.unclaimed ?? 0)}`;

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
            const upper = run.map((i, k) => `${x(i)},${y(cumulative[bi][k])}`).join(" ");
            const lowerBand = bi === 0 ? null : cumulative[bi - 1];
            const lower = run
              .map((i, k) => `${x(i)},${y(lowerBand ? lowerBand[k] : 0)}`)
              .reverse()
              .join(" ");
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
        {present
          .filter((p) => p.capacityChanged)
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
        <span className="sp-cachepool__time">
          {formatTime(timeline[0])} – {formatTime(timeline[timeline.length - 1])}
        </span>
      </div>
    </div>
  );
}
