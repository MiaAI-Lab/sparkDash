import type { SparkRole } from "./types";

/** Resolve cluster role from config/snapshot fields (supports legacy workerNode-only). */
export function resolveSparkRole(spark: {
  role?: SparkRole | string | null;
  workerNode?: boolean | null;
}): SparkRole {
  if (spark.role === "head" || spark.role === "worker" || spark.role === "standalone") {
    return spark.role;
  }
  return spark.workerNode ? "worker" : "standalone";
}

export function isWorkerSpark(spark: {
  role?: SparkRole | string | null;
  workerNode?: boolean | null;
}): boolean {
  return resolveSparkRole(spark) === "worker";
}

/**
 * Whether this Spark should probe/show the local LLM API.
 * Workers: never. Head: always. Standalone: llmMonitoring (default true).
 */
export function isLlmMonitoringEnabled(spark: {
  role?: SparkRole | string | null;
  workerNode?: boolean | null;
  llmMonitoring?: boolean | null;
}): boolean {
  const role = resolveSparkRole(spark);
  if (role === "worker") return false;
  if (role === "head") return true;
  return spark.llmMonitoring !== false;
}
