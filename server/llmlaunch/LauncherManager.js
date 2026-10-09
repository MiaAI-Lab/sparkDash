import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn, execFile } from "child_process";
import { HOST_PATHS } from "../config.js";
import { sshCommandSpec, sshExec } from "../collectors/ssh.js";
import { chooseLocalInvocation } from "../collectors/HermesProbe.js";
import {
  exitPrefix,
  buildAttachCommand,
  buildStartCommand,
  buildStatusCommand,
  buildStopCommand,
} from "./commands.js";

export const MAX_LINES = 5000;
const START_WATCH_MAX_MS = 6 * 60 * 60 * 1000;
const STOP_MAX_MS = 15 * 60 * 1000;
const KILL_GRACE_MS = 3000;

// CSI sequences (colors, cursor moves, erase) and OSC (window titles).
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]/g;

export function stripAnsi(text) {
  return text.replace(ANSI_RE, "");
}

/**
 * Turns a byte stream into lines. A lone "\r" means "redraw this line" (progress
 * bars), so the text typed so far is dropped; "\r\n" is an ordinary newline. The
 * unfinished last line is exposed as `partial` so live progress stays visible.
 */
export class LineSplitter {
  constructor() {
    this.buf = "";
    this.cr = false;
  }

  /** @returns {string[]} completed lines */
  feed(chunk) {
    const out = [];
    for (const ch of stripAnsi(chunk)) {
      if (this.cr) {
        this.cr = false;
        if (ch === "\n") {
          out.push(this.buf);
          this.buf = "";
          continue;
        }
        this.buf = "";
      }
      if (ch === "\n") {
        out.push(this.buf);
        this.buf = "";
      } else if (ch === "\r") {
        this.cr = true;
      } else {
        this.buf += ch;
      }
    }
    return out;
  }

  get partial() {
    return this.buf;
  }

  flush() {
    const rest = this.buf;
    this.buf = "";
    this.cr = false;
    return rest;
  }
}

function resolveLocalInvocation(spark, cmd) {
  const mntNs = fs.existsSync(path.join(HOST_PATHS.PROC, "1", "ns", "mnt"))
    ? path.join(HOST_PATHS.PROC, "1", "ns", "mnt")
    : null;
  let passwdText = "";
  try {
    passwdText = fs.readFileSync(
      mntNs ? path.join(HOST_PATHS.ROOT, "etc", "passwd") : "/etc/passwd",
      "utf8"
    );
  } catch {
    passwdText = "";
  }
  return chooseLocalInvocation({
    mntNs,
    passwdText,
    currentUid: typeof process.getuid === "function" ? process.getuid() : -1,
    user: spark.ssh?.user,
    cmd,
    // Launcher scripts must never run as the dashboard's (root) user: refuse instead.
    requireDrop: true,
  });
}

/** Default process factory: ssh for remote Sparks, host-user drop + nsenter for the local one. */
export function defaultSpawn(spark, cmd, opts = {}) {
  // `opts.stdin`: keep stdin open as a pipe so the caller can hand over secrets without argv.
  const stdio = [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"];
  if (spark.isLocal) {
    const inv = resolveLocalInvocation(spark, cmd);
    return spawn(inv.file, inv.args, { stdio, detached: true });
  }
  const spec = sshCommandSpec(spark, {
    remoteArgv: [cmd],
    multiplex: false,
    extraSshArgs: ["-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4"],
  });
  return spawn(spec.file, spec.args, { env: spec.env, stdio, detached: true });
}

function defaultExec(spark, cmd, timeoutMs) {
  if (!spark.isLocal) return sshExec(spark, cmd, { timeoutMs });
  const inv = resolveLocalInvocation(spark, cmd);
  return new Promise((resolve, reject) => {
    execFile(inv.file, inv.args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout).trim())
    );
  });
}

/**
 * Runs the start / stop scripts of user-registered LLMs and streams their output.
 * One job at a time per Spark; the finished job stays readable until the next one.
 */
export class LauncherManager {
  /**
   * @param {object} opts
   * @param {import("./LauncherStore.js").LauncherStore} opts.store
   * @param {(spark: object, cmd: string) => import("child_process").ChildProcess} [opts.spawnProcess]
   * @param {(spark: object, cmd: string, timeoutMs: number) => Promise<string>} [opts.exec]
   * @param {(event: object) => void} [opts.onEvent]
   */
  constructor({ store, spawnProcess = defaultSpawn, exec = defaultExec, onEvent = () => {}, now = Date.now }) {
    this.store = store;
    this.spawnProcess = spawnProcess;
    this.exec = exec;
    this.onEvent = onEvent;
    this.now = now;
    /** @type {Map<string, object>} sparkId -> latest job */
    this.jobs = new Map();
  }

  summary(job) {
    return {
      id: job.id,
      sparkId: job.sparkId,
      launcherId: job.launcherId,
      launcherName: job.launcherName,
      action: job.action,
      status: job.status,
      exitCode: job.exitCode,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
    };
  }

