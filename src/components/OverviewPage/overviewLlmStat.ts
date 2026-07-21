import type { SparkSnapshot } from "../../api/types";

export interface OverviewLlmStat {
  label: string;
  value: string;
  title?: string;
}

type OverviewLlmSource = Pick<SparkSnapshot, "llmCluster" | "metrics">;

export function getOverviewLlmStat(spark: OverviewLlmSource): OverviewLlmStat | null {
  const cluster = spark.llmCluster;
  if (cluster?.role === "worker") {
    return {
      label: "Distributed worker",
      value: cluster.label,
      title: `${cluster.label} distributed worker · rank ${cluster.rank} / ${cluster.worldSize - 1}`,
    };
  }

  const llm = Array.isArray(spark.metrics.llm)
    ? spark.metrics.llm.find((candidate) => candidate.available)
    : null;
  if (!llm) return null;

  return {
    label: llm.backend === "vllm" ? "vLLM" : llm.backend ?? "LLM",
    value: llm.modelId ?? "unknown",
    title: llm.modelId ?? undefined,
  };
}
