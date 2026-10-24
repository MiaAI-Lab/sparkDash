import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import os from "node:os";
import { passkeyOnly, passkeyOrigin } from "./passkeys/settings.js";
import { sessionFor } from "./passkeys/session.js";
import { hasCredentials, passkeyStoreAvailable } from "./passkeys/store.js";

export function configuredToken() {
  const token = process.env.SPARKDASH_TOKEN || process.env.DASHBOARD_TOKEN || "";
  return token.trim();
}

/**
 * Passkey sign-in is on: an origin is configured, and a token exists to prove who
 * may enrol. Startup refuses an origin without a token (passkeys/preflight.js).
 */
export function passkeysEnabled() {
  return Boolean(passkeyOrigin()) && Boolean(configuredToken()) && passkeyStoreAvailable();
}

export function isLoopbackBind(host) {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

export function requireRemoteAuth(bindHost) {
  return !isLoopbackBind(bindHost);
}

/** Unset/empty/"1" allow a tokenless remote bind. Set "0" to fail closed. */
export function allowOpenRemote() {
  const v = process.env.SPARKDASH_ALLOW_OPEN_REMOTE;
  if (v == null || v === "") return true;
  return v === "1";
}

/** This machine's own name, without the `.local` macOS appends to it. */
const SELF_NAME = os.hostname().toLowerCase().replace(/\.local$/, "");
let tailscaleName = "";

/** This machine's Tailscale MagicDNS name (`Self.DNSName`), so Tailscale Serve needs no setup. */
export function setTailscaleName(dnsName) {
  tailscaleName = String(dnsName || "").toLowerCase().replace(/\.$/, "");
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Names that only reach this machine: neither a DNS-rebinding page nor another site can use them. */
function isOwnName(name) {
  if (name === "localhost" || name.endsWith(".localhost") || name === "[::1]") return true;
  if (isIP(name) === 4 && name.startsWith("127.")) return true;
  if (name === SELF_NAME || name === `${SELF_NAME}.local` || (tailscaleName && name === tailscaleName)) return true;
  // The passkey origin is, by configuration, how the operator's browser reaches us.
  const origin = passkeyOrigin();
  if (origin && new URL(origin).hostname === name) return true;
  const extra = (process.env.SPARKDASH_ALLOWED_HOSTS || "").split(",");
  return extra.some((h) => parseUrl(`http://${h.trim()}`)?.hostname === name);
}

/** A rebinding page has to use the attacker's own name, so any IP literal is a safe Host too. */
function isAllowedHost(name) {
  return isOwnName(name) || isIP(name.replace(/^\[(.*)\]$/, "$1")) !== 0;
}

/**
 * On a loopback bind, the name a browser request is refused for, or "" to let it through.
 * Origin must match the request's own Host (same-origin) or be one of our own names, for a
 * proxy that rewrites Host to 127.0.0.1. A request without Host or Origin is not a browser's.
 */
function refusedName(req) {
  if (requireRemoteAuth(process.env.BIND_HOST || "127.0.0.1")) return "";
  // Neither a rebinding page nor another site can know the token.
  if (configuredToken() && authenticate(req).ok) return "";
  const { host, origin } = req.headers || {};
  const hostUrl = host ? parseUrl(`http://${host}`) : null;
  if (host && !(hostUrl && isAllowedHost(hostUrl.hostname))) return hostUrl?.hostname || String(host).slice(0, 100);
  if (!origin) return "";
  const originUrl = parseUrl(origin);
  if (originUrl && (originUrl.host === hostUrl?.host || isOwnName(originUrl.hostname))) return "";
  return originUrl?.hostname || String(origin).slice(0, 100);
}

const refusedLoggedAt = new Map();

/** Name the refused host at most once an hour, so the operator sees exactly what to allow. */
function logRefused(name) {
  const now = Date.now();
  if (now - (refusedLoggedAt.get(name) ?? -Infinity) < 60 * 60 * 1000) return;
  if (refusedLoggedAt.size >= 100) refusedLoggedAt.clear();
  refusedLoggedAt.set(name, now);
  console.warn(
    `[sparkDash] refused a request for ${JSON.stringify(name)} on a loopback bind. If that is how you reach this dashboard, add it to SPARKDASH_ALLOWED_HOSTS.`
  );
}

function refuse(req, res, name) {
  logRefused(name);
  if (req.method === "GET" && /text\/html/.test(req.headers?.accept || "")) {
    const shown = name.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    return res
      .status(403)
      .type("html")
      .send(
        `<!doctype html><title>sparkDash: host not allowed</title><p>sparkDash does not answer to <b>${shown}</b>.</p>` +
          `<p>If that is how you reach this dashboard, such as a reverse proxy or a custom domain, add it to <code>SPARKDASH_ALLOWED_HOSTS</code> (comma-separated) and restart sparkDash.</p>`
      );
  }
  return res.status(403).json({ error: `sparkDash does not answer to ${name} (add it to SPARKDASH_ALLOWED_HOSTS if that is this dashboard's address)` });
}

export function tokensEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function extractBearer(req) {
  const header = req.headers?.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match) return match[1].trim();
  const query = req.query ? req.query.token : queryTokenFromUrl(req.url);
  return typeof query === "string" ? query.trim() : "";
}

/**
 * The WebSocket upgrade hands verifyClient a raw IncomingMessage — Express has
 * not parsed it, so there is no req.query. Read `?token=` from the URL itself,
 * or the browser's socket (which cannot set headers) is always refused.
 */
function queryTokenFromUrl(url) {
  if (typeof url !== "string" || !url.includes("?")) return "";
  try {
    return new URL(url, "http://localhost").searchParams.get("token") || "";
  } catch {
    return "";
  }
}

/**
 * SPARKDASH_PASSKEY_ONLY with at least one passkey enrolled: the token no longer
 * authenticates the dashboard. Prometheus' read of /metrics is the one exception
 * — a scraper cannot hold a passkey, and the exposition is read-only telemetry.
 * With nothing enrolled the token still works, so turning the flag on is never a
 * one-way door.
 */
export function tokenRefused(req) {
  if (!passkeysEnabled() || !passkeyOnly() || !hasCredentials()) return false;
  const method = (req.method || "GET").toUpperCase();
  return !((method === "GET" || method === "HEAD") && requestPath(req) === "/metrics");
}

function requestPath(req) {
  if (typeof req.path === "string") return req.path;
  try {
    return new URL(req.url || "/", "http://localhost").pathname;
  } catch {
    return "";
  }
}

/**
 * The cookie is ambient: a browser attaches it to a request some other page
 * triggered. SameSite=Strict already keeps it off cross-site requests; a
 * cookie-authenticated mutation or WebSocket must also name our origin, so a
 * same-site sibling cannot ride it either. The bearer path needs no such check.
 */
function crossOriginForCookie(req) {
  const method = (req.method || "GET").toUpperCase();
  const upgrade = String(req.headers?.upgrade || "").toLowerCase() === "websocket";
  const mutating = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  if (!mutating && !upgrade) return false;
  return req.headers?.origin !== passkeyOrigin();
}

/**
 * Who this request is. `keyAuthority` is true when it carries the token's
 * authority — the token itself, or a session the token established — which is
 * what enrolling and revoking passkeys require. A passkey session is
 * authenticated without it, so a stolen session cannot mint permanent access.
 */
export function authenticate(req) {
  const expected = configuredToken();
  if (!expected) return { ok: true, mode: "open-loopback", keyAuthority: false };
  const provided = extractBearer(req);
  const tokenMatches = Boolean(provided) && tokensEqual(provided, expected);
  if (tokenMatches && !tokenRefused(req)) return { ok: true, mode: "bearer", keyAuthority: true };
  const session = sessionFor(req);
  if (session) {
    if (crossOriginForCookie(req)) return { ok: false, status: 403, error: "Cross-origin request refused" };
    return { ok: true, mode: "session", session, keyAuthority: session.credentialId === null };
  }
  if (tokenMatches) {
    return { ok: false, status: 401, error: "Sign in with a passkey: SPARKDASH_PASSKEY_ONLY no longer accepts the access token" };
  }
  return { ok: false, status: 401, error: "Authentication required" };
}

/**
 * Loopback Host/Origin (DNS-rebinding) check on its own, for routes that must
 * answer before token auth (such as /api/auth/status).
 */
export function createHostGuardMiddleware() {
  return function hostGuard(req, res, next) {
    const refused = refusedName(req);
    if (refused) return refuse(req, res, refused);
    next();
  };
}

export function createAuthMiddleware() {
  return function authMiddleware(req, res, next) {
    const refused = refusedName(req);
    if (refused) return refuse(req, res, refused);
    const method = (req.method || "GET").toUpperCase();
    const mutating = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    const remote = requireRemoteAuth(process.env.BIND_HOST || "127.0.0.1");
    if (!mutating && !remote && !configuredToken()) return next();
    if (!mutating && !remote) return next();
    if (!mutating && remote && !configuredToken()) {
      if (allowOpenRemote()) return next();
      return res.status(403).json({ error: "Remote access requires SPARKDASH_TOKEN" });
    }
    // The built frontend must load before the app can ask for the token: the
    // SPA shell and its hashed assets carry no secrets, so on a tokened remote
    // bind they answer without auth (the loopback bind already serves every
    // GET open). API routes and the WebSocket stay gated; the app then
    // authenticates its own calls with the stored token (src/api/authToken.ts)
    // or its passkey session cookie.
    if (!mutating && !/^\/(api|ws|metrics)(\/|$)/.test(req.path || "")) return next();
    const result = authenticate(req);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    next();
  };
}

/**
 * What the UI needs to know before it asks for credentials, and nothing more.
 * `tokenRequired` is true exactly when a configured token gates the WebSocket
 * upgrade and mutations (authorizeUpgrade / createAuthMiddleware both fall
 * through to authenticate(), which only checks once a token is set).
 * `authenticated` says whether this request's credentials would pass.
 * `passkeys` reports the configured posture only — never whether anything is
 * enrolled, which would tell a caller when a takeover attempt is worth making.
 * The token itself is never part of the response.
 */
export function authStatus(req) {
  const tokenRequired = Boolean(configuredToken());
  const result = authenticate(req);
  if (!passkeysEnabled()) return { tokenRequired, authenticated: result.ok, passkeys: { enabled: false }, session: null };
  const session = sessionFor(req);
  return {
    tokenRequired,
    authenticated: result.ok,
    passkeys: { enabled: true, passkeyOnly: passkeyOnly() },
    session: session ? { method: session.credentialId ? "passkey" : "token", canManage: session.credentialId === null } : null,
  };
}

export function authorizeUpgrade(req) {
  const refused = refusedName(req);
  if (refused) {
    logRefused(refused);
    return false;
  }
  const remote = requireRemoteAuth(process.env.BIND_HOST || "127.0.0.1");
  if (!remote && !configuredToken()) return true;
  return authenticate(req).ok;
}
