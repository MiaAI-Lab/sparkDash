/**
 * One occupancy helper per host. It keeps one ACP bridge per enabled ACP
 * harness and one private adapter each for Hermes and DSH. HTTP handlers only
 * read the cache: concurrent dashboard polls cannot spawn another bridge.
 *
 *   OCCUPANCY_BIND=127.0.0.1 OCCUPANCY_TOKEN="$(openssl rand -hex 32)" \
 *   OCCUPANCY_ADAPTERS=openclaw,opencode,omp,hermes,dsh \
 *   node scripts/occupancy-helper/index.js
 */
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { HARNESSES } from "../../server/occupancy/catalog.js";
import { argvFromEnv, createAcpBridge, defaultOpenProcess } from "./acpBridge.js";
import { loadDsh } from "./dshAdapter.js";
import { loadHermes } from "./hermesAdapter.js";

const SCHEMA_VERSION = 1;
const REFRESH_MS = 10_000;

export function createOccupancyHelper(opts = {}) {
  const env = opts.env || process.env;
  const adapters = selectedAdapters(opts.adapters || env.OCCUPANCY_ADAPTERS);
  const token = opts.token ?? env.OCCUPANCY_TOKEN ?? "";
  const host = opts.host ?? env.OCCUPANCY_BIND ?? "127.0.0.1";
  const port = Number(opts.port ?? env.OCCUPANCY_PORT ?? 8790);
  const refreshMs = Number(opts.refreshMs ?? env.OCCUPANCY_REFRESH_MS ?? REFRESH_MS);
  const slots = new Map();
  let timer = null;
  let refreshing = null;
  let server = null;

  for (const id of adapters) {
    slots.set(id, createSlot(id, opts, env));
  }

  function payload(now = Date.now()) {
    const rows = [];
    const summary = {};
    for (const [id, slot] of slots) {
      const cache = slot.current();
      summary[id] = {
        coverage: cache.coverage,
        stale: Boolean(cache.stale),
        rows: cache.rows.length,
        error: cache.error,
      };
      for (const row of cache.rows) rows.push(row);
    }
    return { schemaVersion: SCHEMA_VERSION, observedAt: now, adapters: summary, rows };
  }

  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      await Promise.all([...slots.values()].map((slot) => slot.refresh()));
      return payload();
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  function start() {
    assertBind(host, token);
    if (timer) return listen();
    const wait = Math.min(120_000, Math.max(2_000, refreshMs || REFRESH_MS));
    timer = setInterval(() => {
      void refresh();
    }, wait);
    timer.unref?.();
    void refresh();
    return listen();
  }

  function listen() {
    if (server) return Promise.resolve(server);
    server = http.createServer((req, res) => {
      void onRequest(req, res);
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve(server));
    });
  }

  async function onRequest(req, res) {
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-type", "application/json");
    const pathname = urlPath(req);
    if (req.method !== "GET" || (pathname !== "/occupancy" && pathname !== "/health")) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    if (!authorized(req, token)) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const body = pathname === "/health" ? healthBody(payload()) : payload();
    res.statusCode = 200;
    res.end(JSON.stringify(body));
  }

  async function close() {
    for (const slot of slots.values()) slot.stop();
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    const current = server;
    server = null;
    if (!current) return;
    await new Promise((resolve, reject) => current.close((err) => (err ? reject(err) : resolve())));
  }

  return {
    start,
    close,
    refresh,
    payload,
    onRequest,
    host,
    port,
    adapters: [...slots.keys()],
    spawnCounts: () => Object.fromEntries([...slots].map(([id, slot]) => [id, slot.spawns?.() || 0])),
  };
}

function createSlot(id, opts, env) {
  const spec = HARNESSES.find((item) => item.id === id);
  if (spec?.transport === "acp") {
    const command = opts.commands?.[id] ?? env[spec.commandEnv] ?? spec.defaultCommand;
    let spawns = 0;
    const bridge = createAcpBridge({
      harness: id,
      argv: argvFromEnv(command),
      openProcess: (argv) => {
        spawns += 1;
        if (opts.openProcess) return opts.openProcess(id, argv);
        return defaultOpenProcess(argv);
      },
    });
    return {
      current: () => bridge.current(),
      refresh: () => bridge.refresh(),
      stop: () => bridge.stop(),
      spawns: () => spawns,
    };
  }
  let cache = { coverage: "unavailable", stale: false, error: null, observedAt: null, rows: [] };
  let generation = 0;
  return {
    current: () => cache,
    async refresh() {
      const gen = generation;
      const result = id === "hermes"
        ? loadHermes({ stateDir: opts.hermesStateDir ?? env.HERMES_STATE_DIR, readFile: opts.readFile, readDb: opts.readDb })
        : await loadDsh({
            webUrl: opts.dshWebUrl ?? env.DSH_WEB_URL,
            profileDir: opts.dshProfileDir ?? env.DSH_PROFILE_DIR,
            fetchFn: opts.fetchFn,
            readProfiles: opts.readProfiles,
          });
      if (gen !== generation) return;
      if (result.coverage === "unavailable" && cache.rows.length > 0) {
        cache = { ...cache, stale: true, coverage: "partial", error: result.error };
        return;
      }
      cache = {
        coverage: result.coverage,
        stale: false,
        error: result.error,
        observedAt: Date.now(),
        rows: result.rows,
      };
    },
    stop() {
      generation += 1;
      cache = { coverage: "unavailable", stale: false, error: null, observedAt: null, rows: [] };
    },
    spawns: () => 0,
  };
}

function selectedAdapters(value) {
  const wanted = String(value || "openclaw,opencode,omp,hermes,dsh")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const known = new Set(HARNESSES.map((item) => item.id));
  return [...new Set(wanted.filter((id) => known.has(id)))];
}

function assertBind(host, token) {
  if (host === "0.0.0.0" || host === "::" || host === "") {
    throw new Error("Refusing to bind all interfaces. Set OCCUPANCY_BIND to a loopback or tailnet address.");
  }
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!loopback && !token) {
    throw new Error("Refusing a reachable bind without OCCUPANCY_TOKEN.");
  }
}

function authorized(req, token) {
  if (!token) return true;
  const header = String(req.headers.authorization || "");
  const got = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const left = Buffer.from(got);
  const right = Buffer.from(String(token));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function healthBody(body) {
  return {
    ok: true,
    schemaVersion: body.schemaVersion,
    observedAt: body.observedAt,
    adapters: body.adapters,
  };
}

function urlPath(req) {
  try {
    return new URL(req.url || "/", "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

const isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const helper = createOccupancyHelper();
  await helper.start();
  console.error(`Occupancy helper on http://${helper.host}:${helper.port}/occupancy (${helper.adapters.join(", ")})`);
}
