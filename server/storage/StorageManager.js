/**
 * Storage Manager: finds what fills a Spark's disk and cleans it up. Runs the programs in
 * ./scripts on a unit: locally through the host mount namespace (like the GPU clock), or over SSH.
 *
 * - A scan is a background job per unit; its result is kept as a "session" so the page can be left
 *   and reopened, and so drilling into a folder only rescans that folder.
 * - Deleting and removing images happen one at a time per unit.
 * - A sudo password typed in the dashboard is used for one call and never stored.
 */
import { randomUUID } from "node:crypto";
import { runProgram } from "../gpuclock/GpuClockManager.js";
import { SudoPasswordGuard } from "../util/sudoPasswordGuard.js";
import { loadSessions, saveSessions } from "./scanStore.js";
import {
  SCAN_LIMIT_SECONDS,
  SCAN_MAX_ROWS,
  SCAN_PARALLEL,
  buildProgram,
  isContainerId,
  isImageId,
  parseDockerListOutput,
  parseDockerRemoveOutput,
  parseDirsOutput,
  parseScanOutput,
  parseScanRequest,
  parseStatusOutput,
  parseSudoPassword,
  programResult,
  parseContextOutput,
  isQuarantineId,
  parseQuarantineOutput,
  parseAdviseOutput,
} from "./commands.js";
import { RECENT_MINUTES, adviseItem, overallLevel } from "./advice.js";
import { classifyContext, transportOf } from "./context.js";
import { assertDeletable, depthOf, hasUnsafeName, parentOf, parseAbsolutePath, protectedReason, PROTECTED_ROOTS, PROTECTED_TREE_ROOTS } from "./policy.js";
import { AdmissionController } from "./admission.js";
import { defaultContextOf, parseJobOutput, scanPlan, stopReasonText } from "./scanJob.js";
import { parseBuilderPruneOutput, parseOlderThanDays } from "./builderPrune.js";

const STATUS_TIMEOUT_MS = 25_000;
const DELETE_TIMEOUT_MS = 30 * 60_000;
/** Programs that take the unit lock (see unit-state.sh): scans and every change. Add new mutation programs here. */
const UNIT_LOCKED_PROGRAMS = new Set(["scan", "delete", "dockerRemove", "dockerRemoveContainers", "quarantine", "dockerBuilderPrune"]);
/** Stopping a scan: TERM, this long to go, then KILL and this long to be gone. */
const STOP_GRACE_MS = 5_000;
const STOP_KILL_WAIT_MS = 3_000;
const JOB_STATUS_TIMEOUT_MS = 20_000;
/** A scan the dashboard lost track of is checked on the unit this often (backing off to the maximum). */
const RECONCILE_MS = 10_000;
const RECONCILE_MAX_MS = 60_000;
/** The unit starts a program a little after the dashboard asked (connecting): margin for "stops by itself at". */
const START_MARGIN_MS = 30_000;
const DOCKER_LIST_TIMEOUT_MS = 3 * 60_000;
const DOCKER_REMOVE_TIMEOUT_MS = 20 * 60_000;
const MAX_CONTAINERS_PER_REQUEST = 200;
/** After a transport failure the outcome on the unit is unknown: refuse a second change for a while. */
const HOLD_AFTER_TRANSPORT_ERROR_MS = 30_000;
const MAX_IMAGES_PER_REQUEST = 200;
/** Scan output can hold thousands of rows. */
const SCAN_MAX_BUFFER = 32 * 1024 * 1024;
/** Execution-context probe: how long to wait, and how long an answer (or a failure) is reused. */
const CONTEXT_TIMEOUT_MS = 20_000;
const CONTEXT_TTL_MS = 10 * 60_000;
const CONTEXT_FAIL_TTL_MS = 15_000;
/** The delete advisor: the unit's time for all its checks, and how long the dashboard waits (connecting included). */
export const ADVISE_BUDGET_SECONDS = 20;
const ADVISE_TIMEOUT_MS = (ADVISE_BUDGET_SECONDS + 25) * 1000;

/** Error codes a program can report, with the HTTP status the route answers with. */
const CODE_STATUS = {
  "no-sudo": 409,
  "no-bash": 409,
  "no-sh": 409,
  "bad-password": 403,
  "not-found": 404,
  "bad-path": 400,
  "symlinked-path": 409,
  mountpoint: 409,
  permission: 403,
  readonly: 409,
  "rm-failed": 422,
  "no-docker": 409,
  "docker-denied": 403,
  "docker-down": 409,
  "bad-output": 502,
  "unit-busy": 409,
  "no-state": 409,
  "bad-job": 400,
  // Delete v2 (scripts/delete.sh, quarantine.sh).
  protected: 403,
  "protected-descendant": 403,
  "staging-unavailable": 409,
  "tree-writable-by-others": 409,
  "no-ack": 409,
  "no-perl": 409,
  changed: 409,
  "quarantine-unavailable": 409,
  "restore-conflict": 409,
  "restore-failed": 422,
  "parent-missing": 409,
  "payload-present": 409,
  "bad-record": 409,
  // Docker build cache (scripts/docker-builder-prune.sh).
  "bad-args": 400,
  "builder-unknown": 409,
  "prune-failed": 422,
};

/** Refusals of an administrator delete that the person can still do by hand: the answer carries the command. */
const MANUAL_DELETE_CODES = new Set(["staging-unavailable", "tree-writable-by-others", "no-ack"]);

/** Most paths one bulk delete takes. */
export const MAX_BULK_DELETE_PATHS = 200;
/** A bulk delete starts no new item after this long; what is left is reported as skipped. */
const BULK_DELETE_LIMIT_MS = 45 * 60_000;
/**
 * Answers that end a bulk delete at once, the rest reported as skipped: a wrong password (more tries would only
 * burn guesses), the acknowledgement is missing, contact was lost (the outcome is unknown), another dashboard or
 * change holds the Spark, or the Spark lacks what every delete needs (sudo, perl, its state folder, a shell).
 */
const BULK_STOP_CODES = new Set(["bad-password", "password-locked", "no-ack", "unreachable", "busy", "unit-busy", "scan-running", "no-sudo", "no-perl", "no-state", "no-sh", "no-bash"]);
/** What the items after a stop are told. */
const BULK_SKIP_REASONS = {
  "bad-password": "Not tried: the sudo password was not accepted.",
  "password-locked": "Not tried: too many wrong sudo passwords.",
  "no-ack": "Not tried: deleting folders as administrator is off for this Spark.",
  unreachable: "Not tried: the dashboard lost contact with the Spark.",
  "time-limit": "Not tried: the bulk delete reached its 45-minute limit.",
};
const bulkSkipReason = (code) => BULK_SKIP_REASONS[code] ?? "Not tried: the bulk delete stopped before it.";

/**
 * The paths of a bulk delete, each checked as a single delete checks it. One bad path refuses the whole request
 * (its error names the path). Exact repeats are dropped; a path inside another listed path is `covered` (deleting
 * the outer one removes it) and not run on its own. `run` keeps the order given.
 * @param {unknown} input
 * @returns {{ run: string[], covered: string[] }}
 */
