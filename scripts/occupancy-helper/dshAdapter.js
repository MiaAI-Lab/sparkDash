import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_SESSIONS = 100;

/**
 * Read-only DeepSeek Harness web adapter. Lists sessions and optional model
 * metadata. A failed call is unavailable, not a healthy empty list.
 */
export async function loadDsh({
  webUrl = "http://127.0.0.1:3080",
  profileDir = path.join(os.homedir(), ".dsh", "profiles"),
  fetchFn = fetch,
  readProfiles = true,
  timeoutMs = 8_000,
  maxBytes = 1_000_000,
  token = "",
  signal,
} = {}) {
  let parsed;
  try {
    parsed = new URL(webUrl);
  } catch {
    return { coverage: "unavailable", stale: false, error: "DSH_WEB_URL is invalid", rows: [] };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { coverage: "unavailable", stale: false, error: "DSH_WEB_URL must be http or https", rows: [] };
  }
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("DSH refresh cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error("DSH refresh timed out")), timeoutMs);
  const rpcOptions = { signal: controller.signal, maxBytes, token: String(token || ""), cookie: "" };
  try {
    const origins = readProfiles ? loadProviderOrigins(profileDir) : new Map();
    const items = await fetchSessionList(fetchFn, parsed, rpcOptions);
    const active = items.filter((item) => item && item.blank !== true).slice(0, MAX_SESSIONS);
    const rows = [];
    let modelsOk = true;
    for (const item of active) {
      // Newer DSH builds have no session/models endpoint: stop asking after one miss.
      const models = modelsOk
        ? await fetchSessionModels(fetchFn, parsed, item.sessionId, rpcOptions)
        : { provider: "", model: "" };
      if (modelsOk && !models.model) modelsOk = false;
      rows.push(mapDshSession(item, models, origins));
    }
    return { coverage: "supported", stale: false, error: null, rows: rows.filter(Boolean) };
  } catch (err) {
    return { coverage: "unavailable", stale: false, error: err.message || "DSH web API not reachable", rows: [] };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function fetchSessionList(fetchFn, webUrl, options) {
  const body = await rpc(fetchFn, webUrl, "session/list", { args: { _request: { cursor: "" } } }, options);
  const items = body?.value?.items;
  if (!Array.isArray(items)) throw new Error("session/list returned no items");
  return items;
}

async function fetchSessionModels(fetchFn, webUrl, sessionId, options) {
  try {
    const body = await rpc(fetchFn, webUrl, "session/models", { args: { _request: { sessionId } } }, options);
    const current = body?.value?.current;
    return {
      provider: typeof current?.provider === "string" ? current.provider : "",
      model: typeof current?.model === "string" ? current.model : "",
    };
  } catch (err) {
    if (options.signal.aborted) throw err;
    return { provider: "", model: "" };
  }
}

// DSH web gates /api behind a cookie it hands out for its launch token
// (GET /?token=...). Exchange once per refresh, only when a token is set.
async function authCookie(fetchFn, webUrl, token, signal) {
  const res = await fetchFn(`${webUrl.origin}/?token=${encodeURIComponent(token)}`, { redirect: "manual", signal });
  void res.body?.cancel().catch(() => {});
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const pair = raw.map((line) => String(line).split(";", 1)[0]).find((line) => line.startsWith("dsh-auth-"));
  if (!pair) throw new Error("DSH web token was not accepted");
  return pair;
}

async function rpc(fetchFn, webUrl, method, payload, options) {
  const { signal } = options;
  if (options.token && !options.cookie) options.cookie = await authCookie(fetchFn, webUrl, options.token, signal);
  return rpcOnce(fetchFn, webUrl, method, payload, options);
}

async function rpcOnce(fetchFn, webUrl, method, payload, { signal, maxBytes, cookie }) {
  let reader;
  let rejectCancelled;
  const onAbort = () => rejectCancelled(signal.reason);
  const cancelled = new Promise((_, reject) => {
    rejectCancelled = reject;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    if (signal.aborted) throw signal.reason;
    const work = (async () => {
      const res = await fetchFn(`${webUrl.origin}/api/${method}`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", accept: "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ type: "client-request", rpcId: `occupancy-${method}`, method, payload }),
      });
      if (signal.aborted) { void res.body?.cancel().catch(() => {}); throw signal.reason; }
      if (!res.ok) { void res.body?.cancel().catch(() => {}); throw new Error(`${method} HTTP ${res.status}`); }
      if (!res.body?.getReader) throw new Error(`${method} response has no readable body`);
      reader = res.body.getReader();
      const chunks = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new Error(`${method} response exceeded size cap`);
        chunks.push(Buffer.from(value));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body?.result?.ok) throw new Error(`${method} failed`);
      return body.result;
    })();
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    // Cancellation must not wait for an uncooperative stream source.
    void reader?.cancel().catch(() => {});
  }
}

export function mapDshSession(item, models, origins) {
  const sessionId = String(item?.sessionId || "").trim();
  if (!sessionId) return null;
  const title = typeof item?.projections?.values?.title === "string" ? item.projections.values.title.trim() : "";
  const running = item.running === true;
  const origin = models?.provider ? origins.get(models.provider) : null;
  const pressure = item?.projections?.values?.contextPressure;
  const row = {
    harness: "dsh",
    sessionId,
    title: title || `dsh-${sessionId.slice(0, 8)}`,
    cwd: "",
    updatedAt: numberTime(item.updatedAt),
    activity: running ? "generating" : "unknown",
    activityProvenance: running ? "native" : "none",
    origin: origin ? { host: origin.host, port: origin.port } : null,
    originProvenance: origin ? "native" : "none",
    agent: models?.provider && models?.model ? `${models.provider}/${models.model}` : "",
  };
  if (Number.isFinite(Number(pressure?.pressureTokens)) && Number(pressure.pressureTokens) > 0) {
    row.contextUsed = Math.round(Number(pressure.pressureTokens));
  }
  if (Number.isFinite(Number(pressure?.contextWindow)) && Number(pressure.contextWindow) > 0) {
    row.contextWindow = Math.round(Number(pressure.contextWindow));
  }
  return row;
}

function numberTime(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n > 1e12 ? n : n * 1000).toISOString();
}

export function loadProviderOrigins(profileDir) {
  const origins = new Map();
  let names = [];
  try {
    names = fs.readdirSync(profileDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return origins;
  }
  for (const name of names) {
    try {
      parseProviderBaseUrls(fs.readFileSync(path.join(profileDir, name, "cordis.patch.yml"), "utf8"), origins);
    } catch {
      /* profile without a patch file */
    }
  }
  return origins;
}

export function parseProviderBaseUrls(text, origins) {
  const lines = String(text || "").split("\n");
  let inProviders = false;
  let current = null;
  let indentOf = 0;
  for (const line of lines) {
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^providers:\s*$/.test(trimmed)) {
      inProviders = true;
      current = null;
      continue;
    }
    if (!inProviders) continue;
    if (current && indent <= indentOf && trimmed.endsWith(":")) current = null;
    const provider = trimmed.match(/^([\w.-]+):\s*$/);
    if (provider && !current) {
      current = provider[1];
      indentOf = indent;
      continue;
    }
    const url = trimmed.match(/^baseURL:\s*["']?(https?:\/\/[^"'\s]+)/);
    if (current && url) {
      try {
        const parsed = new URL(url[1]);
        const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
        if (parsed.hostname && Number.isInteger(port)) origins.set(current, { host: parsed.hostname, port });
      } catch {
        /* skip */
      }
    }
  }
}
