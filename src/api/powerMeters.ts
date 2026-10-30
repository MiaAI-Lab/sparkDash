/**
 * Optional power meters (server/powermeter, docs/POWER-METERS.md): whether they are
 * configured and working. The energy they measure is part of /api/fleet-energy.
 */
import { apiFetch } from "./client";

export interface PowerMeterUnitStatus {
  id: string;
  name: string;
  /** False when the id in power-meters.json is not a registered unit. */
  known: boolean;
  /** Whether its wall power is recorded (registered units only). */
  recorded: boolean;
  meter: string;
  channel: string;
  sinceMs: number | null;
  watts: number | null;
  /** When the meter itself last reported. */
  atMs: number | null;
  fresh: boolean;
  error: string | null;
  polledAtMs: number | null;
  /** End of the newest 5-minute period the meter's own record has confirmed. */
  reconciledThroughMs: number | null;
}

export type PowerMeterHistoryState = "pending" | "backfilling" | "ok" | "error" | "unsupported" | "unavailable" | "off";

export interface PowerMeterMeterStatus {
  id: string;
  type: string;
  /** The provider's own name for the meter ("Home Assistant"). */
  label: string;
  /** Display target (a URL or host), never a credential. */
  target: string | null;
  health: "pending" | "ok" | "error" | "unavailable";
  ok: boolean;
  error: string | null;
  lastOkAt: number | null;
  history: {
    state: PowerMeterHistoryState;
    lastOkAt: number | null;
    lastError: string | null;
    backfill: { fromMs: number; throughMs: number; startedAt: number; doneAt?: number } | null;
  };
}

export type PowerMeterStatus =
  | { enabled: false; state: "absent" | "disabled" | "invalid"; error?: string }
  | {
      enabled: true;
      state: "ok";
      configPath: string;
      pollIntervalMs: number;
      staleAfterMs: number;
      history: { enabled: boolean; backfillDays: number };
      meters: PowerMeterMeterStatus[];
      units: PowerMeterUnitStatus[];
    };

export function fetchPowerMeterStatus(): Promise<PowerMeterStatus> {
  return apiFetch("/api/power-meters");
}
