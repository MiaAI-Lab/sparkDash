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
