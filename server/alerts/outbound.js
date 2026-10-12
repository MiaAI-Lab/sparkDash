/**
 * Which addresses an alert channel may reach. This is the one place that
 * decides it for alerts, and it decides nothing of its own: it applies the
 * outbound-target policy `server/validate.js` already applies to units, LLM
 * endpoints and bench targets —
 *
 *   - save time: `isAllowedTargetHost` (a valid host; an IP literal must not be
 *     a forbidden address), plus a DNS check of a hostname when it resolves;
 *   - send time: `assertAllowedTarget`, which resolves the host and refuses if
 *     any answer is a forbidden address (`isForbiddenAddress`: unspecified,
 *     link-local / cloud metadata, multicast and IPv4-mapped forms of those).
 *     The connection is then pinned to exactly those checked addresses, so a
 *     record that changes between the check and the connect (DNS rebinding)
 *     cannot redirect it.
 *
 * Private LAN, Tailscale and loopback addresses stay allowed, as they are for
 * units — a self-hosted ntfy on the LAN is the common case. What the dashboard
 * may reach is the maintainer's decision: change it in validate.js and alerts
 * follow, rather than growing a second policy here.
 */
import dns from "node:dns/promises";
import net from "node:net";
import { assertAllowedTarget, isAllowedTargetHost } from "../validate.js";

/** Refused by the policy. The message is fixed text: no host, address or URL. */
export class OutboundPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "OutboundPolicyError";
    this.status = 400;
  }
}

export const POLICY_BLOCKED = "blocked: the host resolves to an address the outbound policy does not allow";
export const POLICY_UNRESOLVED = "could not resolve the channel host";

/** URL hostname without IPv6 brackets. */
export function channelHost(url) {
  const host = url.hostname;
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Save-time check of a parsed URL: http(s) only, and a host the policy allows.
 * @returns {string|null} an error message, or null when allowed
 */
export function channelUrlProblem(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Channel URL must start with http:// or https://";
  const host = channelHost(url);
  if (!host) return "Channel URL needs a host";
  if (!isAllowedTargetHost(host)) return "Channel URL host is not allowed (same outbound policy as unit and LLM targets)";
  return null;
}

/**
 * Resolve the channel's host and apply the policy to every answer.
 * @param {URL} url
 * @param {{ lookup?: typeof dns.lookup }} [opts]
 * @returns {Promise<string[]>} the checked addresses
 */
export async function resolveChannelTarget(url, { lookup = dns.lookup } = {}) {
  const host = channelHost(url);
  if (!isAllowedTargetHost(host)) throw new OutboundPolicyError(POLICY_BLOCKED);
  try {
    return await assertAllowedTarget(host, [host], { lookup });
  } catch (err) {
    throw new OutboundPolicyError(err?.status === 403 ? POLICY_BLOCKED : POLICY_UNRESOLVED);
  }
}

/**
 * A `lookup` for the connection that answers with the addresses already
 * checked, never asking DNS again.
 * @param {string[]} addresses
 */
export function pinnedLookup(addresses) {
  const entries = addresses.map((address) => ({ address, family: net.isIP(address) || 4 }));
  return (_hostname, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    const all = typeof options === "object" && options?.all;
    if (all) cb(null, entries);
    else cb(null, entries[0].address, entries[0].family);
  };
}
