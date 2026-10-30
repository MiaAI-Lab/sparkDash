/**
 * Wording for the two "generated tokens" numbers the UI shows, kept in one
 * place so the LLM panel tile and the token-totals tables explain each other.
 *
 * - The engine's own counter (`totalOutputTokens`) starts at zero whenever the
 *   LLM server restarts.
 * - sparkDash's ledger (the "Total tokens by model" tables) keeps counting
 *   across restarts, from when sparkDash first saw the endpoint.
 */
export const ENGINE_GENERATED_LABEL = "Generated (engine)";
export const ENGINE_GENERATED_TITLE = "Reported by the engine since it last started";
export const LEDGER_HINT = "Counted by sparkDash since tracking began";
export const LEDGER_TITLE =
  "Counted by sparkDash since tracking began, filtered by the selected range. It survives engine restarts, so it can be larger than the engine's own Generated counter.";

/**
 * A ledger row's prompt whose cache split was never measured (the engine published no cached counter
 * then): neither cached nor computed prefill. Older servers send only the flag.
 */
export function unreportedOf(row: { promptTokens: number; cachedTokens: number; cacheReported?: boolean; unreportedPromptTokens?: number }): number {
  const open = Math.max(0, (row.promptTokens || 0) - Math.min(row.cachedTokens || 0, row.promptTokens || 0));
  const n = typeof row.unreportedPromptTokens === "number" ? row.unreportedPromptTokens : row.cacheReported === false ? open : 0;
  return Math.min(Math.max(0, n), open);
}

/** The hover of a token row: prompt, its split and generated. */
export function tokenRowTitle(row: { promptTokens: number; cachedTokens: number; unreportedPromptTokens: number; completionTokens: number }): string {
  const prefill = row.promptTokens - row.cachedTokens - row.unreportedPromptTokens;
  const unreported = row.unreportedPromptTokens > 0 ? ` \u00b7 ${row.unreportedPromptTokens.toLocaleString()} not reported` : "";
  return `${row.promptTokens.toLocaleString()} prompt \u00b7 ${row.cachedTokens.toLocaleString()} cached \u00b7 ${prefill.toLocaleString()} prefill${unreported} \u00b7 ${row.completionTokens.toLocaleString()} generated`;
}