export function parseDeletePaths(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_BULK_DELETE_PATHS) {
    throw httpError(400, `paths must be a list of 1 to ${MAX_BULK_DELETE_PATHS} absolute paths`, "bad-paths");
  }
  const unique = [];
  const seen = new Set();
  for (const raw of input) {
    let p;
    try {
      p = parseAbsolutePath(raw);
      assertDeletable(p);
    } catch (err) {
      const shown = typeof raw === "string" && !hasUnsafeName(raw) ? raw.slice(0, 300) : null;
      throw httpError(err.status ?? 400, shown ? `${shown}: ${err.message}` : `One of the paths: ${err.message}`, err.code ?? "bad-path", { path: typeof raw === "string" ? raw.slice(0, 4096) : null });
    }
    if (!seen.has(p)) {
      seen.add(p);
      unique.push(p);
    }
  }
  const run = [];
  const covered = [];
  for (const p of unique) (unique.some((q) => p.startsWith(`${q}/`)) ? covered : run).push(p);
  return { run, covered };
}

/** Sudo ran the program (the answer came from after the sudo gate), so a typed password was accepted. */
const sudoAccepted = (out) => {
  const text = String(out ?? "");
  return /^RESULT=(ok|error)$/m.test(text) && !/^CODE=(bad-password|no-sudo)$/m.test(text);
};
const shellQuote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

const httpError = (status, message, code, extra) => Object.assign(new Error(message), { status, code }, extra);

/** @param {object} spark registry entry */
export function assertSupported(spark) {
  if (!spark) throw httpError(404, "Spark not found");
  if (spark.kind === "host") throw httpError(400, "Storage Manager only supports DGX Spark units for now");
  if (spark.platform === "windows" || spark.platform === "darwin") {
    throw httpError(400, "Storage Manager only supports Linux DGX Spark units for now");
  }
}

/**
 * `sudo`, `sudoPassword` and `remember` from a request body. A password without `sudo: true` is a mistake,
 * not a hint. `remember` asks to keep a typed password (once sudo has accepted it) for next time.
 */
export function parseElevation(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  if (b.sudo !== undefined && typeof b.sudo !== "boolean") throw httpError(400, "sudo must be true or false");
  if (b.remember !== undefined && typeof b.remember !== "boolean") throw httpError(400, "remember must be true or false");
  const password = parseSudoPassword(b.sudoPassword);
  if (password != null && b.sudo !== true) throw httpError(400, "sudoPassword needs sudo: true");
  return { elevate: b.sudo === true, password, remember: b.remember === true && password != null };
}

/**
 * @typedef {{ path: string, bytes: number, type: "dir" | "file" | "link" | "other",
 *   expanded: boolean, locked: string | null, unsafe?: true, sharedBytes?: number, modifiedAt?: number }} StorageEntry
 *   `bytes` counts every file once (what `du -s` of the folder alone says). `sharedBytes`, when present, is the
 *   part held by files that also have hard links outside the folder: deleting the folder does not free it.
 *   `modifiedAt`, when known: the newest modification time of anything in it (its own for a file or a link),
 *   in whole seconds since 1970, as the unit's clock had it.
 * @typedef {{ revision: number, root: string, scannedAt: number, analysedAt: number, elevated: boolean, unreadable: number,
 *   timedOut: boolean, hardlinks: "exact" | "approx", dated: boolean, entries: Map<string, StorageEntry> }} Session
 *   `dated`: the analysis recorded modification times (the basic scan and analyses from before them did not).
 */

export class StorageManager {
  /**
   * @param {{ run?: typeof runProgram, now?: () => number, holdMs?: number,
   *   vault?: import("./sudoVault.js").SudoVault | null, scansFile?: string | null }} [opts]
   *   `vault`: remembered sudo passwords. `scansFile`: where the latest analysis per unit is kept.
   *   `context`: execution-context probe settings (`transport` decides ssh / nsenter / local, as runProgram does).
   *   `admission`: decides what storage work may start (one per Spark, two heavy jobs per fleet).
   *   `jobContext(spark)`: how a scan's processes can be reached (see scanJob.js defaultContextOf).
   *   `reconcileMs`, `stopGraceMs`, `stopKillWaitMs`: scan stop and follow-up timings (shorter in tests).
   *   `acks`: per-Spark acknowledgements for administrator folder deletes (ackStore.js).
   *   `protectedPaths`: more folders a delete never removes or reaches into (the dashboard's config and install).
   */
  constructor({
    run = runProgram,
    now = Date.now,
    holdMs = HOLD_AFTER_TRANSPORT_ERROR_MS,
    vault = null,
    scansFile = null,
    context = {},
    admission = new AdmissionController({ now }),
    jobContext = defaultContextOf,
    reconcileMs = RECONCILE_MS,
    stopGraceMs = STOP_GRACE_MS,
    stopKillWaitMs = STOP_KILL_WAIT_MS,
    acks = null,
    protectedPaths = [],
    bulkLimitMs = BULK_DELETE_LIMIT_MS,
  } = {}) {
    this._bulkLimitMs = bulkLimitMs;
    /** @type {Map<string, object>} the latest bulk delete per unit (kept after it ends, for a page opened later) */
    this._bulkJobs = new Map();
    /** @type {Map<string, Promise<void>>} */
    this._bulkPending = new Map();
    /** @type {import("./ackStore.js").ElevatedDeleteAcks | null} who may delete folders as administrator, per Spark */
    this._acks = acks;
    // What the delete program refuses to remove or reach into: policy.js's list plus the dashboard's own folders.
    const own = protectedPaths.filter((p) => typeof p === "string" && p.startsWith("/"));
    this._protectedArg = [...PROTECTED_ROOTS, ...own].join("\n");
    // Where nothing is ever put back by a restore.
    this._treesArg = [...PROTECTED_TREE_ROOTS, ...own].join("\n");
    this._admission = admission;
    this._jobContext = jobContext;
    this._reconcileMs = reconcileMs;
    this._stopGraceMs = stopGraceMs;
    this._stopKillWaitMs = stopKillWaitMs;
    /** @type {Map<string, Promise<void>>} a stop request per unit, while it runs */
    this._stopping = new Map();
    this._contextOpts = { transport: transportOf, ttlMs: CONTEXT_TTL_MS, failTtlMs: CONTEXT_FAIL_TTL_MS, ...context };
    /** @type {Map<string, { key: string, at: number, value: object | null, error: Error | null, promise: Promise<object> | null }>} */
    this._contexts = new Map();
    this._run = run;
    this._now = now;
    this._holdMs = holdMs;
    this._guard = new SudoPasswordGuard({ now });
    /** @type {Map<string, object>} latest scan job per unit */
    this._jobs = new Map();
    /** @type {Map<string, Promise<void>>} */
    this._pending = new Map();
    this._vault = vault;
    this._scansFile = scansFile;
    const loaded = loadSessions(scansFile);
    /** @type {Map<string, Session>} */
    this._sessions = loaded.sessions;
    this._revision = loaded.revision;
  }

  /** Keep the analyses on disk. A failure is logged: the analysis is still on screen. */
  _persist() {
    try {
      saveSessions(this._scansFile, this._sessions, this._revision);
    } catch (err) {
      console.error(`[storage] Could not save the analysis: ${err.message}`);
    }
  }

  /** Resolves when the unit's scan job (if any) and a stop request for it have finished. For tests and shutdown. */
  async settled(sparkId) {
    await this._pending.get(sparkId);
    await this._stopping.get(sparkId);
    await this._bulkPending.get(sparkId);
  }

  _checkPasswordLock(spark) {
    const secs = this._guard.lockedForSeconds(spark);
    if (secs > 0) throw httpError(429, `Too many wrong sudo passwords. Try again in ${secs} s.`, "password-locked");
  }

