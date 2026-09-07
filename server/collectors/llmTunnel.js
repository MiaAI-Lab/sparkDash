/**
 * Resolve the HTTP target for an LLM server on a Spark.
 *
 * Local units (and remotes whose LLM is LAN-reachable) use llmProbeHost
 * directly. Remote units that bind only loopback (ds4 `start.sh` default
 * `--host 127.0.0.1`) are reached with an SSH local forward:
 *   ssh -N -L 127.0.0.1:<ephemeral>:127.0.0.1:<llmPort>
 *
 * Decode / Prefill benches hold the tunnel for the job and close it after.
 */

import net from "net";
import { spawn } from "child_process";
import { LLM_PROBE_TIMEOUT_MS } from "../config.js";
import { isAllowedTargetHost } from "../validate.js";
import { llmProbeHost } from "./llmHost.js";
import { sshCommandSpec } from "./ssh.js";

const TUNNEL_READY_MS = 12_000;
const TUNNEL_POLL_MS = 50;

/**
 * @param {() => void} fn
 * @returns {() => void}
 */
export function onceClose(fn) {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try {
      fn();
    } catch {
      /* ignore */
    }
  };
}

/**
 * Bind 127.0.0.1:0, then close so ssh -L can reuse the port.
 * @returns {Promise<number>}
 */
export function allocateLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      server.close((err) => {
        if (err) reject(err);
        else if (!Number.isInteger(port) || port < 1) reject(new Error("Failed to allocate local port"));
        else resolve(port);
      });
    });
  });
}

/**
 * Wait until a TCP connect to host:port succeeds (or timeout / abort).
 * @param {string} host
 * @param {number} port
 * @param {number} timeoutMs
 * @param {AbortSignal} [signal]
 */
export async function waitForTcp(host, port, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    try {
      await new Promise((resolve, reject) => {
        const sock = net.connect({ host, port }, () => {
          sock.end();
          resolve();
        });
        sock.once("error", reject);
        sock.setTimeout(400, () => {
          sock.destroy();
          reject(new Error("timeout"));
        });
      });
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, TUNNEL_POLL_MS));
    }
  }
  throw new Error(
    `SSH tunnel did not become ready on ${host}:${port}${lastErr ? `: ${lastErr.message}` : ""}`
  );
}

/**
 * Cheap reachability check (same /v1/models the connectivity test uses).
 * @param {string} host
 * @param {number} port
 * @param {{ apiKey?: string | null, timeoutMs?: number, fetchImpl?: typeof fetch }} [opts]
 */
export async function probeLlmHttp(host, port, opts = {}) {
  if (!host || !isAllowedTargetHost(host)) return false;
  const timeoutMs =
    Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : LLM_PROBE_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl || fetch;
  /** @type {Record<string, string>} */
  const headers = {};
  const apiKey = opts.apiKey != null ? String(opts.apiKey).trim() : "";
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const res = await fetchImpl(`http://${host}:${port}/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers,
    });
    return res.status !== 404 && res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Open `ssh -N -L 127.0.0.1:local:127.0.0.1:remotePort` and wait until the
 * local side accepts connections.
 *
 * @param {object} spark
 * @param {number} remotePort
 * @param {{
 *   signal?: AbortSignal,
 *   onStatus?: (msg: string) => void,
 *   spawnImpl?: typeof spawn,
 *   allocatePort?: () => Promise<number>,
 * }} [opts]
 * @returns {Promise<{ host: string, port: number, via: "ssh-tunnel", close: () => void }>}
 */
export async function openSshLlmTunnel(spark, remotePort, opts = {}) {
  const p = Number(remotePort);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error("Invalid LLM port for SSH tunnel");
  }

  const spawnImpl = opts.spawnImpl || spawn;
  const allocatePort = opts.allocatePort || allocateLocalPort;
  const localPort = await allocatePort();
  const forward = `127.0.0.1:${localPort}:127.0.0.1:${p}`;

  opts.onStatus?.(`Opening SSH tunnel to 127.0.0.1:${p}…`);

  const spec = sshCommandSpec(spark, {
    extraSshArgs: [
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=6",
      "-L",
      forward,
    ],
  });

  let stderr = "";
  const child = spawnImpl(spec.file, spec.args, {
    env: spec.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (child.stderr) {
    child.stderr.setEncoding("text");
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4000) stderr = stderr.slice(-2000);
    });
  }

  const close = onceClose(() => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        if (!child.killed) child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 1500).unref?.();
  });

  // Ignore exit/error after the local port is accepting — mid-job drops
  // surface as HTTP failures on the bench streams.
  let opened = false;
  const exitPromise = new Promise((_, reject) => {
    child.once("error", (err) => {
      if (opened) return;
      close();
      reject(new Error(`SSH tunnel failed to start: ${err.message}`));
    });
    child.once("exit", (code, signal) => {
      if (opened) return;
      const detail = stderr.trim() || `code ${code}${signal ? ` signal ${signal}` : ""}`;
      reject(new Error(`SSH tunnel exited: ${detail}`));
    });
  });

  const onAbort = () => {
    close();
  };
  if (opts.signal) {
    if (opts.signal.aborted) {
      close();
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    await Promise.race([
      waitForTcp("127.0.0.1", localPort, TUNNEL_READY_MS, opts.signal),
      exitPromise,
    ]);
    opened = true;
  } catch (err) {
    close();
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    throw err;
  }

  if (opts.signal) opts.signal.removeEventListener("abort", onAbort);

  return {
    host: "127.0.0.1",
    port: localPort,
    via: "ssh-tunnel",
    close,
  };
}

/**
 * Pick a direct LAN/loopback HTTP target, or fall back to an SSH tunnel.
 *
 * @param {object} spark
 * @param {number} port
 * @param {{
 *   apiKey?: string | null,
 *   signal?: AbortSignal,
 *   onStatus?: (msg: string) => void,
 *   probe?: typeof probeLlmHttp,
 *   openTunnel?: typeof openSshLlmTunnel,
 * }} [opts]
 * @returns {Promise<{ host: string, port: number, via: "direct" | "ssh-tunnel", close: () => void }>}
 */
export async function resolveLlmHttpTarget(spark, port, opts = {}) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error("Invalid LLM port");
  }

  const probe = opts.probe || probeLlmHttp;
  const openTunnel = opts.openTunnel || openSshLlmTunnel;
  const host = llmProbeHost(spark);
  const direct = {
    host,
    port: p,
    via: /** @type {const} */ ("direct"),
    close: onceClose(() => {}),
  };

  if (spark?.isLocal) return direct;

  if (host && isAllowedTargetHost(host)) {
    opts.onStatus?.(`Reaching LLM on ${host}:${p}…`);
    const ok = await probe(host, p, { apiKey: opts.apiKey });
    if (ok) return direct;
  }

  try {
    return await openTunnel(spark, p, {
      signal: opts.signal,
      onStatus: opts.onStatus,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    const lan = host ? `${host}:${p}` : `(no LAN IP)`;
    throw new Error(
      `LLM on ${lan} is not reachable over the LAN, and SSH tunnel to 127.0.0.1:${p} failed: ${err?.message || err}`
    );
  }
}
