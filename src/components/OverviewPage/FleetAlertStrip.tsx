import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AlertInstance, SparkSnapshot } from "../../api/types";
import { fleetExceptions, formatTemperature } from "../../shared/fleetExceptions";
import { AlertTriangleIcon, ChevronRightIcon } from "../ui/icons";

export type FleetAlert = {
  /** `${unitId}:${id}` — the server's alerts use the same keys. */
  key: string;
  unitId: string;
  unitName: string;
  label: string;
  detail?: string;
  severity: "critical" | "warning";
  /** Thermal / hardware throttle: safety-relevant, shown even with the full list off. */
  throttle?: boolean;
  /** When the server says the condition began (survives reloads); null = counted from first sight here. */
  startsAt: number | null;
};

/** The strip's own conditions, from the module the server's alert notifications use too. */
export function deriveAlerts(sparks: SparkSnapshot[], unit: "celsius" | "fahrenheit" = "celsius"): FleetAlert[] {
  const alerts: FleetAlert[] = [];
  for (const spark of sparks) {
    for (const ex of fleetExceptions(spark, unit)) {
      alerts.push({
        key: `${spark.id}:${ex.id}`,
        unitId: spark.id,
        unitName: spark.name,
        label: ex.label,
        ...(ex.detail ? { detail: ex.detail } : {}),
        severity: ex.severity,
        ...(ex.id === "throttle" ? { throttle: true } : {}),
        startsAt: null,
      });
    }
  }
  return alerts;
}

/**
 * The server's firing alerts as strip rows. A strip condition the browser can
 * still see takes its text from the live snapshot, so it honours the
 * temperature unit; a Health finding keeps the server's words.
 */
export function serverAlertRows(alerts: AlertInstance[], sparks: SparkSnapshot[], unit: "celsius" | "fahrenheit" = "celsius"): FleetAlert[] {
  const live = new Map(deriveAlerts(sparks, unit).map((a) => [a.key, a]));
  return alerts.map((a) => {
    const here = live.get(a.key);
    return {
      key: a.key,
      unitId: a.unitId,
      unitName: here?.unitName ?? a.unitName,
      label: here?.label ?? a.label,
      ...(here ? (here.detail ? { detail: here.detail } : {}) : a.summary && a.summary !== a.label ? { detail: a.summary } : {}),
      severity: a.severity,
      ...(a.ruleId === "throttle" ? { throttle: true } : {}),
      startsAt: a.startsAt,
    };
  });
}

/**
 * What the strip lists: the server's alerts while alert notifications are on
 * (and have arrived), otherwise its own derivation. `showExceptions` is the user
 * setting for the full list; throttle alerts are safety-relevant and always show.
 */
export function stripAlerts({
  sparks,
  alertsEnabled = false,
  serverAlerts = null,
  showExceptions = true,
  temperatureUnit = "celsius",
}: {
  sparks: SparkSnapshot[];
  alertsEnabled?: boolean;
  serverAlerts?: AlertInstance[] | null;
  showExceptions?: boolean;
  temperatureUnit?: "celsius" | "fahrenheit";
}): FleetAlert[] {
  const all = alertsEnabled && serverAlerts ? serverAlertRows(serverAlerts, sparks, temperatureUnit) : deriveAlerts(sparks, temperatureUnit);
  return showExceptions ? all : all.filter((a) => a.throttle);
}

/** Fleet exception strip. */
export function FleetAlertStrip({
  sparks,
  onSelect,
  showExceptions = true,
  temperatureUnit = "celsius",
  alertsEnabled = false,
  serverAlerts = null,
}: {
  sparks: SparkSnapshot[];
  onSelect?: (id: string) => void;
  showExceptions?: boolean;
  temperatureUnit?: "celsius" | "fahrenheit";
  /** Alert notifications on: list the server's firing alerts, with their real durations. */
  alertsEnabled?: boolean;
  serverAlerts?: AlertInstance[] | null;
}) {
  const { t } = useTranslation("overview");
  const alerts = useMemo(
    () => stripAlerts({ sparks, alertsEnabled, serverAlerts, showExceptions, temperatureUnit }),
    [sparks, alertsEnabled, serverAlerts, showExceptions, temperatureUnit]
  );
  // Localize only conditions present in the live snapshot. Server-only findings
  // retain their original label/summary, as in serverAlertRows; rules stay shared.
  const liveText = useMemo(() => {
    const text = new Map<string, Pick<FleetAlert, "label" | "detail">>();
    for (const spark of sparks) {
      for (const condition of fleetExceptions(spark, temperatureUnit)) {
        const labels = {
          offline: t("alerts.offline"), disk: t("alerts.disk"),
          llm: t("alerts.llm"), tailnet: t("alerts.tailnet"),
          throttle: spark.metrics?.gpu?.throttle?.thermal ? t("alerts.thermal") : t("alerts.hardware"),
        };
        let detail = condition.detail;
        if (condition.id === "throttle") {
          const throttle = spark.metrics?.gpu?.throttle;
          const bits = [throttle?.detail];
          const temperature = spark.metrics?.gpu?.temperature;
          if (temperature) bits.push(t("alerts.temperature", { value: formatTemperature(temperature, temperatureUnit) }));
          if (throttle?.smClockMHz) {
            const frequency = (throttle.smClockMHz / 1000).toFixed(1);
            bits.push(throttle.smClockPct != null
              ? t("alerts.clockWithMax", { frequency, percent: Math.round(throttle.smClockPct) })
              : t("alerts.clock", { frequency }));
          }
          detail = bits.filter(Boolean).join(" · ");
        }
        text.set(`${spark.id}:${condition.id}`, { label: labels[condition.id], detail });
      }
    }
    return text;
  }, [sparks, temperatureUnit, t]);
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
    <section className="ov-alerts" aria-label={t("alerts.title")}>
      {alerts.map((alert) => {
        const since = alert.startsAt ?? firstSeen.current.get(alert.key) ?? now;
        const mins = Math.max(0, Math.floor((now - since) / 60_000));
        const text = liveText.get(alert.key) ?? alert;
        return (
          <div key={alert.key} className={`alert-strip ov-alert ${alert.severity === "critical" ? "ov-alert--bad" : ""}`} role="status">
            <AlertTriangleIcon className="h-[18px] w-[18px] shrink-0" />
            <div className="ov-alert__text">
              <b>{alert.unitName}</b> {text.label}.
              <small>{[text.detail, t("alerts.active", { count: mins })].filter(Boolean).join(" · ")}</small>
            </div>
            <button type="button" className="btn btn--sm" onClick={() => onSelect?.(alert.unitId)}>
              {t("alerts.open", { name: alert.unitName })}
              <ChevronRightIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </section>
  );
}