  activeJob(sparkId) {
    const job = this.jobs.get(sparkId);
    return job && job.status === "running" ? job : null;
  }

  latestJob(sparkId) {
    return this.jobs.get(sparkId) ?? null;
  }

  /** @returns {{ job: object, lines: {seq:number,text:string}[], partial: string, nextSeq: number } | null} */
  readJob(sparkId, jobId, since = 0) {
    const job = this.jobs.get(sparkId);
    if (!job || job.id !== jobId) return null;
    const lines = job.lines.filter((l) => l.seq > since);
    return {
      job: this.summary(job),
      lines,
      partial: job.status === "running" ? job.splitter.partial : "",
      nextSeq: job.seq,
      truncated: job.dropped > 0,
    };
  }

  /** @returns {Promise<Record<string, "running"|"stopped"|"unknown">>} */
  async statuses(spark, launchers) {
    const out = {};
    for (const l of launchers) out[l.id] = "unknown";
    if (launchers.length === 0) return out;
    try {
      const text = await this.exec(spark, buildStatusCommand(launchers.map((l) => l.id)), 15000);
      for (const line of String(text).split("\n")) {
        const m = /^(\S+) (RUNNING|STOPPED)$/.exec(line.trim());
        if (m && m[1] in out) out[m[1]] = m[2] === "RUNNING" ? "running" : "stopped";
      }
    } catch {
      /* host unreachable: leave everything "unknown" */
    }
    return out;
  }

  /**
   * @param {object} spark  full Spark config (with SSH secrets)
   * @param {object} launcher
   * @param {"start"|"stop"|"attach"} action
   * @returns {{ ok: true, job: object } | { ok: false, reason: string, active?: object }}
   */
  startJob(spark, launcher, action) {
    const active = this.activeJob(spark.id);
    if (active) {
      // A stop script is real work in flight: never run two at once. A start/attach job is only a
      // watcher on a script that keeps running by itself, so a new action just stops watching it.
      if (active.action === "stop") {
        return { ok: false, reason: "busy", active: this.summary(active) };
      }
      this._detachWatcher(active);
    }
    let cmd;
    let maxMs;
    const nonce = crypto.randomBytes(12).toString("hex");
    if (action === "start") {
      cmd = buildStartCommand({ id: launcher.id, dir: launcher.dir, script: launcher.startScript, nonce });
      maxMs = START_WATCH_MAX_MS;
    } else if (action === "attach") {
      cmd = buildAttachCommand({ id: launcher.id, nonce });
      maxMs = START_WATCH_MAX_MS;
    } else {
      cmd = buildStopCommand({ dir: launcher.dir, script: launcher.stopScript, nonce });
      maxMs = STOP_MAX_MS;
    }
    const markerPrefix = exitPrefix(nonce);

    const job = {
      id: crypto.randomBytes(6).toString("hex"),
      sparkId: spark.id,
      launcherId: launcher.id,
      launcherName: launcher.name,
      action,
      status: "running",
      exitCode: null,
      startedAt: this.now(),
      finishedAt: null,
      error: null,
      lines: [],
      seq: 0,
      dropped: 0,
      splitter: new LineSplitter(),
      cancelled: false,
      timedOut: false,
      child: null,
      timer: null,
    };
    this.jobs.set(spark.id, job);

    const push = (text) => {
      // The exit marker is protocol, not output: only a line that STARTS with this job's
      // random nonce counts, so script output can not forge or end the job early.
      if (text.startsWith(markerPrefix)) {
        const n = Number.parseInt(text.slice(markerPrefix.length), 10);
        job.markerExit = Number.isFinite(n) ? n : -1;
        // The marker is preceded by a newline that may have produced an empty line.
        if (job.lines.length && job.lines[job.lines.length - 1].text === "") job.lines.pop();
        return;
      }
      job.seq += 1;
      job.lines.push({ seq: job.seq, text });
      if (job.lines.length > MAX_LINES) {
        const over = job.lines.length - MAX_LINES;
        job.lines.splice(0, over);
        job.dropped += over;
      }
    };

    let child;
    try {
      child = this.spawnProcess(spark, cmd);
    } catch (err) {
      this._finish(job, { error: err instanceof Error ? err.message : String(err) });
      return { ok: true, job: this.summary(job) };
    }
    job.child = child;

    const onData = (buf) => {
      for (const line of job.splitter.feed(buf.toString("utf8"))) push(line);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => this._finish(job, { error: err.message, flush: push }));
    child.on("close", (code) => this._finish(job, { code, flush: push }));

    job.timer = setTimeout(() => {
      job.timedOut = true;
      this._kill(job);
    }, maxMs);
    job.timer.unref?.();

    this.onEvent({
      type: `llm.${action}.requested`,
      severity: "info",
      sparkId: spark.id,
      message: `${action === "start" ? "Starting" : action === "stop" ? "Stopping" : "Opening output of"} ${launcher.name}`,
    });
    return { ok: true, job: this.summary(job) };
  }

