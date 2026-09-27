import { useEffect, useState } from "react";
import { fetchFleetEnergy } from "../../api/client";
import type { FleetEnergy } from "../../api/types";

const DAY_MS = 86_400_000;

function number(value: number | null, digits = 2): string {
  return value == null ? "—" : value.toFixed(digits);
}

export function FleetEnergyCard({ nodeCount }: { nodeCount: number }) {
  const [data, setData] = useState<FleetEnergy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => fetchFleetEnergy()
      .then((next) => { if (!cancelled) { setData(next); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    void load();
    const timer = window.setInterval(load, 10_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const coverage = data && nodeCount > 0
    ? Math.min(100, (data.coverage24hMs / (DAY_MS * nodeCount)) * 100)
    : 0;
  const state = error
    ? `Energy telemetry unavailable: ${error}`
    : data?.membershipChanged
      ? "Fleet membership changed. Restart sparkDash to establish a truthful new accounting scope."
      : !data
        ? "Loading fleet energy…"
        : data.freshNodeCount < nodeCount
          ? `Partial coverage: ${data.freshNodeCount}/${nodeCount} nodes currently fresh.`
          : data.energy24hKwh == null
            ? "Warming up — no complete energy interval recorded yet."
            : null;

  return (
    <section className="panel p-4" aria-labelledby="fleet-energy-title">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="fleet-energy-title" className="text-sm font-semibold text-text-strong">Fleet Energy</h2>
          <p className="text-[10px] text-muted">Estimated, not wall-metered · 24h coverage {coverage.toFixed(1)}%</p>
        </div>
        <span className="text-xs text-muted">{data ? `${data.freshNodeCount}/${nodeCount} fresh` : "—"}</span>
      </div>
      {state && <p className="mt-3 rounded bg-warning/10 px-3 py-2 text-xs text-warning" role="status">{state}</p>}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div><div className="text-[10px] text-muted">Current</div><strong className="font-tabular text-sm">{number(data?.currentWatts30s ?? null, 0)} W</strong></div>
        <div><div className="text-[10px] text-muted">24 hours</div><strong className="font-tabular text-sm">{number(data?.energy24hKwh ?? null)} kWh</strong></div>
        <div><div className="text-[10px] text-muted">31 days</div><strong className="font-tabular text-sm">{number(data?.energy31dKwh ?? null)} kWh</strong></div>
        <div><div className="text-[10px] text-muted">Efficiency</div><strong className="font-tabular text-sm">{number(data?.whPerOutputToken24h ?? null, 4)} Wh/token</strong></div>
      </div>
      <div className="mt-3 flex h-12 items-end gap-px" aria-label="Hourly estimated watts for the last 24 hours, with gaps shown empty">
        {(data?.hourlyWatts24h ?? Array(24).fill(null)).map((watts, index, values) => {
          const max = Math.max(1, ...values.filter((value): value is number => value != null));
          return <span key={index} className="min-w-0 flex-1 bg-accent/60" style={{ height: watts == null ? 0 : `${Math.max(4, (watts / max) * 100)}%` }} title={watts == null ? "No complete coverage" : `${watts.toFixed(0)} W`} />;
        })}
      </div>
    </section>
  );
}
