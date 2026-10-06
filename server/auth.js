import { timingSafeEqual } from "node:crypto";

export function configuredToken() {
  const token = process.env.SPARKDASH_TOKEN || process.env.DASHBOARD_TOKEN || "";
  return token.trim();
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

function tokensEqual(left, right) {
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

export function authenticate(req) {
  const expected = configuredToken();
  if (!expected) return { ok: true, mode: "open-loopback" };
  const provided = extractBearer(req);
  if (!provided || !tokensEqual(provided, expected)) {
    return { ok: false, status: 401, error: "Authentication required" };
  }
  return { ok: true, mode: "bearer" };
}

export function createAuthMiddleware() {
  return function authMiddleware(req, res, next) {
    const method = (req.method || "GET").toUpperCase();
    const mutating = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    const remote = requireRemoteAuth(process.env.BIND_HOST || "127.0.0.1");
    if (!mutating && !remote && !configuredToken()) return next();
    if (!mutating && !remote) return next();
    if (!mutating && remote && !configuredToken()) {
      if (allowOpenRemote()) return next();
      return res.status(403).json({ error: "Remote access requires SPARKDASH_TOKEN" });
    }
    const result = authenticate(req);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    next();
  };
}

/**
 * What the UI needs to know before it asks for a token, and nothing more.
 * `tokenRequired` is true exactly when a configured token gates the WebSocket
 * upgrade and mutations (authorizeUpgrade / createAuthMiddleware both fall
 * through to authenticate(), which only checks once a token is set).
 * `authenticated` says whether this request's bearer/`?token=` would pass.
 * The token itself is never part of the response.
 */
export function authStatus(req) {
  const tokenRequired = Boolean(configuredToken());
  return { tokenRequired, authenticated: authenticate(req).ok };
}

export function authorizeUpgrade(req) {
  const remote = requireRemoteAuth(process.env.BIND_HOST || "127.0.0.1");
  if (!remote && !configuredToken()) return true;
  return authenticate(req).ok;
}