  /**
   * Run a program and return its raw output. A transport failure is a 502 that marks the outcome unknown.
   * @param {object} spark
   * @param {Parameters<typeof buildProgram>[0]} name
   * @param {{ args?: (string | number)[], elevate?: boolean, password?: string | null, timeoutMs: number, maxBuffer?: number,
   *   job?: string | null, hardLimitSeconds?: number }} o  `job`, `hardLimitSeconds`: see buildProgram.
   */
  async _exec(spark, name, { args = [], elevate = false, password = null, remember = false, timeoutMs, maxBuffer, job = null, hardLimitSeconds = 0 }) {
    const account = this._guard.key(spark);
    // No password typed: use the one remembered for this account, if any.
    let fromVault = false;
    if (elevate && password == null && this._vault) {
      const saved = this._vault.get(account);
      if (saved != null) {
        password = saved;
        fromVault = true;
      }
    }
    const usePassword = elevate && password != null;
    if (usePassword) this._checkPasswordLock(spark);
    const program = buildProgram(name, { args, elevate, password: usePassword, unitLock: UNIT_LOCKED_PROGRAMS.has(name), job, hardLimitSeconds });
    let out;
    try {
      // `name` and `args` are for test runners; runProgram ignores them.
      out = await this._run(spark, program, { timeoutMs, input: usePassword ? password : null, maxBuffer, name, args });
    } catch (err) {
      let detail = String(err.message || err);
      // Scrub the password from the whole message first, then shorten it.
      if (usePassword && password.length > 0) detail = detail.split(password).join("***");
      detail = detail.slice(0, 200);
      throw httpError(502, `Could not reach ${spark.name || spark.id}: ${detail}`, "unreachable", { holdBusy: true });
    }
    if (usePassword) {
      const text = String(out);
      const wrong = /^CODE=bad-password$/m.test(text);
      // Sudo accepted the password only when the program itself answered after the sudo gate: a well-formed
      // RESULT line that is not "wrong password" or "no sudo". An empty, truncated or noisy answer proves
      // nothing, so it neither clears the wrong-guess count nor remembers anything.
      const accepted = /^RESULT=(ok|error)$/m.test(text) && !wrong && !/^CODE=no-sudo$/m.test(text);
      if (wrong) {
        this._guard.note(spark, true);
        // A remembered password that sudo no longer accepts is dropped, so the page asks for a new one.
        if (fromVault) this._vault.delete(account);
      } else if (accepted) {
        this._guard.note(spark, false);
        if (remember && !fromVault && this._vault) {
          try {
            this._vault.set(account, password);
          } catch (err) {
            console.error(`[storage] Could not remember the sudo password: ${err.message}`);
          }
        }
      }
    }
    return out;
  }

  /** Whether a sudo password is remembered for this unit's account. */
  hasSavedSudo(spark) {
    return Boolean(this._vault?.has(this._guard.key(spark)));
  }

  /** Forget the remembered sudo password for this unit's account. */
  forgetSudo(spark) {
    assertSupported(spark);
    return { forgotten: Boolean(this._vault?.delete(this._guard.key(spark))) };
  }

  _fail(res, extra) {
    return httpError(CODE_STATUS[res.code] ?? 500, res.message, res.code, extra);
  }

  /** A change on the unit, exclusive per Spark (admission refuses `busy`, or `scan-running` while a scan holds it). */
  async _exclusive(spark, fn) {
    const ticket = this._admission.admit(spark.id, { kind: "mutation", label: "change" });
    let hold = false;
    try {
      return await fn();
    } catch (err) {
      hold = err?.holdBusy === true;
      throw err;
    } finally {
      // A timed-out or dropped connection can leave the program still running on the unit (it also keeps the
      // unit lock, so another dashboard cannot start meanwhile).
      if (hold && this._holdMs > 0) setTimeout(() => ticket.release(), this._holdMs).unref?.();
      else ticket.release();
    }
  }

  // ─── Overview ──────────────────────────────────────────────

  /** Read-only: disks, sudo availability and whether Docker answers. */
  async status(spark) {
    assertSupported(spark);
    let out;
    try {
      out = await this._exec(spark, "status", { timeoutMs: STATUS_TIMEOUT_MS });
    } catch (err) {
      // Unreachable: whatever the context probe found may no longer hold (reboot, new host).
      if (err?.code === "unreachable") this.invalidateContext(spark.id);
      throw err;
    }
    const res = parseStatusOutput(out);
    if (!res.ok) throw this._fail(res);
    const { ok: _ok, bootId, ...status } = res;
    // Rebooted since the context was probed: probe again next time.
    const cached = this._contexts.get(spark.id)?.value;
    if (cached && bootId && cached.bootId && cached.bootId !== bootId) this.invalidateContext(spark.id);
    return { ...status, sudoSaved: this.hasSavedSudo(spark), elevatedDeleteAck: this.elevatedDeleteAck(spark) };
  }

  // ─── Execution context (roadmap §4) ────────────────────────

  /** What the cached context is valid for: the way the unit is reached and the account on it. */
  _contextKey(spark) {
    return `${this._contextOpts.transport(spark)}|${this._guard.key(spark)}`;
  }

  /**
   * Who and where the Storage Manager's programs run as on this Spark, probed once and cached: a success for
   * `ttlMs`, a failure for the much shorter `failTtlMs`. The cache is dropped when the way the unit is reached
   * or its account changes, when it cannot be reached, and when its boot id changes (see status()).
   * @param {object} spark
   * @param {{ refresh?: boolean }} [opts]
   */
  async context(spark, { refresh = false } = {}) {
    assertSupported(spark);
    const key = this._contextKey(spark);
    const hit = this._contexts.get(spark.id);
    if (!refresh && hit && hit.key === key) {
      if (hit.promise) return hit.promise;
      const age = this._now() - hit.at;
      if (hit.value && age < this._contextOpts.ttlMs) return hit.value;
      if (hit.error && age < this._contextOpts.failTtlMs) throw hit.error;
    }
    const transport = this._contextOpts.transport(spark);
    const entry = { key, at: this._now(), value: null, error: null, promise: null };
    entry.promise = (async () => {
      try {
        const out = await this._exec(spark, "context", { timeoutMs: CONTEXT_TIMEOUT_MS });
        const res = parseContextOutput(out);
        if (!res.ok) throw this._fail(res);
        const { ok: _ok, ...facts } = res;
        entry.value = { kind: classifyContext(transport, facts), transport, ...facts, probedAt: this._now() };
        return entry.value;
      } catch (err) {
        entry.error = err;
        throw err;
      } finally {
        entry.at = this._now();
        entry.promise = null;
      }
    })();
    this._contexts.set(spark.id, entry);
    return entry.promise;
  }

  /** The cached context when it is still valid, else null. Never probes: for features deciding what to offer. */
  contextOf(spark) {
    const hit = spark ? this._contexts.get(spark.id) : null;
    if (!hit?.value || hit.key !== this._contextKey(spark) || this._now() - hit.at >= this._contextOpts.ttlMs) return null;
    return hit.value;
  }

  invalidateContext(sparkId) {
    this._contexts.delete(sparkId);
  }

