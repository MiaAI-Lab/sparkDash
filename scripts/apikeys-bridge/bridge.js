// Reference host-side bridge for sparkDash's read-only API Keys page.
//
// Runs on the host next to LiteLLM, holds the LiteLLM master key, and answers exactly three GET
// calls on a unix socket. sparkDash talks only to this socket and never sees the master key.
//
//   GET /v1/health          -> { version, upstream: "ok" | "down" }
//   GET /v1/keys            -> { keys: [KeyRecord] }
//   GET /v1/keys/<64-hex>   -> { key: KeyRecord }
//
// Every request needs "Authorization: Bearer <token>"; only the token's sha256 is configured here.
// Lockout: after 10 rejected tokens within 10 minutes every request gets 429 with Retry-After until
// the oldest failure leaves the window. Nothing else (no write method, no other path) is routed.
// No log of requests or keys is written; failures are counted in memory only.
//
// Environment:
//   APIKEYS_BRIDGE_SOCKET        unix socket path to listen on (created 0660)
//   APIKEYS_BRIDGE_TOKEN_SHA256  hex sha256 of the token sparkDash sends
//   LITELLM_URL                  e.g. http://127.0.0.1:4000
//   LITELLM_MASTER_KEY_FILE      file holding the master key; defaults to
//                                $CREDENTIALS_DIRECTORY/litellm-master-key (systemd LoadCredential)
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { pathToFileURL } from "node:url";

export const VERSION = "1";
export const MAX_FAILURES = 10;
export const FAILURE_WINDOW_MS = 10 * 60_000;
const ID_RE = /^[0-9a-f]{64}$/;
const MAX_PAGES = 50;
export const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;

function pick(k, nowMs = Date.now()) {
  const exp = k.expires ? Date.parse(k.expires) : NaN;
  const state = k.blocked ? "blocked" : Number.isFinite(exp) && exp <= nowMs ? "expired" : "active";
  return {
    id: k.token,
    alias: k.key_alias ?? null,
    state,
    blocked: typeof k.blocked === "boolean" ? k.blocked : null,
    // LiteLLM omits spend when it is not tracked; pass null through, never invent 0.
    spend: typeof k.spend === "number" ? k.spend : null,
    maxBudget: k.max_budget ?? null,
    budgetDuration: k.budget_duration ?? null,
    budgetResetAt: k.budget_reset_at ?? null,
    expires: k.expires ?? null,
    createdAt: k.created_at ?? null,
    lastActive: k.last_active ?? null,
    rpmLimit: k.rpm_limit ?? null,
    tpmLimit: k.tpm_limit ?? null,
    maxParallelRequests: k.max_parallel_requests ?? null,
    models: Array.isArray(k.models) ? k.models : [],
  };
}

export function createBridge({ tokenSha256, litellmUrl, masterKey, now = Date.now, fetchImpl = fetch }) {
  const expected = Buffer.from(String(tokenSha256 || "").toLowerCase(), "hex");
  if (expected.length !== 32) throw new Error("APIKEYS_BRIDGE_TOKEN_SHA256 must be a hex sha256");
  if (!masterKey) throw new Error("LiteLLM master key is empty");
  const base = String(litellmUrl || "").replace(/\/+$/, "");
  let failures = [];

  const litellm = async (path) => {
    try {
      const res = await fetchImpl(base + path, { headers: { Authorization: `Bearer ${masterKey}` }, signal: AbortSignal.timeout(15_000) });
      // Bound what we buffer from LiteLLM; an oversized or unparsable body counts as a failure.
      const text = await res.text();
      if (text.length > MAX_UPSTREAM_BYTES) return { status: 0, json: null };
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json };
    } catch {
      return { status: 0, json: null };
    }
  };

  async function route(path) {
    if (path === "/v1/health") {
      const r = await litellm("/health/readiness");
      return [200, { version: VERSION, upstream: r.status === 200 ? "ok" : "down" }];
    }
    if (path === "/v1/keys") {
      const keys = [];
      for (let page = 1; ; page++) {
        const r = await litellm(`/key/list?return_full_object=true&size=100&page=${page}`);
        if (r.status !== 200 || !Array.isArray(r.json?.keys)) return [502, { error: "LiteLLM key list failed" }];
        const t = now();
        for (const k of r.json.keys) if (k && typeof k === "object" && ID_RE.test(String(k.token))) keys.push(pick(k, t));
        if (page >= Number(r.json.total_pages || 1)) break;
        // Never present a cut-off list as the whole list.
        if (page >= MAX_PAGES) return [502, { error: `more than ${MAX_PAGES * 100} keys; list not returned` }];
      }
      return [200, { keys }];
    }
    const m = /^\/v1\/keys\/([0-9a-f]{64})$/.exec(path);
    if (m) {
      const r = await litellm(`/key/info?key=${m[1]}`);
      if (r.status === 404) return [404, { error: "not found" }];
      if (r.status !== 200 || !r.json?.info) return [502, { error: "LiteLLM key info failed" }];
      return [200, { key: pick({ ...r.json.info, token: m[1] }, now()) }];
    }
    return [404, { error: "not found" }];
  }

  function authorized(header) {
    const t = now();
    failures = failures.filter((f) => t - f < FAILURE_WINDOW_MS);
    if (failures.length >= MAX_FAILURES) return { status: 429, retryAfter: Math.ceil((failures[0] + FAILURE_WINDOW_MS - t) / 1000) };
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const got = crypto.createHash("sha256").update(token).digest();
    if (token && crypto.timingSafeEqual(got, expected)) return { status: 200 };
    failures.push(t);
    return { status: 401 };
  }

  return http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET") return send(405, { error: "method not allowed" }, { Allow: "GET" });
    const auth = authorized(req.headers.authorization);
    if (auth.status === 429) return send(429, { error: "too many rejected tokens" }, { "Retry-After": String(auth.retryAfter) });
    if (auth.status !== 200) return send(401, { error: "admin token required" });
    const [status, body] = await route((req.url || "").split("?")[0]);
    send(status, body);
  });
}

async function main() {
  const socketPath = process.env.APIKEYS_BRIDGE_SOCKET;
  const keyFile = process.env.LITELLM_MASTER_KEY_FILE || (process.env.CREDENTIALS_DIRECTORY ? `${process.env.CREDENTIALS_DIRECTORY}/litellm-master-key` : "");
  if (!socketPath || !keyFile) throw new Error("set APIKEYS_BRIDGE_SOCKET and LITELLM_MASTER_KEY_FILE (or LoadCredential=litellm-master-key)");
  const server = createBridge({
    tokenSha256: process.env.APIKEYS_BRIDGE_TOKEN_SHA256,
    litellmUrl: process.env.LITELLM_URL || "http://127.0.0.1:4000",
    masterKey: fs.readFileSync(keyFile, "utf8").trim(),
  });
  if (fs.existsSync(socketPath) && fs.lstatSync(socketPath).isSocket()) fs.unlinkSync(socketPath);
  const old = process.umask(0o117);
  server.listen(socketPath, () => {
    process.umask(old);
    console.log(`[apikeys-bridge] v${VERSION} listening on ${socketPath}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((err) => {
    console.error(`[apikeys-bridge] ${err.message}`);
    process.exit(1);
  });
}
