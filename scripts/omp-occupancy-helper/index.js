/**
 * oh-my-pi (omp) occupancy helper for sparkDash URL attach.
 * GET /occupancy → { found, rows } of projector-input fields only.
 *
 * Run on the machine that has ~/.omp:
 *   OMP_OCCUPANCY_TOKEN="$(openssl rand -hex 32)" \
 *   OMP_OCCUPANCY_BIND="$(tailscale ip -4)" \
 *   node scripts/omp-occupancy-helper/index.js
 *
 * In sparkDash: LLM card → Settings → Occupancy sources → oh-my-pi → URL.
 * Paste the printed URL and token, then Check and Save occupancy.
 */
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadOmpOccupancy } from "../../server/collectors/OmpSessions.js";

export async function loadOccupancy(deps = {}) {
  const attach = {
    enabled: true,
    mode: deps.mode ?? "local",
    stateDir: deps.stateDir ?? "",
    url: "",
    id: "",
  };
  const loaded = await loadOmpOccupancy(attach, deps);
  if (loaded.missingState) {
    const err = new Error("oh-my-pi sessions not found");
    err.status = 503;
    throw err;
  }
  return { found: loaded.found, rows: loaded.rows };
}

function timingEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createOccupancyHelper(opts = {}) {
  const token = opts.token ?? process.env.OMP_OCCUPANCY_TOKEN ?? "";
  const occupancyPath = opts.path ?? process.env.OMP_OCCUPANCY_PATH ?? "/occupancy";
  const ttlMs = opts.ttlMs ?? 2000;
  const load = opts.load ?? loadOccupancy;
  const host = opts.host ?? process.env.OMP_OCCUPANCY_BIND ?? "127.0.0.1";
  const port = Number(opts.port ?? process.env.OMP_OCCUPANCY_PORT ?? 8789);
  let cached = null;
  let cachedAt = 0;
  /** @type {http.Server | null} */
  let server = null;

  async function occupancyJson() {
    const now = Date.now();
    if (cached && now - cachedAt < ttlMs) return cached;
    const payload = await load(opts.deps ?? {});
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
    } catch (err) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "oh-my-pi sessions not found" }));
    }
  }

  function listen() {
    if (host === "0.0.0.0" || host === "::") {
      console.error("Refusing to bind all interfaces. Set OMP_OCCUPANCY_BIND to a tailnet IP or use Tailscale Serve.");
      process.exitCode = 1;
      return Promise.reject(new Error("bind not allowed"));
    }
    if (token === "" && host !== "127.0.0.1" && host !== "::1") {
      console.error("Refusing reachable bind without OMP_OCCUPANCY_TOKEN.");
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
  console.error(`oh-my-pi occupancy helper on ${url}`);
  console.error(
    "In sparkDash: any LLM card → Settings → Occupancy sources → oh-my-pi → URL. Paste that URL and OMP_OCCUPANCY_TOKEN, then Check and Save occupancy."
  );
}