  /**
   * The folders directly inside `path`, for the folder picker. Read-only, runs as the unit's account.
   * @param {object} spark
   * @param {unknown} path
   */
  async listFolders(spark, path) {
    assertSupported(spark);
    const dir = parseAbsolutePath(path ?? "/");
    const out = await this._exec(spark, "dirs", { args: [dir], timeoutMs: STATUS_TIMEOUT_MS });
    const res = parseDirsOutput(out);
    if (!res.ok) throw this._fail(res);
    return { path: dir, dirs: res.dirs, more: res.more };
  }

  // ─── Scanning ──────────────────────────────────────────────

  /**
   * The job as the page sees it. `holdsSpark`: the Spark stays busy for this job (other storage work is refused)
   * because its processes may still run on the unit; `holdReason` says why ("running" | "stopping" |
   * "unconfirmed" | "unreachable") and `holdUntil`, when known, is when the unit's own limit ends it.
   */
  _publicJob(job) {
    if (!job) return null;
    const { id, state, path, depth, mode, elevated, startedAt, finishedAt, error, cancellable, cancelBestEffort, stopsByItselfAt } = job;
    const hold = job.hold;
    return {
      id,
      state,
      path,
      depth,
      mode,
      elevated,
      startedAt,
      finishedAt,
      error,
      cancellable,
      cancelBestEffort,
      stopsByItselfAt,
      stop: job.stop ? { requestedAt: job.stop.requestedAt, outcome: job.stop.outcome, message: job.stop.message } : null,
      holdsSpark: hold != null,
      holdReason: hold?.reason ?? null,
      holdUntil: hold == null ? null : job.viaSudo ? job.stopsByItselfAt : hold.reason === "unreachable" ? job.deadlineAt : null,
    };
  }

  /**
   * What the page needs: the latest job and, when it changed since `sinceRevision`, the session.
   * @param {object} spark
   * @param {number | null} [sinceRevision]
   */
  snapshot(spark, sinceRevision = null) {
    assertSupported(spark);
    const session = this._sessions.get(spark.id) ?? null;
    const job = this._publicJob(this._jobs.get(spark.id));
    if (!session) return { job, revision: 0, session: null };
    const out = { job, revision: session.revision, session: null };
    if (sinceRevision !== session.revision) {
      out.session = {
        root: session.root,
        scannedAt: session.scannedAt,
        analysedAt: session.analysedAt,
        elevated: session.elevated,
        unreadable: session.unreadable,
        timedOut: session.timedOut,
        hardlinks: session.hardlinks,
        dated: session.dated === true,
        entries: [...session.entries.values()].sort((a, b) => b.bytes - a.bytes),
      };
    }
    return out;
  }

  /**
   * Start a background scan. `mode: "new"` replaces what the page shows; `"drill"` rescans one
   * folder and swaps it into the existing result.
   * @param {object} spark
   * @param {unknown} body `{ path?, depth?, mode?, sudo?, sudoPassword? }`
   */
  startScan(spark, body) {
    assertSupported(spark);
    const req = parseScanRequest(body);
    const { elevate, password, remember } = parseElevation(body);
    const plan = scanPlan(this._jobContext(spark), elevate);
    const startedAt = this._now();
    const job = {
      id: randomUUID(),
      state: "running",
      path: req.path,
      depth: req.depth,
      mode: req.mode,
      elevated: elevate,
      startedAt,
      finishedAt: null,
      error: null,
      cancellable: plan.cancellable,
      cancelBestEffort: plan.cancelBestEffort,
      // Through sudo the scan runs as root and cannot be stopped from here: the unit ends it by then.
      stopsByItselfAt: plan.viaSudo ? startedAt + plan.limits.stopsWithinMs + START_MARGIN_MS : null,
      stop: null,
      // While set, the Spark stays busy for this scan (admission ticket held).
      hold: { reason: "running" },
      viaSudo: plan.viaSudo,
      // By then nothing of the scan runs on the unit any more (its own deadline), even if never heard back.
      deadlineAt: startedAt + plan.limits.stopsWithinMs + START_MARGIN_MS,
      ticket: null,
      execDone: false,
      reconcileTimer: null,
      reconcileFailures: 0,
    };
    job.ticket = this._admission.admit(spark.id, { kind: "heavy", label: "scan", refusal: () => this._scanRefusal(job) });
    try {
      if (elevate && password != null) this._checkPasswordLock(spark);
    } catch (err) {
      job.ticket.release();
      throw err;
    }
    this._jobs.set(spark.id, job);
    const finish = (state, error = null) => {
      if (job.state !== "running") return;
      job.state = state;
      job.error = error;
      job.finishedAt = this._now();
    };
    // Errors raised here carry a status and a curated message; anything else stays generic.
    const errorOf = (err) => {
      const known = Number.isInteger(err?.status);
      return { code: known ? err.code ?? "failed" : "failed", message: known ? err.message : "The scan failed" };
    };
    const work = (async () => {
      let out;
      try {
        out = await this._exec(spark, "scan", {
          args: [req.path, req.depth, plan.limits.limitSeconds, SCAN_MAX_ROWS, SCAN_PARALLEL, plan.limits.deadlineSeconds],
          elevate,
          password,
          remember,
          timeoutMs: plan.limits.stopsWithinMs + 60_000,
          maxBuffer: SCAN_MAX_BUFFER,
          job: job.id,
          hardLimitSeconds: plan.limits.hardLimitSeconds,
        });
      } catch (err) {
        finish("error", errorOf(err));
        // Lost contact (or a stop ended the program): whether anything still runs on the unit is unknown.
        // Anything else was refused before the program started.
        this._scanEnded(spark, job, err?.code !== "unreachable");
        return;
      }
      this._scanEnded(spark, job, true);
      if (job.state !== "running") return; // stopped while it ran
      try {
        const parsed = parseScanOutput(out, req.path, SCAN_MAX_ROWS);
        if (!parsed.ok) throw this._fail(parsed);
        if (!parsed.rows.some((r) => r.path === req.path)) {
          throw httpError(502, "The scan did not report the folder itself", "bad-output");
        }
        this._merge(spark.id, req, elevate, parsed);
        finish("done");
      } catch (err) {
        finish("error", errorOf(err));
      }
    })();
    this._pending.set(spark.id, work);
    return this._publicJob(job);
  }

  /** What another request is told while a scan keeps the Spark busy. */
  _scanRefusal(job) {
    const reason = job.hold?.reason;
    const message =
      reason === "stopping"
        ? "The scan on this Spark is being stopped. Try again once it has stopped."
        : reason === "unconfirmed"
          ? "The last scan on this Spark could not be confirmed stopped, so the Spark stays busy until it is."
          : reason === "unreachable"
            ? "The dashboard lost contact with this Spark during a scan, so the Spark stays busy until it can confirm the scan has ended."
            : "A scan is still running on this Spark. Wait for it to finish or stop it first.";
    return { status: 409, code: "scan-running", message };
  }

  /**
   * The scan program returned. `clean`: the unit answered (or the program never started), so it has ended there;
   * otherwise contact was lost and it may still be running.
   */
  _scanEnded(spark, job, clean) {
    job.execDone = true;
    if (job.hold == null) return;
    const stop = job.stop?.outcome;
    if (stop === "pending") return; // the stop request decides
    if (clean && !stop) return this._releaseScan(job);
    if (clean) {
      // A stop was not confirmed, but the program has ended now: check nothing of it is left.
      this._scheduleReconcile(spark, job, 0);
      return;
    }
    job.hold.reason = stop ? "unconfirmed" : "unreachable";
    this._scheduleReconcile(spark, job, this._reconcileMs);
  }

