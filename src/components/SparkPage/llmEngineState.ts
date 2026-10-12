import { i18next } from "../../i18n";
import type { LlmMetrics } from "../../api/types";

export interface EngineStateLabel {
  text: string;
  /** Hover text; set when the value needs explaining. */
  title?: string;
  /** Render muted — the value is an absence, not a reading. */
  muted: boolean;
}

/**
 * The LLM panel's Engine tile. `gpuMemoryUtilization` carries the engine
 * state only where the probe fills it (vLLM's sleep gauge; SGLang and q27,
 * which are always resident, report Active). For the rest — TensorFold,
 * llama.cpp, … — a bare dash read like a failed probe, so the tile says the
 * backend does not report it. The dash is kept for "no LLM at all".
 */
export function engineStateLabel(llm: LlmMetrics | null | undefined): EngineStateLabel {
  if (!llm) return { text: "—", muted: false };
  if (llm.gpuMemoryUtilization == null) {
    return {
      text: i18next.t("spark.llmState.na", "n/a"),
      title: i18next.t("spark.llmState.naTitle", "This backend does not report engine sleep state"),
      muted: true,
    };
  }
  const text =
    llm.gpuMemoryUtilization === 0
      ? i18next.t("spark.llmState.sleeping", "Sleeping")
      : i18next.t("spark.llmState.active", "Active");
  return { text, muted: false };
}
