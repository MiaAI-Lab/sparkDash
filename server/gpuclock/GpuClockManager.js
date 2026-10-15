/**
 * Runs the GPU clock cap programs on a unit: locally through the host mount
 * namespace (as root, like the shutdown helper), or over SSH with `sudo -n`.
 * One action per unit at a time. Supported on Linux Spark units only.
 */
import { execFile } from "node:child_process";
import { sshExec } from "../collectors/ssh.js";
import { hostMountNs } from "../shutdown.js";
import { scrubbedChildEnv } from "../llmlaunch/childEnv.js";
import {
  buildApplyProgram,
  buildManualCommand,
  buildResetProgram,
  buildStatusProgram,
  parseCapRequest,
  parseProgramOutput,
  parseSudoPassword,
} from "./commands.js";

const ACTION_TIMEOUT_MS = 45_000;
const STATUS_TIMEOUT_MS = 15_000;

/** Error codes a program can report, with the HTTP status the route answers with. */
const CODE_STATUS = {
  "no-sudo": 409,
  "no-nvidia": 409,
  "no-gpu": 409,
  "no-systemd": 409,
  range: 400,
  "bad-output": 502,
  "bad-password": 403,
  // The action reached the unit and failed there (nvidia-smi, systemd, the marker write).
  "lgc-failed": 422,
  "service-failed": 422,
  "cron-failed": 422,
  "rgc-failed": 422,
  "marker-failed": 422,
};
/** After a transport failure the outcome on the unit is unknown: refuse a second action for a while. */
const HOLD_AFTER_TRANSPORT_ERROR_MS = 30_000;
const PASSWORD_ATTEMPTS = 3;
const PASSWORD_LOCK_MS = 5 * 60_000;
/** Across all units, so a second registry entry for the same machine does not reset the guess budget. */
const PASSWORD_ATTEMPTS_GLOBAL = 9;

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

/**
 * Why this unit cannot take a cap, or null when it can. One source of truth for
 * the per-unit routes and the fleet batch, which reports the reason per unit
 * instead of failing the whole call.
 */
export function gpuClockUnsupportedReason(spark) {
  if (!spark) return "Spark not found";
  if (spark.kind === "host") return "GPU clock caps are only supported on Spark units";
  if (spark.platform === "windows" || spark.platform === "darwin") {
    return "GPU clock caps are only supported on Linux Spark units";
  }
  return null;
}

/** @param {object} spark registry entry */
export function assertSupported(spark) {
  const reason = gpuClockUnsupportedReason(spark);
  if (reason) throw httpError(spark ? 400 : 404, reason);
}

/**
 * The one command line sent over ssh. With a password the outer sh reads it from stdin into
 * the environment of the inner program, which moves it into a plain variable at once; the
 * program itself arrives base64-encoded (no quoting issues, nothing secret in the argv).
 */
export function remoteCommand(program, withPassword) {
  const b64 = Buffer.from(program, "utf8").toString("base64");
  return withPassword
    ? `sh -c 'IFS= read -r SPARKDASH_SUDO_PW; export SPARKDASH_SUDO_PW; echo ${b64} | base64 -d | sh'`
    : `echo ${b64} | base64 -d | sh`;
}

/**
 * Default runner: the program text goes in as one argument, never through a shell string.
 * A sudo password (`input`) travels on stdin (remote) or in the child's environment (local,
 * where it is only readable by the same user and root); it is never part of an argument list.
 */
export function runProgram(spark, program, { timeoutMs = ACTION_TIMEOUT_MS, input = null } = {}) {
  if (!spark.isLocal) {
    const cmd = remoteCommand(program, input != null);
    return sshExec(spark, cmd, input == null ? { timeoutMs } : { timeoutMs, input: `${input}\n` });
  }
  const mntNs = hostMountNs();
  const [file, args] = mntNs
    ? ["nsenter", [`--mount=${mntNs}`, "--", "sh", "-c", program]]
    : ["sh", ["-c", program]];
  const env = scrubbedChildEnv();
  if (input != null) env.SPARKDASH_SUDO_PW = input;
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, env, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 300)));
      else resolve(String(stdout).trim());
    });
  });
}

export class GpuClockManager {
  /** @param {{ run?: typeof runProgram, paths?: object }} [opts] `paths` is a test hook for the program's file locations. */
  constructor({ run = runProgram, paths = {}, holdMs = HOLD_AFTER_TRANSPORT_ERROR_MS, now = Date.now } = {}) {
    this._run = run;
    this._now = now;
    /** @type {Map<string, { n: number, until: number }>} wrong sudo passwords per unit */
    this._pwFails = new Map();
    this._holdMs = holdMs;
    this._paths = paths;
    /** @type {Set<string>} */
    this._busy = new Set();
  }

  async _exec(spark, program, timeoutMs, input = null) {
    let out;
    try {
      out = await this._run(spark, program, { timeoutMs, input });
    } catch (err) {
      let detail = String(err.message || err).slice(0, 200);
      if (input && input.length >= 4) detail = detail.split(input).join("***");
      const e = httpError(502, `Could not reach ${spark.name || spark.id}: ${detail}`);
      e.holdBusy = true;
      throw e;
    }
    return parseProgramOutput(out);
  }

  /** What a password is a guess against: the account on the machine, not the registry entry. */
  _pwKey(spark) {
    if (spark.isLocal) return "local";
    const ssh = spark.ssh || {};
    return `${ssh.user || ""}@${ssh.host || spark.lanIp || spark.id}:${ssh.port || 22}`.toLowerCase();
  }

