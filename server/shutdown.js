/**
 * Shutdown helpers: the power-off invocation for a local unit and the command
 * string for a remote one.
 *
 * The helper lives on the *host* (`/usr/local/bin/spark-shutdown`). A container
 * install has no sudo of its own, so the local route has to enter the host
 * mount namespace first — the same nsenter pattern the collectors use to read
 * /host/proc (the image ships util-linux for exactly this).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HOST_PATHS } from "./config.js";

export const SHUTDOWN_BIN = "/usr/local/bin/spark-shutdown";

/** The host's own power-off binary, used when the dashboard may power the host
 * off directly (root + privileged container — see localPowerOffMode). */
export const POWEROFF_BIN = "/usr/sbin/poweroff";

/**
 * Host mount namespace of PID 1, or null when the dashboard runs directly on
 * the host (bare-metal / dev) and there is no container boundary to cross.
 * @param {string} [procPath]
 * @returns {string | null}
 */
export function hostMountNs(procPath = HOST_PATHS.PROC) {
  const ns = path.join(procPath, "1", "ns", "mnt");
  try {
    return fs.existsSync(ns) ? ns : null;
  } catch {
    return null;
  }
}

/**
 * Local invocation. Inside the host mount namespace both `sudo` and the helper
 * resolve against the host's filesystem; without one this is the plain
 * bare-host call.
 * @param {{ bin?: string, mntNs?: string | null, args?: string[] }} [opts]
 * @returns {{ file: string, args: string[] }}
 */
export function localShutdownCommand({
  bin = SHUTDOWN_BIN,
  mntNs = hostMountNs(),
  args = [],
} = {}) {
  const sudoArgs = ["-n", bin, ...args];
  return mntNs
    ? { file: "nsenter", args: [`--mount=${mntNs}`, "--", "sudo", ...sudoArgs] }
    : { file: "sudo", args: sudoArgs };
}

/**
 * Remote command string. Lines are joined with newlines rather than "; " — the
 * line that backgrounds the helper ends in `&`, and `&;` is a syntax error a
 * POSIX shell rejects before the helper or the authorization check can run.
 *
 * `--check` proves passwordless sudo against the helper itself:
 * `sudo -n true` is not authorized by a sudoers rule scoped to the helper, so
 * the old probe failed for exactly the setup the README recommends. The second
 * probe keeps helpers that predate the `--check` contract working when sudo is
 * granted more broadly.
 * @param {string} [bin]
 */
export function remoteShutdownCommand(bin = SHUTDOWN_BIN) {
  return [
    `test -x ${bin} || { echo "missing ${bin}" >&2; exit 127; }`,
    `sudo -n ${bin} --check >/dev/null 2>&1 || sudo -n true >/dev/null 2>&1 || { echo "passwordless sudo required for ${bin}" >&2; exit 126; }`,
    `nohup sudo -n ${bin} >/dev/null 2>&1 &`,
    `sleep 0.3`,
    `exit 0`,
  ].join("\n");
}

/**
 * Local check command: proves the helper exists and passwordless sudo covers it
 * before anything is scheduled — the same probe the remote command runs, for the
 * dashboard's own host. A container enters the host mount namespace so `sh`,
 * `sudo` and the helper all resolve against the host's filesystem.
 * @param {{ bin?: string, mntNs?: string | null }} [opts]
 * @returns {{ file: string, args: string[] }}
 */
export function localShutdownCheckCommand({
  bin = SHUTDOWN_BIN,
  mntNs = hostMountNs(),
} = {}) {
  const script = [
    `test -x ${bin} || { echo "missing ${bin}" >&2; exit 127; }`,
    `sudo -n ${bin} --check >/dev/null 2>&1 || sudo -n true >/dev/null 2>&1 || { echo "passwordless sudo required for ${bin}" >&2; exit 126; }`,
    `exit 0`,
  ].join("\n");
  return mntNs
    ? { file: "nsenter", args: [`--mount=${mntNs}`, "--", "sh", "-c", script] }
    : { file: "sh", args: ["-c", script] };
}

/**
 * Run the local check and settle on the child's exit status. Resolves only when
 * the helper is present and authorized; every failure mode rejects with the
 * reason the power-off would not happen (GitHub #379).
 * @param {{ bin?: string, mntNs?: string | null, spawnFn?: typeof spawn, timeoutMs?: number }} [opts]
 * @returns {Promise<true>}
 */
