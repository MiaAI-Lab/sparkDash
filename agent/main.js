/**
 * sparkdash-node-agent — entry point.
 *
 * Runs on each DGX Spark (and Narthex). Provides local telemetry, live versions,
 * service catalog, memory budgeting, and actions over a local HTTP API (default
 * port 30091, next to the hasso5703 cockpit's 30090).
 *
 * Batch 0: stub entry. Wires up the HTTP server + collectors + catalog + actions
 * as the batches land:
 *   - Batch 1A: agent/collectors/ + agent/telemetry.js + agent/http.js
 *   - Batch 1B: agent/catalog/ (recipes.js, memory.js, services.js)
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
 *   RECIPES_PATH      — path to recipes.json (default: ./config/recipes.json)
 *   AGENT_VERSION     — agent version string (default: from package.json)
 */

// Batch 0 stub: this file is loaded by `node main.js` and by tests. It should
// not throw on import. The real wiring lands in Batches 1-5.

export const AGENT_VERSION = "0.1.0";

/**
 * Build the node identity from env vars.
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
 * Stub server builder. Batch 1A replaces this with the real HTTP server.
 * @param {object} opts
 * @returns {{start: () => Promise<void>, stop: () => Promise<void>}}
 */
export function createNodeAgent(opts = {}) {
  const identity = readNodeIdentity(opts.env);
  return {
    identity,
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

// Allow `node main.js` to run as a smoke test (Batch 0: just print identity).
const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isDirectRun) {
  const identity = readNodeIdentity();
  console.log(JSON.stringify({ agentVersion: AGENT_VERSION, identity }, null, 2));
}