  _releaseScan(job) {
    if (job.hold == null) return;
    job.hold = null;
    if (job.reconcileTimer) clearTimeout(job.reconcileTimer);
    job.reconcileTimer = null;
    job.ticket?.release();
  }

  /**
   * Stop the scan on the unit: its processes get TERM, then KILL, and the unit checks nothing of it is left.
   * Answers at once with the job "stopping"; the outcome follows in the job's `stop`. The Spark stays busy
   * until the stop is confirmed or later reconciled. Not offered for a scan that runs through sudo.
   */
  cancelScan(spark) {
    assertSupported(spark);
    const job = this._jobs.get(spark.id);
    if (!job || job.hold == null) return this._publicJob(job);
    if (!job.cancellable) {
      const mins = Math.max(1, Math.ceil(((job.stopsByItselfAt ?? job.deadlineAt) - this._now()) / 60_000));
      throw httpError(
        409,
        `A scan run as administrator cannot be stopped from the dashboard. The Spark stops it by itself within ${mins} minute${mins === 1 ? "" : "s"}.`,
        "not-cancellable"
      );
    }
    if (job.stop?.outcome === "pending") return this._publicJob(job);
    if (job.state === "running") job.state = "stopping";
    job.stop = { requestedAt: this._now(), outcome: "pending", reason: null, message: null };
    job.hold.reason = "stopping";
    if (job.reconcileTimer) clearTimeout(job.reconcileTimer);
    job.reconcileTimer = null;
    const work = this._stopScan(spark, job).finally(() => {
      if (this._stopping.get(spark.id) === work) this._stopping.delete(spark.id);
    });
    this._stopping.set(spark.id, work);
    return this._publicJob(job);
  }

  async _stopScan(spark, job) {
    let res;
    try {
      const out = await this._exec(spark, "job", {
        args: ["cancel", job.id, this._stopGraceMs, this._stopKillWaitMs],
        timeoutMs: this._stopGraceMs + this._stopKillWaitMs + JOB_STATUS_TIMEOUT_MS,
      });
      res = parseJobOutput("cancel", out);
      if (!res.ok) res = { outcome: "unknown", reason: res.code };
    } catch {
      res = { outcome: "unknown", reason: "unreachable" };
    }
    if (job.hold == null) return;
    if (res.outcome === "terminated" || res.outcome === "already-gone") {
      const message = res.outcome === "terminated" ? "Stopped. Nothing of the scan is left running on the Spark." : "The scan had already ended on the Spark.";
      job.stop = { ...job.stop, outcome: res.outcome, reason: res.reason, message };
      if (job.state === "stopping") {
        job.state = "cancelled";
        job.finishedAt = this._now();
      }
      this._releaseScan(job);
      return;
    }
    job.stop = {
      ...job.stop,
      outcome: res.outcome,
      reason: res.reason,
      message: `Could not confirm it stopped — the Spark stays busy until it does. ${stopReasonText(res.reason)}`,
    };
    job.hold.reason = "unconfirmed";
    this._scheduleReconcile(spark, job, job.execDone ? 0 : this._reconcileMs);
  }

  _scheduleReconcile(spark, job, delayMs) {
    if (job.hold == null) return;
    if (job.reconcileTimer) clearTimeout(job.reconcileTimer);
    job.reconcileTimer = setTimeout(() => {
      job.reconcileTimer = null;
      void this._reconcile(spark, job);
    }, Math.max(0, delayMs));
    job.reconcileTimer.unref?.();
  }

  /** Ask the unit whether anything of a scan the dashboard lost track of still runs; release the Spark once not. */
  async _reconcile(spark, job) {
    if (job.hold == null || job.stop?.outcome === "pending") return;
    if (job.viaSudo) {
      // Root's processes are not this account's to check; the unit's own limit (run as root) ends them.
      const left = job.stopsByItselfAt - this._now();
      if (left <= 0) this._settleHold(job, "time-limit");
      else this._scheduleReconcile(spark, job, left);
      return;
    }
    let res = null;
    try {
      res = parseJobOutput("status", await this._exec(spark, "job", { args: ["status", job.id], timeoutMs: JOB_STATUS_TIMEOUT_MS }));
    } catch {
      res = null;
    }
    if (job.hold == null || job.stop?.outcome === "pending") return;
    // Gone; or the check could not run but nothing at all holds the unit lock (every process of the scan does).
    if (res?.ok && (res.state === "gone" || (res.state === "unknown" && res.lock === "free"))) return this._settleHold(job, "confirmed");
    // Never heard back: by the scan's own deadline on the unit nothing of it runs any more.
    if (!res?.ok && job.hold.reason === "unreachable" && this._now() >= job.deadlineAt) return this._settleHold(job, "deadline");
    job.reconcileFailures = res?.ok ? 0 : job.reconcileFailures + 1;
    this._scheduleReconcile(spark, job, Math.min(RECONCILE_MAX_MS, this._reconcileMs * 2 ** job.reconcileFailures));
  }

  /** The scan is known to have ended on the unit (`how`: confirmed there, or past its own limit). */
  _settleHold(job, how) {
    if (job.stop && job.stop.outcome !== "terminated" && job.stop.outcome !== "already-gone") {
      job.stop = {
        ...job.stop,
        outcome: "terminated",
        message: how === "confirmed" ? "Stopped: the Spark has confirmed nothing of the scan is left running." : "The scan has reached its time limit on the Spark.",
      };
    }
    if (job.state === "stopping") {
      job.state = "cancelled";
      job.finishedAt = this._now();
    }
    this._releaseScan(job);
  }

  _merge(sparkId, req, elevated, parsed) {
    const rootDepth = depthOf(req.path);
    /** @type {Map<string, StorageEntry>} */
    let entries = new Map();
    const prev = this._sessions.get(sparkId);
    if (req.mode === "drill" && prev) {
      entries = prev.entries;
      const before = entries.get(req.path)?.bytes;
      const self = parsed.rows.find((r) => r.path === req.path);
      const after = self?.bytes;
      for (const p of [...entries.keys()]) if (p === req.path || p.startsWith(req.path === "/" ? "/" : `${req.path}/`)) entries.delete(p);
      // The folder grew or shrank since the first scan: keep its parents' totals in line.
      if (before != null && after != null && before !== after) this._adjustAncestors(entries, req.path, after - before);
      // Something in it changed since: its parents changed then too. Dates only move forward here: a parent's
      // date is the newest of everything in it, and without measuring the rest again nobody knows whether this
      // folder held that newest item, so an older answer leaves it as it was. A parent without a date keeps none.
      if (self?.modifiedAt != null) this._raiseAncestorDates(entries, req.path, self.modifiedAt);
    }
    for (const row of parsed.rows) {
      const unsafe = hasUnsafeName(row.path);
      /** @type {StorageEntry} */
      const entry = {
        path: row.path,
        bytes: row.bytes,
        type: row.type,
        expanded: row.type === "dir" && !unsafe && depthOf(row.path) - rootDepth < req.depth,
        locked: protectedReason(row.path),
      };
      if (unsafe) entry.unsafe = true;
      if (row.sharedBytes > 0) entry.sharedBytes = Math.min(row.sharedBytes, row.bytes);
      if (Number.isSafeInteger(row.modifiedAt) && row.modifiedAt >= 0) entry.modifiedAt = row.modifiedAt;
      entries.set(row.path, entry);
    }
    const drilled = req.mode === "drill" && prev;
    this._sessions.set(sparkId, {
      revision: ++this._revision,
      root: drilled ? prev.root : req.path,
      scannedAt: this._now(),
      // When the analysis was made. Looking inside a folder later refreshes that folder only.
      analysedAt: drilled ? prev.analysedAt : this._now(),
      // These describe the whole analysis, not the one folder just looked inside: keep them, so
      // "some folders could not be opened" does not disappear after opening a readable subfolder.
      elevated: drilled ? prev.elevated : elevated,
      unreadable: drilled ? Math.max(prev.unreadable, parsed.unreadable) : parsed.unreadable,
      timedOut: drilled ? prev.timedOut || parsed.timedOut : parsed.timedOut,
      // "exact": every file counted once. Anything less in either scan makes the whole result approximate.
      hardlinks: drilled && prev.hardlinks !== "exact" ? "approx" : parsed.hardlinks,
      // Like `elevated`, this describes the analysis: whether the scan that made it recorded dates.
      dated: drilled ? prev.dated === true : parsed.dated === true,
      entries,
    });
    this._persist();
  }

