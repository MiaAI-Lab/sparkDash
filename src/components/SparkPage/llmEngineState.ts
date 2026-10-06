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
      text: "n/a",
      title: "This backend does not report engine sleep state",
      muted: true,
    };
  }
  return { text: llm.gpuMemoryUtilization === 0 ? "Sleeping" : "Active", muted: false };
}
