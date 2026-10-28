/**
 * Bind-retry policy for startup.
 *
 * On a Spark that boots with the dashboard's container set to restart
 * unconditionally, the server process routinely wins the race against the
 * Tailscale interface: binding the unit's 100.x address while tailscale0 has
 * no address yet fails with EADDRNOTAVAIL. Exiting was the old behaviour, and
 * under `node --watch` an exit parks the process until a file changes — the
 * dashboard stayed dead forever after a reboot that came up too fast. A few
 * patient retries ride the race out; every other bind error (port in use,
 * bad address) is a real misconfiguration and must still fail loudly.
 *
 * Exported as a pure decision so the policy is testable without sockets.
 */

/** Bind errors that are plausibly transient at boot. Everything else exits. */
export const LISTEN_RETRY_CODES = Object.freeze(["EADDRNOTAVAIL"]);

/** Delay between bind retries, and how many we allow (~2 min total). */
export const LISTEN_RETRY_DELAY_MS = 5000;
export const LISTEN_RETRY_MAX_ATTEMPTS = 24;

/**
 * Decide whether a failed `server.listen()` should be retried.
 * @param {object} opts
 * @param {string|undefined} opts.code the error's `code` (e.g. "EADDRNOTAVAIL")
 * @param {number} opts.attempt retries already spent (0-based)
 * @returns {{ retry: boolean, delayMs: number, attempt: number }}
 */
export function planListenRetry({ code, attempt }) {
  const retry = LISTEN_RETRY_CODES.includes(code) && Number.isFinite(attempt) && attempt < LISTEN_RETRY_MAX_ATTEMPTS;
  return { retry, delayMs: LISTEN_RETRY_DELAY_MS, attempt };
}
