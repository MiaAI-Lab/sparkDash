/**
 * Local-only types for the cost-compare feature.
 * Kept outside src/api/types.ts so upstream merges never touch it.
 */

/** One hosted model's per-token prices (USD), from the litellm catalog. */
export interface ModelPrice {
  id: string;
  provider: string | null;
  mode: string;
  inputCostPerToken: number;
  outputCostPerToken: number;
  /** Prefix-cache read price; null when the provider does not report one. */
  cacheReadCostPerToken: number | null;
  /** Prefix-cache write price; null when unreported. */
  cacheWriteCostPerToken: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
}

export interface ModelPricesResponse {
  models: ModelPrice[];
  /** Epoch ms of the last successful catalog fetch; absent on very old caches. */
  fetchedAt?: number;
  source: string;
  /** True when served from cache because the upstream refresh failed. */
  stale?: boolean;
}