  _adjustAncestors(entries, path, delta) {
    for (let p = parentOf(path); p != null; p = parentOf(p)) {
      const e = entries.get(p);
      if (e) e.bytes = Math.max(0, e.bytes + delta);
    }
  }

  /** Folders above `path` that have a date get at least `time` (see _merge). */
  _raiseAncestorDates(entries, path, time) {
    for (let p = parentOf(path); p != null; p = parentOf(p)) {
      const e = entries.get(p);
      if (e?.modifiedAt != null && e.modifiedAt < time) e.modifiedAt = time;
    }
  }

  /**
   * Drop a deleted path (and everything under it) from the session and shrink its parents. `persist: false`
   * leaves saving to the caller (a bulk delete saves once at the end; the page reads the session from memory).
   */
  _forget(sparkId, path, persist = true) {
    const session = this._sessions.get(sparkId);
    const entry = session?.entries.get(path);
    if (!session || !entry) return;
    for (const p of [...session.entries.keys()]) if (p === path || p.startsWith(`${path}/`)) session.entries.delete(p);
    // The folders above shrink by what was really freed: bytes held by files that still have a link elsewhere stay.
    // Their dates are left as they are: working out the newest of what remains would need another scan (and the
    // delete itself has just changed the folder it was in), so they read as of the analysis.
    this._adjustAncestors(session.entries, path, -(entry.bytes - (entry.sharedBytes ?? 0)));
    session.revision = ++this._revision;
    if (persist) this._persist();
  }

  // ─── Deleting ──────────────────────────────────────────────

  /**
   * Delete one file or folder, permanently (delete v2, scripts/delete.sh: staged, checked, then deleted).
   * `sudo` / `sudoPassword` run it as root; a folder then also needs this Spark's acknowledgement.
   * @param {object} spark
   * @param {unknown} body `{ path, sudo?, sudoPassword? }`
   */
  async delete(spark, body) {
    assertSupported(spark);
    const path = parseAbsolutePath(body?.path);
    assertDeletable(path);
    const { elevate, password, remember } = parseElevation(body);
    return this._exclusive(spark, async () => {
      const args = [path, randomUUID(), this._ackFlag(spark, elevate), this._protectedArg];
      const out = await this._exec(spark, "delete", { args, elevate, password, remember, timeoutMs: DELETE_TIMEOUT_MS });
      const res = programResult(out);
      if (!res.ok) throw this._mutationError(res, elevate, `sudo rm -rf --one-file-system -- ${shellQuote(path)}`);
      this._forget(spark.id, path);
      return { path };
    });
  }

  // ─── Delete advisor ────────────────────────────────────────

  /**
   * How careful to be before deleting these paths, from evidence only (advice.js): what the Spark reports now
   * (scripts/advise.sh: programs and running containers that use them, recent changes, partial downloads, files that
   * look like keys or logins, git work not committed or pushed), plus what the dashboard keeps (its launchers and the
   * LLM servers it watches, this Spark's analysis for "last changed", other Sparks' analyses for same-name-and-size
   * items). Read-only and never elevated; it neither waits for nor takes the Spark's busy slot or the unit lock.
   * Paths are checked as a delete checks them: one that may not be deleted refuses the request.
   * @param {object} spark
   * @param {unknown} body `{ paths: string[] }`
   * @param {{ refs?: (() => { launchers?: object[], llm?: object[] }) | null, nameOf?: (sparkId: string) => string | null }} [opts]
   *   `refs`: the dashboard's own references for this Spark; `nameOf`: another Spark's name (null: no longer configured).
   */
  async advise(spark, body, { refs = null, nameOf = () => null } = {}) {
    assertSupported(spark);
    const { run, covered } = parseDeletePaths(body?.paths);
    const out = await this._exec(spark, "advise", { args: [RECENT_MINUTES, ADVISE_BUDGET_SECONDS, ...run], timeoutMs: ADVISE_TIMEOUT_MS });
    const res = parseAdviseOutput(out, run.length);
    if (!res.ok) throw this._fail(res);
    const nowMs = this._now();
    const session = this._sessions.get(spark.id) ?? null;
    const others = [];
    for (const [id, s] of this._sessions) {
      const name = id === spark.id ? null : nameOf(id);
      if (name) others.push({ sparkId: id, name, analysedAt: s.analysedAt, entries: [...s.entries.values()] });
    }
    let own = null;
    try {
      own = refs ? refs() : {};
    } catch (err) {
      console.error(`[storage] Could not read the dashboard's references for ${spark.id}: ${err?.message ?? err}`);
    }
    const unit = { now: res.now, procs: res.procs, docker: res.docker, git: res.git };
    const items = run.map((path, k) => {
      // Hugging Face model folders the analysis lists at or under the path (deleting a whole cache holds them).
      const hubNames = [];
      if (session) for (const p of session.entries.keys()) if ((p === path || p.startsWith(`${path}/`)) && /\/models--[^/]+$/.test(p)) hubNames.push(p.slice(p.lastIndexOf("/") + 1));
      const item = adviseItem(path, {
        evidence: res.items[k],
        unit,
        homes: res.home ? [res.home] : [],
        refs: { ...(own ?? {}), home: res.home, hubNames },
        entry: session?.entries.get(path) ?? null,
        session,
        others,
        nowMs,
      });
      if (own == null) {
        item.unchecked.push({ rule: "references", text: "SparkDash's own launchers and LLM servers could not be read, so references to it were not checked." });
        Object.assign(item, { complete: false, level: item.level === "low" ? "review" : item.level });
      }
      return item;
    });
    return { checkedAt: nowMs, recentMinutes: RECENT_MINUTES, ...overallLevel(items), items, covered };
  }

  // ─── Bulk delete ───────────────────────────────────────────

