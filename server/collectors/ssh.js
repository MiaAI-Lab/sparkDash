/**
 * sshExec — centralized SSH command execution.
 * Supports both key-based and password-based (sshpass) authentication.
 *
 * Uses execFile + argv arrays (no shell interpolation of user/host/cmd).
 * Password auth uses sshpass -e (password via env), not -p on the command line.
 */
import { execFile } from "child_process";
import fs from "fs";
import { SSH_CONNECT_TIMEOUT } from "../config.js";
import { isAllowedTargetHost, isValidSshUser } from "../validate.js";

// Detect sshpass without shelling out to `which` on every cold call —
// checking PATH entries directly is faster and avoids spawning a shell.
let _sshpassAvailable = null;
function sshpassAvailable() {
  if (_sshpassAvailable !== null) return _sshpassAvailable;
  try {
    const candidates = [
      "/usr/bin/sshpass",
      "/usr/local/bin/sshpass",
      "/bin/sshpass",
      "/opt/homebrew/bin/sshpass",
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
          _sshpassAvailable = true;
          return _sshpassAvailable;
        }
      } catch {
        /* ignore */
      }
    }
    // Fall back to a PATH scan in case sshpass lives somewhere unusual.
    const pathDirs = (process.env.PATH || "").split(":");
    for (const dir of pathDirs) {
      if (!dir) continue;
      try {
        const candidate = `${dir}/sshpass`;
        if (fs.existsSync(candidate)) {
          _sshpassAvailable = true;
          return _sshpassAvailable;
        }
      } catch {
        /* ignore */
      }
    }
    _sshpassAvailable = false;
  } catch {
    _sshpassAvailable = false;
  }
  return _sshpassAvailable;
}

/**
 * Execute a command on a remote Spark via SSH.
 *
 * @param {Object} spark - Spark config object
 * @param {string} cmd - Command to execute (passed as a single remote argv via bash -c)
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<string>} - Trimmed stdout
 */
export async function sshExec(spark, cmd, options = {}) {
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 10000;
  const { host, user, auth, password } = spark.ssh || {};
  const targetHost = host || spark.lanIp;

  if (!targetHost || !user) {
    throw new Error(`SSH config missing for ${spark.id}: host=${targetHost}, user=${user}`);
  }

  if (!isAllowedTargetHost(targetHost)) {
    throw new Error(`SSH host not allowed: ${targetHost}`);
  }
  if (!isValidSshUser(user)) {
    throw new Error(`SSH user not allowed: ${user}`);
  }

  if (typeof cmd !== "string" || !cmd) {
    throw new Error("SSH command must be a non-empty string");
  }

  // Base SSH options (no shell metacharacters in argv)
  // accept-new: trust first-seen host key (LAN ops); pin known_hosts for stricter envs
  const baseOpts = [
    "-o",
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];

  const remote = `${user}@${targetHost}`;
  // Remote command as a single argument — ssh does not invoke a local shell for it
  // when using execFile without a shell. `--` stops option parsing before destination.
  let file;
  let args;
  // Minimal child env — only what ssh/sshpass actually need. Spreading the full
  // `process.env` would leak every host var (AWS_*, GITHUB_TOKEN, etc.) into the
  // child; this whitelist scopes to PATH, HOME, USER/LOGNAME (ssh logging +
  // known_hosts mixing), TERM, and SSH_AUTH_SOCK so agent-forwarded key auth
  // still works. SSHPASS is added below only for password auth.
  const env = {
    PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: process.env.HOME || "/root",
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    TERM: process.env.TERM || "xterm",
    ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
  };

  if (auth === "pass") {
    if (!password) {
      throw new Error(
        `SSH password auth selected for ${spark.id} but no password is set (Edit Spark once — passwords are stored encrypted and survive restarts)`
      );
    }
    if (!sshpassAvailable()) {
      throw new Error(`sshpass is not installed. Install it with: sudo apt-get install sshpass`);
    }
    // Password via env (sshpass -e) — never on argv or in process list as -p
    env.SSHPASS = password;
    file = "sshpass";
    args = ["-e", "ssh", ...baseOpts, "--", remote, cmd];
  } else {
    // Key-based SSH (default) — BatchMode prevents hanging on missing keys
    file = "ssh";
    args = [...baseOpts, "-o", "BatchMode=yes", "--", remote, cmd];
  }

  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, env, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        reject(new Error(`SSH to ${targetHost} failed: ${msg}`));
      } else {
        resolve(String(stdout).trim());
      }
    });
  });
}

/**
 * Test SSH connectivity to a Spark.
 * Returns { ok: boolean, message: string }
 */
export async function sshTest(spark) {
  try {
    const result = await sshExec(spark, "echo ok");
    return { ok: result === "ok", message: result };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

/**
 * Test LLM server connectivity on a single port.
 * Returns { ok: boolean, message: string }
 *
 * `port` is required at call sites today (both pass `resolveLlmPort(spark)`).
 * We accept `null`/`undefined` defensively and resolve from `spark.llmPort`
 * so any future caller that forgets the arg can't silently hit port 8888.
 */
export async function llmTest(spark, port) {
  try {
    const host = spark.lanIp;
    if (!isAllowedTargetHost(host)) {
      return { ok: false, message: `Invalid or disallowed lanIp: ${host}` };
    }
    const resolvedPort =
      Number.isInteger(port) && port >= 1 && port <= 65535
        ? port
        : Number(spark?.llmPorts?.[0] || spark?.llmPort) || 8888;
    const url = `http://${host}:${resolvedPort}/v1/models`;
    /** @type {Record<string, string>} */
    const headers = {};
    const apiKey =
      spark?.llmApiKeys?.[String(resolvedPort)] ||
      spark?.llmApiKeys?.[resolvedPort] ||
      null;
    if (apiKey) headers.Authorization = `Bearer ${String(apiKey).trim()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000), headers });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: "Auth required (set API key in LLM Settings)" };
    }
    return { ok: res.ok, message: `Model: ${data?.data?.[0]?.id || "unknown"}` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

/**
 * Test LLM connectivity on all configured ports.
 * Returns { ok: boolean, ports: { port, ok, message }[] }
 */
export async function llmTestAll(spark) {
  const ports = spark.llmPorts || (spark.llmPort ? [spark.llmPort] : [8888]);
  const results = await Promise.all(
    ports.map(async (port) => {
      const result = await llmTest(spark, port);
      return { port, ...result };
    })
  );
  const allOk = results.every((r) => r.ok);
  return { ok: allOk, ports: results };
}
