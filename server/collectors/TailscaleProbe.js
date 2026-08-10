/**
 * TailscaleProbe — reports whether a Spark is actually present on its tailnet.
 *
 * Why this exists: a Spark can be perfectly healthy — SSH answering, GPU idle,
 * LLM serving — while `tailscaled` has lost its session with the coordination
 * server. Short connections retry and survive, so every LAN-based check
 * (including sparkDash's own SSH liveness) still reports "up", but the box is
 * unreachable from anywhere off the LAN: phone on cellular, the admin console,
 * another tailnet node. The dashboard and the tailnet disagree and the dashboard
 * looks right.
 *
 * `tailscale status --json` is the authoritative answer, and it must be asked of
 * the node itself — one node's view of a *peer* can be stale, so peer state is
 * deliberately not used here.
 *
 * Command: `tailscale status --json` (read-only; no state is changed)
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
 *
 * Exported for unit testing — keep it pure (no I/O, no clock).
 *
 * @param {object} raw - parsed output of `tailscale status --json`
 * @returns {object} normalized fields (without `error`)
 */
export function parseTailscaleStatus(raw) {
  const self = raw && typeof raw === "object" && raw.Self && typeof raw.Self === "object"
    ? raw.Self
    : null;

  // Health is the payload that actually explains a failure, e.g.
  // "Tailscale hasn't received a network map from the coordination server in 2m7s."
  const health = Array.isArray(raw?.Health)
    ? raw.Health.filter((m) => typeof m === "string" && m.trim().length > 0)
    : [];

  const ips = Array.isArray(self?.TailscaleIPs)
    ? self.TailscaleIPs.filter((ip) => typeof ip === "string")
    : [];

  return {
    available: self != null,
    /**
     * Self.Online is the node's OWN view of whether it is talking to the
     * coordination server. This is the signal a LAN-only check cannot see.
     * null when tailscale did not report it.
     */
    online: typeof self?.Online === "boolean" ? self.Online : null,
    /** "Running" | "Stopped" | "NeedsLogin" | "NoState" — tailscaled's own state. */
    backendState: str(raw?.BackendState),
    hostName: str(self?.HostName),
    dnsName: str(self?.DNSName),
    tailscaleIp: ips[0] ?? null,
    /** DERP relay region, or null when the node has a direct path. */
    relay: str(self?.Relay),
    /** ISO timestamp; null when key expiry is disabled for this node. */
    keyExpiry: str(self?.KeyExpiry),
    keyExpired: self?.Expired === true,
    version: str(raw?.Version),
    /** Human-readable reasons tailscale itself considers itself unhealthy. */
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

  /** Symmetry with the other probes; nothing persistent to release. */
  dispose() {}

  /**
   * Host PID 1 mount namespace, present when running as the bind-mounted
   * container. Mirrors SystemCollector._hasHostProc.
   */
  _hasHostProc() {
    return fs.existsSync(path.join(HOST_PATHS.PROC, "1", "ns", "mnt"));
  }

  /**
   * Run the status command for an `isLocal` Spark.
   *
   * In the container the `tailscale` CLI and, more importantly, tailscaled's
   * unix socket live on the *host*, so a plain `sh -c` finds neither. Enter the
   * host mount namespace when it is available (same approach SystemCollector
   * uses for nvidia-smi).
   *
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
        if (err) return reject(new Error(stderr?.trim() || err.message));
        resolve(String(stdout).trim());
      });
    });
  }

  /**
   * Never throws — on failure returns `_default()` with `error` set, matching
   * the other probes.
   *
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
      // Most common causes: tailscale not installed, or tailscaled not running
      // (the CLI exits non-zero). Both are legitimately "not on the tailnet".
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
