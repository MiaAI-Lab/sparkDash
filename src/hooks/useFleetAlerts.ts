import { useMemo } from "react";
import type { AlertInstance, SparkSnapshot } from "../api/types";

/**
 * The fleet's active alerts as the UI shows them, from whichever side owns
 * them: the server's firing set while `alertsEnabled` is on, otherwise the
 * browser's own derivation (the exceptions strip's original rules). Shared by
 * the Overview strip and the tab badge / desktop notifications so the two can
 * never disagree about what is wrong.
 */
export interface FleetAlertRow {
  key: string;
  unitId: string;
  unitName: string;
  label: string;
  severity: "critical" | "warning";
  /** Server start time (survives reloads); null = derived here, count from first sight. */
  startsAt: number | null;
}

export function deriveFleetAlerts(sparks: SparkSnapshot[]): FleetAlertRow[] {
  const rows: FleetAlertRow[] = [];
  const push = (spark: SparkSnapshot, suffix: string, label: string, severity: FleetAlertRow["severity"]) =>
    rows.push({ key: `${spark.id}:${suffix}`, unitId: spark.id, unitName: spark.name, label, severity, startsAt: null });
  for (const spark of sparks) {
    if (!spark.online) push(spark, "offline", "Host unreachable", "critical");
    if (spark.metrics.gpu?.throttle?.active) push(spark, "throttle", `GPU throttled: ${spark.metrics.gpu.throttle.detail}`, "critical");
    if (spark.metrics.storage.some((disk) => disk.percentage >= 90)) push(spark, "disk", "Storage at or above 90%", "warning");
    if (spark.llmMonitoring !== false && spark.metrics.llm.length > 0 && spark.metrics.llm.every((llm) => !llm.available)) push(spark, "llm", "LLM unavailable", "warning");
    if (spark.tailscaleMonitoring && spark.metrics.tailscale && (!spark.metrics.tailscale.available || spark.metrics.tailscale.online === false)) push(spark, "tailnet", "Tailnet unavailable", "warning");
  }
  return rows;
}

export function serverAlertRows(alerts: AlertInstance[]): FleetAlertRow[] {
  return alerts.map((a) => ({
    key: a.key,
    unitId: a.unitId,
    unitName: a.unitName,
    label: `${a.ruleName}: ${a.summary}`,
    severity: a.severity,
    startsAt: a.startsAt,
  }));
}

/**
 * `ready` is false until there is something real to judge — no live snapshot
 * yet, or alerts on but the server's set not received — so a page that is
 * still connecting does not report every unit as unreachable.
 */
export function useFleetAlerts(
  sparks: SparkSnapshot[],
  alertsEnabled: boolean,
  serverAlerts: AlertInstance[] | null
): { rows: FleetAlertRow[]; ready: boolean; source: "server" | "browser" } {
  return useMemo(
    () =>
      alertsEnabled
        ? { rows: serverAlertRows(serverAlerts ?? []), ready: serverAlerts !== null, source: "server" }
        : { rows: deriveFleetAlerts(sparks), ready: sparks.length > 0, source: "browser" },
    [alertsEnabled, serverAlerts, sparks]
  );
}
