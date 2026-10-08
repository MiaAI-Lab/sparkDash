import type { SparkSnapshot } from "../../api/types";
import { isWorkerSpark } from "../../api/sparkRole";

/** Live decode tok/s of the first reachable LLM on a Spark, or null. */
export function primaryDecodeTps(spark: SparkSnapshot): number | null {
  const llm = Array.isArray(spark.metrics.llm) ? spark.metrics.llm.find((l) => l.available) : null;
  return llm ? llm.generationTps : null;
}

/** Short label for the rail: tok/s when an LLM is live, otherwise a status word. */
export function railSubLabel(spark: SparkSnapshot): string {
  if (!spark.online) return "off";
  const tps = primaryDecodeTps(spark);
  if (tps != null) return tps >= 100 ? tps.toFixed(0) : tps.toFixed(1);
  return isWorkerSpark(spark) ? "worker" : "—";
}

export function isThrottling(spark: SparkSnapshot): boolean {
  return Boolean(spark.online && spark.metrics.gpu?.throttle?.thermal);
}

/** First Spark that can host a showcase (has a reachable LLM and is not a worker). */
export function showcaseTarget(sparks: SparkSnapshot[]): SparkSnapshot | null {
  return (
    sparks.find((s) => s.online && !isWorkerSpark(s) && Array.isArray(s.metrics.llm) && s.metrics.llm.some((l) => l.available)) ??
    null
  );
}

export function openShowcase(spark: SparkSnapshot) {
  const idx = Array.isArray(spark.metrics.llm) ? spark.metrics.llm.findIndex((l) => l.available) : -1;
  const llm = idx >= 0 ? spark.metrics.llm[idx] : null;
  const port = spark.llmPorts?.[idx] ?? spark.llmPort;
  const params = new URLSearchParams();
  if (port) params.set("port", String(port));
  if (llm?.modelId) params.set("model", llm.modelId);
  const q = params.toString() ? `?${params.toString()}` : "";
  window.open(`/showcase/${encodeURIComponent(spark.id)}${q}`, "_blank", "noopener,noreferrer");
}
