/**
 * Hermes dashboard/WebUI login for URL attaches.
 * Cookie cache is process-local. Never transcripts.
 */

const cookieCache = new Map();

export function resetHermesAuthCache() {
  cookieCache.clear();
}

export async function hermesAuthedGetter(origin, token, fetchResponse, username) {
  if (!token) {
    return async function getJson(url) {
      const res = await fetchResponse(url);
      return res.json();
    };
  }
  let cookie = "";
  try {
    cookie = await cookieFor(origin, token, fetchResponse, username);
  } catch (err) {
    if (!isMissingLoginEndpoint(err)) throw err;
  }
  if (!cookie) {
    return async function getJson(url) {
      const res = await fetchResponse(url, { token });
      return res.json();
    };
  }
  return async function getJson(url) {
    try {
      const res = await fetchResponse(url, { cookie });
      return res.json();
    } catch (err) {
      if (Number(err?.status) !== 401) throw err;
      cookieCache.delete(cookieCacheKey(origin, token, username));
      cookie = await cookieFor(origin, token, fetchResponse, username);
      const res = await fetchResponse(url, { cookie });
      return res.json();
    }
  };
}

function cookieCacheKey(origin, token, username) {
  return `${origin}\0${token}\0${username || ""}`;
}

function isMissingLoginEndpoint(err) {
  const status = Number(err?.status);
  return status === 404 || status === 405;
}

function isBearerFallbackStatus(err) {
  const status = Number(err?.status);
  return isMissingLoginEndpoint(err) || status === 401 || status === 403;
}

async function cookieFor(origin, token, fetchResponse, username) {
  const key = cookieCacheKey(origin, token, username);
  const cached = cookieCache.get(key);
  if (cached) return cached;
  const cookie = await loginHermes(origin, token, fetchResponse, username);
  if (cookie) cookieCache.set(key, cookie);
  return cookie;
}

async function loginHermes(origin, token, fetchResponse, username) {
  const provider = await discoverPasswordProvider(origin, fetchResponse);
  if (provider) {
    try {
      const res = await fetchResponse(`${origin}/auth/password-login`, {
        method: "POST",
        extraHeaders: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          username: String(username || "").trim() || "admin",
          password: token,
        }),
      });
      return sessionCookieFromResponse(res);
    } catch (err) {
      if (isMissingLoginEndpoint(err)) return "";
      throw err;
    }
  }
  try {
    const res = await fetchResponse(`${origin}/api/auth/login`, {
      method: "POST",
      extraHeaders: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: token }),
    });
    return sessionCookieFromResponse(res);
  } catch (err) {
    if (isMissingLoginEndpoint(err)) return "";
    throw err;
  }
}

async function discoverPasswordProvider(origin, fetchResponse) {
  try {
    const res = await fetchResponse(`${origin}/api/auth/providers`);
    const data = await res.json();
    const list = Array.isArray(data?.providers) ? data.providers : [];
    const found = list.find((item) => item && item.supports_password && item.name);
    return found ? String(found.name) : "";
  } catch (err) {
    if (isBearerFallbackStatus(err)) return "";
    throw err;
  }
}

function sessionCookieFromResponse(res) {
  const headers = res?.headers;
  if (!headers) return "";
  const rawList =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie")].filter(Boolean);
  const parts = [];
  for (const raw of rawList) {
    const first = String(raw).split(";", 1)[0].trim();
    const name = first.split("=", 1)[0].toLowerCase();
    if (name === "hermes_session" || name.startsWith("hermes_session_")) parts.push(first);
  }
  return parts.join("; ");
}
