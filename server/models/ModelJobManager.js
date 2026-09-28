/**
 * ModelJobManager — one mutating host script at a time, with a live transcript
 * the UI can delta-poll.
 *
 * Two mechanics are borrowed rather than reinvented:
 *
 *  - ShowcaseManager's `rev` + `since` cursor: every poll returns only the
 *    transcript appended since the last poll (`append`) instead of resending
 *    the whole thing. A `reset` flag covers the ring-buffer trim, where the
 *    client's cursor points at bytes that are already gone.
 *  - DecodeBench's boot recovery: jobs checkpointed as `running` in
 *    models-active.json are promoted to `cancelled` on startup, so a
 *    `docker compose restart` mid-start leaves the modal something to read
 *    instead of a 404.
 *
 * Concurrency: exactly one *mutating* job (start/stop/restart) at a time across
 * all models — the whole point of the panel is one-model-at-a-time, and two
 * `start.sh` racing over the same GPU/port is unrecoverable. A `logs` job is
 * read-only and runs concurrently; cancelling one kills only its own process
 * group (the `docker logs -f` tail), never the model.
 *
 * Job status is NOT derived from the exit code: `start.sh` ends in
 * `docker logs -f` and therefore never exits on its own. Completion of the
 * *model* comes from ModelProbe (container running OR port answering). A job
 * stays `running` until the script exits, the timeout hits, or it is cancelled
 * — which is correct for a tail-forever script, and the readiness badge is
 * driven separately by the probe.
 */
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  MODEL_JOB_TIMEOUT_MS,
  MODEL_JOB_TAIL_CHARS,
  MODEL_JOB_HISTORY,
} from "../config.js";
import { atomicWrite } from "../util/atomicWrite.js";
import {
  buildScriptCommand,
  buildChainedCommand,
  resolveRunTarget,
  spawnOnTarget,
  shQuote,
} from "./hostExec.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");
const ACTIVE_PATH =
  process.env.MODEL_ACTIVE_PATH || path.join(ROOT, "config", "models-active.json");

/** Mutating actions take the single global slot. */
const MUTATING = new Set(["start", "stop", "restart"]);
/** Keep finished jobs in memory this long before pruning (per model). */
const FINISHED_TTL_MS = 30 * 60_000;

/** Transcript lines the ring buffer keeps at most (chars are the hard cap). */
const LINE_MAX = 4000;

function err400(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}
function err409(msg) {
  const e = new Error(msg);
  e.status = 409;
  return e;
}

/**
 * Ring-buffered transcript with the delta bookkeeping that belongs to it:
 * `totalChars` only ever grows (that is the client's cursor space), while the
 * kept window slides. Exported for tests.
 */
export class Transcript {
  /** @param {number} capChars */
  constructor(capChars = MODEL_JOB_TAIL_CHARS) {
    this.capChars = capChars;
    this.buf = "";
    /** Monotonic: total chars ever appended. Delta cursor lives in this space. */
    this.totalChars = 0;
    /** Absolute offset of buf[0]; the delta cursor can never point below this. */
    this.baseOffset = 0;
    /** High-water mark of bytes the client has been shown. */
    this.sentThrough = 0;
  }

  /** @param {string} text */
  append(text) {
    if (!text) return;
    const s = text.length > this.capChars ? text.slice(-this.capChars) : text;
    this.buf += s;
    this.totalChars += s.length;
    if (this.buf.length > this.capChars) {
      const drop = this.buf.length - this.capChars;
      this.buf = this.buf.slice(drop);
      this.baseOffset += drop;
    }
  }

  /**
   * @param {number|null} since absolute cursor from the previous poll
   * @param {{ full?: boolean }} [opts]
   * @returns {{ text: string, reset: boolean, since: number, totalChars: number }}
   */
  read(since, opts = {}) {
    const full = Boolean(opts.full) || since == null || !Number.isFinite(since);
    const cursor = full ? this.baseOffset : Math.max(0, Math.floor(since));
    // Cursor older than the ring window (or ahead of us after a restart):
    // the client must rebuild from what we still have.
    const reset = !full && cursor < this.baseOffset;
    const from = reset || full ? this.baseOffset : Math.min(cursor, this.totalChars);
    const text = this.buf.slice(Math.max(0, from - this.baseOffset));
    this.sentThrough = Math.max(this.sentThrough, this.totalChars);
    return { text, reset, since: this.totalChars, totalChars: this.totalChars };
  }
}

