/**
 * Input validation for Spark targets (host / user / lanIp).
 * Keeps SSRF-ish footguns smaller on an otherwise unauthenticated LAN dashboard.
 */

/** IPv4 dotted quad with each octet 0–255. */
export function isValidIPv4(host) {
  if (typeof host !== "string") return false;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((o) => {
    const n = Number(o);
    return n >= 0 && n <= 255 && String(n) === String(Number(o));
  });
}

/** DNS hostname (no spaces/shell metacharacters). */
export function isValidHostname(host) {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) return false;
  if (host === "localhost") return true;
  return /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$/.test(
    host
  );
}

/** Accept IPv4 or hostname for SSH / LLM targets. */
export function isValidHost(host) {
  return isValidIPv4(host) || isValidHostname(host);
}

/**
 * Classify a probe target for security-posture hints.
 * Uses the configured host only — not the process bind address.
 * Hostnames (except localhost) are "unknown" (no DNS lookup).
 *
 * @returns {"local" | "lan" | "public" | "unknown"}
 */
export function classifyHostScope(host) {
  if (typeof host !== "string" || !host.trim()) return "unknown";
  const h = host.trim().toLowerCase();
  if (h === "localhost" || h === "::1") return "local";
  if (!isValidIPv4(h)) return "unknown";
  const [a, b] = h.split(".").map(Number);
  if (a === 127) return "local";
  if (a === 10) return "lan";
  if (a === 172 && b >= 16 && b <= 31) return "lan";
  if (a === 192 && b === 168) return "lan";
  if (a === 169 && b === 254) return "lan";
  if (a === 0 || a >= 224) return "unknown";
  return "public";
}

/**
 * Block cloud metadata / link-local misuse. Allow private, loopback, and public
 * (remote Sparks may be anywhere on a managed network).
 */
export function isAllowedTargetHost(host) {
  if (!isValidHost(host)) return false;
  if (!isValidIPv4(host)) return true;
  const [a, b] = host.split(".").map(Number);
  // link-local / APIPA (includes 169.254.169.254 metadata)
  if (a === 169 && b === 254) return false;
  // unspecified
  if (a === 0) return false;
  // multicast / reserved
  if (a >= 224) return false;
  return true;
}

/** OpenSSH-safe username. */
export function isValidSshUser(user) {
  return typeof user === "string" && /^[a-zA-Z0-9._-]{1,64}$/.test(user);
}

/**
 * Reserved Spark ids that must never be accepted from an API client.
 * Matches the frontend `OVERVIEW_ID` constant (kept in sync manually — it is
 * a single value and duplicated across the boundary on purpose).
 */
export const RESERVED_SPARK_IDS = Object.freeze(new Set(["__overview__"]));

/**
 * Validate a client-supplied Spark id. Same character class as the SSH user
 * regex (no path traversal, no shell metacharacters), 1–64 chars, and not a
 * reserved id. The registry stores the id as a JSON key (no path-injection),
 * but rejecting early avoids accidental collisions with reserved tab ids.
 */
export function isValidSparkId(id) {
  if (typeof id !== "string") return false;
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(id)) return false;
  if (RESERVED_SPARK_IDS.has(id)) return false;
  return true;
}

/**
 * Validate fields used for SSH/LLM probes. Returns null if ok, else error message.
 * @param {{ lanIp?: string, ssh?: { host?: string, user?: string } }} body
 */
export function validateSparkTarget(body) {
  const lanIp = body?.lanIp || "";
  const sshHost = body?.ssh?.host || "";
  const target = sshHost || lanIp;
  if (!target) return "lanIp or ssh.host is required";
  if (!isAllowedTargetHost(target)) {
    return `Invalid or disallowed host: ${target}`;
  }
  if (lanIp && !isAllowedTargetHost(lanIp)) {
    return `Invalid or disallowed lanIp: ${lanIp}`;
  }
  const user = body?.ssh?.user;
  if (user != null && user !== "" && !isValidSshUser(user)) {
    return "Invalid SSH user (allowed: letters, digits, . _ -)";
  }
  return null;
}

/**
 * Simple per-IP sliding window rate limiter for sensitive routes.
 * @param {number} maxRequests
 * @param {number} windowMs
 */
export function createRateLimiter(maxRequests, windowMs) {
  /** @type {Map<string, number[]>} */
  const hits = new Map();

  return function rateLimit(key) {
    const now = Date.now();
    let times = hits.get(key) || [];
    times = times.filter((t) => now - t < windowMs);
    if (times.length >= maxRequests) {
      hits.set(key, times);
      return false;
    }
    times.push(now);
    hits.set(key, times);
    return true;
  };
}
