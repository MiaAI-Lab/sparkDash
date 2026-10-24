/**
 * Passkey sign-in settings, read live from the environment.
 *
 * Compose passes every setting as `NAME=${NAME:-}` — present and empty — so each
 * reader treats an empty value exactly like an absent one. `process.env.X ?? d`
 * would never reach the default there.
 */
import { isIP } from "node:net";

export const ORIGIN_VAR = "SPARKDASH_PASSKEY_ORIGIN";

/** A ceremony's challenge lives this long; the browser's own timeout is shorter. */
export const CHALLENGE_TTL_MS = 2 * 60 * 1000;
/** Failed passkey sign-ins allowed in one window before each further one is delayed. */
export const LOGIN_ATTEMPT_LIMIT = 10;
export const LOGIN_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
/** Longest a throttled sign-in waits before it is still processed. */
export const MAX_LOGIN_BACKOFF_MS = 10_000;

const DEFAULT_SESSION_TTL_DAYS = 30;

export class PasskeyConfigError extends Error {}

function env(name) {
  return (process.env[name] || "").trim();
}

/**
 * The browser-facing origin ceremonies are verified against, or "" when passkey
 * sign-in is off. Never derived from a request header: a credential is bound to
 * the relying party it was created under, so a header-derived value would let a
 * request choose which identity it authenticates against.
 *
 * Throws on a value that cannot work rather than degrading to "off": silently
 * ignoring it would verify against the wrong origin or arm a ceremony no browser
 * will run.
 */
export function passkeyOrigin() {
  const raw = env(ORIGIN_VAR);
  if (!raw) return "";
  const refuse = (why) =>
    new PasskeyConfigError(
      `${ORIGIN_VAR} is not a usable passkey origin: ${why}. Set it to the origin the browser shows — ` +
        `e.g. https://spark.example.ts.net or http://localhost:5555 — or unset it to serve without passkey sign-in.`
    );
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw refuse("it is not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw refuse("the scheme must be http or https");
  if (url.username || url.password || url.search || url.hash) throw refuse("an origin carries no credentials, query or fragment");
  if (url.pathname !== "/") throw refuse("an origin carries no path");
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const loopbackIp = host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
  if (loopbackIp) throw refuse(`use http://localhost for loopback access, not ${host} — a passkey cannot be bound to an IP address`);
  if (isIP(host) !== 0) throw refuse("a passkey cannot be bound to an IP address, only to a hostname");
  // navigator.credentials exists only in a secure context, so a plaintext remote
  // origin would render a sign-in whose ceremony can never start.
  if (url.protocol === "http:" && host !== "localhost") {
    throw refuse(
      `http://${host} is not a secure context, so no browser will run a passkey ceremony on it — front sparkDash ` +
        `with TLS (Tailscale Serve is the least work) or use http://localhost for local access`
    );
  }
  return url.origin;
}

/** The relying-party identifier: the origin's hostname. */
export function passkeyRpId() {
  const origin = passkeyOrigin();
  return origin ? new URL(origin).hostname : "";
}

/** SPARKDASH_PASSKEY_ONLY=1: once a passkey is enrolled, the token no longer signs a browser in. */
export function passkeyOnly() {
  return ["1", "true"].includes(env("SPARKDASH_PASSKEY_ONLY").toLowerCase());
}

/** Fixed session lifetime from sign-in; presenting a session never extends it. */
export function sessionTtlMs() {
  const days = Number.parseInt(env("SPARKDASH_SESSION_TTL_DAYS"), 10);
  const bounded = Number.isInteger(days) && days >= 1 ? Math.min(days, 365) : DEFAULT_SESSION_TTL_DAYS;
  return bounded * 24 * 60 * 60 * 1000;
}
