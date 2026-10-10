import { useEffect, useRef, useState } from "react";
import { TrendLine } from "../../ui/TrendLine";

const SAMPLE_MS = 1000;
const MAX_SAMPLES = 90;

/**
 * Live generation tok/s while a decode run is in flight: the rate measured from the run's
 * own streams, else the engine's throughput as the monitor reads it, sampled once a second
 * so the line moves smoothly between polls. Renders nothing when neither exists.
 */
export function LiveTps({ tps, active }: { tps: number | null | undefined; active: boolean }) {
  const [samples, setSamples] = useState<number[]>([]);
  const latest = useRef<number | null>(tps ?? null);
  latest.current = tps ?? null;

  useEffect(() => {
    if (!active) return;
    setSamples([]);
    const id = setInterval(() => {
      const v = latest.current;
      if (v == null) return;
      setSamples((prev) => [...prev.slice(-(MAX_SAMPLES - 1)), v]);
    }, SAMPLE_MS);
    return () => clearInterval(id);
  }, [active]);

  if (!active || tps == null) return null;
  const peak = samples.length ? Math.max(...samples) : tps;
  return (
    <div className="bench-live" aria-label="Live generation speed">
      <div className="bench-live__head">
        <span className="bench-live__label">
          <span className="bench-live__dot" aria-hidden /> Live generation
        </span>
        <span className="bench-live__peak">peak {peak.toFixed(1)} tok/s</span>
      </div>
      <div className="bench-live__value">
        {tps.toFixed(1)} <small>tok/s</small>
      </div>
      <TrendLine data={samples} height={40} min={0} />
    </div>
  );
}
