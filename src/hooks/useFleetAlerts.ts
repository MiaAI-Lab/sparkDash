import { useMemo } from "react";
import type { AlertInstance, SparkSnapshot } from "../api/types";
import { stripAlerts, type FleetAlert } from "../components/OverviewPage/FleetAlertStrip";

/**
 * The fleet's active alerts from the Overview strip's own code — the server's
 * firing set while alert notifications are on, otherwise the strip's
 * `deriveAlerts`, with the same `temperatureUnit` — so the strip, the tab badge
 * and desktop notifications can never disagree about what is wrong.
 *
 * Always every alert (offline, throttle, storage, LLM, Health), whatever
 * Settings → "Show active fleet exceptions" says: that switch only decides what
 * the strip shows (throttling alone while off, the default), and someone who
 * turned the badge or notifications on wants to hear about an offline unit.
 *
 * `ready` is false until there is something real to judge (no live snapshot
 * yet, or notifications on but the server's set not received), so a page that
 * is still connecting does not report every unit as unreachable.
 */
export function useFleetAlerts({
  sparks,
  alertsEnabled,
  serverAlerts,
  temperatureUnit,
}: {
  sparks: SparkSnapshot[];
  alertsEnabled: boolean;
  serverAlerts: AlertInstance[] | null;
  temperatureUnit: "celsius" | "fahrenheit";
}): { rows: FleetAlert[]; ready: boolean; source: "server" | "browser" } {
  return useMemo(() => {
    const server = alertsEnabled && serverAlerts !== null;
    return {
      rows: stripAlerts({ sparks, alertsEnabled, serverAlerts, showExceptions: true, temperatureUnit }),
      ready: server || (!alertsEnabled && sparks.length > 0),
      source: server ? "server" : "browser",
    };
  }, [sparks, alertsEnabled, serverAlerts, temperatureUnit]);
}
