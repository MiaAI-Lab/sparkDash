/**
 * shutdown — graceful power-off for Sparks (shared helper; pairs with wol.js).
 *
 * Remote Sparks (over SSH): verify the host script + passwordless sudo, then
 * background it so SSH returns before the host dies:
 *   sudo -n /usr/local/bin/spark-shutdown
 * Install that script on each remote Spark with a NOPASSWD sudoers entry for
 * the SSH user (see README → Power controls for the provisioning one-liner).
 *
 * Local Spark: inside the sparkDash container (privileged, pid: host) there is
 * no sudo and the container namespace is not the host's — nsenter into host
 * PID 1's mount namespace and ask host systemd directly. On a bare host
 * (npm run dev / deploy without Docker) the classic sudo -n script path is
 * used instead.
 *
 * Both paths acknowledge before the host actually goes down — systemctl /
 * nohup'd script *queue* the power-off, so the HTTP response flushes with
 * seconds to spare. Anything that fails inside the ack window (missing
 * binary, sudo wants a password, missing remote script) rejects with the real
 * reason instead of a fake "Shutdown initiated".
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { sshExec } from "./collectors/ssh.js";

const SHUTDOWN_BIN = "/usr/local/bin/spark-shutdown";

/**
 * Remote: verify script + passwordless sudo, then background shutdown so SSH
 * returns before the host dies. Failures before backgrounding surface to the UI.
 */
const SHUTDOWN_REMOTE_CMD = [
  `test -x ${SHUTDOWN_BIN} || { echo "missing ${SHUTDOWN_BIN}" >&2; exit 127; }`,
  // Command-scoped passwordless check: a narrow sudoers rule covering only
  // SHUTDOWN_BIN passes; the old global `sudo -n true` gate locked out exactly
  // that (safer) configuration.
  `sudo -n -l ${SHUTDOWN_BIN} >/dev/null 2>&1 || { echo "passwordless sudo permission missing for ${SHUTDOWN_BIN}" >&2; exit 126; }`,
  `nohup sudo -n ${SHUTDOWN_BIN} >/dev/null 2>&1 &`,
  `sleep 0.3`,
  `exit 0`,
].join("\n");
const SHUTDOWN_ACK_WINDOW_MS = 1500;

/** PATH scan for an executable; mirrors ssh.js sshpassAvailable(). */
let _commandCache = new Map();
function commandAvailable(name) {
  if (_commandCache.has(name)) return _commandCache.get(name);
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const found = dirs.some((dir) => {
    try {
      return fs.statSync(path.join(dir, name)).isFile();
    } catch {
      return false;
    }
  });
  _commandCache.set(name, found);
  return found;
}

/**
 * Local power-off command. The dashboard container is the common case:
 * /.dockerenv + privileged + pid:host → reach host systemd through PID 1's
 * mount namespace. Anything else (host process, non-shared PID namespace)
 * keeps the sudo + host-script contract.
 */
export function localShutdownPlan() {
  if (fs.existsSync("/.dockerenv") && commandAvailable("nsenter")) {
    return { file: "nsenter", args: ["-t", "1", "-m", "--", "systemctl", "poweroff"] };
  }
  return { file: "sudo", args: ["-n", SHUTDOWN_BIN] };
}

/**
 * Only treat "host dropped the SSH session mid-shutdown" as success.
 * Connect timeouts / auth / missing script must remain real errors.
 */
function isBenignShutdownSshError(msg) {
  return /ECONNRESET|Connection reset|broken pipe|Connection closed by remote|closed by remote host|Connection to .* closed/i.test(
    String(msg || "")
  );
}

function initiateLocalShutdown() {
  return new Promise((resolve, reject) => {
    const { file, args } = localShutdownPlan();
    let child;
    try {
      child = spawn(file, args, { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    let stderr = "";
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-400);
      });
    }
    child.on("error", (err) => {
      const msg = err.message || String(err);
      if (/ENOENT/i.test(msg)) settle(reject, new Error(`${file} not found on this host`));
      else if (/EACCES/i.test(msg)) settle(reject, new Error(`${file} is not executable`));
      else settle(reject, new Error(msg));
    });
    child.on("close", (code) => {
      if (code === 0) {
        settle(resolve, "Shutdown initiated");
      } else {
        const detail = stderr.trim() || "no stderr";
        settle(reject, new Error(`${file} exited ${code}: ${detail}`));
      }
    });
    child.unref();
    // No event within the window — assume the power-off is underway (a dying
    // host may never flush our stdio); reporting success beats "Failed to fetch".
    setTimeout(() => settle(resolve, "Shutdown initiated"), SHUTDOWN_ACK_WINDOW_MS);
  });
}

/**
 * Kick off graceful shutdown. Always aims to return quickly so the browser
 * gets a real JSON response instead of "Failed to fetch" when the SSH session
 * drops as the host powers off.
 */
export function initiateSparkShutdown(spark) {
  if (spark.isLocal) return initiateLocalShutdown();

  return sshExec(spark, SHUTDOWN_REMOTE_CMD, { timeoutMs: 8000 })
    .then(() => "Shutdown initiated")
    .catch((err) => {
      const msg = err.message || String(err);
      if (isBenignShutdownSshError(msg)) {
        return "Shutdown initiated";
      }
      throw err;
    });
}

/** HTTP status for a shutdown failure message. */
export function shutdownErrorStatus(msg) {
  if (/timed out|connection refused|unreachable|no route|ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
    return 503;
  }
  return 500;
}
