import type { SparkSnapshot } from "../api/types";

export type FleetExceptionId = "offline" | "throttle" | "disk" | "llm" | "tailnet";

export interface FleetException {
  id: FleetExceptionId;
  label: string;
  detail?: string;
  severity: "critical" | "warning";
}

export function formatTemperature(c: number, unit?: "celsius" | "fahrenheit"): string;
export function fleetExceptions(spark: SparkSnapshot, unit?: "celsius" | "fahrenheit"): FleetException[];
