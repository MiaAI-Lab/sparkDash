import type { SparkConfig, SparkRole } from "../api/types";
import { i18next } from "../i18n";

export const ADD_STEPS = ["Connect", "Role", "Services"] as const;
export type AddStep = 0 | 1 | 2;

export type AddSparkDraft = Omit<SparkConfig, "id">;

/** Localized label for an Add-dialog step. */
export function stepLabel(step: AddStep): string {
  if (step === 0) return i18next.t("spark.step.connect", "Connect");
  if (step === 1) return i18next.t("spark.step.role", "Role");
  return i18next.t("spark.step.services", "Services");
}

/** Machine-readable Connect-step problem, so callers never match on text. */
export type ConnectIssue = "lanIp" | "password";

export function connectIssue(config: AddSparkDraft): ConnectIssue | null {
  if (!config.isLocal && !config.lanIp.trim()) return "lanIp";
  if (!config.isLocal && config.ssh.auth === "pass" && !config.ssh.password) return "password";
  return null;
}

/** Validation message for the Connect step, or null when it can advance. */
export function validateConnect(config: AddSparkDraft): string | null {
  const issue = connectIssue(config);
  if (issue === "lanIp") {
    return i18next.t("spark.validate.lanIp", "LAN IP is required for a remote host");
  }
  if (issue === "password") {
    return i18next.t("spark.validate.password", "Password is required when SSH auth is Password");
  }
  return null;
}

/** Validation message for the Role step, or null when it can advance. */
export function validateRole(config: AddSparkDraft): string | null {
  return config.name.trim() ? null : i18next.t("spark.validate.name", "Give this unit a name");
}

/** Whether the "Next" / "Add" button for `step` should be enabled. */
export function canAdvance(step: AddStep, config: AddSparkDraft): boolean {
  if (step === 0) return validateConnect(config) === null;
  if (step === 1) return validateRole(config) === null;
  return validateConnect(config) === null && validateRole(config) === null;
}

/** Role patch that keeps role, workerNode and llmMonitoring consistent. */
export function rolePatch(role: SparkRole): Partial<AddSparkDraft> {
  return { role, workerNode: role === "worker", llmMonitoring: role !== "worker" };
}

/** Comma-separated LLM ports -> valid ports only (1-65535, integers). */
export function parsePorts(text: string): number[] {
  return text
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
}

export function slugifyId(name: string, now: number = Date.now()): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || `spark-${now}`;
}
