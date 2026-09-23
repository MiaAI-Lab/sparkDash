/**
 * sparkdash-node-agent — entry point.
 *
 * Runs on each DGX Spark (and Narthex). Provides local telemetry, live
 * versions, service catalog, memory budgeting, and actions over a local HTTP
 * API (default port 30091, next to the hasso5703 cockpit's 30090).
 *
 * Batches landed so far:
 *   - Batch 1A: agent/collectors/ + agent/telemetry.js + agent/http.js — LANDED
 *   - Batch 1B: agent/catalog/ (recipes.js, memory.js, services.js) — LANDED
 *   - Batch 2A: agent/actions/docker.js + agent/actions/audit.js
 *   - Batch 2B: agent/actions/systemd.js + agent/actions/llm-switch.js
 *   - Batch 5A: agent/catalog/media.js
 *
 * Style: Node.js ESM, plain JS (JSDoc types), no build step. Mirrors sparkDash
 * server/ style. Reads the seam contract in shared/types.ts (JSDoc references).
 *
 * Env vars:
 *   NODE_AGENT_PORT   — HTTP port (default 30091)
 *   NODE_AGENT_BIND   — bind address (default 0.0.0.0)
 *   NODE_AGENT_TOKEN  — optional bearer token for the local HTTP API
 *   NODE_ID           — node id (default: hostname, "unknown" when unset)
 *   NODE_NAME         — node name (default: hostname, "unknown" when unset)
 *   NODE_LAN_IP       — node LAN IP (default: first non-loopback IPv4)
 *   LLM_PORTS         — comma-separated LLM server ports to probe (default "8080")
 *   NODE_COMFY_PORT   — ComfyUI port (default 8188; 0 = no ComfyUI probe)
 *   RECIPES_PATH      — path to recipes.json (default: <agent>/config/recipes.json,
 *                       fallback to <agent>/config/recipes.example.json when the
 *                       default is missing; an explicitly set RECIPES_PATH that
 *                       is missing degrades to an empty catalog, not the example)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadRecipes,
  getRecipe,
  listRecipes,
  validateRecipe,
  validateRecipeFile,
} from "./catalog/recipes.js";
import { computeMemoryBudget } from "./catalog/memory.js";
import { listServices } from "./catalog/services.js";
import { createHttpServer } from "./http.js";
import { collectTelemetry } from "./telemetry.js";

// Catalog seam — re-exported so Worker 1A (telemetry) and 2A/2B (actions) can
// import from agent/main.js or the catalog modules directly (same code).
export { loadRecipes, getRecipe, listRecipes, validateRecipe, validateRecipeFile };
export { computeMemoryBudget };
export { listServices };

const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RECIPES = path.join(AGENT_DIR, "config", "recipes.json");
const EXAMPLE_RECIPES = path.join(AGENT_DIR, "config", "recipes.example.json");

export const AGENT_VERSION = "0.1.0";

/**
 * Parse a comma-separated port list into unique valid port numbers.
 * @param {string | number | Array<string | number> | null | undefined} raw
 * @returns {number[]}
 */
export function parsePortList(raw) {
  if (raw == null) return [];
  const items = Array.isArray(raw)
    ? raw.map(String)
    : String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  /** @type {number[]} */
  const out = [];
  for (const item of items) {
    const n = Number(String(item).trim());
    if (Number.isInteger(n) && n >= 1 && n <= 65535 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/**
 * First non-loopback IPv4 address, or "127.0.0.1" when none.
 * @returns {string}
 */
export function detectLanIp() {
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const item of list || []) {
        if (item.family === "IPv4" && !item.internal) return item.address;
      }
    }
  } catch {
    /* fall through */
  }
  return "127.0.0.1";
}

/**
 * Build the node identity from env vars.
 * @param {object} [env]
 * @returns {{nodeId: string, nodeName: string, lanIp: string, port: number, bind: string, token: string|null, llmPorts: number[], comfyPort: number|null}}
 */
export function readNodeIdentity(env = process.env) {
  const hostname = env.HOSTNAME || "unknown";
  const comfyPort = parsePortList(env.NODE_COMFY_PORT || "8188");
  return {
    nodeId: env.NODE_ID || hostname,
    nodeName: env.NODE_NAME || hostname,
    lanIp: env.NODE_LAN_IP || detectLanIp(),
    port: Number(env.NODE_AGENT_PORT || 30091),
    bind: env.NODE_AGENT_BIND || "0.0.0.0",
    token: env.NODE_AGENT_TOKEN || null,
    llmPorts: parsePortList(env.LLM_PORTS || "8080"),
    comfyPort: comfyPort.length > 0 ? comfyPort[0] : null,
  };
}

/**
 * Resolve the recipes file path.
 * - env.RECIPES_PATH set → use as-is (a missing explicit path is surfaced to
 *   the caller, never papered over with the example).
 * - otherwise <agent>/config/recipes.json; if that is missing, fall back to
 *   <agent>/config/recipes.example.json so the agent works out of the box.
 * @param {object} [env]
 * @returns {string}
 */
export function resolveRecipesPath(env = process.env) {
  if (env.RECIPES_PATH) return env.RECIPES_PATH;
  try {
    fs.accessSync(DEFAULT_RECIPES);
    return DEFAULT_RECIPES;
  } catch {
    if (fs.existsSync(EXAMPLE_RECIPES)) return EXAMPLE_RECIPES;
    return DEFAULT_RECIPES; // let the caller surface the ENOENT
  }
}

