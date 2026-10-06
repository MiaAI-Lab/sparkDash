import { useEffect, useRef, useState } from "react";
import type { AlertInstance, SparkSnapshot } from "../../api/types";
import { useFleetAlerts } from "../../hooks/useFleetAlerts";

export function FleetAlertStrip({
  sparks,
  onSelect,
  alertsEnabled = false,
  serverAlerts = null,
}: {
  sparks: SparkSnapshot[];
  onSelect?: (id: string) => void;
  /** Server alerts are on: show the server's firing set instead of deriving one here. */
  alertsEnabled?: boolean;
  serverAlerts?: AlertInstance[] | null;
}) {
  const { rows } = useFleetAlerts(sparks, alertsEnabled, serverAlerts);
  const firstSeen = useRef(new Map<string, number>());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const active = new Set(rows.map((row) => row.key));
    for (const row of rows) if (!firstSeen.current.has(row.key)) firstSeen.current.set(row.key, Date.now());
    for (const key of firstSeen.current.keys()) if (!active.has(key)) firstSeen.current.delete(key);
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [rows]);
  if (rows.length === 0) return <p className="text-xs text-success" role="status">No active fleet exceptions.</p>;
  return (
    <section className="panel p-3" aria-labelledby="fleet-alerts-title">
      <h2 id="fleet-alerts-title" className="text-xs font-semibold text-text-strong">Active fleet exceptions · {rows.length}</h2>
      <ul className="mt-2 flex flex-wrap gap-2">
        {rows.map((row) => {
          // Server alerts carry their own start time, so durations survive reloads.
          const since = row.startsAt ?? firstSeen.current.get(row.key) ?? now;
          return <li key={row.key}>
            <button type="button" onClick={() => onSelect?.(row.unitId)} className={`min-h-11 rounded border px-3 py-2 text-left text-xs ${row.severity === "critical" ? "border-danger/50 text-danger" : "border-warning/50 text-warning"}`}>
              <strong>{row.unitName}</strong> · {row.label} · {Math.max(0, Math.floor((now - since) / 60_000))}m
            </button>
          </li>;
        })}
      </ul>
    </section>
  );
}
