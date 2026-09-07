/**
 * sshExec — centralized SSH command execution.
 * Supports both key-based and password-based (sshpass) authentication.
 *
 * Uses execFile + argv arrays (no shell interpolation of user/host/cmd).
 * Password auth uses sshpass -e (password via env), not -p on the command line.
 */
import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import { COMFY_PORT, COMFY_PROBE_TIMEOUT_MS, SSH_CONNECT_TIMEOUT } from "../config.js";
import { isAllowedTargetHost, isValidSshUser } from "../validate.js";
import { llmProbeHost } from "./llmHost.js";

// Detect sshpass without shelling out to `which` on every cold call —
// checking PATH entries directly is faster and avoids spawning a shell.
let _sshpassAvailable = null;
const _multiplexStates = new Map();
const _controlDir = fs.mkdtempSync("/tmp/sparkdash-ssh-");
const _controlSalt = crypto.randomBytes(32);
fs.chmodSync(_controlDir, 0o700);

function controlPersistSeconds() {
  const configured = Number.parseInt(process.env.SSH_CONTROL_PERSIST_SECONDS ?? "60", 10);
  return Number.isFinite(configured) ? Math.min(3600, Math.max(0, configured)) : 60;
}

function ensureControlDir() {
  fs.mkdirSync(_controlDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(_controlDir, 0o700);
}

/**
 * Build an isolated OpenSSH control socket config. Credentials are included
 * only in the digest so two password records cannot share an authenticated
 * transport; the secret itself is never exposed in argv or the socket path.
 */
export function sshMultiplexConfig(spark, targetHost, user, auth, password) {
  const persistSeconds = controlPersistSeconds();
  if (persistSeconds === 0) return null;

  ensureControlDir();
  const identityFile = process.env.SSH_IDENTITY_FILE || "default";
  const isolationKey = [spark.id, user, targetHost, auth || "key", identityFile, password || ""].join("\0");
  const digest = crypto
    .createHash("sha256")
    .update(_controlSalt)
    .update(isolationKey)
    .digest("hex")
    .slice(0, 24);
  return {
    key: digest,
    persistSeconds,
    args: [
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPersist=${persistSeconds}`,
      "-o",
      `ControlPath=${_controlDir}/${digest}`,
    ],
  };
}

/** Establish or re-check the master before concurrent pollers run. */
export async function ensureMultiplexReady(config, establish) {
  if (!config) return;

  const now = Date.now();
  let state = _multiplexStates.get(config.key);
  if (state && now >= state.expiresAt) {
    _multiplexStates.delete(config.key);
    state = null;
  }

  if (!state) {
    state = {
      ready: Promise.resolve().then(establish),
      expiresAt: now + config.persistSeconds * 1000,
    };
    _multiplexStates.set(config.key, state);
  }

  try {
    await state.ready;
    return state;
  } catch (err) {
    if (_multiplexStates.get(config.key) === state) _multiplexStates.delete(config.key);
    throw err;
  }
}

process.once("exit", () => {
  try {
    fs.rmSync(_controlDir, { recursive: true, force: true });
  } catch {
    // ControlPersist bounds any master left behind by an abrupt shutdown.
  }
});

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
 * Build file/args/env for an ssh (or sshpass) invocation. No shell interpolation.
 *
 * `extraSshArgs` sit after the shared ConnectTimeout / StrictHostKeyChecking
 * options and before `-- user@host`. `remoteArgv` is the remote command (omit
 * for `-N` tunnels).
 *
 * @param {object} spark
 * @param {{ extraSshArgs?: string[], remoteArgv?: string[] }} [opts]
 * @returns {{ file: string, args: string[], env: NodeJS.ProcessEnv, targetHost: string }}
 */
export function sshCommandSpec(spark, opts = {}) {
  const extraSshArgs = Array.isArray(opts.extraSshArgs) ? opts.extraSshArgs : [];
  const remoteArgv = Array.isArray(opts.remoteArgv) ? opts.remoteArgv : [];
  const { host, user, auth, password } = spark?.ssh || {};
  const targetHost = host || spark?.lanIp;

  if (!targetHost || !user) {
    throw new Error(`SSH config missing for ${spark?.id}: host=${targetHost}, user=${user}`);
  }

  if (!isAllowedTargetHost(targetHost)) {
    throw new Error(`SSH host not allowed: ${targetHost}`);
  }
  if (!isValidSshUser(user)) {
    throw new Error(`SSH user not allowed: ${user}`);
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
  // `--` stops option parsing before destination.
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
    args = ["-e", "ssh", ...baseOpts, ...extraSshArgs, "--", remote, ...remoteArgv];
  } else {
    // Key-based SSH (default) — BatchMode prevents hanging on missing keys
    file = "ssh";
    args = [...baseOpts, "-o", "BatchMode=yes"];
    const identityFile = process.env.SSH_IDENTITY_FILE;
    if (identityFile) {
      args.push("-i", identityFile);
    }
    args.push(...extraSshArgs, "--", remote, ...remoteArgv);
  }

  return { file, args, env, targetHost };
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

  if (typeof cmd !== "string" || !cmd) {
    throw new Error("SSH command must be a non-empty string");
  }

  const spec = sshCommandSpec(spark, { remoteArgv: [cmd] });
  const { user, auth, password } = spark.ssh || {};
  const multiplex = sshMultiplexConfig(spark, spec.targetHost, user, auth, password);
  // Keep tunnel callers of sshCommandSpec independent of collector mux state.
  const { file, args, env, targetHost } = multiplex
    ? sshCommandSpec(spark, { extraSshArgs: multiplex.args, remoteArgv: [cmd] })
    : spec;

  const execute = (execArgs) => new Promise((resolve, reject) => {
    execFile(file, execArgs, { timeout: timeoutMs, env, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        reject(new Error(`SSH to ${targetHost} failed: ${msg}`, { cause: err }));
      } else {
        resolve(String(stdout).trim());
      }
    });
  });

  let multiplexState;
  if (multiplex) {
    const probeArgs = [...args];
    probeArgs[probeArgs.length - 1] = "true";
    multiplexState = await ensureMultiplexReady(multiplex, () => execute(probeArgs));
  }
  try {
    return await execute(args);
  } catch (err) {
    // OpenSSH reports transport errors as 255. Signals/timeouts and local
    // execution errors also leave transport health unknown. Ordinary remote
    // nonzero exits do not mean the shared connection is dead.
    const failure = err.cause;
    const transportFailed = failure?.code === 255 || failure?.killed ||
      failure?.signal || typeof failure?.code !== "number";
    // A late failure from an old command must not evict a newer recovery probe.
    if (multiplex && transportFailed && _multiplexStates.get(multiplex.key) === multiplexState) {
      _multiplexStates.delete(multiplex.key);
    }
    // Never replay the command: the remote side may already have executed it.
    throw err;
  }
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
    const host = llmProbeHost(spark);
    if (!isAllowedTargetHost(host)) {
      return { ok: false, message: `Invalid or disallowed LLM host: ${host}` };
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

/**
 * Test ComfyUI connectivity on a single port (GET /system_stats).
 * Returns { ok: boolean, message: string, skipped?: boolean }
 */
export async function comfyTest(spark, port) {
  try {
    const host = llmProbeHost(spark);
    if (!isAllowedTargetHost(host)) {
      return { ok: false, message: `Invalid or disallowed ComfyUI host: ${host}` };
    }
    const resolvedPort =
      Number.isInteger(port) && port >= 1 && port <= 65535
        ? port
        : Number(spark?.comfyPort) || COMFY_PORT;
    const url = `http://${host}:${resolvedPort}/system_stats`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(COMFY_PROBE_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, message: `HTTP ${res.status}` };
    }
    const ver = data?.system?.comfyui_version;
    return {
      ok: true,
      message: ver ? `ComfyUI ${ver}` : "reachable",
    };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}
