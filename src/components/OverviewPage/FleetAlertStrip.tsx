import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SparkSnapshot } from "../../api/types";
import { AlertTriangleIcon, ChevronRightIcon } from "../ui/icons";

type Alert = { key: string; spark: SparkSnapshot; label: string; detail?: string; severity: "critical" | "warning"; throttle?: boolean };

function fmtTemp(c: number, unit: "celsius" | "fahrenheit"): string {
  return unit === "fahrenheit" ? `${Math.round((c * 9) / 5 + 32)}°F` : `${Math.round(c)}°C`;
}

export function deriveAlerts(
  sparks: SparkSnapshot[],
  unit: "celsius" | "fahrenheit" = "celsius",
  t: (key: string, def: string, opts?: Record<string, unknown>) => string
): Alert[] {
  const alerts: Alert[] = [];
  for (const spark of sparks) {
    if (!spark.online) alerts.push({ key: `${spark.id}:offline`, spark, label: t("overview.alerts.hostUnreachable", "Host unreachable"), severity: "critical" });
    const th = spark.metrics.gpu?.throttle;
    // A software power cap on an idle GPU is normal; only thermal / hardware slowdown is an alert.
    if (th?.thermal || th?.hwSlowdown) {
      const bits: string[] = [];
      const temp = spark.metrics.gpu?.temperature;
      if (temp) bits.push(t("overview.alerts.gpuTemp", "GPU at {temp}", { temp: fmtTemp(temp, unit) }));
      if (th.smClockMHz) bits.push(
        th.smClockPct != null
          ? t("overview.alerts.smClockPct", "SM clock {ghz} GHz ({pct}% of max)", { ghz: (th.smClockMHz / 1000).toFixed(1), pct: Math.round(th.smClockPct) })
          : t("overview.alerts.smClock", "SM clock {ghz} GHz", { ghz: (th.smClockMHz / 1000).toFixed(1) })
      );
      alerts.push({
        key: `${spark.id}:throttle`,
        spark,
        label: th.thermal ? t("overview.alerts.thermal", "is thermal throttling") : t("overview.alerts.hwSlowdown", "has a hardware slowdown"),
        detail: [th.detail, ...bits].filter(Boolean).join(" · "),
        severity: "critical",
        throttle: true,
      });
    }
    if (spark.metrics.storage.some((disk) => disk.percentage >= 90)) alerts.push({ key: `${spark.id}:disk`, spark, label: t("overview.alerts.disk", "storage is at or above 90%"), severity: "warning" });
    if (spark.llmMonitoring !== false && spark.metrics.llm.length > 0 && spark.metrics.llm.every((llm) => !llm.available)) alerts.push({ key: `${spark.id}:llm`, spark, label: t("overview.alerts.llm", "LLM is unavailable"), severity: "warning" });
    if (spark.tailscaleMonitoring && spark.metrics.tailscale && (!spark.metrics.tailscale.available || spark.metrics.tailscale.online === false)) alerts.push({ key: `${spark.id}:tailnet`, spark, label: t("overview.alerts.tailnet", "tailnet is unavailable"), severity: "warning" });
  }
  return alerts;
}

/**
 * Fleet exception strip. `showExceptions` is the user setting for the full list
 * (offline, disk, LLM, tailnet); throttle alerts are safety-relevant and always show.
 */
export function FleetAlertStrip({
  sparks,
  onSelect,
  showExceptions = true,
  temperatureUnit = "celsius",
}: {
  sparks: SparkSnapshot[];
  onSelect?: (id: string) => void;
  showExceptions?: boolean;
  temperatureUnit?: "celsius" | "fahrenheit";
}) {
  const { t } = useTranslation();
  const alerts = useMemo(() => {
    const all = deriveAlerts(sparks, temperatureUnit, t);
    return showExceptions ? all : all.filter((a) => a.throttle);
  }, [sparks, showExceptions, temperatureUnit, t]);
  const firstSeen = useRef(new Map<string, number>());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const active = new Set(alerts.map((alert) => alert.key));
    for (const alert of alerts) if (!firstSeen.current.has(alert.key)) firstSeen.current.set(alert.key, Date.now());
    for (const key of firstSeen.current.keys()) if (!active.has(key)) firstSeen.current.delete(key);
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [alerts]);
  if (alerts.length === 0) return null;
  return (
    <section className="ov-alerts" aria-label={t("overview.alerts.aria", "Active fleet exceptions")}>
      {alerts.map((alert) => {
        const mins = Math.max(0, Math.floor((now - (firstSeen.current.get(alert.key) ?? now)) / 60_000));
        return (
          <div key={alert.key} className={`alert-strip ov-alert ${alert.severity === "critical" ? "ov-alert--bad" : ""}`} role="status">
            <AlertTriangleIcon className="h-[18px] w-[18px] shrink-0" />
            <div className="ov-alert__text">
              <b>{alert.spark.name}</b> {alert.label}.
              <small>{[alert.detail, t("overview.alerts.activeFor", "{mins}m active", { mins })].filter(Boolean).join(" · ")}</small>
            </div>
            <button type="button" className="btn btn--sm" onClick={() => onSelect?.(alert.spark.id)}>
              {t("overview.alerts.open", "Open {name}", { name: alert.spark.name })}
              <ChevronRightIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </section>
  );
}
