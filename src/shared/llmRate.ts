import type { LlmMetrics } from "../api/types";

/**
 * The live decode rate of an engine, or null when there is none to show: no engine, or one that
 * answered but whose stats could not be read (its rate is unknown, not zero).
 */
export function measuredGenerationTps(llm: Pick<LlmMetrics, "generationTps" | "measurementValid"> | null | undefined): number | null {
  if (!llm || llm.measurementValid === false) return null;
  return llm.generationTps;
}
