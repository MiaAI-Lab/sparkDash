import crypto from "node:crypto";

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function createSignedValue(value, secret) {
  const payload = b64url(JSON.stringify(value));
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function readSignedValue(token, secret) {
  if (!token || typeof token !== "string") return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  let actual;
  try { actual = Buffer.from(signature, "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
}

export function normalizeAllowlist(value) {
  return new Set(String(value || "").split(/[\s,]+/).map((email) => email.trim().toLowerCase()).filter(Boolean));
}

export function isAllowedEmail(email, allowed) {
  return typeof email === "string" && allowed.has(email.trim().toLowerCase());
}

export function safeReturnPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

export function parseCookies(value) {
  const result = {};
  for (const pair of String(value || "").split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    result[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim());
  }
  return result;
}

export function secureCookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function sessionFromRequest(req, secret, now = Math.floor(Date.now() / 1000)) {
  const token = parseCookies(req.headers.cookie).sparkdash_session;
  const session = readSignedValue(token, secret);
  return session && session.exp > now && typeof session.email === "string" ? session : null;
}

export function renderLogin(message = "Sign in with an approved Google account to view sparkDash.") {
  const escaped = message.replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>sparkDash sign in</title><style>body{margin:0;background:#090b10;color:#eef2ff;font:16px system-ui;display:grid;place-items:center;min-height:100vh}.card{width:min(420px,85vw);padding:32px;border:1px solid #293044;border-radius:16px;background:#111520}h1{margin:0 0 12px}p{color:#9ba7bd;line-height:1.5}a{display:block;text-align:center;margin-top:24px;padding:12px;border-radius:9px;background:#6d5dfc;color:white;text-decoration:none;font-weight:650}</style></head><body><main class="card"><h1>spark<span style="color:#8b7cff">Dash</span></h1><p>${escaped}</p><a href="/auth/login">Continue with Google</a></main></body></html>`;
}

export function renderDenied(email) {
  return renderLogin(`${email || "This Google account"} is not on the approved viewer list.`);
}
