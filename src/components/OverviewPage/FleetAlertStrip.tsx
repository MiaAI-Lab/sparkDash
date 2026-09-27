import { useEffect, useMemo, useRef, useState } from "react";
import type { SparkSnapshot } from "../../api/types";

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

export function FleetAlertStrip({ sparks, onSelect }: { sparks: SparkSnapshot[]; onSelect?: (id: string) => void }) {
  const alerts = useMemo(() => derive(sparks), [sparks]);
  const firstSeen = useRef(new Map<string, number>());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const active = new Set(alerts.map((alert) => alert.key));
    for (const alert of alerts) if (!firstSeen.current.has(alert.key)) firstSeen.current.set(alert.key, Date.now());
    for (const key of firstSeen.current.keys()) if (!active.has(key)) firstSeen.current.delete(key);
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [alerts]);
  if (alerts.length === 0) return <p className="text-xs text-success" role="status">No active fleet exceptions.</p>;
  return (
    <section className="panel p-3" aria-labelledby="fleet-alerts-title">
      <h2 id="fleet-alerts-title" className="text-xs font-semibold text-text-strong">Active fleet exceptions · {alerts.length}</h2>
      <ul className="mt-2 flex flex-wrap gap-2">
        {alerts.map((alert) => <li key={alert.key}>
          <button type="button" onClick={() => onSelect?.(alert.spark.id)} className={`min-h-11 rounded border px-3 py-2 text-left text-xs ${alert.severity === "critical" ? "border-danger/50 text-danger" : "border-warning/50 text-warning"}`}>
            <strong>{alert.spark.name}</strong> · {alert.label} · {Math.max(0, Math.floor((now - (firstSeen.current.get(alert.key) ?? now)) / 60_000))}m
          </button>
        </li>)}
      </ul>
    </section>
  );
}
