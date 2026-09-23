/**
 * Compact token formatting + saturating accumulation for token totals.
 * Shared by React components (LlmTokenTotals, FleetTokenTotals) and Node
 * (ledger). Local-only module: see docs/LOCAL-MODS.md.
 */

/** Largest exact integer JS numbers can represent (2^53 - 1). */
export const MAX_SAFE_TOKENS = Number.MAX_SAFE_INTEGER;

/**
 * Add without overflowing past MAX_SAFE_INTEGER. Numbers ≥ 2^53 lose integer
 * precision (e.g. 2^53 + 1 === 2^53), so counters saturate at that ceiling
 * instead of drifting into floats that silently round.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function addTokens(a, b) {
  const sum = a + b;
  if (!Number.isFinite(sum) || sum > MAX_SAFE_TOKENS) return MAX_SAFE_TOKENS;
  return sum;
}

/**
 * Saturating += for a numeric field held on an object.
 * @param {{ [key: string]: number }} obj
 * @param {string} key
 * @param {number} value
 */
export function addTokensTo(obj, key, value) {
  obj[key] = addTokens(obj[key] || 0, value);
}

/**
 * Compact token count: 12,3M style (Spanish-style decimal comma preserved by
 * the caller's toLocaleString only for sub-10k values) — here fixed-point:
 * < 10 000 → grouped integer ("9.812");
 * ≥ 10 000 → 3 significant digits + suffix: 12.3M / 1.05B / 2.4T (locale-neutral ".").
 * Saturated counters render as "≥ 9e15" style ceiling marker: "9.007.199.254.740.991+" → just "MAX".
 * @param {number} n
 * @returns {string}
 */
export function formatTokensCompact(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= MAX_SAFE_TOKENS) return "9.0e15+";
  if (n < 10_000) return n.toLocaleString("en-US");
  const units = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  // ≥ 10 000: format with 3 significant digits against the largest unit.
  for (let i = 0; i < units.length; i++) {
    const [factor, suffix] = units[i];
    if (n >= factor) {
      const scaled = n / factor;
      // 999 999 rounds to "1000k" — step up to the bigger suffix instead.
      if (scaled >= 999.5 && i > 0) {
        const [biggerFactor, biggerSuffix] = units[i - 1];
        const bs = n / biggerFactor;
        const bd = bs < 10 ? 2 : bs < 100 ? 1 : 0;
        return bs.toFixed(bd).replace(/0+$/, "").replace(/\.$/, "") + biggerSuffix;
      }
      // 12 345 → 12.3k ; 123 456 → 123k ; 1 050 000 → 1.05M ; 2 400 000 000 000 → 2.4T
      const digits = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
      const text = scaled.toFixed(digits);
      // Strip trailing zeros + decimal comma for clean 123k / 1M forms.
      const trimmed = text.includes(".")
        ? text.replace(/0+$/, "").replace(/\.$/, "")
        : text;
      return trimmed + suffix;
    }
  }
  return n.toLocaleString("en-US");
}
