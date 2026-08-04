/**
 * ComfyProbe — probes a ComfyUI server (default port 8188) over its REST API.
 *
 * Reports version, device VRAM, queue depth, the running job and its elapsed
 * time, and the most recent output preview.
 *
 * Step progress ("14/20") is deliberately NOT taken from the API: ComfyUI sends
 * `progress_state` only to the client that submitted the prompt
 * (comfy_execution/progress.py), so a passive monitor never receives it and no
 * REST route exposes it. When `comfyLogPath` is configured we parse the tqdm
 * line out of the server log instead — same spirit as reading host metrics off
 * the filesystem elsewhere in this app.
 */
import fs from "fs";
import path from "path";
import { LLM_PROBE_TIMEOUT_MS, HOST_PATHS } from "../config.js";
import { llmProbeHost } from "./llmHost.js";
import { sshExec } from "./ssh.js";

/** Bytes of log tail to scan for the newest tqdm progress line. */
const LOG_TAIL_BYTES = 8192;
/** A parsed tqdm line older than this is stale — drop it. */
const LOG_PROGRESS_TTL_MS = 30_000;

/**
 * Pull the newest tqdm progress line out of a chunk of ComfyUI log output.
 * tqdm rewrites one line with \r, so the tail holds many generations of it.
 *   " 90%|█████████ | 18/20 [11:31<01:18, 39.18s/it]"
 * @param {string} text
 * @returns {{ step: number, steps: number, elapsedSeconds: number | null,
 *             etaSeconds: number | null, secPerStep: number | null } | null}
 */
export function parseProgressLine(text) {
  if (!text) return null;
  const re =
    /(\d+)\/(\d+)\s*\[([\d:?]+)<([\d:?]+),\s*([\d.]+)(s\/it|it\/s)\]/g;
  let last = null;
  for (const m of text.matchAll(re)) last = m;
  if (!last) return null;

  const step = Number(last[1]);
  const steps = Number(last[2]);
  if (!Number.isFinite(step) || !Number.isFinite(steps) || steps <= 0) return null;

  const rate = Number(last[5]);
  const secPerStep = Number.isFinite(rate)
    ? last[6] === "s/it"
      ? rate
      : rate > 0
        ? 1 / rate
        : null
    : null;

  return {
    step,
    steps,
    elapsedSeconds: parseClock(last[3]),
    etaSeconds: parseClock(last[4]),
    secPerStep,
  };
}