  /**
   * Stop the watcher. Jobs run in their own process group (detached), so the group
   * is signalled: killing only the shell would leave its `tail` holding the pipe.
   * The user's start script lives in its own session (setsid) and is not affected.
   */
  /** Stop watching a start/attach job right away; the script it was following is unaffected. */
  _detachWatcher(job) {
    job.cancelled = true;
    this._kill(job);
    this._finish(job, { code: null });
  }

  _kill(job) {
    const child = job.child;
    if (!child || child.exitCode != null || child.signalCode != null) return;
    const signal = (sig) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };
    signal("SIGTERM");
    const t = setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS);
    t.unref?.();
  }

  _finish(job, { code = null, error = null, flush = null } = {}) {
    if (job.status !== "running") return;
    clearTimeout(job.timer);
    const rest = job.splitter.flush();
    if (rest && flush) flush(rest);
    job.finishedAt = this.now();
    const exit = job.markerExit ?? null;
    job.exitCode = exit != null && exit >= 0 ? exit : code;
    if (error) {
      job.status = "failed";
      job.error = error;
    } else if (job.cancelled) {
      job.status = "cancelled";
    } else if (job.timedOut) {
      job.status = job.action === "stop" ? "failed" : "detached";
      job.error =
        job.action === "stop"
          ? "Stop script did not finish in time and was cancelled"
          : "Stopped watching after 6 hours. The script keeps running; open the output again to re-attach.";
    } else if (job.exitCode === 0 || (job.action !== "stop" && job.markerExit === -1 && code === 0)) {
      job.status = "completed";
    } else {
      job.status = "failed";
      if (job.exitCode == null) job.error = "Connection to the Spark ended unexpectedly";
    }
    this.onEvent({
      type: `llm.${job.action}.${job.status}`,
      severity: job.status === "failed" ? "error" : job.status === "completed" ? "success" : "info",
      sparkId: job.sparkId,
      message: this._eventMessage(job),
    });
  }

  _eventMessage(job) {
    const what = job.launcherName;
    if (job.action === "attach") return `Closed output of ${what}`;
    const verb = job.action === "start" ? "start script" : "stop script";
    if (job.status === "completed") return `${what}: ${verb} finished`;
    if (job.status === "cancelled") return `${what}: ${verb} cancelled`;
    if (job.status === "detached") return `${what}: stopped watching ${verb}`;
    return `${what}: ${verb} failed${job.exitCode != null ? ` (exit ${job.exitCode})` : ""}`;
  }

  /** Cancel the active job on a Spark. Start/attach: stops watching only; the script keeps running. */
  cancel(sparkId) {
    const job = this.activeJob(sparkId);
    if (!job) return false;
    // A stop script is real work in flight: it stays exclusive until it ends (or times out),
    // so the UI can not offer Start while stop.sh is still running on the Spark.
    if (job.action === "stop") return false;
    job.cancelled = true;
    this._kill(job);
    return true;
  }

  /** Kill every watcher (dashboard shutdown). Detached start scripts are left running. */
  shutdown() {
    for (const job of this.jobs.values()) {
      if (job.status === "running") {
        job.cancelled = true;
        this._kill(job);
      }
    }
  }

  /** True when the launcher's script (process group) is alive on the Spark. */
  async isLive(spark, launcher) {
    return (await this.statuses(spark, [launcher]))[launcher.id] === "running";
  }

  /** Remove a launcher unless its script is still running (that would orphan it). */
  async removeLauncher(spark, launcherId) {
    const launcher = this.store.get(spark.id, launcherId);
    if (!launcher) return { ok: false, notFound: true, error: "Model not found" };
    if (await this.isLive(spark, launcher)) {
      return { ok: false, conflict: true, error: "This model is still running. Stop it first, then remove it." };
    }
    this.store.remove(spark.id, launcherId);
    return { ok: true };
  }

  /** Update a launcher; changing dir / scripts is refused while its script is running. */
  async updateLauncher(spark, launcherId, input) {
    const launcher = this.store.get(spark.id, launcherId);
    if (!launcher) return { ok: false, notFound: true, error: "Model not found" };
    const body = input && typeof input === "object" ? input : {};
    const changesTarget = ["dir", "startScript", "stopScript"].some(
      (k) => body[k] !== undefined && body[k] !== launcher[k]
    );
    if (changesTarget && (await this.isLive(spark, launcher))) {
      return { ok: false, conflict: true, error: "This model is still running. Stop it before changing its directory or scripts." };
    }
    return this.store.update(spark.id, launcherId, input);
  }

  removeSpark(sparkId) {
    this.cancel(sparkId);
    this.jobs.delete(sparkId);
    this.store.removeSpark(sparkId);
  }
}
