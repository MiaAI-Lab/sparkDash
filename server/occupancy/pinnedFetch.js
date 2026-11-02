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
 * Other callers name themselves with `label` (errors read "<label> request timed out", …), and
 * with `allowErrorStatus` get a non-2xx answer back as `{ status, body }` instead of an error.
 *
 * @param {URL|string} target
 * @param {{
 *   addresses: string[],
 *   headers?: Record<string, string>,
 *   timeoutMs?: number,
 *   maxBytes?: number,
 *   signal?: AbortSignal,
 *   label?: string,
 *   allowErrorStatus?: boolean,
 * }} opts
 */
export function fetchPinned(target, opts) {
  const parsed = typeof target === "string" ? new URL(target) : target;
  const label = opts.label ?? "Helper";
  const addresses = [...new Set((opts.addresses || []).map((item) => String(item || "").trim()).filter(Boolean))];
  if (addresses.length === 0) {
    return Promise.reject(statusError(400, `${label} target resolved to no addresses`));
  }
  const address = addresses[0];
  if (net.isIP(address) === 0) {
    return Promise.reject(statusError(400, opts.label ? `Pinned ${label} address is not an IP` : "Pinned helper address is not an IP"));
  }
  const lib = parsed.protocol === "https:" ? https : http;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;

  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(statusError(499, `${label} request aborted`));
      return;
    }
    let settled = false;
    let response = null;
    let deadline;
    const onAbort = () => finish(statusError(499, `${label} request aborted`));
    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      opts.signal?.removeEventListener("abort", onAbort);
      if (err) {
        response?.destroy();
        req.destroy();
        // The underlying error (a TLS code, say) stays available as `cause`.
        reject(err?.status ? err : Object.assign(statusError(502, `${label} request failed`), { cause: err }));
      } else resolve(value);
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
        response = res;
        res.on("error", (err) => finish(err));
        res.on("aborted", () => finish(statusError(502, `${label} response was interrupted`)));
        res.on("close", () => {
          if (!res.complete) finish(statusError(502, `${label} response was interrupted`));
        });
        if (settled) {
          res.destroy();
          return;
        }
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400) {
          finish(statusError(403, `${label} redirects are not followed`));
          return;
        }
        const chunks = [];
        let received = 0;
        res.on("data", (chunk) => {
          if (settled) return;
          received += chunk.length;
          if (received > maxBytes) {
            finish(statusError(502, `${label} response exceeded the size cap`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          if ((code < 200 || code >= 300) && !opts.allowErrorStatus) {
            // Helper 401 must not open the dashboard access-token dialog.
            finish(statusError(502, `${label} answered HTTP ${code}`));
            return;
          }
          finish(null, { status: code, body: Buffer.concat(chunks).toString("utf8") });
        });
      }
    );
    req.on("timeout", () => finish(statusError(504, `${label} request timed out`)));
    req.on("error", (err) => {
      if (err?.code === "ABORT_ERR" || opts.signal?.aborted) onAbort();
      else finish(err);
    });
    // Socket inactivity alone does not bound a peer that trickles bytes forever.
    deadline = setTimeout(() => finish(statusError(504, `${label} request timed out`)), timeoutMs);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    req.end();
  });
}
