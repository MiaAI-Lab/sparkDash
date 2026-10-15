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
  try {
    const origins = readProfiles ? loadProviderOrigins(profileDir) : new Map();
    const items = await fetchSessionList(fetchFn, parsed);
    const active = items.filter((item) => item && item.blank !== true).slice(0, MAX_SESSIONS);
    const rows = [];
    for (const item of active) {
      const models = await fetchSessionModels(fetchFn, parsed, item.sessionId);
      rows.push(mapDshSession(item, models, origins));
    }
    return { coverage: "supported", stale: false, error: null, rows: rows.filter(Boolean) };
  } catch (err) {
    return { coverage: "unavailable", stale: false, error: err.message || "DSH web API not reachable", rows: [] };
  }
}

async function fetchSessionList(fetchFn, webUrl) {
  const body = await rpc(fetchFn, webUrl, "session.list", { cursor: "" });
  const items = body?.value?.items;
  if (!Array.isArray(items)) throw new Error("session.list returned no items");
  return items;
}

async function fetchSessionModels(fetchFn, webUrl, sessionId) {
  try {
    const body = await rpc(fetchFn, webUrl, "session.models", { sessionId });
    const current = body?.value?.current;
    return {
      provider: typeof current?.provider === "string" ? current.provider : "",
      model: typeof current?.model === "string" ? current.model : "",
    };
  } catch {
    return { provider: "", model: "" };
  }
}

async function rpc(fetchFn, webUrl, method, payload) {
  const res = await fetchFn(`${webUrl.origin}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: `occupancy-${method}`, method, payload }),
  });
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const body = await res.json();
  if (!body?.result?.ok) throw new Error(`${method} failed`);
  return body.result;
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
