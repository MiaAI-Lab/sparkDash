/**
 * On-demand LLM HTTP(S) target for Remote benches.
 * Shared by the React dialog and the Node bench runners.
 */

/**
 * @param {{ host: string, port: number, tls?: boolean }} target
 * @returns {string}
 */
export function formatLlmBaseUrl(target) {
  const host = String(target?.host || "").trim();
  const port = Number(target?.port);
  const tls = Boolean(target?.tls);
  const scheme = tls ? "https" : "http";
  if (!host) return "";
  const omit = (tls && port === 443) || (!tls && port === 80);
  if (!Number.isInteger(port) || port < 1 || omit) {
    return `${scheme}://${host}`;
  }
  return `${scheme}://${host}:${port}`;
}

/**
 * Parse a typed host (hostname, host:port, or full URL) plus optional port/tls.
 *
 * @param {unknown} hostInput
 * @param {unknown} [portInput]
 * @param {unknown} [tlsInput]  true/false; omitted → infer from URL, else HTTPS
 * @returns {{ host: string, port: number, tls: boolean }}
 */
export function parseLlmTargetInput(hostInput, portInput, tlsInput) {
  const raw = String(hostInput ?? "").trim();
  if (!raw) {
    const err = new Error("Enter a host");
    err.status = 400;
    throw err;
  }

  let host = raw;
  /** @type {number | null} */
  let urlPort = null;
  /** @type {boolean | null} */
  let urlTls = null;

  const hasScheme = /^https?:\/\//i.test(raw);
  const looksLikeUrl = hasScheme || (raw.includes("/") && raw.includes("."));
  if (looksLikeUrl) {
    let url;
    try {
      url = new URL(hasScheme ? raw : `https://${raw}`);
    } catch {
      const err = new Error("Invalid URL");
      err.status = 400;
      throw err;
    }
    host = url.hostname;
    urlTls = url.protocol === "https:";
    if (url.port) {
      const n = parseInt(url.port, 10);
      if (Number.isInteger(n)) urlPort = n;
    }
  } else if (raw.includes("/")) {
    host = raw.split("/")[0].trim();
  }

  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }

  // host:port without a scheme (not IPv6)
  if (!looksLikeUrl && urlPort == null && /^\d{1,5}$/.test(host.split(":").pop() || "")) {
    const idx = host.lastIndexOf(":");
    if (idx > 0 && host.indexOf(":") === idx) {
      const n = parseInt(host.slice(idx + 1), 10);
      if (Number.isInteger(n) && n >= 1 && n <= 65535) {
        urlPort = n;
        host = host.slice(0, idx);
      }
    }
  }

  host = host.trim();
  if (!host) {
    const err = new Error("Enter a host");
    err.status = 400;
    throw err;
  }

  let tls;
  if (urlTls != null) tls = urlTls;
  else if (tlsInput === true || tlsInput === "true") tls = true;
  else if (tlsInput === false || tlsInput === "false") tls = false;
  else tls = true;

  let port = urlPort;
  if (port == null && portInput != null && String(portInput).trim() !== "") {
    port = Number(portInput);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    port = tls ? 443 : 8888;
  }

  return { host, port, tls };
}
