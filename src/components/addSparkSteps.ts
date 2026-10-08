import type { SparkConfig, SparkRole } from "../api/types";

export const ADD_STEPS = ["Connect", "Role", "Services"] as const;
export type AddStep = 0 | 1 | 2;

export type AddSparkDraft = Omit<SparkConfig, "id">;

/** Validation message for the Connect step, or null when it can advance. */
export function validateConnect(config: AddSparkDraft): string | null {
  if (!config.isLocal && !config.lanIp.trim()) return "LAN IP is required for a remote host";
  if (!config.isLocal && config.ssh.auth === "pass" && !config.ssh.password) {
    return "Password is required when SSH auth is Password";
  }
  return null;
}

/** Validation message for the Role step, or null when it can advance. */
export function validateRole(config: AddSparkDraft): string | null {
  return config.name.trim() ? null : "Give this unit a name";
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
