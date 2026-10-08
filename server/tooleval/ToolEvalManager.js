import crypto from "crypto";
import { defaultSpawn, LineSplitter } from "../llmlaunch/LauncherManager.js";
import {
  TE_EXIT,
  buildAttachProgram,
  buildCheckProgram,
  buildDeleteRunProgram,
  buildInstallProgram,
  buildOnceProgram,
  buildReadResultProgram,
  buildRunProgram,
  buildStatusProgram,
  buildStopProgram,
  secretsPayload,
} from "./commands.js";

export const MAX_LINES = 5000;
export const MAX_EVENTS = 5000;
const RUN_WATCH_MAX_MS = 12 * 60 * 60 * 1000;
const INSTALL_MAX_MS = 20 * 60 * 1000;
const ONCE_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 3000;

/** Fold one JSONL progress event from the tool into the live progress summary. Pure. */
export function reduceProgress(prev, ev) {
  const p = prev ? { ...prev, counts: { ...prev.counts }, scenarios: prev.scenarios.slice() } : emptyProgress();
  if (!ev || typeof ev !== "object") return p;
  switch (ev.event) {
    case "server_discovered":
      p.server = { baseUrl: ev.base_url ?? null, backend: ev.backend ?? null };
      p.phase = "connecting";
      break;
    case "model_auto_selected":
      p.model = ev.model ?? null;
      break;
    case "scenario_start":
      p.phase = "running";
      p.total = Number.isFinite(ev.total) ? ev.total : p.total;
      p.index = Number.isFinite(ev.index) ? ev.index : p.index;
      p.current = { id: ev.scenario_id ?? null, title: ev.title ?? null, category: ev.category ?? null };
      break;
    case "scenario_result": {
      p.phase = "running";
      p.total = Number.isFinite(ev.total) ? ev.total : p.total;
      const status = typeof ev.status === "string" ? ev.status : "other";
      const key = status === "pass" || status === "partial" || status === "fail" ? status : "other";
      p.counts[key] += 1;
      p.points += Number.isFinite(ev.points) ? ev.points : 0;
      p.done += 1;
      p.scenarios.push({
        id: ev.scenario_id ?? null,
        title: p.current?.id === ev.scenario_id ? p.current.title : null,
        category: p.current?.id === ev.scenario_id ? p.current.category : null,
        status,
        points: Number.isFinite(ev.points) ? ev.points : null,
        durationSeconds: Number.isFinite(ev.duration_seconds) ? ev.duration_seconds : null,
      });
      if (p.scenarios.length > 400) p.scenarios.splice(0, p.scenarios.length - 400);
      break;
    }
    case "benchmark_complete":
      p.phase = "done";
      p.finalScore = Number.isFinite(ev.final_score) ? ev.final_score : p.finalScore;
      p.current = null;
      break;
    case "error":
      p.phase = "error";
      p.error = { code: ev.error ?? "error", message: ev.message ?? null };
      break;
    default:
      break;
  }
  return p;
}

