import { AppLink } from "../ui/AppLink";
import { ENERGY_ID, idToPath } from "../../constants";
import { useEffect, useState } from "react";
import { fetchFleetEnergy } from "../../api/client";
import type { FleetEnergy } from "../../api/types";

const DAY_MS = 86_400_000;

function number(value: number | null, digits = 2): string {
  return value == null ? "—" : value.toFixed(digits);
}

export function FleetEnergyCard({ nodeCount, onOpenDetails }: { nodeCount: number; onOpenDetails?: () => void }) {
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

  // Fleet coverage is wall-clock time during which every node was fresh, so
  // it is capped by its measurement window — not window × nodeCount. Use the
  // server-provided window; DAY_MS is only a fallback for older servers.
  const coverageWindowMs = data?.coverage24hWindowMs ?? DAY_MS;
  const coverage = data && nodeCount > 0
    ? Math.min(100, (data.coverage24hMs / coverageWindowMs) * 100)
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

  const hourly = data?.hourlyWatts24h ?? Array(24).fill(null);
  const max = Math.max(1, ...hourly.filter((value): value is number => value != null));
  return (
    <section className="panel ov-card" aria-labelledby="fleet-energy-title">
      <div className="ov-card__head">
        <h2 id="fleet-energy-title" className="ov-card__title">Fleet energy</h2>
        <div className="ov-card__tools">
          <span className="tag">{data ? `${data.freshNodeCount}/${nodeCount} fresh` : "\u2014"}</span>
          {onOpenDetails ? (
            <AppLink href={idToPath(ENERGY_ID)} className="btn btn--sm btn--ghost" onNavigate={onOpenDetails}>
              Details
            </AppLink>
          ) : null}
        </div>
      </div>
      {state && <p className="ov-note" role="status">{state}</p>}
      <div>
        <div className="big-num">{number(data?.energy24hKwh ?? null)}<small>kWh / 24 h</small></div>
        <div className="ov-card__sub mono">Estimated, not wall-metered · 24h coverage {coverage.toFixed(1)}%</div>
      </div>
      <div className="ov-bars" aria-label="Hourly estimated watts for the last 24 hours, with gaps shown empty">
        {hourly.map((watts, index) => (
          <span
            key={index}
            className={index === hourly.length - 1 ? "is-now" : undefined}
            style={{ height: watts == null ? 0 : `${Math.max(4, (watts / max) * 100)}%` }}
            title={watts == null ? "No complete coverage" : `${watts.toFixed(0)} W`}
          />
        ))}
      </div>
      <div className="ov-axis mono"><span>24h ago</span><span>12h</span><span>now</span></div>
      <dl className="ov-stats">
        <div><dt>Current</dt><dd className="mono">{number(data?.currentWatts30s ?? null, 0)} W</dd></div>
        <div><dt>31 days</dt><dd className="mono">{number(data?.energy31dKwh ?? null)} kWh</dd></div>
        <div><dt>Efficiency</dt><dd className="mono">{number(data?.whPerOutputToken24h ?? null, 4)} Wh/token</dd></div>
      </dl>
    </section>
  );
}
