/**
 * DeepSeek Harness (dsh) occupancy helper for sparkDash URL attach.
 * GET /occupancy → { found, rows } of projector-input fields only.
 *
 * Polls the dsh web JSON-RPC API (POST /api/session.list + session.models)
 * and maps sessions to projector-input rows. dsh web must be running.
 *
 * Provider-to-origin mapping reads ~/.dsh/profiles/ <profile> /cordis.patch.yml to
 * extract baseURL per provider, then emits originHost/originPort so the
 * projector can map dsh sessions onto the correct spark cards.
 *
 * Run on the machine that hosts dsh web:
 *   DSH_OCCUPANCY_TOKEN="$(openssl rand -hex 32)" \
 *   DSH_OCCUPANCY_BIND="$(tailscale ip -4)" \
 *   DSH_WEB_URL="http://127.0.0.1:3080" \
 *   node scripts/dsh-occupancy-helper/index.js
 *
 * In sparkDash: LLM card → Settings → Occupancy sources → DeepSeek Harness → URL.
 * Paste the printed URL and token, then Check and Save occupancy.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DSH_WEB_URL_DEFAULT = "http://127.0.0.1:3080";
const MAX_SESSIONS = 100;
const MODELS_BATCH = 20;

/**
 * Load dsh sessions from the web API and map to projector rows.
 * @param {{ webUrl?: string, fetchFn?: typeof fetch, profileDir?: string }} opts
 * @returns {Promise<{ found: number, rows: object[] }>}
 */
export async function loadOccupancy(opts = {}) {
  const webUrl = String(opts.webUrl ?? process.env.DSH_WEB_URL ?? DSH_WEB_URL_DEFAULT).trim();
  const fetchFn = opts.fetchFn ?? fetch;
  const profileDir = opts.profileDir ?? path.join(os.homedir(), ".dsh", "profiles");
  try {
    const providerOrigins = loadProviderOrigins(profileDir);
    const items = await fetchSessionList(fetchFn, webUrl);
    const active = items.filter((item) => item && item.blank === false);
    const enriched = await enrichWithModels(fetchFn, webUrl, active.slice(0, MAX_SESSIONS));
    const rows = enriched.map((item) => mapSessionRow(item, providerOrigins));
    return { found: rows.length, rows };
  } catch {
    return { found: 0, rows: [] };
  }
}