/** "11:31" / "1:02:03" → seconds. "?" or garbage → null. */
function parseClock(s) {
  if (!s || s.includes("?")) return null;
  const parts = s.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export class ComfyProbe {
  constructor(spark, port = 8188) {
    this.spark = spark;
    this.port = port;
    this.baseUrl = `http://${llmProbeHost(spark)}:${port}`;

    this.version = null;
    this.pythonVersion = null;
    this.pytorchVersion = null;
    this.device = null;
    this.error = null;

    /** Last successfully parsed tqdm progress, with the time we read it. */
    this._progress = null;
    this._progressAt = 0;
  }

  /** Update probe port (and host from spark). */
  setPort(port) {
    const next = Number(port);
    if (Number.isInteger(next) && next >= 1 && next <= 65535) this.port = next;
    this.baseUrl = `http://${llmProbeHost(this.spark)}:${this.port}`;
  }

  /** Probe the ComfyUI server and return a snapshot. */
  async probe() {
    let stats;
    try {
      stats = await this._json("/system_stats");
    } catch (err) {
      this.error = `ComfyUI unreachable: ${err.message}`;
      return this._default();
    }

    this.error = null;
    this._applyStats(stats);

    // Queue + jobs are best-effort — a running ComfyUI without them still
    // reports version and VRAM rather than showing as down.
    const [queue, jobs] = await Promise.all([
      this._json("/queue").catch(() => null),
      this._json("/api/jobs?limit=5").catch(() => null),
    ]);

    const queueRunning = Array.isArray(queue?.queue_running) ? queue.queue_running.length : 0;
    const queuePending = Array.isArray(queue?.queue_pending) ? queue.queue_pending.length : 0;

    const jobList = Array.isArray(jobs?.jobs) ? jobs.jobs : [];
    const running = jobList.find((j) => j?.status === "in_progress") || null;
    const lastDone = jobList.find((j) => j?.status === "completed") || null;

    // Only spend a log read while something is actually rendering.
    const progress = queueRunning > 0 || running ? await this._readProgress() : null;

    return {
      available: true,
      version: this.version,
      pythonVersion: this.pythonVersion,
      pytorchVersion: this.pytorchVersion,
      device: this.device,
      queueRunning,
      queuePending,
      job: running ? this._buildJob(running, progress) : null,
      lastOutput: this._buildOutput(lastDone),
      error: null,
    };
  }

  _applyStats(stats) {
    const sys = stats?.system || {};
    this.version = sys.comfyui_version ?? null;
    this.pythonVersion = sys.python_version ? String(sys.python_version).split(" ")[0] : null;
    this.pytorchVersion = sys.pytorch_version ?? null;

    const dev = Array.isArray(stats?.devices) ? stats.devices[0] : null;
    this.device = dev
      ? {
          name: dev.name ?? null,
          vramTotal: num(dev.vram_total),
          vramFree: num(dev.vram_free),
          torchVramTotal: num(dev.torch_vram_total),
          torchVramFree: num(dev.torch_vram_free),
        }
      : null;
  }

  /**
   * @param {object} job an /api/jobs entry with status "in_progress"
   * @param {ReturnType<typeof parseProgressLine> | null} progress
   */
  _buildJob(job, progress) {
    const startMs = num(job.execution_start_time) ?? num(job.create_time);
    const elapsedSeconds = startMs != null ? Math.max(0, (Date.now() - startMs) / 1000) : null;
    const percent =
      progress && progress.steps > 0 ? (progress.step / progress.steps) * 100 : null;

    return {
      id: job.id ?? null,
      elapsedSeconds,
      step: progress?.step ?? null,
      steps: progress?.steps ?? null,
      percent,
      secPerStep: progress?.secPerStep ?? null,
      etaSeconds: progress?.etaSeconds ?? null,
    };
  }

  _buildOutput(job) {
    const out = job?.preview_output;
    if (!out || !out.filename) return null;
    return {
      filename: out.filename,
      subfolder: out.subfolder ?? "",
      type: out.type ?? "output",
      mediaType: out.mediaType ?? null,
      finishedAt: num(job.execution_end_time),
    };
  }

  // ─── Log tail (step progress) ────────────────────────────
  /** Read + parse the newest tqdm line, or null when unavailable/stale. */
  async _readProgress() {
    const logPath = this.spark?.comfyLogPath;
    if (!logPath || typeof logPath !== "string") return null;

    let tail;
    try {
      tail = this.spark.isLocal
        ? this._readLocalTail(logPath)
        : await sshExec(this.spark, `tail -c ${LOG_TAIL_BYTES} ${shellQuote(logPath)}`);
    } catch {
      return null; // missing/unreadable log is not a probe failure
    }

    const parsed = parseProgressLine(String(tail || "").replace(/\r/g, "\n"));
    if (parsed) {
      this._progress = parsed;
      this._progressAt = Date.now();
      return parsed;
    }
    // tqdm only rewrites during sampling; hold the last reading briefly so the
    // panel doesn't blink between steps, then let it expire.
    if (this._progress && Date.now() - this._progressAt < LOG_PROGRESS_TTL_MS) {
      return this._progress;
    }
    this._progress = null;
    return null;
  }

  /** Read the last LOG_TAIL_BYTES of a host file (bind-mounted at HOST_PATHS.ROOT). */
  _readLocalTail(logPath) {
    const mapped = path.join(HOST_PATHS.ROOT, logPath);
    const target = fs.existsSync(mapped) ? mapped : logPath;
    const fd = fs.openSync(target, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, LOG_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  }

  _default() {
    return {
      available: false,
      version: this.version,
      pythonVersion: this.pythonVersion,
      pytorchVersion: this.pytorchVersion,
      device: null,
      queueRunning: 0,
      queuePending: 0,
      job: null,
      lastOutput: null,
      error: this.error,
    };
  }

  // ─── HTTP ────────────────────────────────────────────────
  async _json(route) {
    const res = await fetch(`${this.baseUrl}${route}`, {
      signal: AbortSignal.timeout(LLM_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}
