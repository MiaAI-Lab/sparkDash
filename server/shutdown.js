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
 * Start the helper on the dashboard's own host. Resolves once it is detached —
 * the route has already answered the browser by then, because the host (and
 * this process) is about to go down.
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
      // Settle on 'spawn', not on the return of spawn() — a missing binary
      // reports through the async 'error' event, which resolving here would
      // swallow (the caller would log success and the host would stay up).
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
        resolve("Shutdown initiated");
      });
    } catch (err) {
      reject(err);
    }
  });
}
