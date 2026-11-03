// Read-only client for the host-side API keys bridge (see README "API Keys").
//
// The dashboard never talks to LiteLLM and never holds its master key. It sends a fixed set of
// GET requests to a bridge listening on a unix socket; the bridge holds the master key and answers
// only these calls. Anything else is refused here before a socket is opened.
import http from "node:http";

/** Bridge paths this module may call. Read-only: there is no write method in this module. */
export const KEY_ID_RE = /^[0-9a-f]{64}$/;
export const BRIDGE_CALLS = Object.freeze(["/v1/health", "/v1/keys", "/v1/keys/:id"]);
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** True when `path` is one of BRIDGE_CALLS (":id" = a 64-hex hashed key id). */
export function isBridgeCall(path) {
  if (path === "/v1/health" || path === "/v1/keys") return true;
  const m = /^\/v1\/keys\/([^/]+)$/.exec(path);
  return Boolean(m && KEY_ID_RE.test(m[1]));
}

/**
 * GET one bridge call. Resolves { status, json, retryAfter } and never rejects; transport failures
 * become status 0 with an error string so callers can report "unavailable" rather than data.
 */
export function bridgeGet({ socketPath, path, token, timeoutMs = 10_000 }) {
  if (!isBridgeCall(path)) return Promise.resolve({ status: 0, json: null, error: "call not allowed" });
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const req = http.request(
      { socketPath, method: "GET", path, headers: { Accept: "application/json", Authorization: `Bearer ${token}` } },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy();
            done({ status: 0, json: null, error: "bridge response too large" });
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
          } catch {
            done({ status: 0, json: null, error: "bridge sent invalid JSON" });
            return;
          }
          done({ status: res.statusCode || 0, json, retryAfter: res.headers["retry-after"] });
        });
        res.on("error", () => done({ status: 0, json: null, error: "bridge connection failed" }));
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done({ status: 0, json: null, error: "bridge timed out" });
    });
    req.on("error", () => done({ status: 0, json: null, error: "bridge unavailable" }));
    req.end();
  });
}