async function fetchSessionList(fetchFn, webUrl) {
  const res = await fetchFn(`${webUrl}/api/session.list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId: "dsh-occupancy",
      method: "session.list",
      payload: { cursor: "" },
    }),
  });
  if (!res.ok) throw new Error(`session.list HTTP ${res.status}`);
  const body = await res.json();
  const result = body?.result;
  if (!result?.ok) throw new Error("session.list failed");
  const items = result.value?.items;
  return Array.isArray(items) ? items : [];
}

async function enrichWithModels(fetchFn, webUrl, items) {
  const results = [];
  for (let i = 0; i < items.length; i += MODELS_BATCH) {
    const batch = items.slice(i, i + MODELS_BATCH);
    const enriched = await Promise.all(
      batch.map(async (item) => {
        try {
          const models = await fetchSessionModels(fetchFn, webUrl, item.sessionId);
          return { ...item, _provider: models.provider, _model: models.model };
        } catch {
          return { ...item, _provider: null, _model: null };
        }
      }),
    );
    results.push(...enriched);
  }
  return results;
}

async function fetchSessionModels(fetchFn, webUrl, sessionId) {
  const res = await fetchFn(`${webUrl}/api/session.models`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId: `dsh-models-${sessionId}`,
      method: "session.models",
      payload: { sessionId },
    }),
  });
  if (!res.ok) throw new Error(`session.models HTTP ${res.status}`);
  const body = await res.json();
  const result = body?.result;
  if (!result?.ok) throw new Error("session.models failed");
  const current = result.value?.current;
  return {
    provider: typeof current?.provider === "string" ? current.provider : null,
    model: typeof current?.model === "string" ? current.model : null,
  };
}

/**
 * Parse cordis.patch.yml files to build a provider→{host,port} map.
 * Reads all profiles and merges — last definition wins per provider.
 * Minimal YAML extraction: looks for `providers:` block, then
 * `<provider>:` entries with `baseURL:` values.
 * @param {string} profileDir
 * @returns {Map<string, {host: string, port: number}>}
 */
export function loadProviderOrigins(profileDir) {
  const origins = new Map();
  let dirs;
  try {
    dirs = fs.readdirSync(profileDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return origins;
  }
  for (const name of dirs) {
    const file = path.join(profileDir, name, "cordis.patch.yml");
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    parseProviderBaseUrls(text, origins);
  }
  return origins;
}

/**
 * Extract provider→baseURL pairs from cordis.patch.yml text.
 * Scans for the `providers:` mapping block and collects `baseURL` values.
 * @param {string} text
 * @param {Map<string, {host: string, port: number}>} origins
 */
export function parseProviderBaseUrls(text, origins) {
  const lines = String(text).split("\n");
  let inProviders = false;
  let currentProvider = null;
  let providerIndent = 0;
  for (const line of lines) {
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    // Detect `providers:` key at any indent level.
    if (/^providers:\s*$/.test(trimmed)) {
      inProviders = true;
      continue;
    }

    if (!inProviders) continue;

    // A new top-level key (same or less indent than providers parent) ends the block.
    // The `providers:` key is typically nested under `config:` which is under
    // an item like `llm-pi-ai`. We track the provider indent to detect block end.
    if (currentProvider != null && indent <= providerIndent && trimmed.endsWith(":")) {
      currentProvider = null;
    }

    // Provider key: `john-remote:` at deeper indent than `providers:`
    const providerMatch = trimmed.match(/^([\w-]+):\s*$/);
    if (providerMatch && currentProvider == null) {
      currentProvider = providerMatch[1];
      providerIndent = indent;
      continue;
    }

    // baseURL value inside a provider block
    if (currentProvider && /^baseURL:\s*["']?/.test(trimmed)) {
      const urlMatch = trimmed.match(/baseURL:\s*["']?(https?:\/\/[^"'\s]+)/);
      if (urlMatch) {
        const origin = parseUrlHostPort(urlMatch[1]);
        if (origin) origins.set(currentProvider, origin);
      }
      continue;
    }
  }
}

function parseUrlHostPort(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : (parsed.protocol === "https:" ? 443 : 80);
    if (host && Number.isInteger(port)) return { host, port };
  } catch {
    /* invalid URL — skip */
  }
  return null;
}

function mapSessionRow(item, providerOrigins = new Map()) {
  const sessionId = String(item.sessionId ?? "");
  const projections = item.projections?.values;
  const title = typeof projections?.title === "string" ? projections.title.trim() : "";
  const handle = title || `dsh-${sessionId.slice(0, 8)}`;
  const row = {
    source: "dsh",
    id: sessionId,
    handle,
    lastUsedAt: Number(item.updatedAt) || undefined,
    midTurn: item.running ? "generating" : "unknown",
  };
  const cp = projections?.contextPressure;
  if (cp && Number.isFinite(cp.pressureTokens)) {
    row.contextUsed = cp.pressureTokens;
  }
  if (cp && Number.isFinite(cp.contextWindow)) {
    row.contextWindow = cp.contextWindow;
  }
  row.contextApprox = false;
  if (item._provider && item._model) {
    row.agent = `${item._provider}/${item._model}`;
  }
  const origin = providerOrigins.get(item._provider);
  if (origin) {
    row.originHost = origin.host;
    row.originPort = origin.port;
  }
  return row;
}

function timingEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createOccupancyHelper(opts = {}) {
  const token = opts.token ?? process.env.DSH_OCCUPANCY_TOKEN ?? "";
  const occupancyPath = opts.path ?? process.env.DSH_OCCUPANCY_PATH ?? "/occupancy";
  const ttlMs = opts.ttlMs ?? 2000;
  const load = opts.load ?? loadOccupancy;
  const host = opts.host ?? process.env.DSH_OCCUPANCY_BIND ?? "127.0.0.1";
  const port = Number(opts.port ?? process.env.DSH_OCCUPANCY_PORT ?? 8791);
  let cached = null;
  let cachedAt = 0;
  /** @type {http.Server | null} */
  let server = null;

  async function occupancyJson() {
    const now = Date.now();
    if (cached && now - cachedAt < ttlMs) return cached;
    const payload = await load(opts);
    cached = payload;
    cachedAt = now;
    return payload;
  }

  async function onRequest(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET" || urlPath(req) !== occupancyPath) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    if (token && !bearerMatches(req, token)) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    try {
      const payload = await occupancyJson();
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(payload));
    } catch {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "DeepSeek Harness web API not reachable" }));
    }
  }

  function listen() {
    if (host === "0.0.0.0" || host === "::") {
      console.error("Refusing to bind all interfaces. Set DSH_OCCUPANCY_BIND to a tailnet IP or use Tailscale Serve.");
      process.exitCode = 1;
      return Promise.reject(new Error("bind not allowed"));
    }
    if (token === "" && host !== "127.0.0.1" && host !== "::1") {
      console.error("Refusing reachable bind without DSH_OCCUPANCY_TOKEN.");
      process.exitCode = 1;
      return Promise.reject(new Error("token required"));
    }
    server = http.createServer((req, res) => void onRequest(req, res));
    return new Promise((resolve) => {
      server.listen(port, host, () => resolve(server));
    });
  }

  function close() {
    return new Promise((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }
      server.close((err) => (err ? reject(err) : resolve()));
      server = null;
    });
  }

  return { onRequest, listen, close, occupancyJson, host, port, path: occupancyPath };
}

function urlPath(req) {
  try {
    return new URL(req.url || "/", "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

function bearerMatches(req, token) {
  const header = String(req.headers.authorization || "");
  const got = header.startsWith("Bearer ") ? header.slice(7) : "";
  return timingEqual(got, token);
}

const isMain =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const helper = createOccupancyHelper();
  await helper.listen();
  const url = `http://${helper.host}:${helper.port}${helper.path}`;
  console.error(`DeepSeek Harness occupancy helper on ${url}`);
  console.error(
    "In sparkDash: any LLM card → Settings → Occupancy sources → DeepSeek Harness → URL. Paste that URL and DSH_OCCUPANCY_TOKEN, then Check and Save occupancy."
  );
}