  /** Refuse further password attempts for a while after repeated wrong ones. */
  _checkPasswordLock(spark) {
    const now = this._now();
    const f = [this._pwFails.get(this._pwKey(spark)), this._pwFails.get("*")]
      .filter((x) => x && x.until > now)
      .sort((x, y) => y.until - x.until)[0];
    if (f) {
      const secs = Math.ceil((f.until - now) / 1000);
      throw httpError(429, `Too many wrong sudo passwords. Try again in ${secs} s.`, "password-locked");
    }
  }

  _bump(key, limit) {
    const f = this._pwFails.get(key) ?? { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= limit) {
      f.until = this._now() + PASSWORD_LOCK_MS;
      f.n = 0;
    }
    this._pwFails.set(key, f);
  }

  _notePasswordResult(spark, wrong) {
    const key = this._pwKey(spark);
    if (!wrong) return void this._pwFails.delete(key);
    this._bump(key, PASSWORD_ATTEMPTS);
    this._bump("*", PASSWORD_ATTEMPTS_GLOBAL);
  }

  _fail(res) {
    const status = CODE_STATUS[res.CODE] ?? 500;
    return httpError(status, res.MSG || "The unit refused the request", res.CODE);
  }

  async _exclusive(spark, fn) {
    if (this._busy.has(spark.id)) throw httpError(409, "Another GPU clock action is still running on this unit");
    this._busy.add(spark.id);
    let hold = false;
    try {
      return await fn();
    } catch (err) {
      hold = err?.holdBusy === true;
      throw err;
    } finally {
      // A timed-out or dropped connection can leave the program still running on the unit.
      if (hold && this._holdMs > 0) {
        setTimeout(() => this._busy.delete(spark.id), this._holdMs).unref?.();
      } else {
        this._busy.delete(spark.id);
      }
    }
  }

  /** Read-only: hardware maximum, current cap, sudo availability, what keeps the
   * cap across boots here, and the state of both boot hooks. */
  async status(spark) {
    assertSupported(spark);
    const res = await this._exec(spark, buildStatusProgram(this._paths), STATUS_TIMEOUT_MS);
    if (res.RESULT !== "ok") {
      // A unit without nvidia-smi is a normal answer for the dialog, not a server error.
      if (res.CODE === "no-nvidia") return { supported: false, reason: res.MSG };
      throw this._fail(res);
    }
    const num = (v) => (/^\d+$/.test(v ?? "") ? Number(v) : null);
    const clocks = (v) => (/^\d+,\d+$/.test(v ?? "") ? v : null);
    return {
      supported: true,
      hwMaxMHz: num(res.HWMAX),
      capMHz: num(res.CAP),
      sudo: ["root", "yes", "no"].includes(res.SUDO) ? res.SUDO : "no",
      /** What "keep after reboot" would use here: the systemd unit, the user's
       * @reboot cron line, or nothing. */
      persistKind: ["unit", "cron", "none"].includes(res.PERSIST_KIND) ? res.PERSIST_KIND : "none",
      service: {
        installed: res.SVC_INSTALLED === "1",
        clocks: clocks(res.SVC_CLOCKS),
        enabled: res.SVC_ENABLED || null,
        active: res.SVC_ACTIVE || null,
      },
      cron: {
        installed: res.CRON_INSTALLED === "1",
        clocks: clocks(res.CRON_CLOCKS),
      },
    };
  }

  /**
   * The paste-into-a-terminal command for running apply/reset on the unit by hand
   * (plain sudo, asks for the password). Needs no access to the unit, so it works
   * when the dashboard itself cannot use sudo or is offline.
   * @param {object} spark
   * @param {{ action?: unknown, maxMHz?: unknown, minMHz?: unknown, persist?: unknown }} query
   */
  command(spark, query = {}) {
    assertSupported(spark);
    const action = query.action;
    if (action === "reset") return { command: buildManualCommand("reset", {}, this._paths) };
    if (action !== "apply") throw httpError(400, "action must be apply or reset");
    // Query strings: only plain digits count as numbers.
    const num = (v, dflt) => (v === undefined ? dflt : typeof v === "string" && /^\d{1,6}$/.test(v) ? Number(v) : NaN);
    const req = parseCapRequest({
      maxMHz: num(query.maxMHz),
      minMHz: num(query.minMHz, 0),
      persist: query.persist === "1" || query.persist === "true",
    });
    return { command: buildManualCommand("apply", req, this._paths) };
  }

  /**
   * Apply a cap; `persist` installs the boot hook the unit can take (systemd unit, else an
   * @reboot cron line). `body.sudoPassword` (optional) is used for sudo on this one call and
   * never stored.
   */
  async apply(spark, body) {
    assertSupported(spark);
    const req = parseCapRequest(body);
    const password = parseSudoPassword(body?.sudoPassword);
    return this._exclusive(spark, async () => {
      const program = buildApplyProgram(req, { ...this._paths, password: password != null });
      const res = await this._privileged(spark, program, password);
      const persisted = res.PERSIST === "1";
      return {
        capMHz: Number(res.CAP) || req.maxMHz,
        persist: persisted,
        persistKind: persisted ? (res.PERSIST_KIND === "cron" ? "cron" : "unit") : "none",
        minMHz: req.minMHz,
      };
    });
  }

  /** Remove the cap and the service. */
  async reset(spark, body = {}) {
    assertSupported(spark);
    const password = parseSudoPassword(body?.sudoPassword);
    return this._exclusive(spark, async () => {
      const program = buildResetProgram({ ...this._paths, password: password != null });
      await this._privileged(spark, program, password);
      return {};
    });
  }

  async _privileged(spark, program, password) {
    if (password != null) this._checkPasswordLock(spark);
    const res = await this._exec(spark, program, ACTION_TIMEOUT_MS, password);
    if (password != null) this._notePasswordResult(spark, res.CODE === "bad-password");
    if (res.RESULT !== "ok") throw this._fail(res);
    return res;
  }
}