  /**
   * Delete several files and folders, permanently, one after another under one busy lock (the Spark's admission
   * slot). Each item is a full single delete (delete.sh: staged, checked, then deleted, with its own recovery
   * record), never one combined program. Every path is checked first; one that may not be deleted refuses the
   * whole request and nothing runs. A failed item does not stop the rest, except for the answers in
   * BULK_STOP_CODES, after which the remaining items are skipped. A typed sudo password is used for every item of
   * this request and dropped when it ends; `remember` keeps it once sudo has accepted it, as a single delete does.
   *
   * Answers at once with the job (it can take many minutes); `deleteManyJob` follows it. `onFinish(job)` is called
   * once with the final public job.
   * @param {object} spark
   * @param {unknown} body `{ paths: string[], sudo?, sudoPassword?, remember? }`
   * @param {{ onFinish?: ((job: object) => void) | null }} [opts]
   */
  startDeleteMany(spark, body, { onFinish = null } = {}) {
    assertSupported(spark);
    const { run, covered } = parseDeletePaths(body?.paths);
    const { elevate, password, remember } = parseElevation(body);
    const job = {
      id: randomUUID(),
      state: "running",
      elevated: elevate,
      total: run.length,
      done: 0,
      current: null,
      startedAt: this._now(),
      finishedAt: null,
      deleted: [],
      failed: [],
      skipped: [],
      covered,
      stopped: null,
      ticket: null,
    };
    job.ticket = this._admission.admit(spark.id, { kind: "mutation", label: "bulk delete", refusal: () => this._bulkRefusal(job) });
    try {
      // Locked out after wrong guesses: refused now, before anything is tried.
      if (elevate && (password != null || this.hasSavedSudo(spark))) this._checkPasswordLock(spark);
    } catch (err) {
      job.ticket.release();
      throw err;
    }
    this._bulkJobs.set(spark.id, job);
    const work = this._runDeleteMany(spark, job, run, { elevate, password, remember })
      .catch((err) => console.error(`[storage] Bulk delete on ${spark.id} failed: ${err?.message ?? err}`))
      .finally(() => {
        if (this._bulkPending.get(spark.id) === work) this._bulkPending.delete(spark.id);
        try {
          onFinish?.(this._publicBulk(job));
        } catch (err) {
          console.error(`[storage] Could not record the bulk delete: ${err?.message ?? err}`);
        }
      });
    this._bulkPending.set(spark.id, work);
    return this._publicBulk(job);
  }

  async _runDeleteMany(spark, job, run, { elevate, password, remember }) {
    let hold = false;
    // Remember a typed password at most once: on the first item sudo accepts it.
    let rememberLeft = remember;
    const stop = (code, message) => {
      if (!job.stopped) job.stopped = { code, message };
    };
    try {
      for (const path of run) {
        if (!job.stopped && this._now() - job.startedAt >= this._bulkLimitMs) {
          stop("time-limit", "The bulk delete reached its 45-minute limit, so the rest was not tried.");
        }
        if (job.stopped) {
          job.skipped.push({ path, reason: bulkSkipReason(job.stopped.code) });
          continue;
        }
        job.current = path;
        let out;
        try {
          const args = [path, randomUUID(), this._ackFlag(spark, elevate), this._protectedArg];
          out = await this._exec(spark, "delete", { args, elevate, password, remember: rememberLeft, timeoutMs: DELETE_TIMEOUT_MS });
        } catch (err) {
          const code = typeof err?.code === "string" ? err.code : "failed";
          if (err?.holdBusy === true) hold = true;
          if (code === "password-locked") {
            // Refused before the program ran: this item was not tried either.
            job.skipped.push({ path, reason: bulkSkipReason(code) });
          } else {
            const message = code === "unreachable" ? `${err.message}. Whether it was deleted is not known: analyse again to check.` : String(err?.message ?? "The delete failed");
            job.failed.push({ path, code, message, partial: false });
            job.done += 1;
          }
          stop(code, String(err?.message ?? "The bulk delete stopped"));
          continue;
        }
        if (rememberLeft && sudoAccepted(out)) rememberLeft = false;
        const res = programResult(out);
        if (res.ok) {
          this._forget(spark.id, path, false);
          job.deleted.push(path);
        } else {
          const err = this._mutationError(res, elevate, `sudo rm -rf --one-file-system -- ${shellQuote(path)}`);
          job.failed.push({
            path,
            code: err.code,
            message: err.message,
            partial: err.partial === true,
            ...(err.quarantineId ? { quarantineId: err.quarantineId } : {}),
            ...(err.command ? { command: err.command } : {}),
          });
          if (BULK_STOP_CODES.has(err.code)) stop(err.code, err.message);
        }
        job.done += 1;
      }
    } finally {
      job.current = null;
      job.state = "done";
      job.finishedAt = this._now();
      if (job.deleted.length > 0) this._persist();
      const ticket = job.ticket;
      // Lost contact: the last program may still run on the unit. Keep the Spark busy a while, as a single delete does.
      if (hold && this._holdMs > 0) setTimeout(() => ticket.release(), this._holdMs).unref?.();
      else ticket.release();
    }
  }

  /** What another request is told while a bulk delete holds the Spark. */
  _bulkRefusal(job) {
    if (job.state !== "running") return { status: 409, code: "busy", message: "The last bulk delete on this Spark lost contact with it, so the Spark stays busy for a moment. Try again shortly." };
    return {
      status: 409,
      code: "busy",
      message: `A bulk delete is running on this Spark (${job.done} of ${job.total} done). Wait for it to finish.`,
    };
  }

  /** The job as the page sees it (never the password). */
  _publicBulk(job) {
    if (!job) return null;
    const { id, state, elevated, total, done, current, startedAt, finishedAt, deleted, failed, skipped, covered, stopped } = job;
    return {
      id,
      state,
      elevated,
      total,
      done,
      current,
      startedAt,
      finishedAt,
      success: state === "done" && failed.length === 0 && skipped.length === 0,
      deleted: [...deleted],
      failed: failed.map((f) => ({ ...f })),
      skipped: skipped.map((s) => ({ ...s })),
      covered: [...covered],
      stopped: stopped ? { ...stopped } : null,
    };
  }

  /**
   * The latest bulk delete on this Spark (running or finished), or the one with this id; null when unknown.
   * @param {object} spark
   * @param {string} [id]
   */
  deleteManyJob(spark, id) {
    assertSupported(spark);
    const job = this._bulkJobs.get(spark.id) ?? null;
    if (!job || (id != null && job.id !== id)) return null;
    return this._publicBulk(job);
  }

  /** "1" when an administrator delete may remove a folder on this Spark (the owner acknowledged it). */
  _ackFlag(spark, elevate) {
    return elevate && this.elevatedDeleteAck(spark) ? "1" : "0";
  }

  /** The HTTP error for a refused or failed delete, restore or quarantine delete. */
  _mutationError(res, elevate, command) {
    // The item is still there after the failure, and rm may already have removed some of what was in it.
    const partial = res.values?.REMAINS === "1";
    // Already root and still refused: more sudo will not help.
    const code = res.code === "permission" && elevate ? "rm-failed" : res.code;
    const message = res.code === "permission" && elevate ? `Still refused even as an administrator${res.values?.MSG ? `: ${res.values.MSG}` : ""}` : res.message;
    const extra = { partial };
    // Staged, but could not be put back (its name was taken): it is listed under "Needs attention".
    if (isQuarantineId(res.values?.QID)) extra.quarantineId = res.values.QID;
    if (elevate && command && MANUAL_DELETE_CODES.has(code)) extra.command = command;
    return httpError(CODE_STATUS[code] ?? 500, message, code, extra);
  }

  // ─── Needs attention (delete v2 recovery records) ──────────

  /** Deletes that were staged and never finished on this Spark, with what is on disk now. Read-only. */
  async quarantine(spark) {
    assertSupported(spark);
    const out = await this._exec(spark, "quarantineList", { args: ["list"], timeoutMs: STATUS_TIMEOUT_MS });
    const res = parseQuarantineOutput(out);
    if (!res.ok) throw this._fail(res);
    return { items: res.items };
  }

