/**
 * sparkdash-node-agent — entry point.
 *
 * Runs on each DGX Spark (and Narthex). Provides local telemetry, live versions,
 * service catalog, memory budgeting, and actions over a local HTTP API (default
 * port 30091, next to the hasso5703 cockpit's 30090).
 *
 * Batch 0: scaffolding. Wires up collectors + HTTP + actions as batches land:
 *   - Batch 1A: agent/collectors/ + agent/telemetry.js + agent/http.js
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
 *   NODE_ID           — node id (default: hostname)
 *   NODE_NAME         — node name (default: hostname)
 *   NODE_LAN_IP       — node LAN IP (default: first non-loopback)
 *   RECIPES_PATH      — path to recipes.json (default: <agent>/config/recipes.json,
 *                       fallback to <agent>/config/recipes.example.json when the
 *                       default is missing; an explicitly set RECIPES_PATH that
 *                       is missing degrades to an empty catalog, not the example)
 *   AGENT_VERSION     — agent version string (default: from package.json)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  loadRecipes,
  getRecipe,
  listRecipes,
  validateRecipe,
  validateRecipeFile,
} from "./catalog/recipes.js";
import { computeMemoryBudget } from "./catalog/memory.js";
import { listServices } from "./catalog/services.js";

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
 * Build the node identity from env vars.
 * @param {object} [env]
 * @returns {{nodeId: string, nodeName: string, lanIp: string, port: number, bind: string, token: string|null}}
 */
export function readNodeIdentity(env = process.env) {
  const hostname = env.HOSTNAME || "unknown";
  return {
    nodeId: env.NODE_ID || hostname,
    nodeName: env.NODE_NAME || hostname,
    lanIp: env.NODE_LAN_IP || "127.0.0.1",
    port: Number(env.NODE_AGENT_PORT || 30091),
    bind: env.NODE_AGENT_BIND || "0.0.0.0",
    token: env.NODE_AGENT_TOKEN || null,
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
 * Batch 1B: attaches the catalog seam consumed by Batch 1A (telemetry) and
 * 2A/2B (actions): recipe accessors, memory budgeting pre-filled with this
 * node's identity, and the recipe↔live-state join.
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
 *   start: () => Promise<void>,
 *   stop: () => Promise<void>
 * }}
 */
export function createNodeAgent(opts = {}) {
  const identity = readNodeIdentity(opts.env);
  const catalog = loadCatalog(opts.env, { force: Boolean(opts.reloadCatalog) });
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
      // Batch 1A: start the HTTP server on identity.port
      return Promise.resolve();
    },
    stop() {
      // Batch 1A: stop the HTTP server
      return Promise.resolve();
    },
  };
}

// Allow `node main.js` to run as a smoke test (identity + catalog summary).
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
}
