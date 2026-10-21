/**
 * Local-only types for the llm-token-totals feature.
 * Kept outside src/api/types.ts so upstream merges never touch it.
 */

/** Cumulative token totals for one model on one series (spark + LLM port). */
export interface LlmTokenModelTotals {
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  /** Prefix-cache served subset of promptTokens (0 when the backend does not report the split). */
  cachedTokens: number;
  /**
   * Whether the backend reports the cache split at all. `false` = `cachedTokens` is not
   * a measured value (the engine publishes no prefix-cache counter), so it must render as
   * "unknown" instead of a 0 % hit rate. Absent on older data (treated as reported).
   */
  cacheReported?: boolean;
  lastSeenAt: number;
}

/** One series = one (sparkId, port) LLM endpoint. */
export interface LlmTokenSeriesTotals {
  sparkId: string;
  port: number;
  updatedAt: number | null;
  lastModelId: string | null;
  totals: { promptTokens: number; completionTokens: number; cachedTokens: number; cacheReported?: boolean };
  models: LlmTokenModelTotals[];
}

export interface LlmTokenTotalsResponse {
  /** "all" or the normalized window echo for ranged queries. */
  range: "all" | "today" | "1h" | "6h" | "7d" | "14d" | "30d";
  series: LlmTokenSeriesTotals[];
}

/** Range keys for the totals dropdown (server validates the same set). */
export type LlmTokenRange = LlmTokenTotalsResponse["range"];