  /**
   * Put a staged item back where it was (`restore`, never replacing anything there), delete it for good
   * (`delete`, with the same checks as a delete), or drop a record whose item is no longer staged (`forget`,
   * refused with `payload-present` when anything is staged there). When the staged item is gone, restore and
   * delete also only drop the record. A restore destination is checked against the delete policy first.
   * @param {object} spark
   * @param {string} id the record id
   * @param {"restore" | "delete" | "forget"} action
   * @param {unknown} body `{ sudo?, sudoPassword?, remember? }`
   */
  async resolveQuarantined(spark, id, action, body) {
    assertSupported(spark);
    if (!isQuarantineId(id)) throw httpError(400, "That is not a recovery record id", "bad-id");
    if (action !== "restore" && action !== "delete" && action !== "forget") throw httpError(400, "action must be restore, delete or forget", "bad-action");
    const { elevate, password, remember } = parseElevation(body);
    return this._exclusive(spark, async () => {
      // Where a restore puts it: the record lives on the unit, so read it and apply the policy here; the unit
      // then only restores to exactly this path (and checks the place by identity itself).
      let dest = "";
      if (action === "restore") {
        const { items } = await this.quarantine(spark);
        const item = items.find((i) => i.id === id);
        if (!item) throw httpError(404, "This item is no longer listed", "not-found");
        try {
          dest = parseAbsolutePath(item.path);
        } catch {
          throw httpError(409, "The record's original path cannot be used, so it is not put back from here. Check it on the Spark by hand.", "bad-record");
        }
        const why = protectedReason(dest);
        if (why) throw httpError(403, `It cannot be put back there: ${why}`, "protected");
      }
      const args = [action, id, this._ackFlag(spark, elevate), this._protectedArg, dest, action === "restore" ? this._treesArg : ""];
      const out = await this._exec(spark, "quarantine", { args, elevate, password, remember, timeoutMs: DELETE_TIMEOUT_MS });
      const res = programResult(out);
      if (!res.ok) throw this._mutationError(res, elevate, null);
      const outcome = res.values?.OUTCOME;
      return { id, outcome: ["restored", "deleted", "in-place", "gone", "forgotten"].includes(outcome) ? outcome : null };
    });
  }

  // ─── Administrator folder deletes: the per-Spark acknowledgement ──

  /** The stored acknowledgement for this Spark's account, or null. */
  elevatedDeleteAck(spark) {
    const ack = this._acks?.get(spark.id, this._guard.key(spark));
    return ack ? { user: ack.user, acknowledgedAt: ack.acknowledgedAt } : null;
  }

  /**
   * Store the owner's acknowledgement that processes of this Spark's account are treated as having root
   * access, which lets administrator deletes remove folders. `body.confirm` must be true.
   * @param {object} spark
   * @param {unknown} body `{ confirm: true, user? }` `user`: the account name the page showed
   */
  acknowledgeElevatedDelete(spark, body) {
    assertSupported(spark);
    if (body?.confirm !== true) throw httpError(400, "confirm must be true", "bad-request");
    if (!this._acks) throw httpError(409, "This dashboard has nowhere to keep the acknowledgement", "no-ack-store");
    const user = typeof body.user === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(body.user) ? body.user : null;
    const ack = this._acks.set(spark.id, this._guard.key(spark), user);
    return { user: ack.user, acknowledgedAt: ack.acknowledgedAt };
  }

  /** Revoke it: administrator deletes of folders are refused again on this Spark. */
  revokeElevatedDelete(spark) {
    assertSupported(spark);
    return { revoked: Boolean(this._acks?.delete(spark.id, this._guard.key(spark))) };
  }

  // ─── Docker ────────────────────────────────────────────────

  /** Docker's disk use and every image, with whether anything uses it. */
  async docker(spark, body) {
    assertSupported(spark);
    const { elevate, password, remember } = parseElevation(body);
    // `light`: only the images and containers, without Docker's slow disk-use totals.
    const out = await this._exec(spark, "dockerList", { args: body?.light === true ? ["light"] : [], elevate, password, remember, timeoutMs: DOCKER_LIST_TIMEOUT_MS });
    const res = parseDockerListOutput(out);
    if (!res.ok) throw this._fail(res);
    const { ok: _ok, ...overview } = res;
    return overview;
  }

  /**
   * Remove images by ID. Images that gained a container since the list was drawn are skipped.
   * @param {object} spark
   * @param {unknown} body `{ ids: string[], sudo?, sudoPassword? }`
   */
  async removeImages(spark, body) {
    assertSupported(spark);
    const ids = body?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IMAGES_PER_REQUEST || !ids.every(isImageId)) {
      throw httpError(400, `ids must be a list of 1 to ${MAX_IMAGES_PER_REQUEST} image IDs (sha256:…)`, "bad-ids");
    }
    const unique = [...new Set(ids)];
    const { elevate, password, remember } = parseElevation(body);
    return this._exclusive(spark, async () => {
      const out = await this._exec(spark, "dockerRemove", { args: unique, elevate, password, remember, timeoutMs: DOCKER_REMOVE_TIMEOUT_MS });
      const res = parseDockerRemoveOutput(out);
      if (!res.ok) throw this._fail(res);
      const { ok: _ok, ...result } = res;
      return result;
    });
  }

  /**
   * Remove stopped containers by ID. A container that started again is skipped on the unit; its
   * volumes are kept. The images they used stay until removed separately.
   * @param {object} spark
   * @param {unknown} body `{ ids: string[], sudo?, sudoPassword? }`
   */
  async removeContainers(spark, body) {
    assertSupported(spark);
    const ids = body?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_CONTAINERS_PER_REQUEST || !ids.every(isContainerId)) {
      throw httpError(400, `ids must be a list of 1 to ${MAX_CONTAINERS_PER_REQUEST} container IDs`, "bad-ids");
    }
    const unique = [...new Set(ids)];
    const { elevate, password, remember } = parseElevation(body);
    return this._exclusive(spark, async () => {
      const out = await this._exec(spark, "dockerRemoveContainers", { args: unique, elevate, password, remember, timeoutMs: DOCKER_REMOVE_TIMEOUT_MS });
      const res = parseDockerRemoveOutput(out);
      if (!res.ok) throw this._fail(res);
      const { ok: _ok, ...result } = res;
      return result;
    });
  }

  /**
   * Clear Docker's build cache that nothing uses and that Docker last used more than `olderThanDays` days ago, on
   * the builder built into the daemon (scripts/docker-builder-prune.sh). Docker decides what is unused and reports
   * what it reclaimed; a builder that cannot be identified is refused (`builder-unknown`), never guessed.
   * @param {object} spark
   * @param {unknown} body `{ olderThanDays: 1..365, sudo?, sudoPassword?, remember? }`
   */
  async pruneBuilderCache(spark, body) {
    assertSupported(spark);
    const days = parseOlderThanDays(body?.olderThanDays);
    const { elevate, password, remember } = parseElevation(body);
    return this._exclusive(spark, async () => {
      const out = await this._exec(spark, "dockerBuilderPrune", { args: [days], elevate, password, remember, timeoutMs: DOCKER_REMOVE_TIMEOUT_MS });
      const res = parseBuilderPruneOutput(out);
      if (!res.ok) throw this._fail(res);
      return { olderThanDays: days, adapter: res.adapter, reclaimedBytes: res.reclaimedBytes };
    });
  }
}
