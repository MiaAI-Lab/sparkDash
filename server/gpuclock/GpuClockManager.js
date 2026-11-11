/**
 * Runs the GPU clock cap and power limit programs on a unit: locally through the
 * host mount namespace (as root, like the shutdown helper), or over SSH with `sudo -n`.
 * One action per unit at a time. Clock caps are for Linux Spark units, power limits
 * for Linux GPU hosts (a Spark's GPU reports none).
 */
import { execFile } from "node:child_process";
import { sshExec } from "../collectors/ssh.js";
import { hostMountNs } from "../shutdown.js";
import { scrubbedChildEnv } from "../llmlaunch/childEnv.js";
import { SudoPasswordGuard } from "../util/sudoPasswordGuard.js";
import {
  buildApplyProgram,
  buildManualCommand,
  buildResetProgram,
  buildStatusProgram,
  parseCapRequest,
  parseProgramOutput,
  parseSudoPassword,
} from "./commands.js";
import {
  buildPowerApplyProgram,
  buildPowerStatusProgram,
  parseBootLimits,
  parseCards,
  parsePowerRequest,
} from "./powerCommands.js";

const ACTION_TIMEOUT_MS = 45_000;
const STATUS_TIMEOUT_MS = 15_000;

/** Error codes a program can report, with the HTTP status the route answers with. */
const CODE_STATUS = {
  "no-sudo": 409,
  "no-nvidia": 409,
  "no-gpu": 409,
  "no-systemd": 409,
  busy: 409,
  "lock-failed": 409,
  "no-card": 409,
  "not-adjustable": 409,
  range: 400,
  "bad-output": 502,
  "bad-password": 403,
  // The action reached the unit and failed there (nvidia-smi, systemd, the marker write).
  "lgc-failed": 422,
  "service-failed": 422,
  "cron-failed": 422,
  "rgc-failed": 422,
  "marker-failed": 422,
  "pl-failed": 422,
  "pl-not-held": 422,
};
/** After a transport failure the outcome on the unit is unknown: refuse a second action for a while. */
const HOLD_AFTER_TRANSPORT_ERROR_MS = 30_000;

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

/** @param {object} spark registry entry */
export function assertPowerSupported(spark) {
  if (!spark) throw httpError(404, "Spark not found");
  if (spark.kind !== "host") throw httpError(400, "GPU power limits are only supported on dedicated GPU hosts");
  if (spark.platform === "windows" || spark.platform === "darwin") {
    throw httpError(400, "GPU power limits are only supported on Linux hosts");
  }
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
export function runProgram(spark, program, { timeoutMs = ACTION_TIMEOUT_MS, input = null, maxBuffer = 10 * 1024 * 1024 } = {}) {
  if (!spark.isLocal) {
    const cmd = remoteCommand(program, input != null);
    return sshExec(spark, cmd, input == null ? { timeoutMs, maxBuffer } : { timeoutMs, maxBuffer, input: `${input}\n` });
  }
  const mntNs = hostMountNs();
  const [file, args] = mntNs
    ? ["nsenter", [`--mount=${mntNs}`, "--", "sh", "-c", program]]
    : ["sh", ["-c", program]];
  const env = scrubbedChildEnv();
  if (input != null) env.SPARKDASH_SUDO_PW = input;
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, env, maxBuffer }, (err, stdout, stderr) => {
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
    this._pwGuard = new SudoPasswordGuard({ now });
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

  /** Refuse further password attempts for a while after repeated wrong ones. */
  _checkPasswordLock(spark) {
    const secs = this._pwGuard.lockedForSeconds(spark);
    if (secs > 0) throw httpError(429, `Too many wrong sudo passwords. Try again in ${secs} s.`, "password-locked");
  }

  _notePasswordResult(spark, wrong) {
    this._pwGuard.note(spark, wrong);
  }

  _fail(res) {
    const status = CODE_STATUS[res.CODE] ?? 500;
    return httpError(status, res.MSG || "The unit refused the request", res.CODE);
  }

  async _exclusive(spark, fn) {
    if (this._busy.has(spark.id)) throw httpError(409, "Another GPU action is still running on this unit");
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
        /** The @reboot job ran at this boot and could not re-apply the cap. */
        failed: res.CRON_FAILED === "1",
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

  /** Read-only: each card's limit and range, sudo availability and the boot services. */
  async powerStatus(spark) {
    assertPowerSupported(spark);
    const res = await this._exec(spark, buildPowerStatusProgram(this._paths), STATUS_TIMEOUT_MS);
    if (res.RESULT !== "ok") {
      if (res.CODE === "no-nvidia" || res.CODE === "no-gpu") return { supported: false, reason: res.MSG };
      throw this._fail(res);
    }
    const boot = parseBootLimits(res.SVC_CARD);
    const cards = parseCards(res.CARD).map((card) => ({ ...card, bootW: boot.get(card.uuid) ?? null }));
    if (cards.length === 0) return { supported: false, reason: "nvidia-smi reported no cards on this unit" };
    return {
      supported: true,
      cards,
      sudo: ["root", "yes", "no"].includes(res.SUDO) ? res.SUDO : "no",
      service: {
        installed: res.SVC_INSTALLED === "1",
        enabled: res.SVC_ENABLED || null,
        active: res.SVC_ACTIVE || null,
      },
      otherServices: res.OTHER_SVC ?? [],
    };
  }

  /**
   * Set the power limit of one or more cards; `persist` writes the boot service, and false removes
   * it. `body.sudoPassword` (optional) is used for sudo on this one call and never stored.
   */
  async setPower(spark, body) {
    assertPowerSupported(spark);
    const req = parsePowerRequest(body);
    const password = parseSudoPassword(body?.sudoPassword);
    return this._exclusive(spark, async () => {
      const program = buildPowerApplyProgram(req, { ...this._paths, password: password != null });
      const res = await this._privileged(spark, program, password);
      const cards = parseCards(res.CARD);
      return {
        limits: req.limits.map((l) => ({ ...l, index: cards.find((c) => c.uuid === l.uuid)?.index ?? null })),
        persist: res.PERSIST === "1",
      };
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
