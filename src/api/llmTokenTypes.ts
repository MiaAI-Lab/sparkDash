/**
 * Local-only types for the llm-token-totals feature.
 * Kept outside src/api/types.ts so upstream merges never touch it.
 */

/** Cumulative token totals for one model on one series (spark + LLM port). */
export interface LlmTokenModelTotals {
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  lastSeenAt: number;
}

/** One series = one (sparkId, port) LLM endpoint. */
export interface LlmTokenSeriesTotals {
  sparkId: string;
  port: number;
  updatedAt: number | null;
  lastModelId: string | null;
  totals: { promptTokens: number; completionTokens: number };
  models: LlmTokenModelTotals[];
}

export interface LlmTokenTotalsResponse {
  /** "all" or the normalized window echo for ranged queries. */
  range: "all" | "today" | "7d" | "14d" | "30d";
  series: LlmTokenSeriesTotals[];
}

/** Range keys for the totals dropdown (server validates the same set). */
export type LlmTokenRange = LlmTokenTotalsResponse["range"];
