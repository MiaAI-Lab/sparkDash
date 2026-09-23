/**
 * http.js — local HTTP API for the node agent (zero dependencies, node:http).
 *
 * Endpoints (JSON, CORS open for local use):
 *   GET /            → identity + endpoint list
 *   GET /health      → { ok: true, agentVersion }
 *   GET /telemetry   → full NodeAgentSnapshot (calls snapshotFn live)
 *   GET /versions    → snapshot.versions
 *   GET /containers  → snapshot.containers
 *
 * Each telemetry/versions/containers request invokes snapshotFn() directly
 * (no cache) — the dashboard server owns poll pacing.
 *
 * Optional bearer token (opts.token, from NODE_AGENT_TOKEN): required on
 * /telemetry, /versions, /containers. /health and / stay open for liveness.
 */
import http from "node:http";

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Create the node-agent HTTP server.
 * @param {() => Promise<object>} snapshotFn returns a NodeAgentSnapshot
 * @param {number} [port] default 30091; 0 → ephemeral (tests)
 * @param {string} [bind] default "0.0.0.0"
 * @param {{ agentVersion?: string, token?: string | null }} [opts]
 * @returns {{ start: () => Promise<{port:number, address:string}>, stop: () => Promise<void> }}
 */
export function createHttpServer(snapshotFn, port = 30091, bind = "0.0.0.0", opts = {}) {
  const agentVersion = opts.agentVersion || "0.1.0";
  const token = opts.token || null;
  /** @type {import("node:http").Server | null} */
  let server = null;

  const handler = (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== "GET") {
      json(res, 405, { error: "method not allowed" });
      return;
    }

    let pathname;
    try {
      pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
    } catch {
      pathname = req.url || "/";
    }

    const authorized = !token || req.headers.authorization === `Bearer ${token}`;

    try {
      if (pathname === "/") {
        json(res, 200, {
          name: "sparkdash-node-agent",
          version: agentVersion,
          endpoints: ["/telemetry", "/versions", "/containers", "/health"],
        });
        return;
      }
      if (pathname === "/health") {
        json(res, 200, { ok: true, agentVersion });
        return;
      }
      if (!authorized) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
      if (pathname === "/telemetry" || pathname === "/versions" || pathname === "/containers") {
        Promise.resolve()
          .then(() => snapshotFn())
          .then((snap) => {
            if (pathname === "/telemetry") json(res, 200, snap);
            else if (pathname === "/versions") json(res, 200, snap?.versions ?? []);
            else json(res, 200, snap?.containers ?? []);
          })
          .catch((err) => {
            json(res, 500, {
              error: "telemetry failed",
              message: String(err?.message || err),
            });
          });
        return;
      }
      json(res, 404, { error: "not found" });
    } catch {
      try {
        json(res, 500, { error: "internal error" });
      } catch {
        /* response already sent */
      }
    }
  };

  return {
    /**
     * Start listening.
     * @returns {Promise<{port:number, address:string}>}
     */
    async start() {
      if (server) return server.address() || { port: 0, address: "" };
      server = http.createServer(handler);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, bind, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const addr = server.address();
      return { port: addr?.port ?? port, address: addr?.address ?? bind };
    },

    /** Close the listener and any in-flight keep-alive connections. */
    async stop() {
      if (!server) return;
      const s = server;
      server = null;
      await new Promise((resolve, reject) => {
        s.close((err) => (err ? reject(err) : resolve()));
        if (typeof s.closeAllConnections === "function") s.closeAllConnections();
      });
    },
  };
}
