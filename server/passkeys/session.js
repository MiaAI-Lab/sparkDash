/**
 * The browser side of a session: an opaque token in an HttpOnly, SameSite=Strict
 * cookie, Secure (and `__Host-` prefixed) on an https origin. Validity is decided
 * by server-side state alone (store.findSession), so signing out or revoking a
 * passkey ends the session immediately.
 */
import * as store from "./store.js";
import { passkeyOrigin } from "./settings.js";

function cookieName(origin = passkeyOrigin()) {
  // __Host- binds the cookie to exactly this host, path / and Secure. It cannot
  // be used on the http://localhost origin, where Secure cookies are not stored
  // by every browser.
  return origin.startsWith("https:") ? "__Host-sparkdash_session" : "sparkdash_session";
}

/** The session token a request carries, or "". */
export function sessionToken(req) {
  const header = req.headers?.cookie;
  if (typeof header !== "string" || !header) return "";
  const name = cookieName();
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

/** The live session a request carries, or null. Never touches the store when passkeys are off. */
export function sessionFor(req) {
  if (!passkeyOrigin()) return null;
  const token = sessionToken(req);
  return token ? store.findSession(token) : null;
}

function cookie(value, maxAgeSeconds) {
  const origin = passkeyOrigin();
  const secure = origin.startsWith("https:") ? "; Secure" : "";
  return `${cookieName(origin)}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Strict${secure}`;
}

/** Cookie lifetime mirrors the server's fixed expiry exactly. */
export function setSessionCookie(res, { token, expiresAt }) {
  res.append("Set-Cookie", cookie(token, Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))));
}

export function clearSessionCookie(res) {
  res.append("Set-Cookie", cookie("", 0));
}