export function checkLocalShutdown({
  bin = SHUTDOWN_BIN,
  mntNs = hostMountNs(),
  spawnFn = spawn,
  timeoutMs = 8000,
} = {}) {
  return new Promise((resolve, reject) => {
    const { file, args } = localShutdownCheckCommand({ bin, mntNs });
    let settled = false;
    let timer;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(true);
    };
    timer = setTimeout(
      () => settle(new Error(`the local shutdown check timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    const child = spawnFn(file, args, { stdio: "ignore" });
    child.on("error", (err) => {
      const msg = err?.message || String(err);
      settle(
        new Error(
          /ENOENT|not found/i.test(msg)
            ? `${file} not found — ${msg}`
            : msg
        )
      );
    });
    child.on("exit", (code) => {
      if (code === 0) return settle(null);
      if (code === 127) {
        return settle(new Error(`${bin} not found on this host — the helper is installed on the Spark itself (README: "Power off a unit")`));
      }
      if (code === 126) {
        return settle(new Error(`passwordless sudo for ${bin} is required — check the sudoers rule for the helper`));
      }
      settle(new Error(`the shutdown helper check exited with status ${code ?? "a signal"}`));
    });
  });
}

/**
 * Start the helper on the dashboard's own host. Settles on the child's exit
 * status so a helper that fails (missing, unauthorized, error) is reported
 * instead of answered with success while the host stays up (GitHub #379) —
 * the success path still returns quickly, and the caller answers the browser
 * before the helper's power-off takes effect.
 * @param {{ bin?: string, mntNs?: string | null, spawnFn?: typeof spawn }} [opts]
 */
export function spawnLocalShutdown({
  bin = SHUTDOWN_BIN,
  mntNs = hostMountNs(),
  spawnFn = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    try {
      const { file, args } = localShutdownCommand({ bin, mntNs });
      const child = spawnFn(file, args, { detached: true, stdio: "ignore" });
      // A missing binary reports through the async 'error' event, which
      // resolving on 'spawn' would swallow (the caller would log success and
      // the host would stay up).
      child.on("error", (err) => {
        const msg = err?.message || String(err);
        reject(
          new Error(
            /ENOENT|not found/i.test(msg)
              ? `${file} not found — ${bin} is installed on the Spark itself, not in the container`
              : msg
          )
        );
      });
      child.on("spawn", () => {
        child.unref();
      });
      child.on("exit", (code) => {
        if (code === 0) resolve("Shutdown initiated");
        else if (code === 127) reject(new Error(`${bin} not found — ${bin} is installed on the Spark itself, not in the container`));
        else if (code === 126) reject(new Error(`passwordless sudo required for ${bin}`));
        else reject(new Error(`the shutdown helper exited with status ${code ?? "a signal"} — the host was not powered off`));
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * How a power-off of the dashboard's own host can happen right now:
 * - "direct": the dashboard runs as root with the host mount namespace in
 *   reach (a privileged container with PidMode: host, or root on the host
 *   itself) — the host's own poweroff binary can be run through nsenter, no
 *   helper or sudoers rule needed.
 * - "helper": everything else — power-off goes through the installed
 *   `/usr/local/bin/spark-shutdown` helper (README: "Power off a unit").
 * @param {{ uid?: number | null, mntNs?: string | null }} [opts]
 * @returns {"direct" | "helper"}
 */
export function localPowerOffMode({
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  mntNs = hostMountNs(),
} = {}) {
  return uid === 0 && mntNs ? "direct" : "helper";
}

/**
 * Direct power-off: enter the host mount namespace and run the host's own
 * poweroff binary as root. No helper, no sudo.
 * @param {{ bin?: string, mntNs?: string | null }} [opts]
 * @returns {{ file: string, args: string[] }}
 */
export function directPowerOffCommand({ bin = POWEROFF_BIN, mntNs = hostMountNs() } = {}) {
  return { file: "nsenter", args: [`--mount=${mntNs}`, "--", bin] };
}

/**
 * Check command for the direct path: proves the namespace can be entered and
 * the host's poweroff binary exists. Exit 127 is reserved for the missing
 * binary; every other failure is the namespace itself (unprivileged container).
 * @param {{ bin?: string, mntNs?: string | null }} [opts]
 * @returns {{ file: string, args: string[] }}
 */
export function directPowerOffCheckCommand({ bin = POWEROFF_BIN, mntNs = hostMountNs() } = {}) {
  const script = `test -x ${bin} || { echo "missing ${bin}" >&2; exit 127; }`;
  return { file: "nsenter", args: [`--mount=${mntNs}`, "--", "sh", "-c", script] };
}

/** Messages shared by the direct check and the direct spawn. */
const DIRECT_MESSAGES = {
  nsenterMissing: (msg) => `nsenter not found — ${msg}`,
  binaryMissing: (bin) => `${bin} was not found on this host`,
  namespaceUnreachable: 'direct power-off is unavailable here — run the dashboard with privileged: true and PidMode: host (docker-compose), or install the helper (README: "Power off a unit")',
};

/**
 * Run the direct-path check: resolves when the host mount namespace can be
 * entered and the host's poweroff binary exists (GitHub #379 semantics —
 * every failure mode rejects with the reason).
 * @param {{ bin?: string, mntNs?: string | null, spawnFn?: typeof spawn, timeoutMs?: number }} [opts]
 * @returns {Promise<true>}
 */
export function checkLocalDirectPowerOff({
  bin = POWEROFF_BIN,
  mntNs = hostMountNs(),
  spawnFn = spawn,
  timeoutMs = 8000,
} = {}) {
  return new Promise((resolve, reject) => {
    const { file, args } = directPowerOffCheckCommand({ bin, mntNs });
    let settled = false;
    let timer;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(true);
    };
    timer = setTimeout(
      () => settle(new Error(`the local power-off check timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    const child = spawnFn(file, args, { stdio: "ignore" });
    child.on("error", (err) => {
      const msg = err?.message || String(err);
      settle(
        new Error(
          /ENOENT|not found/i.test(msg) ? DIRECT_MESSAGES.nsenterMissing(msg) : msg
        )
      );
    });
    child.on("exit", (code) => {
      if (code === 0) return settle(null);
      if (code === 127) return settle(new Error(`${DIRECT_MESSAGES.binaryMissing(bin)} — direct power-off is unavailable`));
      settle(new Error(`${DIRECT_MESSAGES.namespaceUnreachable} (exit status ${code ?? "a signal"})`));
    });
  });
}

/**
 * Start the direct power-off on the dashboard's own host. Detached like
 * spawnLocalShutdown: settles on the child's exit status so a failure is
 * reported instead of answered with success while the host stays up.
 * @param {{ bin?: string, mntNs?: string | null, spawnFn?: typeof spawn }} [opts]
 */
export function spawnLocalDirectPowerOff({
  bin = POWEROFF_BIN,
  mntNs = hostMountNs(),
  spawnFn = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    try {
      const { file, args } = directPowerOffCommand({ bin, mntNs });
      const child = spawnFn(file, args, { detached: true, stdio: "ignore" });
      child.on("error", (err) => {
        const msg = err?.message || String(err);
        reject(
          new Error(
            /ENOENT|not found/i.test(msg) ? DIRECT_MESSAGES.nsenterMissing(msg) : msg
          )
        );
      });
      child.on("spawn", () => {
        child.unref();
      });
      child.on("exit", (code) => {
        if (code === 0) resolve("Shutdown initiated");
        else if (code === 127) reject(new Error(`${DIRECT_MESSAGES.binaryMissing(bin)} — the host was not powered off`));
        else reject(new Error(`${DIRECT_MESSAGES.namespaceUnreachable} (exit status ${code ?? "a signal"})`));
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Dispatch for the dashboard's own host: direct power-off when root with the
 * host mount namespace in reach, the helper path otherwise.
 * @param {{ uid?: number | null, bin?: string, powerBin?: string, mntNs?: string | null, spawnFn?: typeof spawn, timeoutMs?: number }} [opts]
 * @returns {Promise<true>}
 */
export function checkLocalPowerOff({
  uid,
  bin = SHUTDOWN_BIN,
  powerBin = POWEROFF_BIN,
  mntNs = hostMountNs(),
  spawnFn = spawn,
  timeoutMs = 8000,
} = {}) {
  if (localPowerOffMode({ uid, mntNs }) === "direct") {
    return checkLocalDirectPowerOff({ bin: powerBin, mntNs, spawnFn, timeoutMs });
  }
  return checkLocalShutdown({ bin, mntNs, spawnFn, timeoutMs });
}

/**
 * Dispatch twin of checkLocalPowerOff for the actual power-off spawn.
 * @param {{ uid?: number | null, bin?: string, powerBin?: string, mntNs?: string | null, spawnFn?: typeof spawn }} [opts]
 */
export function spawnLocalPowerOff({
  uid,
  bin = SHUTDOWN_BIN,
  powerBin = POWEROFF_BIN,
  mntNs = hostMountNs(),
  spawnFn = spawn,
} = {}) {
  if (localPowerOffMode({ uid, mntNs }) === "direct") {
    return spawnLocalDirectPowerOff({ bin: powerBin, mntNs, spawnFn });
  }
  return spawnLocalShutdown({ bin, mntNs, spawnFn });
}
