/**
 * Prefill-bench context sizes — shared by the Node runner and the React dialog.
 */

export const PREFILL_CONTEXT_SIZES = [
  1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 300000,
];

export const PREFILL_DEFAULT_CONTEXT_SIZES = [4096, 8192, 16384, 32768];

/** Inclusive bounds for preset chips and typed custom sizes. */
export const PREFILL_MIN_CONTEXT_SIZE = 256;
/**
 * Ceiling used when the model's context is unknown, and where the presets stop: a run above it
 * takes tens of minutes, so typing a bigger size is a deliberate cost.
 */
export const PREFILL_MAX_CONTEXT_SIZE = 300_000;

const SIZE_LABELS = new Map([
  [1024, "1k"],
  [2048, "2k"],
  [4096, "4k"],
  [8192, "8k"],
  [16384, "16k"],
  [32768, "32k"],
  [65536, "64k"],
  [131072, "128k"],
  [262144, "256k"],
  [300000, "300k"],
]);

/**
 * The ceiling a call site should enforce: the model's own context when it is known, else the
 * preset ceiling. There is deliberately no fixed upper bound — models go past 1M now, and a
 * number picked here would just be the next thing to raise.
 * @param {number | null | undefined} contextLength
 * @returns {number}
 */
export function prefillCeilingFor(contextLength) {
  const ctx = Number(contextLength);
  if (!Number.isFinite(ctx) || ctx <= 0) return PREFILL_MAX_CONTEXT_SIZE;
  return Math.floor(ctx);
}

/**
 * Parse a typed context size. Accepts a number, or a string with an optional k/m suffix in the
 * binary sense ("128k" = 131072, "1m" = 1048576) — the format the field's own hint suggests.
 * @param {unknown} raw
 * @param {number} [maxTokens] ceiling for this call site (the model's context when known)
 * @returns {number | null}
 */
export function parseContextSize(raw, maxTokens = PREFILL_MAX_CONTEXT_SIZE) {
  const ceiling = Number(maxTokens) > 0 ? Number(maxTokens) : PREFILL_MAX_CONTEXT_SIZE;
  let n;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string") {
    const m = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(raw.trim());
    if (!m) return null;
    const unit = m[2] ? m[2].toLowerCase() : "";
    n = Number(m[1]) * (unit === "k" ? 1024 : unit === "m" ? 1_048_576 : 1);
  } else {
    return null;
  }
  if (!Number.isFinite(n)) return null;
  n = Math.round(n);
  if (n < PREFILL_MIN_CONTEXT_SIZE || n > ceiling) return null;
  return n;
}

/** @param {number} tokens */
export function formatContextSize(tokens) {
  const n = Number(tokens);
  if (SIZE_LABELS.has(n)) return SIZE_LABELS.get(n);
  if (!Number.isFinite(n) || n <= 0) return String(tokens);
  if (n >= 1_048_576 && n % 1_048_576 === 0) return `${n / 1_048_576}m`;
  // k means 1024 here, matching what the custom field accepts.
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024}k`;
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}k`;
  return String(n);
}