// ── Catalog lifecycle (memoized) ────────────────────────────────────────────

let _catalog = null;

/**
 * Load (and memoize) the recipe catalog for this node.
 *
 * Graceful degradation (mirrors SparkRegistry's ENOENT → empty list):
 * an unreadable / schema-invalid recipes file logs a warning and yields an
 * empty catalog — the agent still boots, telemetry still flows, and catalog
 * endpoints report [] rather than 500.
 *
 * @param {object} [env]
 * @param {{force?: boolean}} [opts] force=true reloads from disk
 * @returns {{path: string, recipeFile: import("./catalog/recipes.js").RecipeFile, recipes: import("./catalog/recipes.js").Recipe[]}}
 */
export function loadCatalog(env = process.env, { force = false } = {}) {
  if (_catalog && !force) return _catalog;
  const identity = readNodeIdentity(env);
  const p = resolveRecipesPath(env);
  let recipeFile;
  try {
    recipeFile = loadRecipes(p);
  } catch (err) {
    console.warn(
      `[node-agent] recipes unavailable at ${p} (${err.message}); continuing with empty catalog`
    );
    recipeFile = { version: 1, nodeId: identity.nodeId, recipes: [] };
  }
  _catalog = { path: p, recipeFile, recipes: recipeFile.recipes };
  return _catalog;
}

/** Clear the memoized catalog (tests / future reload-on-file-change). */
export function resetCatalog() {
  _catalog = null;
}

/**
 * Build the node agent.
 *
 * Batch 1A + 1B: attaches the catalog seam (recipes, memory budgeting,
 * service registry) and the telemetry HTTP server (collectTelemetry over
 * agent/collectors/).
 * @param {object} [opts]
 * @returns {{
 *   identity: object,
 *   catalog: {
 *     path: string,
 *     recipeFile: object,
 *     recipes: object[],
 *     getRecipe: (name: string) => object|null,
 *     listRecipes: () => object[],
 *     computeMemoryBudget: (totalMB: number, usedMB: number, services: object[], wantMB: number, opts?: object) => object,
 *     listServices: (liveState?: object) => object[]
 *   },
 *   start: () => Promise<{port:number, address:string}>,
 *   stop: () => Promise<void>
 * }}
 */
export function createNodeAgent(opts = {}) {
  const identity = readNodeIdentity(opts.env);
  const catalog = loadCatalog(opts.env, { force: Boolean(opts.reloadCatalog) });
  const httpServer = createHttpServer(
    () =>
      collectTelemetry(
        identity.nodeId,
        identity.nodeName,
        identity.lanIp,
        identity.llmPorts,
        identity.comfyPort
      ),
    identity.port,
    identity.bind,
    { agentVersion: AGENT_VERSION, token: identity.token }
  );
  return {
    identity,
    catalog: {
      path: catalog.path,
      recipeFile: catalog.recipeFile,
      recipes: catalog.recipes,
      getRecipe: (name) => getRecipe(name, catalog.recipeFile),
      listRecipes: () => listRecipes(catalog.recipeFile),
      /** Memory budgeting with this node's identity pre-filled. */
      computeMemoryBudget: (totalMB, usedMB, services, wantMB, bOpts = {}) =>
        computeMemoryBudget(totalMB, usedMB, services, wantMB, {
          nodeId: identity.nodeId,
          ...bOpts,
        }),
      /** Join recipes + live state into ServiceInstance[]. */
      listServices: (liveState) => listServices(catalog.recipes, liveState),
    },
    start() {
      return httpServer.start().then((addr) => {
        console.log(
          JSON.stringify(
            {
              event: "node-agent up",
              agentVersion: AGENT_VERSION,
              nodeId: identity.nodeId,
              nodeName: identity.nodeName,
              lanIp: identity.lanIp,
              port: addr.port,
              bind: identity.bind,
              llmPorts: identity.llmPorts,
              comfyPort: identity.comfyPort,
              catalogPath: catalog.path,
              recipeCount: catalog.recipes.length,
            },
            null,
            2
          )
        );
        return addr;
      });
    },
    stop() {
      return httpServer.stop();
    },
  };
}

// `node main.js` runs for real: start the HTTP server, then print identity +
// catalog summary (Batch 0 behavior) + signal-driven graceful shutdown.
const isDirectRun =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isDirectRun) {
  const identity = readNodeIdentity();
  const catalog = loadCatalog();
  console.log(
    JSON.stringify(
      {
        agentVersion: AGENT_VERSION,
        identity,
        catalog: {
          path: catalog.path,
          recipeCount: catalog.recipes.length,
          recipes: catalog.recipes.map((r) => ({
            name: r.name,
            kind: r.kind,
            engine: r.engine,
            port: r.port,
            footprintMB: r.footprintMB,
          })),
        },
      },
      null,
      2
    )
  );
  const agent = createNodeAgent();
  agent.start().catch((err) => {
    console.error("[node-agent] failed to start:", err);
    process.exit(1);
  });
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      console.log(`[node-agent] ${sig} received, shutting down`);
      agent
        .stop()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  }
}