/** Public shape — no internals, no process handles. */
function publicJob(job, opts = {}) {
  return {
    jobId: job.jobId,
    modelId: job.modelId,
    model: job.modelName,
    action: job.action,
    status: job.status,
    script: job.script,
    dir: job.dir,
    source: job.source,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    signal: job.signal,
    error: job.error,
    timedOut: job.timedOut,
    /** chars ever produced — doubles as the transcript cursor ceiling */
    totalChars: job.transcript.totalChars,
    truncated: job.transcript.baseOffset > 0,
    killed: job.killed,
    ...(opts.includeTail ? { tail: job.transcript.read(opts.since ?? null).text } : {}),
  };
}

export class ModelJobManager {
  /**
   * @param {object} [opts]
   * @param {string} [opts.activePath]
   * @param {(modelId: string) => object|null} [opts.getModel] registry lookup
   *   returning a validated model config (id/name/dir/scripts/args/sparkId).
   * @param {(id: string) => object|null} [opts.getSpark] SparkRegistry lookup
   *   INCLUDING ssh.password — every job runs on the model's assigned Spark,
   *   not on the machine the dashboard happens to be hosted by.
   * @param {() => void} [opts.onChange] called after any state change so the
   *   server can force a WS broadcast.
   * @param {(jobId: string) => Promise<void>|void} [opts.afterSettle] hook run
   *   when a job finishes (the server uses it to re-probe liveness immediately).
   */
  constructor(opts = {}) {
    this.getModel = opts.getModel || (() => null);
    this.getSpark = opts.getSpark || (() => null);
    this.afterSettle = opts.afterSettle || (async () => {});
    this.activePath = opts.activePath || ACTIVE_PATH;
    /** @type {Map<string, object>} jobId → job */
    this.jobs = new Map();
    /** @type {Map<string, string>} modelId → newest job id (any action) */
    this.latestByModel = new Map();
    /** @type {string|null} jobId holding the single mutating slot */
    this._mutating = null;
    /** @type {AbortController|null} */
    this._mutatingAbort = null;
    this._recoverInterruptedActive();
  }

