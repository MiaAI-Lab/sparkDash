import { useMemo } from "react";
import { useMetricsHistory, avgPositive } from "../../hooks/metricsStore";

const VIEW_W = 300;
const VIEW_H = 64;
const PAD = 2;

function fmt(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n >= 100 ? n.toFixed(0) : n.toFixed(1);
}

/** Polyline points for one series, normalised to the shared max. */
function buildPoints(data: readonly number[], max: number): string {
  if (data.length < 2) return "";
  const span = max || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * VIEW_W;
    const y = VIEW_H - PAD - (Math.min(v, max) / span) * (VIEW_H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return pts.join(" ");
}

function areaPath(points: string): string {
  const last = points.split(" ").pop() ?? `0,${VIEW_H}`;
  return `M0,${VIEW_H} L${points} L${last.split(",")[0]},${VIEW_H} Z`;
}

/**
 * Longer tok/s history for one LLM port — reads the full in-memory series
 * (HISTORY_MAX samples ≈ 1 h at the 2 s poll) rather than the short sparkline
 * tail, and shows the average over busy (>0) samples for each phase.
 */
export function LlmTrendChart({
  sparkId,
  llmPort,
}: {
  sparkId: string;
  llmPort: number;
}) {
  const gen = useMetricsHistory(sparkId, `llm:${llmPort}.tps`);
  const prefill = useMetricsHistory(sparkId, `llm:${llmPort}.prefill`);
  const ttft = useMetricsHistory(sparkId, `llm:${llmPort}.ttft`);

  const genAvg = useMemo(() => avgPositive(gen), [gen]);
  const prefillAvg = useMemo(() => avgPositive(prefill), [prefill]);
  const ttftAvg = useMemo(() => avgPositive(ttft), [ttft]);

  // Normalise each series to its OWN max: prefill (thousands) and generation
  // (tens) differ by ~100x, so a shared scale would flatten gen into the floor.
  // TTFT (seconds, ~0.1–5) is likewise independent — shape over magnitude.
  const genMax = useMemo(() => Math.max(1, ...gen), [gen]);
  const prefillMax = useMemo(() => Math.max(1, ...prefill), [prefill]);
  // TTFT y-axis always spans at least 1 s (a stable benchmark) — sub-second
  // prefills stay low rather than filling the chart — scaling up only when TTFT
  // actually exceeds a second. Data is in seconds, so 1000 ms == 1.0.
  const ttftMax = useMemo(() => Math.max(1, ...ttft), [ttft]);
  const genPts = useMemo(() => buildPoints(gen, genMax), [gen, genMax]);
  const prefillPts = useMemo(() => buildPoints(prefill, prefillMax), [prefill, prefillMax]);
  const ttftPts = useMemo(() => buildPoints(ttft, ttftMax), [ttft, ttftMax]);

  const hasData = gen.length > 1 || prefill.length > 1 || ttft.length > 1;

  return (
    <div className="border-t border-border pt-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted">
          tok/s history
        </span>
        <span className="text-[10px] text-muted">last ~1h · 2s samples</span>
      </div>
      {!hasData ? (
        <p className="text-[10px] text-muted">No samples yet.</p>
      ) : (
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          className="block w-full"
          style={{ height: 64 }}
          role="img"
          aria-label="Generation and prefill tokens per second, and time-to-first-token, over the last hour"
        >
          {ttftPts && (
            <polyline
              points={ttftPts}
              fill="none"
              stroke="var(--color-muted)"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
              strokeDasharray="4 3"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}
          {prefillPts && (
            <>
              <path d={areaPath(prefillPts)} fill="var(--color-text)" opacity={0.1} />
              <polyline
                points={prefillPts}
                fill="none"
                stroke="var(--color-text)"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </>
          )}
          {genPts && (
            <>
              <path d={areaPath(genPts)} fill="var(--color-accent)" opacity={0.12} />
              <polyline
                points={genPts}
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </>
          )}
        </svg>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[10px] text-muted">
        <span>
          Gen avg{" "}
          <span className="font-tabular text-xs text-accent">{fmt(genAvg)}</span>
        </span>
        <span>
          Prefill avg{" "}
          <span className="font-tabular text-xs text-text">{fmt(prefillAvg)}</span>
        </span>
        <span>
          TTFT avg{" "}
          <span className="font-tabular text-xs text-muted">
            {ttftAvg != null ? `${ttftAvg.toFixed(3)}s` : "—"}
          </span>
        </span>
        <span className="text-[9px]">avg over busy samples only</span>
      </div>
    </div>
  );
}
