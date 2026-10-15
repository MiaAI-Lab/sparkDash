import http from "node:http";
import https from "node:https";
import net from "node:net";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 1_000_000;

function statusError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * GET a helper URL using only the addresses already approved by assertAllowedTarget.
 * Redirects are rejected. The hostname is used for Host/SNI; DNS is not consulted again.
 *
 * @param {URL|string} target
 * @param {{
 *   addresses: string[],
 *   headers?: Record<string, string>,
 *   timeoutMs?: number,
 *   maxBytes?: number,
 *   signal?: AbortSignal,
 * }} opts
 */
export function fetchPinned(target, opts) {
  const parsed = typeof target === "string" ? new URL(target) : target;
  const addresses = [...new Set((opts.addresses || []).map((item) => String(item || "").trim()).filter(Boolean))];
  if (addresses.length === 0) {
    return Promise.reject(statusError(400, "Helper target resolved to no addresses"));
  }
  const address = addresses[0];
  if (net.isIP(address) === 0) {
    return Promise.reject(statusError(400, "Pinned helper address is not an IP"));
  }
  const lib = parsed.protocol === "https:" ? https : http;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;

  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(statusError(499, "Helper request aborted"));
      return;
    }
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port,
        method: "GET",
        path: `${parsed.pathname || "/"}${parsed.search}`,
        servername: parsed.hostname,
        headers: {
          accept: "application/json",
          host: parsed.host,
          ...(opts.headers || {}),
        },
        timeout: timeoutMs,
        lookup: (_hostname, options, callback) => {
          const cb = typeof options === "function" ? options : callback;
          if (options && options.all) cb(null, [{ address, family: net.isIP(address) }]);
          else cb(null, address, net.isIP(address));
        },
      },
      (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400) {
          res.resume();
          reject(statusError(403, "Helper redirects are not followed"));
          return;
        }
        const chunks = [];
        let received = 0;
        let failed = false;
        res.on("data", (chunk) => {
          if (failed) return;
          received += chunk.length;
          if (received > maxBytes) {
            failed = true;
            req.destroy();
            reject(statusError(502, "Helper response exceeded the size cap"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (failed) return;
          const body = Buffer.concat(chunks).toString("utf8");
          if (code < 200 || code >= 300) {
            // Never use 401 here. The dashboard client treats 401 as "this
            // sparkDash server wants its access token" and opens that dialog.
            reject(statusError(502, `Helper answered HTTP ${code}`));
            return;
          }
          resolve({ status: code, body });
        });
      }
    );
    const fail = (err) => {
      if (err?.status) reject(err);
      else reject(statusError(502, "Helper request failed"));
    };
    req.on("timeout", () => {
      req.destroy();
      fail(statusError(504, "Helper request timed out"));
    });
    req.on("error", (err) => {
      if (err?.code === "ABORT_ERR" || opts.signal?.aborted) fail(statusError(499, "Helper request aborted"));
      else fail(err);
    });
    if (opts.signal) {
      const onAbort = () => {
        req.destroy();
        fail(statusError(499, "Helper request aborted"));
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    req.end();
  });
}
