/**
 * MemoryModeManager — the Qwen ⇄ Ollama exclusive-stack state machine, ported from
 * spark-dash's api_memory_mode. The two stacks are exclusive (each reserves most of
 * the 128 GB unified pool), so a switch stops one before starting the other and
 * verifies every step by exit code AND real container state AND settled memory — a
 * script's word never counts (main.py: "We verify real container state instead of
 * trusting a script's word for it").
 *
 * Host command execution reuses the dashboard's own path, inventing nothing: the
 * scripts and the docker CLI run via nsenter into the host mount namespace + a
 * setpriv drop to the local Spark's SSH user (chooseLocalInvocation with
 * requireDrop — running as root is refused), with scrubbedChildEnv, exactly like
 * the LLM launchers and HermesProbe. MemAvailable is read from the host /proc bind
 * mount, like SystemCollector._readHostFile.
 */
import fs from "fs";
import path from "path";
import { execFile, spawn } from "child_process";
import {
  HOST_PATHS,
  MEMORY_FLOOR_GB,
  MEMORY_MODE_ENABLED,
  MEMORY_MODE_LOG_PATH,
  OLLAMA_STACK,
  QWEN_CONTAINER,
  QWEN_DIR,
  QWEN_LAUNCH_WAIT_MS,
} from "../config.js";
import { chooseLocalInvocation } from "../collectors/HermesProbe.js";
import { scrubbedChildEnv } from "../llmlaunch/childEnv.js";
import { LOG_KEEP_BYTES, LOG_MAX_BYTES } from "../llmlaunch/commands.js";
import { validateContainerName, validateDir } from "../llmlaunch/validate.js";
import {
  buildContainerStateCommand,
  buildDockerStartCommand,
  buildDockerStopCommand,
  buildQwenStartCommand,
  buildQwenStopCommand,
} from "./commands.js";

// Poll cadence and waits, mirrored from spark-dash/main.py (wait_state / settle_memory).
export const POLL_STEP_MS = 2000;
export const QWEN_STOPPED_WAIT_MS = 40_000; // stop.sh → qwen container exited
export const OLLAMA_START_WAIT_MS = 30_000; // docker start → running
export const OLLAMA_STOP_WAIT_MS = 40_000; // docker stop → exited
export const QWEN_LAUNCH_WAIT_MS_DEFAULT = 90_000; // documented default (config.js may override via env)
export const SETTLE_MAX_MS = 30_000;
export const PLATEAU_GB = 0.3;

const DOCKER_INSPECT_TIMEOUT_MS = 15_000;
const DOCKER_START_TIMEOUT_MS = 60_000;
const DOCKER_STOP_TIMEOUT_MS = 120_000;
const STOP_SCRIPT_TIMEOUT_MS = 120_000;

const tail = (text, n = 600) => (text || "").trim().slice(-n);
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

/** Config errors that leave the feature off: a bad env must disable it, never shell-inject. */
export function memoryModeConfigProblem(config) {
  if (!config.enabled) return null; // off is not a misconfiguration
  const dirErr = validateDir(config.qwenDir);
  if (dirErr) return `QWEN_DIR: ${dirErr}`;
  const qwenErr = validateContainerName(config.qwenContainer);
  if (qwenErr) return `QWEN_CONTAINER: ${qwenErr}`;
  if (!Array.isArray(config.ollamaStack) || config.ollamaStack.length === 0) return "OLLAMA_STACK is empty";
  for (const name of config.ollamaStack) {
    const err = validateContainerName(name);
    if (err) return `OLLAMA_STACK: ${err}`;
  }
  if (!Number.isFinite(config.memoryFloorGb) || config.memoryFloorGb <= 0) return "MEMORY_FLOOR_GB must be a positive number";
  // The log path is embedded nowhere, but it names a file we create — same allow-list.
  const logErr = validateDir(config.logPath);
  if (logErr) return `MEMORY_MODE_LOG_PATH: ${logErr}`;
  return null;
}

