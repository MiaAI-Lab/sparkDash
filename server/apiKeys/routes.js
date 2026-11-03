// API Keys (opt-in, Settings → API Keys). READ-ONLY views of LiteLLM virtual keys, served
// through a host-side bridge on a unix socket. See README "API Keys" for the bridge protocol.
//
// - Off by default (settings.apiKeysEnabled). While off every route below answers 404.
// - The bridge socket path and token come from the environment
//   (SPARKDASH_APIKEYS_BRIDGE_SOCKET, SPARKDASH_APIKEYS_BRIDGE_TOKEN), read once at startup;
//   neither is ever written to settings.json.
// - Only GET calls in BRIDGE_CALLS are made. No create/delete/limit/block call exists here.
// - A token the bridge rejects (401/403) starts a backoff: no bridge call is made until it ends,
//   30 s doubling per consecutive rejection up to 15 min; a successful call resets it.
// - No audit log is kept: nothing here changes state.
import { bridgeGet, KEY_ID_RE } from "./bridgeClient.js";
import { normalizeHealth, normalizeKey, normalizeKeyList } from "./normalize.js";

export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 15 * 60_000;

/** Backoff after `n` consecutive token rejections (n >= 1). */
export function backoffMs(n) {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, n - 1));
}

export function createApiKeysService({ socketPath, token, timeoutMs = 10_000, now = Date.now, get = bridgeGet } = {}) {
  let rejections = 0;
  let blockedUntil = 0;
  const configured = Boolean(socketPath && token);

  async function call(path) {
    if (!configured) return { ok: false, status: 503, error: "API keys bridge is not configured" };
    const t = now();
    if (t < blockedUntil) {
      return { ok: false, status: 503, error: "The bridge rejected the token; waiting before retrying", retryAfterSec: Math.ceil((blockedUntil - t) / 1000) };
    }
    const out = await get({ socketPath, path, token, timeoutMs });
    if (out.status === 401 || out.status === 403) {
      rejections += 1;
      blockedUntil = now() + backoffMs(rejections);
      console.warn(`[apiKeys] bridge rejected the token (${rejections} in a row); next attempt in ${Math.round(backoffMs(rejections) / 1000)} s`);
      return { ok: false, status: 503, error: "The bridge rejected the token; waiting before retrying", retryAfterSec: Math.ceil(backoffMs(rejections) / 1000) };
    }
    if (out.status === 429) {
      const ra = Number(out.retryAfter);
      const sec = Number.isFinite(ra) && ra > 0 ? Math.min(ra, BACKOFF_MAX_MS / 1000) : BACKOFF_BASE_MS / 1000;
      blockedUntil = now() + sec * 1000;
      return { ok: false, status: 503, error: "The bridge is rate limiting; waiting before retrying", retryAfterSec: Math.ceil(sec) };
    }
    if (out.status === 0) return { ok: false, status: 503, error: out.error || "bridge unavailable" };
    rejections = 0;
    blockedUntil = 0;
    if (out.status === 404) return { ok: false, status: 404, error: "not found" };
    if (out.status !== 200) return { ok: false, status: 502, error: `bridge answered HTTP ${out.status}` };
    return { ok: true, json: out.json };
  }

  return {
    configured,
    state: () => ({ rejections, blockedUntil }),
    async health() {
      const r = await call("/v1/health");
      if (!r.ok) return { ok: true, json: { configured, bridge: configured ? "down" : "unconfigured", upstream: "unknown", error: r.error, retryAfterSec: r.retryAfterSec ?? null } };
      return { ok: true, json: { configured, ...normalizeHealth(r.json), error: null, retryAfterSec: null } };
    },
    async list() {
      const r = await call("/v1/keys");
      if (!r.ok) return r;
      const keys = normalizeKeyList(r.json);
      if (!keys) return { ok: false, status: 502, error: "bridge sent an unexpected key list" };
      return { ok: true, json: { keys } };
    },
    async info(id) {
      const r = await call(`/v1/keys/${id}`);
      if (!r.ok) return r;
      const key = normalizeKey(r.json?.key);
      if (!key || key.id !== id) return { ok: false, status: 502, error: "bridge sent an unexpected key record" };
      return { ok: true, json: { key } };
    },
  };
}

/**
 * Register /api/apikeys/*. Routes sit behind the dashboard's normal auth middleware; when
 * settings.apiKeysEnabled is false they answer 404 so the feature is invisible.
 */
export function registerApiKeysRoutes(app, opts = {}) {
  const env = opts.env ?? process.env;
  const getSettings = opts.getSettings ?? (() => ({}));
  const service =
    opts.service ??
    createApiKeysService({
      socketPath: (env.SPARKDASH_APIKEYS_BRIDGE_SOCKET || "").trim(),
      token: (env.SPARKDASH_APIKEYS_BRIDGE_TOKEN || "").trim(),
    });
  const allow = typeof opts.allow === "function" ? opts.allow : () => true;
  const keyOf = typeof opts.principalKey === "function" ? opts.principalKey : () => "all";
  const limited = typeof opts.rejectLimited === "function" ? opts.rejectLimited : (res, msg) => res.status(429).json({ error: msg });

  const send = (res, r) => {
    res.set("Cache-Control", "no-store");
    if (r.retryAfterSec) res.set("Retry-After", String(r.retryAfterSec));
    if (r.ok) return res.json(r.json);
    return res.status(r.status).json({ error: r.error, retryAfterSec: r.retryAfterSec ?? null });
  };
  const gate = (req, res, next) => {
    if (!getSettings().apiKeysEnabled) return res.status(404).json({ error: "not found" });
    if (!allow(keyOf(req))) return limited(res, "Too many API key requests; try again shortly");
    next();
  };

  app.get("/api/apikeys/status", gate, async (_req, res) => send(res, await service.health()));
  app.get("/api/apikeys/keys", gate, async (_req, res) => send(res, await service.list()));
  app.get("/api/apikeys/keys/:id", gate, async (req, res) => {
    if (!KEY_ID_RE.test(req.params.id)) return res.status(404).json({ error: "not found" });
    send(res, await service.info(req.params.id));
  });
  return service;
}
