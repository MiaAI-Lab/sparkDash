import { i18next } from "../../i18n";

/**
 * Wording for the two "generated tokens" numbers the UI shows, kept in one
 * place so the LLM panel tile and the token-totals tables explain each other.
 *
 * - The engine's own counter (`totalOutputTokens`) starts at zero whenever the
 *   LLM server restarts.
 * - sparkDash's ledger (the "Total tokens by model" tables) keeps counting
 *   across restarts, from when sparkDash first saw the endpoint.
 *
 * The engine counter's wording is a plain constant (LlmPanel takes it from the
 * `tokens.engine.*` catalog); the ledger wording is looked up at call time so it
 * follows the active language inside the Overview card.
 */
export const ENGINE_GENERATED_LABEL = "Generated (engine)";
export const ENGINE_GENERATED_TITLE = "Reported by the engine since it last started";

/** Short line under the ledger number, e.g. "{hint}, whole fleet". */
export function ledgerHint(): string {
  return i18next.t("tokens.ledger.hint", "Counted by sparkDash since tracking began");
}

/** Tooltip on the ledger number: the long explanation of what it counts. */
export function ledgerTitle(): string {
  return i18next.t(
    "tokens.ledger.title",
    "Counted by sparkDash since tracking began, filtered by the selected range. It survives engine restarts, so it can be larger than the engine's own Generated counter.",
  );
}
