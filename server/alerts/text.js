/**
 * Length caps for text that reaches an alert summary, a notification or the
 * Activity log. Much of it comes from elsewhere — a unit's name, a kernel Xid
 * line, an SSH error, a model id — so every such string is flattened to one
 * line and cut, with an ellipsis, before it is stored or sent.
 */

/** Summaries and details. */
export const MAX_SUMMARY_CHARS = 120;
/** Unit and channel names. */
export const MAX_NAME_CHARS = 60;

/**
 * One line of at most `max` characters; longer text ends in "…".
 * @param {unknown} value
 * @param {number} [max]
 */
export function capText(value, max = MAX_SUMMARY_CHARS) {
  if (value == null) return "";
  // eslint-disable-next-line no-control-regex
  const flat = String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  return `${chars.slice(0, Math.max(1, max - 1)).join("").trimEnd()}…`;
}