  // ─── Queries ────────────────────────────────────────────
  /** @param {string} jobId @param {number|null} [since] */
  getJob(jobId, since = null) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const delta = job.transcript.read(since);
    return {
      ...publicJob(job),
      append: delta.text,
      reset: delta.reset,
      since: delta.since,
    };
  }

  /** Newest job for a model (any action) or null. Metadata only — no transcript. */
  getLatest(modelId) {
    const id = this.latestByModel.get(modelId);
    if (!id) return null;
    const job = this.jobs.get(id);
    // NOT getJob(): that returns the transcript delta, which would put up to
    // the whole ring buffer into every WS snapshot. The modal pulls the text
    // by delta-polling GET /jobs/:id?since= instead.
    return job ? publicJob(job) : null;
  }

  /** Metadata-only lookup for the DELETE guard (no delta accounting). */
  peek(jobId) {
    const job = this.jobs.get(jobId);
    return job ? publicJob(job) : null;
  }

  activeJob() {
    if (!this._mutating) return null;
    const job = this.jobs.get(this._mutating);
    return job && job.status === "running" ? publicJob(job) : null;
  }

  /** Running logs job for a model, if any. */
  activeLogs(modelId) {
    for (const job of this.jobs.values()) {
      if (job.modelId === modelId && job.action === "logs" && job.status === "running") {
        return publicJob(job);
      }
    }
    return null;
  }

  list() {
    return Array.from(this.jobs.values())
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 20)
      .map((j) => publicJob(j));
  }

  // ─── Commands ───────────────────────────────────────────
  /**
   * Queue a model script on the Spark assigned to the card (over SSH).
   * @param {string} modelId
   * @param {"start"|"stop"|"restart"|"logs"} action
   * @param {{ source?: string, timeoutMs?: number }} [meta]
   * @returns {{ jobId: string, status: string, stoppingJobId?: string|null }}
   */
  start(modelId, action, meta = {}) {
    if (!["start", "stop", "restart", "logs"].includes(action)) throw err400(`Unknown action: ${action}`);
    const model = this.getModel(modelId);
    if (!model) throw err400(`Model ${modelId} not found`);
    const target = resolveRunTarget(model, this.getSpark);
    if (target.kind === null) throw err400(target.error);

    const scriptKey = `${action}Script`;
    const script = model[scriptKey];
    // Logs have a universal fallback: every model with a container can be
    // tailed with `docker logs -f`, even when the repo ships no logs.sh.
    const dockerLogsFallback = !script && action === "logs" && Boolean(model.container);
    if (!script && !dockerLogsFallback) {
      const e = new Error(
        action === "logs"
          ? `Model ${modelId} has no logs script configured`
          : `Model ${modelId} has no ${action} script configured`
      );
      e.status = 400;
      throw e;
    }

    const active = this.activeJob();
    if (MUTATING.has(action)) {
      if (active) {
        throw err409(
          `A ${active.action} job is already running for ${active.model} — wait for it to finish or cancel it first`
        );
      }
    } else {
      // logs: one tail per model, no global lock.
      const existing = this.activeLogs(modelId);
      if (existing) return { jobId: existing.jobId, status: "running", stoppingJobId: null };
    }

    const args = action === "start" && Array.isArray(model.startArgs) ? model.startArgs : [];
    const cmd = dockerLogsFallback
      ? `docker logs -f --tail 500 ${shQuote(model.container)}`
      : buildScriptCommand({ dir: model.dir, script, args });

    const job = this._createJob(model, action, meta);
    if (dockerLogsFallback) job.script = `docker logs -f ${model.container}`;
    // Announce what is about to run — the transcript is the audit trail.
    job.transcript.append(
      dockerLogsFallback
        ? `$ ${job.script}\n`
        : `$ ./${script}${args.length ? ` ${args.join(" ")}` : ""}   [${model.dir}]\n`
    );

    const timeoutMs =
      Number.isFinite(meta.timeoutMs) && meta.timeoutMs > 0
        ? meta.timeoutMs
        : action === "logs"
          ? 0 // tail until cancelled
          : MODEL_JOB_TIMEOUT_MS;

    if (MUTATING.has(action)) {
      this._mutating = job.jobId;
      this._mutatingAbort = job._abort;
    }
    job.timeoutMs = timeoutMs;
    this._checkpointActive();
    this._notify();
    this._spawnJob(job, [{ target, cmd }], timeoutMs);

    return { jobId: job.jobId, status: "running", stoppingJobId: null };
  }

  /** Register a fresh job record (does not spawn). Shared by start + startExclusive. */
  _createJob(model, action, meta = {}) {
    /** @type {object} */
    const job = {
      jobId: randomUUID(),
      modelId: model.id,
      modelName: model.name || model.id,
      action,
      status: "running",
      script: model[`${action}Script`] || model.startScript || null,
      dir: model.dir,
      source: meta.source || "manual",
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      timedOut: false,
      killed: false,
      transcript: new Transcript(),
      _abort: new AbortController(),
    };
    // Settle hook: the scheduler chains stop→start and needs to await a job.
    job.done = new Promise((resolve) => {
      job._resolveDone = resolve;
    });
    this.jobs.set(job.jobId, job);
    this.latestByModel.set(model.id, job.jobId);
    return job;
  }

  /**
   * Run the job's chunks sequentially. An exclusive Start that crosses Sparks
   * is several chained commands (one per machine); the single global timeout
   * caps the WHOLE job, so each chunk only gets the remaining budget, and a
   * cancel kills whatever chunk is in flight (containers survive — same rule
   * as the old single-host chain).
   * @param {object} job
   * @param {{ target: object, cmd: string }[]} chunks
   * @param {number} timeoutMs 0 = run until cancelled
   */
  async _spawnJob(job, chunks, timeoutMs) {
    // Chunk boundaries are arbitrary (pipe reads), so split lines out here and
    // keep partial lines in the buffer to avoid interleaving a token across
    // two transcript appends.
    let partial = "";
    const push = (chunk, stream) => {
      partial += String(chunk);
      void stream; // transcript is a single merged stream, like a real terminal
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      if (lines.length) {
        job.transcript.append(
          lines.map((l) => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX)}…` : l)).join("\n") + "\n"
        );
      }
      this._notifyThrottled();
    };

    const deadline =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : 0;
    let res = {
      code: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      spawned: true,
      error: null,
    };
    for (const chunk of chunks) {
      // Audit line: which machine executes this chunk.
      job.transcript.append(
        `» ${chunk.target.kind === "ssh" ? "ssh" : "host"} · ${chunk.target.label}\n`
      );
      if (job._abort.signal.aborted) {
        res = { code: null, signal: null, timedOut: false, cancelled: true, spawned: true, error: null };
        break;
      }
      let chunkTimeout = 0; // 0 = no cap (tail-until-cancelled, or untimed job)
      if (deadline) {
        chunkTimeout = deadline - Date.now();
        if (chunkTimeout <= 0) {
          res = { code: null, signal: null, timedOut: true, cancelled: false, spawned: true, error: null };
          break;
        }
      }
      res = await spawnOnTarget(chunk.target, chunk.cmd, {
        onData: push,
        timeoutMs: chunkTimeout,
        signal: job._abort.signal,
      });
      if (res.cancelled || res.timedOut) break;
    }

    if (partial) {
      job.transcript.append(partial);
      partial = "";
    }

    this._settle(job, res);
    this._prune();
    try {
      await this.afterSettle(job);
    } catch {
      /* probe refresh is best-effort */
    }
  }

  _settle(job, res) {
    if (job.status !== "running") return;
    // A readiness release is a success, not a cancellation — the model is up
    // and we only stopped following its log tail.
    const ready = job.releaseReason === "ready";
    job.status = ready
      ? "done"
      : res.cancelled
        ? "cancelled"
        : res.timedOut
          ? "timeout"
          : res.error
            ? "error"
            : "done";
    job.exitCode = ready ? 0 : res.code;
    job.signal = ready ? null : res.signal;
    job.timedOut = Boolean(res.timedOut);
    job.error = ready
      ? null
      : res.timedOut
        ? `Timed out after ${Math.round((job.timeoutMs || MODEL_JOB_TIMEOUT_MS) / 60000)} min and was killed`
        : res.cancelled
          ? "Cancelled — the process group was terminated"
          : res.error || (res.code ? `${job.script} exited with code ${res.code}` : null);
    job.finishedAt = Date.now();
    if (res.error) job.transcript.append(`\n[hostExec] ${res.error}\n`);
    job._resolveDone?.();
    if (this._mutating === job.jobId) {
      this._mutating = null;
      this._mutatingAbort = null;
    }
    this._checkpointActive();
    this._notify(true);
  }

  /**
   * Cancel a job. For a mutating job this kills the script's process group;
   * containers already handed to dockerd keep running (deliberate — cancelling
   * a start must not power off a model that came up). A logs job kills only
   * its own tail.
   */
  cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.status !== "running") return publicJob(job);
    job.killed = true;
    job.transcript.append(`\n[cancel] requesting termination of the script's process group…\n`);
    try {
      job._abort.abort();
    } catch {
      /* ignore */
    }
    return publicJob(job);
  }

  /** Drop a finished job record (UI closes the transcript). */
  remove(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === "running") return false;
    this.jobs.delete(jobId);
    if (this.latestByModel.get(job.modelId) === jobId) this.latestByModel.delete(job.modelId);
    return true;
  }

  /**
   * Finalize every running job on shutdown so a poll after a --watch/restart
   * reload reads "cancelled" instead of 404. Does NOT kill the host scripts —
   * they live in their own process group on the host and are the user's model.
   */
  interruptAll(reason = "Interrupted — server restarted while the job was running") {
    for (const job of this.jobs.values()) {
      if (job.status !== "running") continue;
      job.status = "cancelled";
      job.error = reason;
      job.finishedAt = Date.now();
      job.transcript.append(`\n[sparkDash] ${reason}\n`);
      job._resolveDone?.();
    }
    this._mutating = null;
    this._mutatingAbort = null;
    this._writeActiveFile([]);
    this._notify(true);
  }

  // ─── Boot recovery (DecodeBench pattern) ────────────────
  _recoverInterruptedActive() {
    let leftovers = [];
    try {
      if (!fs.existsSync(this.activePath)) return;
      const data = JSON.parse(fs.readFileSync(this.activePath, "utf8"));
      leftovers = Array.isArray(data?.jobs) ? data.jobs : [];
    } catch (err) {
      console.warn("[ModelJobs] failed to load active jobs:", err?.message || err);
      return;
    }
    for (const snap of leftovers) {
      if (!snap?.jobId || !snap?.modelId) continue;
      const job = {
        ...snap,
        status: "cancelled",
        error: snap.error || "Interrupted — server restarted while the script was running",
        finishedAt: snap.finishedAt || Date.now(),
        transcript: new Transcript(),
        _abort: new AbortController(),
      };
      job.transcript.append(
        `${String(snap.tail || "").trim()}\n\n[sparkDash] ${job.error}\n` || job.error
      );
      this.jobs.set(job.jobId, job);
      this.latestByModel.set(job.modelId, job.jobId);
      console.warn(`[ModelJobs] recovered interrupted ${snap.action} job for ${snap.modelId}`);
    }
    this._writeActiveFile([]);
  }

  _checkpointActive() {
    const running = Array.from(this.jobs.values())
      .filter((j) => j.status === "running")
      .map((j) => ({
        ...publicJob(j, { includeTail: true }),
        tail: j.transcript.read(null).text.slice(-4000),
      }));
    this._writeActiveFile(running);
  }

  _writeActiveFile(jobs) {
    try {
      fs.mkdirSync(path.dirname(this.activePath), { recursive: true });
      atomicWrite(this.activePath, JSON.stringify({ jobs }, null, 2), 0o644);
    } catch (err) {
      console.warn("[ModelJobs] failed to save active jobs:", err?.message || err);
    }
  }

  // ─── Internals ──────────────────────────────────────────
  _notify(force = false) {
    if (force) this._lastNotifyAt = 0;
    const now = Date.now();
    if (this._lastNotifyAt && now - this._lastNotifyAt < 250) return;
    this._lastNotifyAt = now;
    try {
      this.onChange();
    } catch {
      /* ignore */
    }
  }

  _notifyThrottled() {
    this._notify(false);
  }

  /** Bound memory: drop old finished jobs beyond the per-model keep count. */
  _prune() {
    const byModel = new Map();
    for (const job of this.jobs.values()) {
      if (job.status === "running") continue;
      const list = byModel.get(job.modelId) || [];
      list.push(job);
      byModel.set(job.modelId, list);
    }
    const now = Date.now();
    for (const [modelId, list] of byModel) {
      list.sort((a, b) => b.startedAt - a.startedAt);
      list.forEach((job, i) => {
        const stale = now - (job.finishedAt || job.startedAt) > FINISHED_TTL_MS;
        if (i >= MODEL_JOB_HISTORY || (stale && i >= 1)) {
          this.jobs.delete(job.jobId);
          if (this.latestByModel.get(modelId) === job.jobId) this.latestByModel.delete(modelId);
        }
      });
    }
  }

  /**
   * Run a start/restart of one model while others may hold the GPU/port: run
   * every incumbent's stop.sh first, then the target's script, in ONE job so
   * the transcript tells the whole story ("Qwen's stop.sh, then GLM's
   * start.sh") and the single-mutating slot is never released between the two
   * steps. When the two live on different Sparks the chain becomes one
   * command per machine, run in order.
   *
   * The caller picks stopFirstIds fail-closed (everything not PROVEN down), so
   * a listed model that cannot be stopped — unregistered, no stop script,
   * unplaceable Spark — must fail the WHOLE job, not be skipped: silently not
   * stopping an incumbent double-books the GPU/port and surfaces as the new
   * kit's own port validation, the only guard left standing.
   * @param {string} targetId
   * @param {string[]} stopFirstIds
   * @param {{ source?: string, action?: "start"|"restart" }} [meta]
   */
  startExclusive(targetId, stopFirstIds = [], meta = {}) {
    const action = meta.action === "restart" ? "restart" : "start";
    const active = this.activeJob();
    if (active) throw err409(`A ${active.action} job is already running for ${active.model}`);
    const target = this.getModel(targetId);
    if (!target) throw err400(`Model ${targetId} not found`);
    const targetScript = action === "restart" ? target.restartScript : target.startScript;
    if (!targetScript) throw err400(`Model ${targetId} has no ${action} script configured`);

    const steps = [];
    for (const id of stopFirstIds) {
      const m = this.getModel(id);
      if (!m) throw err400(`Model ${id} selected to stop is no longer registered`);
      if (!m.stopScript) {
        throw err400(
          `Model ${m.name || id} may be running but has no stop script — stop it by hand or configure its stop script before starting on top of it`
        );
      }
      const t = resolveRunTarget(m, this.getSpark);
      if (t.kind === null) throw err400(t.error);
      steps.push({
        target: t,
        dir: m.dir,
        script: m.stopScript,
        label: `stop ${m.name || id}`,
        modelId: id,
        action: "stop",
      });
    }
    const targetRun = resolveRunTarget(target, this.getSpark);
    if (targetRun.kind === null) throw err400(targetRun.error);
    steps.push({
      target: targetRun,
      dir: target.dir,
      script: targetScript,
      args: action === "start" && Array.isArray(target.startArgs) ? target.startArgs : [],
      label: `${action} ${target.name || targetId}`,
      modelId: targetId,
      action,
    });

    // One mutating job that *is* the chain; the job's model is the target.
    // Consecutive steps sharing a Spark stay ONE chained command (the
    // transcript tells the whole stop→start story); the chain only splits
    // when the incumbent lives on a different machine than the target.
    const chunks = [];
    for (const s of steps) {
      const last = chunks[chunks.length - 1];
      if (last && last.target.key === s.target.key) last.steps.push(s);
      else chunks.push({ target: s.target, steps: [s] });
    }
    const job = this._createJob(target, action, { ...meta, chained: stopFirstIds.length > 0 });
    job.transcript.append(
      steps.map((s) => `$ ${s.label}: ./${s.script}${s.args?.length ? ` ${s.args.join(" ")}` : ""}   [${s.dir}]`).join("\n") + "\n"
    );
    this._mutating = job.jobId;
    this._mutatingAbort = job._abort;
    this._checkpointActive();
    this._notify();
    job.timeoutMs = MODEL_JOB_TIMEOUT_MS;
    this._spawnJob(
      job,
      chunks.map((c) => ({
        target: c.target,
        cmd: buildChainedCommand(c.steps.map((s) => ({ dir: s.dir, script: s.script, args: s.args, label: s.label }))),
      })),
      MODEL_JOB_TIMEOUT_MS
    );
    return { jobId: job.jobId, status: "running", stoppingJobIds: stopFirstIds };
  }

  /**
   * A model just became ready (container up / port answering). `start.sh`
   * (and a chained `restart.sh`) normally ends in `docker logs -f` and would
   * otherwise hold the single mutating slot until the job timeout, blocking
   * every other model and the scheduler. Readiness is the real end-of-job
   * signal, so stop the tail: containers are owned by dockerd and survive the
   * kill.
   *
   * A restart job releases only once the model was observed DOWN during the
   * job (markRestartSawDown): its own old container answers the port while the
   * chain is still mid-flight, and releasing on that stale readiness would
   * kill the wrapper before the restart script ever ran.
   * Returns true when a job was released.
   * @param {string} modelId
   */
  releaseReadyStart(modelId) {
    let released = false;
    for (const job of this.jobs.values()) {
      if (job.modelId !== modelId || job.status !== "running") continue;
      if (job.action !== "start" && job.action !== "restart") continue;
      if (job.action === "restart" && !job.sawDown) continue;
      job.transcript.append(
        `\n[ready] model is serving — ending the log tail (the container keeps running)\n`
      );
      job.releaseReason = "ready";
      job.killed = false;
      try {
        job._abort.abort();
      } catch {
        /* ignore */
      }
      released = true;
    }
    return released;
  }

  /**
   * Arm running restart jobs so a later ready verdict may release them: the
   * first tick that finds the target not up proves the old container is gone,
   * so the next "serving" observation belongs to the freshly restarted one.
   * @param {string} modelId
   */
  markRestartSawDown(modelId) {
    for (const job of this.jobs.values()) {
      if (job.modelId === modelId && job.status === "running" && job.action === "restart") {
        job.sawDown = true;
      }
    }
  }
}
