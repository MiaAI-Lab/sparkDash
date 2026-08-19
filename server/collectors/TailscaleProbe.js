/**
 * TailscaleProbe — reports whether a unit is actually present on its tailnet.
 *
 * A Spark/host can be healthy on the LAN (SSH, GPU, LLM) while `tailscaled`
 * has lost its session with the coordination server. Verdict is Self.Online
 * on this node — never a peer's (possibly stale) view.
 *
 * Command: `tailscale status --json` (read-only).
 */
import { TAILSCALE_PROBE_TIMEOUT_MS, HOST_PATHS } from "../config.js";
import { sshExec } from "./ssh.js";
import fs from "fs";
import path from "path";

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function str(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

/**
 * Normalize `tailscale status --json` into the fields the UI needs.
 * Pure (no I/O) — exported for unit tests.
 *
 * @param {object} raw
 * @returns {object}
 */
export function parseTailscaleStatus(raw) {
  const self =
    raw && typeof raw === "object" && raw.Self && typeof raw.Self === "object"
      ? raw.Self
      : null;

  const health = Array.isArray(raw?.Health)
    ? raw.Health.filter((m) => typeof m === "string" && m.trim().length > 0)
    : [];

  const ips = Array.isArray(self?.TailscaleIPs)
    ? self.TailscaleIPs.filter((ip) => typeof ip === "string")
    : [];

  return {
    available: self != null,
    online: typeof self?.Online === "boolean" ? self.Online : null,
    backendState: str(raw?.BackendState),
    hostName: str(self?.HostName),
    dnsName: str(self?.DNSName),
    tailscaleIp: ips[0] ?? null,
    relay: str(self?.Relay),
    keyExpiry: str(self?.KeyExpiry),
    keyExpired: self?.Expired === true,
    version: str(raw?.Version),
    health,
  };
}

export class TailscaleProbe {
  /**
   * @param {object} spark
   */
  constructor(spark) {
    this.spark = spark;
    this.error = null;
  }

  /** @param {object} spark */
  setTarget(spark) {
    this.spark = spark ?? this.spark;
    this.error = null;
  }

  dispose() {}

  _hasHostProc() {
    return fs.existsSync(path.join(HOST_PATHS.PROC, "1", "ns", "mnt"));
  }

  /**
   * Local Docker: tailscaled's socket lives on the host, so enter the host
   * mount namespace (same approach as nvidia-smi).
   * @param {string} cmd
   * @returns {Promise<string>}
   */
  async _execLocal(cmd) {
    const { execFile } = await import("child_process");
    const useHostNs = this._hasHostProc();
    const file = useHostNs ? "nsenter" : "sh";
    const args = useHostNs
      ? ["--mount=" + path.join(HOST_PATHS.PROC, "1", "ns", "mnt"), "--", "sh", "-c", cmd]
      : ["-c", cmd];
    return new Promise((resolve, reject) => {
      execFile(file, args, { timeout: TAILSCALE_PROBE_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || "").trim() || err.message));
        resolve(String(stdout).trim());
      });
    });
  }

  /**
   * Never throws — on failure returns `_default()` with `error` set.
   * @returns {Promise<object>}
   */
  async probe() {
    const cmd = "tailscale status --json";
    let out;
    try {
      out = this.spark?.isLocal
        ? await this._execLocal(cmd)
        : await sshExec(this.spark, cmd, { timeoutMs: TAILSCALE_PROBE_TIMEOUT_MS });
    } catch (err) {
      this.error = err.message || "tailscale status failed";
      return this._default();
    }

    let raw;
    try {
      raw = JSON.parse(out);
    } catch {
      this.error = "Unparseable `tailscale status --json` output";
      return this._default();
    }

    const parsed = parseTailscaleStatus(raw);
    if (!parsed.available) {
      this.error = "No Self in `tailscale status --json`";
      return this._default();
    }
    this.error = null;
    return { ...parsed, error: null };
  }

  _default() {
    return {
      available: false,
      online: null,
      backendState: null,
      hostName: null,
      dnsName: null,
      tailscaleIp: null,
      relay: null,
      keyExpiry: null,
      keyExpired: false,
      version: null,
      health: [],
      error: this.error,
    };
  }
}
