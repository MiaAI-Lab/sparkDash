import http from "node:http";
import net from "node:net";
import {
  clearCookie,
  createSignedValue,
  isAllowedEmail,
  normalizeAllowlist,
  parseCookies,
  randomToken,
  readSignedValue,
  renderDenied,
  renderLogin,
  safeReturnPath,
  secureCookie,
  sessionFromRequest,
} from "./public-auth.mjs";

const upstreamHost = process.env.SPARKDASH_UPSTREAM_HOST || "127.0.0.1";
const upstreamPort = Number(process.env.SPARKDASH_UPSTREAM_PORT || 5555);
const listenPort = Number(process.env.SPARKDASH_PUBLIC_PORT || 5556);
const publicOrigin = (process.env.SPARKDASH_PUBLIC_ORIGIN || "").replace(/\/$/, "");
const clientId = process.env.GOOGLE_CLIENT_ID || "";
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
const sessionSecret = process.env.SPARKDASH_SESSION_SECRET || "";
const allowedEmails = normalizeAllowlist(process.env.SPARKDASH_ALLOWED_EMAILS);
const configured = publicOrigin && clientId && clientSecret && sessionSecret.length >= 32 && allowedEmails.size > 0;

function html(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(body);
}

function redirect(res, location, cookies = []) {
  res.writeHead(302, { location, "cache-control": "no-store", ...(cookies.length ? { "set-cookie": cookies } : {}) });
  res.end();
}

function proxyHttp(req, res) {
  const method = req.method || "GET";
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { "content-type": "application/json", allow: "GET, HEAD" });
    return res.end(JSON.stringify({ error: "Public dashboard is read-only" }));
  }
  const proxy = http.request({ host: upstreamHost, port: upstreamPort, method, path: req.url,
    headers: { ...req.headers, host: `${upstreamHost}:${upstreamPort}` } }, (upstream) => {
    res.writeHead(upstream.statusCode || 502, upstream.headers);
    upstream.pipe(res);
  });
  proxy.on("error", () => { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "Dashboard unavailable" })); });
  req.pipe(proxy);
}

async function googleCallback(req, res, url) {
  const cookies = parseCookies(req.headers.cookie);
  const state = readSignedValue(cookies.sparkdash_oauth, sessionSecret);
  if (!state || state.state !== url.searchParams.get("state") || state.exp < Date.now() / 1000) {
    return html(res, 400, renderLogin("The sign-in request expired. Please try again."));
  }
  const code = url.searchParams.get("code");
  if (!code) return html(res, 400, renderLogin("Google did not return an authorization code."));
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: `${publicOrigin}/auth/callback`, grant_type: "authorization_code" }),
  });
  if (!tokenResponse.ok) return html(res, 502, renderLogin("Google sign-in failed. Please try again."));
  const tokens = await tokenResponse.json();
  const infoResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  if (!infoResponse.ok) return html(res, 502, renderLogin("Google identity verification failed."));
  const profile = await infoResponse.json();
  if (profile.email_verified !== true || !isAllowedEmail(profile.email, allowedEmails)) {
    return html(res, 403, renderDenied(profile.email), { "set-cookie": clearCookie("sparkdash_oauth") });
  }
  const session = createSignedValue({ email: profile.email.toLowerCase(), exp: Math.floor(Date.now() / 1000) + 28800 }, sessionSecret);
  redirect(res, safeReturnPath(state.returnTo), [secureCookie("sparkdash_session", session, 28800), clearCookie("sparkdash_oauth")]);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", publicOrigin || "http://localhost");
  if (!configured) return html(res, 503, renderLogin("Google SSO is not configured yet."));
  if (url.pathname === "/auth/login") {
    const state = randomToken();
    const signed = createSignedValue({ state, returnTo: safeReturnPath(url.searchParams.get("returnTo") || req.headers.referer?.replace(publicOrigin, "") || "/"), exp: Math.floor(Date.now() / 1000) + 600 }, sessionSecret);
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.search = new URLSearchParams({ client_id: clientId, redirect_uri: `${publicOrigin}/auth/callback`, response_type: "code", scope: "openid email", state, prompt: "select_account" });
    return redirect(res, auth.toString(), [secureCookie("sparkdash_oauth", signed, 600)]);
  }
  if (url.pathname === "/auth/callback") {
    try { return await googleCallback(req, res, url); }
    catch { return html(res, 502, renderLogin("Google sign-in could not be completed.")); }
  }
  if (url.pathname === "/auth/logout") return redirect(res, "/", [clearCookie("sparkdash_session")]);
  const session = sessionFromRequest(req, sessionSecret);
  if (!session || !isAllowedEmail(session.email, allowedEmails)) return html(res, 401, renderLogin());
  proxyHttp(req, res);
});

server.on("upgrade", (req, socket, head) => {
  if (!configured || req.url !== "/ws" || !sessionFromRequest(req, sessionSecret)) return socket.destroy();
  const upstream = net.connect(upstreamPort, upstreamHost, () => {
    let headers = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (const [name, value] of Object.entries(req.headers)) if (name.toLowerCase() !== "host") headers += `${name}: ${value}\r\n`;
    headers += `host: ${upstreamHost}:${upstreamPort}\r\n\r\n`;
    upstream.write(headers); if (head.length) upstream.write(head); socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
});

server.listen(listenPort, "127.0.0.1", () => console.log(`sparkDash Google SSO read-only proxy on http://127.0.0.1:${listenPort}`));
