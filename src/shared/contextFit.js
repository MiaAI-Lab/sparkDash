/**
 * Context-fit rules shared by the Node benches and the React dialogs, so the UI never offers a
 * size the server then skips (or the reverse).
 *
 * A nominal size is a *target* prompt size; real tokenizers run up to ~1.2x over it, and the
 * reply needs room too, so a size fits when ceil(size * headroom) + reserve <= contextLength.
 * An unknown context (null/0) fits everything.
 */

/** Real prompts run ~1.0x (o200k) to ~1.2x (cl100k/Llama-3) of the nominal size. */
export const CONTEXT_TOKEN_HEADROOM = 1.2;
/** Quality bench long-context items reserve this many tokens for the reply. */
export const QUALITY_LONG_RESERVE_TOKENS = 512;
/** Prefill bench: chat template + header/footer + the 8 generated tokens. */
export const PREFILL_RESERVE_TOKENS = 128;

/**
 * @param {number} size nominal prompt tokens
 * @param {number | null | undefined} contextLength
 * @param {number} reserveTokens
 * @param {number} [headroom]
 */
export function sizeFitsContext(size, contextLength, reserveTokens, headroom = CONTEXT_TOKEN_HEADROOM) {
  const ctx = Number(contextLength);
  if (!Number.isFinite(ctx) || ctx <= 0) return true;
  return Math.ceil(Number(size) * headroom) + reserveTokens <= ctx;
}

/** Quality bench long-context needle size. */
export function qualityLongFitsContext(size, contextLength) {
  return sizeFitsContext(size, contextLength, QUALITY_LONG_RESERVE_TOKENS);
}

/**
 * Prefill bench size. The prompt is built to the target by a chars/4 estimate over one-token
 * filler words, which lands at or just under the target, so only the fixed template/reply
 * reserve is added (no 1.2x factor — that would make the 128k chip unusable on a 128k model).
 */
export function prefillFitsContext(size, contextLength) {
  return sizeFitsContext(size, contextLength, PREFILL_RESERVE_TOKENS, 1);
}
