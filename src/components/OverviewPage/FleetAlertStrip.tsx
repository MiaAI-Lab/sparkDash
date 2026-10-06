import { useEffect, useMemo, useRef, useState } from "react";
import type { AlertInstance, SparkSnapshot } from "../../api/types";

type Alert = { key: string; spark: SparkSnapshot; label: string; severity: "critical" | "warning" };

function derive(sparks: SparkSnapshot[]): Alert[] {
  const alerts: Alert[] = [];
  for (const spark of sparks) {
    if (!spark.online) alerts.push({ key: `${spark.id}:offline`, spark, label: "Host unreachable", severity: "critical" });
    if (spark.metrics.gpu?.throttle?.active) alerts.push({ key: `${spark.id}:throttle`, spark, label: `GPU throttled: ${spark.metrics.gpu.throttle.detail}`, severity: "critical" });
    if (spark.metrics.storage.some((disk) => disk.percentage >= 90)) alerts.push({ key: `${spark.id}:disk`, spark, label: "Storage at or above 90%", severity: "warning" });
    if (spark.llmMonitoring !== false && spark.metrics.llm.length > 0 && spark.metrics.llm.every((llm) => !llm.available)) alerts.push({ key: `${spark.id}:llm`, spark, label: "LLM unavailable", severity: "warning" });
    if (spark.tailscaleMonitoring && spark.metrics.tailscale && (!spark.metrics.tailscale.available || spark.metrics.tailscale.online === false)) alerts.push({ key: `${spark.id}:tailnet`, spark, label: "Tailnet unavailable", severity: "warning" });
  }
  return alerts;
}

/** One chip, whichever side produced it. `startsAt` null = count from first sight. */
type Row = { key: string; unitId: string; unitName: string; label: string; severity: "critical" | "warning"; startsAt: number | null };

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
  const derived = useMemo(() => derive(sparks), [sparks]);
  const rows = useMemo<Row[]>(
    () =>
      alertsEnabled
        ? (serverAlerts ?? []).map((a) => ({
            key: a.key,
            unitId: a.unitId,
            unitName: a.unitName,
            label: `${a.ruleName}: ${a.summary}`,
            severity: a.severity,
            // The server's own start time: durations survive reloads and restarts.
            startsAt: a.startsAt,
          }))
        : derived.map((a) => ({ key: a.key, unitId: a.spark.id, unitName: a.spark.name, label: a.label, severity: a.severity, startsAt: null })),
    [alertsEnabled, serverAlerts, derived]
  );
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