export function emptyProgress() {
  return {
    phase: "starting",
    server: null,
    model: null,
    total: null,
    index: 0,
    done: 0,
    current: null,
    counts: { pass: 0, partial: 0, fail: 0, other: 0 },
    points: 0,
    scenarios: [],
    finalScore: null,
    error: null,
  };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Headline numbers from a result envelope, tolerant of fields the tool may add or omit. */
export function summarizeResult(result) {
  if (!result || typeof result !== "object") return null;
  const scores = result.scores && typeof result.scores === "object" ? result.scores : {};
  const results = Array.isArray(scores.scenario_results) ? scores.scenario_results : [];
  const counts = { pass: 0, partial: 0, fail: 0, other: 0 };
  for (const r of results) {
    const st = String(r?.status ?? r?.result ?? "").toLowerCase();
    counts[st === "pass" || st === "partial" || st === "fail" ? st : "other"] += 1;
  }
  const config = result.config && typeof result.config === "object" ? result.config : {};
  return {
    finalScore: num(result.final_score) ?? num(scores.final_score),
    rating: typeof result.rating === "string" ? result.rating : null,
    deployability: num(result.deployability),
    responsiveness: num(result.responsiveness),
    totalScenarios: num(result.total_scenarios) ?? (results.length || null),
    safetyWarnings: Array.isArray(result.safety_warnings) ? result.safety_warnings.length : 0,
    toolRunId: typeof result.run_id === "string" ? result.run_id : null,
    model: typeof config.model === "string" ? config.model : null,
    backend: typeof config.backend === "string" ? config.backend : null,
    counts: results.length ? counts : null,
    toolVersion: typeof result.tool_eval_bench_version === "string" ? result.tool_eval_bench_version : null,
  };
}

/**
 * Runs `tool-eval-bench` on a Spark and keeps the dashboard's view of it: one live job per
 * Spark (a benchmark run, a re-attach, or an install), progress derived from the tool's
 * JSONL events, and the run index + cached results in the store.
 */
export class ToolEvalManager {
  constructor({ store, spawnProcess = defaultSpawn, onEvent = () => {}, now = Date.now }) {
    this.store = store;
    this.spawnProcess = spawnProcess;
    this.onEvent = onEvent;
    this.now = now;
    /** @type {Map<string, object>} sparkId -> latest job */
    this.jobs = new Map();
  }

  summary(job) {
    return {
      id: job.id,
      sparkId: job.sparkId,
      kind: job.kind,
      type: job.type,
      status: job.status,
      exitCode: job.exitCode,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
    };
  }

  activeJob(sparkId) {
    const j = this.jobs.get(sparkId);
    return j && j.status === "running" ? j : null;
  }

  latestJob(sparkId) {
    return this.jobs.get(sparkId) ?? null;
  }

  /** Run a short program to completion and collect its output (probe, dry-run, status, …). */
  runOnce(spark, cmd, { stdin = null, timeoutMs = ONCE_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawnProcess(spark, cmd, { stdin: stdin != null });
      } catch (err) {
        resolve({ ok: false, code: null, output: "", error: err instanceof Error ? err.message : String(err) });
        return;
      }
      let out = "";
      let timedOut = false;
      const cap = (b) => {
        if (out.length < 40 * 1024 * 1024) out += b.toString("utf8");
      };
      child.stdout?.on("data", cap);
      child.stderr?.on("data", cap);
      const timer = setTimeout(() => {
        timedOut = true;
        this._killGroup(child);
      }, timeoutMs);
      timer.unref?.();
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, code: null, output: out, error: err.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const m = new RegExp(`${TE_EXIT}(-?\\d+)`).exec(out);
        const exit = m ? Number.parseInt(m[1], 10) : code;
        resolve({
          ok: !timedOut && exit === 0,
          code: exit,
          output: out.replace(new RegExp(`${TE_EXIT}-?\\d+\\s*$`), "").trimEnd(),
          error: timedOut ? "The Spark did not answer in time" : null,
        });
      });
      if (stdin != null && child.stdin) {
        child.stdin.on("error", () => {});
        child.stdin.end(stdin);
      }
    });
  }

  /** Is the tool installed on this Spark? */
  async status(spark) {
    const res = await this.runOnce(spark, buildStatusProgram(), { timeoutMs: 40_000 });
    const kv = {};
    for (const line of res.output.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    return {
      reachable: res.ok || Boolean(kv.UV !== undefined || kv.BIN !== undefined),
      installed: Boolean(kv.BIN),
      path: kv.BIN || null,
      version: kv.VERSION || null,
      uv: kv.UV || null,
      python: kv.PYTHON || null,
      pythonVersion: kv.PYTHON_VERSION || null,
      workDir: kv.WORKDIR || null,
      error: res.error,
    };
  }

  /** `--probe` / `--dry-run` / any non-run tool call, synchronous. */
  async once(spark, { argvB64, secrets }) {
    const wantStdin = secrets != null;
    return this.runOnce(spark, buildOnceProgram({ argvB64, wantStdin }), {
      stdin: wantStdin ? secrets : null,
      timeoutMs: 100_000,
    });
  }

  _newJob(spark, { id, kind, type }) {
    return {
      id,
      sparkId: spark.id,
      kind,
      type: type ?? null,
      status: "running",
      exitCode: null,
      startedAt: this.now(),
      finishedAt: null,
      error: null,
      lines: [],
      lseq: 0,
      events: [],
      eseq: 0,
      progress: emptyProgress(),
      splitter: new LineSplitter(),
      src: "O",
      markerExit: null,
      cancelled: false,
      timedOut: false,
      stopRequested: false,
      child: null,
      timer: null,
    };
  }

  _feed(job, chunk) {
    for (const line of job.splitter.feed(chunk)) this._line(job, line);
  }

  _line(job, line) {
    const header = /^==> (.*) <==$/.exec(line);
    if (header) {
      job.src = header[1].endsWith("events.jsonl") ? "E" : "O";
      job.skipBlank = true;
      return;
    }
    if (job.skipBlank && line === "") {
      job.skipBlank = false;
      return;
    }
    job.skipBlank = false;
    const at = line.indexOf(TE_EXIT);
    if (at >= 0) {
      const n = Number.parseInt(line.slice(at + TE_EXIT.length), 10);
      job.markerExit = Number.isFinite(n) ? n : -1;
      line = line.slice(0, at);
      if (!line) return;
    }
    if (job.kind !== "install" && job.src === "E" && line.startsWith("{")) {
      try {
        const ev = JSON.parse(line);
        job.eseq += 1;
        job.events.push({ seq: job.eseq, ...ev });
        if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
        job.progress = reduceProgress(job.progress, ev);
        // No return: the raw output shows what the tool really printed, progress events included.
      } catch {
        /* not JSON: it is just a raw line */
      }
    }
    job.lseq += 1;
    job.lines.push({ seq: job.lseq, text: line, stream: job.src === "E" ? "err" : "out" });
    if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
  }

  _startJob(spark, job, cmd, { stdin = null, maxMs }) {
    this.jobs.set(spark.id, job);
    let child;
    try {
      child = this.spawnProcess(spark, cmd, { stdin: stdin != null });
    } catch (err) {
      this._finish(job, spark, { error: err instanceof Error ? err.message : String(err) });
      return job;
    }
    job.child = child;
    child.stdout?.on("data", (b) => this._feed(job, b.toString("utf8")));
    child.stderr?.on("data", (b) => this._feed(job, b.toString("utf8")));
    child.on("error", (err) => this._finish(job, spark, { error: err.message }));
    child.on("close", (code) => this._finish(job, spark, { code }));
    if (stdin != null && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    }
    job.timer = setTimeout(() => {
      job.timedOut = true;
      this._killGroup(child);
    }, maxMs);
    job.timer.unref?.();
    return job;
  }

  _killGroup(child) {
    if (!child || child.exitCode != null || child.signalCode != null) return;
    const signal = (sig) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* gone */
        }
      }
    };
    signal("SIGTERM");
    const t = setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS);
    t.unref?.();
  }

  /**
   * Start a benchmark run (detached on the Spark) and follow it.
   * @returns {{ ok: true, job: object } | { ok: false, reason: "busy", active: object }}
   */
  startRun(spark, { run, argv, env }) {
    const busy = this.activeJob(spark.id);
    if (busy && busy.kind !== "attach") return { ok: false, reason: "busy", active: this.summary(busy) };
    if (busy) this._detach(busy, spark);
    const argvB64 = Buffer.from(argv.join("\0") + "\0", "utf8").toString("base64");
    const cmd = buildRunProgram({ runId: run.id, argvB64, displayLine: run.command });
    const job = this._newJob(spark, { id: run.id, kind: "run", type: run.type });
    this._startJob(spark, job, cmd, { stdin: secretsPayload(env), maxMs: RUN_WATCH_MAX_MS });
    this.onEvent({
      type: "tooleval.run.started",
      severity: "info",
      sparkId: spark.id,
      message: `${run.typeLabel ?? "Benchmark"} started${run.label ? ` (${run.label})` : ""}`,
    });
    return { ok: true, job };
  }

  /** Re-open the output of a run that was started earlier. */
  attachRun(spark, run) {
    const busy = this.activeJob(spark.id);
    if (busy) {
      if (busy.id === run.id) return { ok: true, job: busy };
      if (busy.kind !== "attach" && busy.kind !== "run") return { ok: false, reason: "busy", active: this.summary(busy) };
      if (busy.kind === "run") return { ok: false, reason: "busy", active: this.summary(busy) };
      this._detach(busy, spark);
    }
    const job = this._newJob(spark, { id: run.id, kind: "attach", type: run.type });
    this._startJob(spark, job, buildAttachProgram({ runId: run.id }), { maxMs: RUN_WATCH_MAX_MS });
    return { ok: true, job };
  }

  install(spark, { extras = [], upgrade = false } = {}) {
    const busy = this.activeJob(spark.id);
    if (busy && busy.kind !== "attach") return { ok: false, reason: "busy", active: this.summary(busy) };
    if (busy) this._detach(busy, spark);
    const job = this._newJob(spark, { id: `install-${crypto.randomBytes(3).toString("hex")}`, kind: "install", type: null });
    this._startJob(spark, job, buildInstallProgram({ extras, upgrade }), { maxMs: INSTALL_MAX_MS });
    return { ok: true, job };
  }

  /** Stop watching the live job. A benchmark run keeps going on the Spark. */
  cancelWatch(sparkId) {
    const job = this.activeJob(sparkId);
    if (!job) return false;
    job.cancelled = true;
    this._killGroup(job.child);
    return true;
  }

  _detach(job, spark) {
    job.cancelled = true;
    this._killGroup(job.child);
    this._finish(job, spark, { code: null });
  }

  /** Ask the tool to stop (TERM, then KILL) via the Spark, regardless of who is watching. */
  async stopRun(spark, runId) {
    const live = this.jobs.get(spark.id);
    if (live && live.id === runId) live.stopRequested = true;
    const res = await this.runOnce(spark, buildStopProgram({ runId }), { timeoutMs: 40_000 });
    return { ok: res.ok, output: res.output };
  }

  _finish(job, spark, { code = null, error = null } = {}) {
    if (job.status !== "running") return;
    clearTimeout(job.timer);
    const rest = job.splitter.flush();
    if (rest) this._line(job, rest);
    job.finishedAt = this.now();
    job.exitCode = job.markerExit != null && job.markerExit >= 0 ? job.markerExit : null;
    if (error) {
      job.status = "failed";
      job.error = error;
    } else if (job.cancelled) {
      job.status = "cancelled";
    } else if (job.timedOut) {
      job.status = "detached";
      job.error = "Stopped watching after the time limit. The run may still be going on the Spark.";
    } else if (job.exitCode === 0) {
      job.status = "completed";
    } else if (job.stopRequested && job.kind !== "install") {
      // The tool was killed on request, so it left no exit code behind.
      job.status = "stopped";
    } else if (job.exitCode != null) {
      job.status = "failed";
    } else {
      // The connection ended before the tool's exit code was seen: the run itself may still be alive.
      job.status = job.kind === "install" ? "failed" : "detached";
      job.error = "Lost the connection to the Spark before the run reported its result.";
    }
    void this._afterJob(job, spark).catch(() => {});
  }

  async _afterJob(job, spark) {
    if (job.kind === "install") {
      this.onEvent({
        type: `tooleval.install.${job.status}`,
        severity: job.status === "completed" ? "success" : "error",
        sparkId: job.sparkId,
        message: job.status === "completed" ? "Tool Eval Bench installed" : "Tool Eval Bench install failed",
      });
      return;
    }
    const run = this.store.get(job.id);
    if (!run) return;
    if (job.status === "detached") return; // still unknown; checkRun() settles it later
    if (job.kind === "attach" && job.cancelled) return;
    const finalStatus =
      job.status === "stopped"
        ? "stopped"
        : job.exitCode === 0
          ? "completed"
          : job.exitCode == null && job.status !== "failed"
            ? run.status
            : "failed";
    this.store.update(job.id, { status: finalStatus, exitCode: job.exitCode, finishedAt: job.finishedAt ?? this.now() });
    await this.captureResult(spark, job.id);
    const fresh = this.store.get(job.id);
    const score = fresh?.summary?.finalScore;
    this.onEvent({
      type: `tooleval.run.${finalStatus}`,
      severity: finalStatus === "completed" ? "success" : finalStatus === "stopped" ? "info" : "error",
      sparkId: job.sparkId,
      message:
        finalStatus === "completed"
          ? `${run.typeLabel ?? "Benchmark"} finished${score != null ? `: score ${score}` : ""}`
          : finalStatus === "stopped"
            ? `${run.typeLabel ?? "Benchmark"} stopped`
            : `${run.typeLabel ?? "Benchmark"} failed${job.exitCode != null ? ` (exit ${job.exitCode})` : ""}`,
    });
  }

  /** Pull result.json from the Spark, cache it locally, and store its headline numbers. */
  async captureResult(spark, runId) {
    const res = await this.runOnce(spark, buildReadResultProgram({ runId }), { timeoutMs: 90_000 });
    const text = res.output.trim();
    if (!text || text === "__NORESULT__") return { ok: false, reason: "no-result" };
    if (text.startsWith("__TOOBIG__")) return { ok: false, reason: "too-big" };
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: "invalid-json" };
    }
    this.store.saveResult(runId, text);
    this.store.update(runId, { resultCached: true, summary: summarizeResult(parsed) });
    return { ok: true };
  }

  /** Settle a run whose watcher was lost: is it still alive, or how did it end? */
  async checkRun(spark, runId) {
    const res = await this.runOnce(spark, buildCheckProgram({ runId }), { timeoutMs: 40_000 });
    const out = res.output.trim().split("\n").pop() ?? "";
    if (out === "ALIVE") return { state: "running" };
    if (out === "GONE") {
      this.store.update(runId, { status: "gone", finishedAt: this.now() });
      return { state: "gone" };
    }
    const m = /^EXIT=(-?\d+)$/.exec(out);
    if (!m) return { state: "unknown" };
    const code = Number.parseInt(m[1], 10);
    const run = this.store.get(runId);
    if (run && run.status === "running") {
      this.store.update(runId, { status: code === 0 ? "completed" : code < 0 ? "stopped" : "failed", exitCode: code >= 0 ? code : null, finishedAt: this.now() });
      await this.captureResult(spark, runId);
    }
    return { state: "finished", exitCode: code };
  }

  /** Remove the run's files on the Spark (best effort) and forget it locally. */
  async deleteRun(spark, runId) {
    if (spark) await this.runOnce(spark, buildDeleteRunProgram({ runId }), { timeoutMs: 40_000 }).catch(() => {});
    return this.store.remove(runId);
  }

  readJob(sparkId, jobId, { lineSince = 0, eventSince = 0 } = {}) {
    const job = this.jobs.get(sparkId);
    if (!job || job.id !== jobId) return null;
    return {
      job: this.summary(job),
      lines: job.lines.filter((l) => l.seq > lineSince),
      events: job.events.filter((e) => e.seq > eventSince),
      partial: job.status === "running" ? job.splitter.partial : "",
      progress: job.progress,
      nextLine: job.lseq,
      nextEvent: job.eseq,
    };
  }

  shutdown() {
    for (const job of this.jobs.values()) {
      if (job.status === "running") {
        job.cancelled = true;
        this._killGroup(job.child);
      }
    }
  }

  removeSpark(sparkId) {
    this.cancelWatch(sparkId);
    this.jobs.delete(sparkId);
    this.store.removeSpark(sparkId);
  }
}
