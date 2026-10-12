import { useMemo } from "react";
import type { AlertInstance, SparkSnapshot } from "../api/types";
import { stripAlerts, type FleetAlert } from "../components/OverviewPage/FleetAlertStrip";

/**
 * The fleet's active alerts exactly as the Overview strip lists them — the
 * server's firing set while alert notifications are on, otherwise the strip's
 * own `deriveAlerts`, with the same `showExceptions` and `temperatureUnit` — so
 * the strip, the tab badge and desktop notifications can never disagree.
 *
 * `ready` is false until there is something real to judge (no live snapshot
 * yet, or notifications on but the server's set not received), so a page that
 * is still connecting does not report every unit as unreachable.
 */
export function useFleetAlerts({
  sparks,
  alertsEnabled,
  serverAlerts,
  showExceptions,
  temperatureUnit,
}: {
  sparks: SparkSnapshot[];
  alertsEnabled: boolean;
  serverAlerts: AlertInstance[] | null;
  showExceptions: boolean;
  temperatureUnit: "celsius" | "fahrenheit";
}): { rows: FleetAlert[]; ready: boolean; source: "server" | "browser" } {
  return useMemo(() => {
    const server = alertsEnabled && serverAlerts !== null;
    return {
      rows: stripAlerts({ sparks, alertsEnabled, serverAlerts, showExceptions, temperatureUnit }),
      ready: server || (!alertsEnabled && sparks.length > 0),
      source: server ? "server" : "browser",
    };
  }, [sparks, alertsEnabled, serverAlerts, showExceptions, temperatureUnit]);
}
