import type { ModelTier, SparkSnapshot, StorageMetrics } from "../../api/types";

/** A Spark's view of where a model lives, given the whole fleet's snapshots. */
export interface ModelPlacement {
  name: string;
  /** Resident copies: which Spark(s) hold a local copy, and in which tier. */
  resident: Array<{ sparkId: string; sparkName: string; tier: ModelTier }>;
  /** Sparks serving this model over the CX7 fabric (loading but not resident). */
  fabric: Array<{ sparkId: string; sparkName: string }>;
}

/** Loose model-name match: exact, or normalize HF-hub-style basenames. */
function modelIdMatches(llmModelId: string | null | undefined, modelName: string): boolean {
  if (!llmModelId) return false;
  const a = llmModelId.toLowerCase();
  const b = modelName.toLowerCase();
  if (a === b) return true;
  // HF hub cache path like ~/.cache/huggingface/hub/models--org--name vs resident name.
  const last = a.split("/").pop() ?? "";
  return last === b || a.endsWith("/" + b) || a.includes("models--" + b.replace(/\s+/g, "-"));
}

/**
 * Resolve per-model placement across the fleet. A model is:
 *  - "resident" on a Spark that holds a local disk copy (tier from its scan);
 *  - served "fabric" on a Spark that is currently *loading* it in unified
 *    memory (llm modelId) but holds no local copy, while at least one peer is
 *    resident — i.e. the peer's hot copy is reached over the CX7 interconnect.
 * Pure (no React) so it is directly unit-testable.
 */
export function resolvePlacement(sparks: SparkSnapshot[]): ModelPlacement[] {
  const byName = new Map<string, ModelPlacement>();
  for (const spark of sparks) {
    const resident = Array.isArray(spark.metrics?.models) ? spark.metrics.models : [];
    for (const m of resident) {
      let entry = byName.get(m.name);
      if (!entry) {
        entry = { name: m.name, resident: [], fabric: [] };
        byName.set(m.name, entry);
      }
      entry.resident.push({ sparkId: spark.id, sparkName: spark.name, tier: m.tier });
    }
  }
  // Fabric: a Spark is loading a model it does not own, while a peer owns it.
  for (const spark of sparks) {
    const loaded = (Array.isArray(spark.metrics?.llm) ? spark.metrics.llm : [])
      .map((l) => l?.modelId)
      .filter(Boolean);
    for (const modelName of Array.from(byName.keys())) {
      const entry = byName.get(modelName)!;
      if (entry.resident.some((r) => r.sparkId === spark.id)) continue; // resident here
      if (entry.resident.length === 0) continue; // nobody owns it locally
      const isLoaded = loaded.some((id) => modelIdMatches(id, modelName));
      if (isLoaded) {
        // Avoid duplicate fabric markers per spark/model.
        if (!entry.fabric.some((f) => f.sparkId === spark.id)) {
          entry.fabric.push({ sparkId: spark.id, sparkName: spark.name });
        }
      }
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** Fleet-wide tier usage (GB) summed across all Sparks' storage devices. */
export function rollupTierGb(sparks: SparkSnapshot[]): Record<ModelTier, number> {
  const out: Record<ModelTier, number> = { hot: 0, warm: 0, cold: 0 };
  for (const spark of sparks) {
    const disks: StorageMetrics[] = Array.isArray(spark.metrics?.storage)
      ? spark.metrics.storage
      : [];
    for (const d of disks) {
      if (d?.disabled) continue;
      const tier = d.tier;
      if (tier === "hot" || tier === "warm" || tier === "cold") {
        out[tier] += (d.used || 0) / 1024;
      }
    }
  }
  return out;
}