/**
 * How a command reaches the host: nsenter into the host mount namespace + setpriv
 * drop to the Spark's SSH user. Exported for tests — passwd text, mount ns and uid
 * are inputs, so the requireDrop refusals (missing user, uid 0) are testable without
 * a host. requireDrop is the launcher posture: never run host scripts as root.
 */
export function resolveMemoryInvocation({ spark, cmd, passwdText, mntNs, currentUid }) {
  return chooseLocalInvocation({
    mntNs,
    passwdText,
    currentUid,
    user: spark?.ssh?.user,
    cmd,
    requireDrop: true,
  });
}

export class MemoryModeManager {
  /**
   * @param {object} opts
   * @param {() => object|null} [opts.getSpark] resolves the local unit (its ssh.user is
   *   the setpriv drop target). Null outside a container with a local Spark → switches
   *   fail with chooseLocalInvocation's own honest error.
   * @param {object} [opts.config] overrides the import-time env config (tests).
   * @param {object} [opts.deps] injectable exec/spawn/mem/clock (tests).
   */
  constructor({ getSpark, config = {}, deps = {} } = {}) {
    this.getSpark = typeof getSpark === "function" ? getSpark : () => null;
    this.config = {
      enabled: MEMORY_MODE_ENABLED,
      qwenDir: QWEN_DIR,
      qwenContainer: QWEN_CONTAINER,
      ollamaStack: OLLAMA_STACK,
      memoryFloorGb: MEMORY_FLOOR_GB,
      qwenLaunchWaitMs: QWEN_LAUNCH_WAIT_MS,
      logPath: MEMORY_MODE_LOG_PATH,
      ...config,
    };
    this.problem = memoryModeConfigProblem(this.config);
    /** One switch at a time (the in-process answer to the launcher flock discipline). */
    this.busy = false;
    this._deps = {
      execHost: (cmd, timeoutMs) => this._execHost(cmd, timeoutMs),
      spawnDetached: (cmd) => this._spawnDetached(cmd),
      readMemAvailable: () => this._readMemAvailableGb(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      ...deps,
    };
  }

  get enabled() {
    return this.config.enabled === true && !this.problem;
  }

  /** What the unit page card shows. Never throws; unreadable states stay honest. */
  async getStatus() {
    const stack = this.config.ollamaStack.map((name) => ({ name, state: "unknown" }));
    const availableGb = this._readMemAvailableGbSafe();
    if (!this.enabled) {
      return {
        enabled: false,
        problem: this.problem,
        mode: "none",
        qwen: null,
        ollamaStack: stack,
        availableGb,
        memoryFloorGb: this.config.memoryFloorGb,
        busy: false,
      };
    }
    const qwen = await this.containerState(this.config.qwenContainer);
    const ollamaStack = await Promise.all(
      this.config.ollamaStack.map(async (name) => ({ name, state: await this.containerState(name) }))
    );
    let mode = "none";
    if (qwen === "running") mode = "qwen";
    else if (ollamaStack.length > 0 && ollamaStack.every((c) => c.state === "running")) mode = "ollama";
    return {
      enabled: true,
      problem: null,
      mode,
      qwen,
      ollamaStack,
      availableGb,
      memoryFloorGb: this.config.memoryFloorGb,
      busy: this.busy,
    };
  }

  /**
   * Run a full switch. Returns the honest {status, message} of the last verified
   * step (main.py's response shape), or throws an err.status=400/409 for requests
   * the manager itself refuses (unknown mode, disabled, one already in flight).
   */
  async switchTo(mode) {
    if (mode !== "qwen" && mode !== "ollama") {
      const err = new Error(`Unknown mode "${String(mode)}" — expected "qwen" or "ollama"`);
      err.status = 400;
      throw err;
    }
    if (!this.enabled) {
      const err = new Error(
        this.problem
          ? `Memory mode is misconfigured and disabled: ${this.problem}`
          : "Memory mode switcher is disabled (set MEMORY_MODE_ENABLED=1)"
      );
      err.status = 409;
      throw err;
    }
    if (this.busy) {
      const err = new Error("A memory-mode switch is already running; wait for it to finish");
      err.status = 409;
      throw err;
    }
    this.busy = true;
    try {
      // Idempotency: an already-settled target state is success, not a re-run.
      // Without this guard, switching to qwen while Qwen is up would trip the
      // memory floor (Qwen itself holds ~100GB) and report a bogus breach,
      // and switching to ollama with both stacks settled would needlessly
      // re-execute stop.sh. Mixed states (both up, or neither) fall through
      // to the full flow, which repairs either case.
      const qwenNow = await this.containerState(this.config.qwenContainer);
      const stackStates = await Promise.all(
        this.config.ollamaStack.map((n) => this.containerState(n))
      );
      const stackUp = stackStates.filter((s) => s === "running").length;
      const stackDown = stackStates.every((s) => s === "exited" || s === "missing");
      if (mode === "qwen" && qwenNow === "running" && stackDown) {
        return { status: "success", message: "Already in Qwen mode: Qwen is running and the Ollama stack is stopped. No switch needed." };
      }
      if (mode === "ollama" && qwenNow === "exited" && stackUp === this.config.ollamaStack.length) {
        return { status: "success", message: "Already in Ollama mode: Qwen is stopped and the whole Ollama stack is running. No switch needed." };
      }
      return mode === "ollama" ? await this._switchToOllama() : await this._switchToQwen();
    } finally {
      this.busy = false;
    }
  }

  // ─── The two flows (port of main.py:250–290) ────────────────────────────

  async _switchToOllama() {
    const rcOut = await this._deps.execHost(buildQwenStopCommand({ dir: this.config.qwenDir }), STOP_SCRIPT_TIMEOUT_MS);
    // sh_logged parity: timestamped header with the exit code, then the output.
    this._appendLog(`\n===== ${stamp()} stop.sh rc=${rcOut.rc} =====\n${rcOut.out}\n`);
    if (rcOut.rc !== 0) {
      return { status: "error", message: `stop.sh failed (exit ${rcOut.rc}): ${tail(rcOut.out)} Qwen left running; Ollama NOT started.` };
    }
    if (!(await this.waitState(this.config.qwenContainer, "exited", QWEN_STOPPED_WAIT_MS))) {
      return { status: "error", message: "stop.sh exited 0 but the Qwen container is still running. Ollama NOT started." };
    }
    const started = [];
    for (const name of this.config.ollamaStack) {
      // The real verdict is waitState, not this exit code (docker start may fail on an
      // already-running container, which is fine; it may also succeed while the
      // container crashes right after, which waitState catches).
      await this._deps.execHost(buildDockerStartCommand(name), DOCKER_START_TIMEOUT_MS);
      if (!(await this.waitState(name, "running", OLLAMA_START_WAIT_MS))) {
        return {
          status: "error",
          message: `Qwen verified stopped, but ${name} failed to start. Up so far: ${started.join(", ") || "none"}.`,
        };
      }
      started.push(name);
    }
    return {
      status: "success",
      message: "Qwen verified stopped; Ollama stack verified running. Tap Models to list your downloaded weights.",
    };
  }

  async _switchToQwen() {
    for (const name of this.config.ollamaStack) {
      if ((await this.containerState(name)) !== "exited") {
        await this._deps.execHost(buildDockerStopCommand(name), DOCKER_STOP_TIMEOUT_MS);
      }
    }
    for (const name of this.config.ollamaStack) {
      if (!(await this.waitState(name, "exited", OLLAMA_STOP_WAIT_MS))) {
        return {
          status: "error",
          message: `${name} did not stop (state: ${await this.containerState(name)}). Qwen NOT launched.`,
        };
      }
    }
    // The kernel lags several seconds reclaiming a just-stopped ~100 GB engine; the
    // old one-shot check produced false floor-breach reports, hence the settle loop.
    const available = await this.settleMemory(this.config.memoryFloorGb, SETTLE_MAX_MS);
    if (available < this.config.memoryFloorGb) {
      return {
        status: "error",
        message:
          `Memory floor breach: ${available}GB available after the stack stopped and memory settled ` +
          `(< ${this.config.memoryFloorGb}GB floor). Something else is holding RAM. Qwen NOT launched.`,
      };
    }
    let pid;
    try {
      // Pass the floor we just cleared as start.sh's own memory number: the two
      // guards must ask the same figure, or the dashboard clears a switch its own
      // script then refuses (MEM_CHECK=0 as the only way out). A manual ./start.sh
      // in a terminal still runs with the script's stricter built-in default.
      const floor = Number(this.config.memoryFloorGb);
      const startEnv = Number.isFinite(floor) && floor > 0 ? { MEM_NEED_GIB: String(Math.floor(floor)) } : null;
      pid = await this._deps.spawnDetached(buildQwenStartCommand({ dir: this.config.qwenDir, env: startEnv }));
    } catch (err) {
      return { status: "error", message: `${err.message} Ollama stack verified stopped; Qwen NOT launched.` };
    }
    if (await this.waitState(this.config.qwenContainer, "running", this.config.qwenLaunchWaitMs)) {
      return {
        status: "success",
        message:
          `Ollama stack verified stopped (${available}GB avail). Qwen container launched (pid ${pid}); ` +
          `engine warming - the Health badge flips when it answers. Output -> ${this.config.logPath}`,
      };
    }
    return {
      status: "error",
      message: `start.sh launched (pid ${pid}) but the container never reached running state. Check ${this.config.logPath}`,
    };
  }

  // ─── Verification primitives (port of main.py's helpers) ────────────────

  /** "running" | "exited" | … | "missing" — a failed inspect is never a silent "exited". */
  async containerState(name) {
    try {
      const { rc, out } = await this._deps.execHost(buildContainerStateCommand(name), DOCKER_INSPECT_TIMEOUT_MS);
      const state = String(out || "").trim();
      return rc === 0 && state ? state : "missing";
    } catch {
      return "missing";
    }
  }

  /** Poll until the container reports `want`, or the timeout runs out. */
  async waitState(name, want, timeoutMs) {
    const deadline = this._deps.now() + timeoutMs;
    while (this._deps.now() < deadline) {
      if ((await this.containerState(name)) === want) return true;
      await this._deps.sleep(POLL_STEP_MS);
    }
    return (await this.containerState(name)) === want;
  }

  /**
   * Poll MemAvailable until it clears the floor or plateaus (two consecutive
   * readings within PLATEAU_GB), capped at maxWaitMs. 1:1 port of settle_memory.
   * @returns {Promise<number>} the last GB reading (below the floor when it never cleared)
   */
  async settleMemory(minRequired, maxWaitMs = SETTLE_MAX_MS) {
    let prev = null;
    let stable = 0;
    const deadline = this._deps.now() + maxWaitMs;
    for (;;) {
      const available = this._deps.readMemAvailable() ?? 0; // an unreadable meminfo is below the floor, not 0 GB free
      if (available >= minRequired) return available;
      if (prev !== null && available - prev < PLATEAU_GB) {
        stable += 1;
        if (stable >= 2) return available;
      } else {
        stable = 0;
      }
      prev = available;
      if (this._deps.now() >= deadline) return available;
      await this._deps.sleep(POLL_STEP_MS);
    }
  }

  // ─── Host plumbing (same path as HermesProbe / LauncherManager) ─────────

  _resolveInvocation(cmd) {
    const mntNs = fs.existsSync(path.join(HOST_PATHS.PROC, "1", "ns", "mnt"))
      ? path.join(HOST_PATHS.PROC, "1", "ns", "mnt")
      : null;
    let passwdText = "";
    try {
      passwdText = fs.readFileSync(mntNs ? path.join(HOST_PATHS.ROOT, "etc", "passwd") : "/etc/passwd", "utf8");
    } catch {
      passwdText = "";
    }
    return resolveMemoryInvocation({
      spark: this.getSpark(),
      cmd,
      passwdText,
      mntNs,
      currentUid: typeof process.getuid === "function" ? process.getuid() : -1,
    });
  }

  /** Attached run: never rejects (main.py's sh() returned rc 124 on timeout). */
  _execHost(cmd, timeoutMs) {
    return new Promise((resolve) => {
      let inv;
      try {
        inv = this._resolveInvocation(cmd);
      } catch (err) {
        resolve({ rc: 126, out: err.message });
        return;
      }
      execFile(
        inv.file,
        inv.args,
        { env: scrubbedChildEnv(), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const out = [stdout, stderr].filter(Boolean).join("\n").trim();
          if (err) {
            const rc = err.killed || err.signal ? 124 : Number.isInteger(err.code) ? err.code : 1;
            resolve({ rc, out: out || err.message });
            return;
          }
          resolve({ rc: 0, out: String(stdout).trim() });
        }
      );
    });
  }

  /** start.sh, detached, output appended to the memory-mode log (sh_logged's fd path). */
  _spawnDetached(cmd) {
    this._trimLog();
    const logFd = fs.openSync(this.config.logPath, "a");
    try {
      fs.appendFileSync(logFd, `\n===== ${stamp()} start.sh =====\n`);
      const inv = this._resolveInvocation(cmd);
      const child = spawn(inv.file, inv.args, {
        env: scrubbedChildEnv(),
        stdio: ["ignore", logFd, logFd],
        detached: true,
      });
      // A failed spawn (no nsenter, drop refused) surfaces as an error event on the
      // child, never as a throw into the route; the state check reports the truth.
      child.on("error", () => {});
      child.unref();
      return child.pid;
    } finally {
      fs.closeSync(logFd);
    }
  }

  /** MemAvailable in GB (one decimal), same kB math as get_sys_memory, host /proc bind. */
  _readMemAvailableGb() {
    for (const file of [path.join(HOST_PATHS.PROC, "meminfo"), "/proc/meminfo"]) {
      try {
        const raw = fs.readFileSync(file, "utf8");
        const m = /MemAvailable:\s+(\d+)\s+kB/.exec(raw);
        if (m) return Math.round((Number(m[1]) / 1048576) * 10) / 10;
      } catch {
        // try the next candidate
      }
    }
    return null;
  }

  _readMemAvailableGbSafe() {
    try {
      return this._readMemAvailableGb();
    } catch {
      return null;
    }
  }

  _appendLog(text) {
    try {
      this._trimLog();
      fs.appendFileSync(this.config.logPath, text);
    } catch {
      // The log is best-effort; a switch is never failed by its own log file.
    }
  }

  /** Keep growth bounded, like the launcher log janitor (LOG_MAX_BYTES / LOG_KEEP_BYTES). */
  _trimLog() {
    try {
      const size = fs.statSync(this.config.logPath).size;
      if (size <= LOG_MAX_BYTES) return;
      const fd = fs.openSync(this.config.logPath, "r+");
      try {
        const buf = Buffer.alloc(LOG_KEEP_BYTES);
        fs.readSync(fd, buf, 0, LOG_KEEP_BYTES, size - LOG_KEEP_BYTES);
        fs.ftruncateSync(fd, LOG_KEEP_BYTES);
        fs.writeSync(fd, buf, 0, LOG_KEEP_BYTES, 0);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // best-effort
    }
  }
}
