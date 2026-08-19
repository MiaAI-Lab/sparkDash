/**
 * ComfyProbe — polls a local ComfyUI HTTP server (default port 8188).
 *
 * Focus: jobs, progress, inventory — not host RAM/VRAM.
 *
 * Endpoints:
 *   GET /system_stats
 *   GET /queue
 *   GET /api/jobs (fallback /history)
 *   GET /models/checkpoints, /models/loras
 *   WS  /ws (optional live progress — often client-scoped in Comfy)
 */
import { COMFY_PROBE_TIMEOUT_MS, COMFY_PORT } from "../config.js";
import { llmProbeHost } from "./llmHost.js";
import { ComfyProgressSocket } from "./ComfyProgressSocket.js";

/**
 * @param {unknown} n
 * @returns {number | null}
 */
function numOrNull(n) {
  const v = typeof n === "string" ? Number(n) : n;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** @param {string} path */
function basename(path) {
  const s = String(path);
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

const MODEL_FILE_RE = /\.(safetensors|sft|ckpt|pt|bin|gguf|pth|onnx)$/i;
const MODELS_TTL_MS = 45_000;
const HISTORY_TTL_MS = 8_000;
const AVG_SAMPLES = 8;
const ETA_FALLBACK_MS = 60_000;

/**
 * Summarize a ComfyUI prompt graph into human-facing workload fields.
 * @param {unknown} prompt
 */
export function summarizeComfyPrompt(prompt) {
  /** @type {string[]} */
  const models = [];
  let nodeCount = 0;
  /** @type {number | null} */
  let steps = null;
  /** @type {number | null} */
  let width = null;
  /** @type {number | null} */
  let height = null;
  /** @type {number | null} */
  let batchSize = null;
  /** @type {string | null} */
  let sampler = null;
  /** @type {Record<string, number>} */
  const classCounts = {};
  /** @type {Record<string, string>} */
  const nodeLabels = {};

  if (!prompt || typeof prompt !== "object" || Array.isArray(prompt)) {
    return {
      models: [],
      nodeCount: 0,
      steps: null,
      width: null,
      height: null,
      batchSize: null,
      sampler: null,
      classCounts: {},
      nodeLabels: {},
    };
  }

  for (const [nid, node] of Object.entries(prompt)) {
    if (!node || typeof node !== "object") continue;
    nodeCount += 1;
    const ct =
      /** @type {{ class_type?: unknown }} */ (node).class_type != null
        ? String(/** @type {{ class_type?: unknown }} */ (node).class_type)
        : "Unknown";
    classCounts[ct] = (classCounts[ct] || 0) + 1;
    nodeLabels[String(nid)] = ct;
    const inputs = /** @type {{ inputs?: Record<string, unknown> }} */ (node).inputs;
    if (!inputs || typeof inputs !== "object") continue;

    for (const [key, val] of Object.entries(inputs)) {
      if (typeof val === "string" && MODEL_FILE_RE.test(val)) {
        models.push(basename(val));
        continue;
      }
      if (key === "steps" && steps == null) {
        const n = numOrNull(val);
        if (n != null) steps = n;
      } else if (key === "width" && width == null) {
        const n = numOrNull(val);
        if (n != null) width = n;
      } else if (key === "height" && height == null) {
        const n = numOrNull(val);
        if (n != null) height = n;
      } else if (key === "batch_size" && batchSize == null) {
        const n = numOrNull(val);
        if (n != null) batchSize = n;
      } else if (key === "sampler_name" && sampler == null && typeof val === "string") {
        sampler = val;
      }
    }
  }

  const seen = new Set();
  const uniqueModels = [];
  for (const m of models) {
    if (seen.has(m)) continue;
    seen.add(m);
    uniqueModels.push(m);
  }

  return {
    models: uniqueModels,
    nodeCount,
    steps,
    width,
    height,
    batchSize,
    sampler,
    classCounts,
    nodeLabels,
  };
}

/**
 * Estimate queue ETA from average job duration and optional live progress.
 * @param {{ avgDurationMs: number, queuePending: number, running: boolean, progressPercent: number | null }} p
 */
export function estimateQueueEtaMs({
  avgDurationMs,
  queuePending,
  running,
  progressPercent,
}) {
  const avg =
    Number.isFinite(avgDurationMs) && avgDurationMs > 0 ? avgDurationMs : ETA_FALLBACK_MS;
  let runningRemaining = 0;
  if (running) {
    if (progressPercent != null && Number.isFinite(progressPercent)) {
      runningRemaining = avg * (1 - Math.min(100, Math.max(0, progressPercent)) / 100);
    } else {
      runningRemaining = avg * 0.5;
    }
  }
  const pending = Math.max(0, Number(queuePending) || 0);
  return Math.round(runningRemaining + pending * avg);
}

/**
 * @param {unknown} item
 * @param {"running" | "pending"} status
 */
function normalizeQueueJob(item, status) {
  if (!Array.isArray(item) || item.length < 3) return null;
  const promptId = item[1] != null ? String(item[1]) : null;
  if (!promptId) return null;
  const prompt = item[2];
  const extra = item[3] && typeof item[3] === "object" ? item[3] : {};
  const summary = summarizeComfyPrompt(prompt);

  /** @type {string | null} */
  let title = null;
  try {
    const png = /** @type {{ extra_pnginfo?: { workflow?: { title?: unknown, name?: unknown } } }} */ (
      extra
    ).extra_pnginfo;
    const wf = png?.workflow;
    if (wf?.title != null && String(wf.title).trim()) title = String(wf.title).trim();
    else if (wf?.name != null && String(wf.name).trim()) title = String(wf.name).trim();
  } catch {
    /* ignore */
  }

  return {
    id: promptId,
    status,
    title,
    models: summary.models,
    nodeCount: summary.nodeCount,
    steps: summary.steps,
    width: summary.width,
    height: summary.height,
    batchSize: summary.batchSize,
    sampler: summary.sampler,
    createTime: numOrNull(extra.create_time),
    _nodeLabels: summary.nodeLabels,
  };
}

/**
 * @param {object} job from /api/jobs
 */
function normalizeApiJob(job) {
  if (!job || typeof job !== "object" || job.id == null) return null;
  const statusRaw = String(job.status || "").toLowerCase();
  let status = "completed";
  if (statusRaw === "failed") status = "failed";
  else if (statusRaw === "cancelled") status = "cancelled";
  else if (statusRaw === "completed" || statusRaw === "success") status = "completed";
  else status = statusRaw || "completed";

  const start = numOrNull(job.execution_start_time);
  const end = numOrNull(job.execution_end_time);
  let durationMs = null;
  if (start != null && end != null && end >= start) durationMs = end - start;

  /** @type {string | null} */
  let title = null;
  if (job.workflow_id != null && String(job.workflow_id).trim()) {
    title = String(job.workflow_id).trim();
  }

  return {
    id: String(job.id),
    status,
    title,
    durationMs,
    endedAt: end,
  };
}

export class ComfyProbe {
  /**
   * @param {object} spark
   * @param {number} [port]
   */
  constructor(spark, port = COMFY_PORT) {
    this.spark = spark;
    this.port = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : COMFY_PORT;
    this.baseUrl = `http://${llmProbeHost(spark)}:${this.port}`;
    this.error = null;
    this._progress = new ComfyProgressSocket(spark, this.port);
    /** @type {{ checkpoints: string[], loras: string[], fetchedAt: number } | null} */
    this._modelsCache = null;
    /** @type {{ lastJob: object | null, durationsMs: number[], fetchedAt: number } | null} */
    this._historyCache = null;
  }

  setTarget(spark, port) {
    this.spark = spark ?? this.spark;
    const next = Number(port);
    if (Number.isInteger(next) && next >= 1 && next <= 65535) {
      this.port = next;
    }
    this.baseUrl = `http://${llmProbeHost(this.spark)}:${this.port}`;
    this._progress.setTarget(this.spark, this.port);
    this._modelsCache = null;
    this._historyCache = null;
  }

  /** Tear down WS when monitoring disabled. */
  dispose() {
    this._progress.close();
  }

  /**
   * Browser deep-link host — always prefer LAN IP so "Open" works from other
   * machines. Probe traffic still uses llmProbeHost (loopback when isLocal).
   */
  openUrl() {
    const lan =
      this.spark?.lanIp != null ? String(this.spark.lanIp).trim() : "";
    const sshHost =
      this.spark?.ssh?.host != null ? String(this.spark.ssh.host).trim() : "";
    const host =
      lan ||
      (sshHost && sshHost !== "127.0.0.1" && sshHost !== "localhost"
        ? sshHost
        : "") ||
      "127.0.0.1";
    return `http://${host}:${this.port}`;
  }

  /**
   * @returns {Promise<object>}
   */
  async probe() {
    try {
      const signal = AbortSignal.timeout(COMFY_PROBE_TIMEOUT_MS);
      const [statsRes, queueRes] = await Promise.all([
        fetch(`${this.baseUrl}/system_stats`, { signal }),
        fetch(`${this.baseUrl}/queue`, { signal }),
      ]);

      if (!statsRes.ok) {
        this.error = `HTTP ${statsRes.status} on /system_stats`;
        this._progress.disconnect();
        return this._default();
      }

      const stats = await statsRes.json().catch(() => null);
      if (!stats || typeof stats !== "object") {
        this.error = "Invalid /system_stats response";
        this._progress.disconnect();
        return this._default();
      }

      /** @type {object[]} */
      let runningJobs = [];
      /** @type {object[]} */
      let pendingJobs = [];
      if (queueRes.ok) {
        const queue = await queueRes.json().catch(() => null);
        if (queue && typeof queue === "object") {
          const runningRaw = Array.isArray(queue.queue_running) ? queue.queue_running : [];
          const pendingRaw = Array.isArray(queue.queue_pending) ? queue.queue_pending : [];
          runningJobs = runningRaw
            .map((item) => normalizeQueueJob(item, "running"))
            .filter(Boolean);
          pendingJobs = pendingRaw
            .map((item) => normalizeQueueJob(item, "pending"))
            .filter(Boolean);
        }
      }

      const activeJob = runningJobs[0] || null;
      if (activeJob?._nodeLabels) {
        this._progress.setNodeLabels(activeJob._nodeLabels);
      }

      const busy = runningJobs.length > 0 || pendingJobs.length > 0;
      this._progress.touchActivity(busy);

      // Enrich history / models (throttled)
      await Promise.all([this._refreshHistory(signal), this._refreshModels(signal)]);

      const system = stats.system && typeof stats.system === "object" ? stats.system : {};
      const devicesRaw = Array.isArray(stats.devices) ? stats.devices : [];
      const deviceType =
        devicesRaw[0] && typeof devicesRaw[0] === "object" && devicesRaw[0].type != null
          ? String(devicesRaw[0].type)
          : null;

      let progress = this._progress.getProgress();
      // Time-based estimate when no live WS progress
      if (busy && activeJob && (!progress || progress.source !== "ws")) {
        progress = this._syntheticProgress(activeJob) ?? progress;
      }
      if (!busy) {
        // clear stale progress when idle
        if (progress && progress.source === "estimate") progress = null;
      }

      const avgDurationMs = this._avgDurationMs();
      const progressPercent = progress?.percent ?? null;
      const queueEtaMs = estimateQueueEtaMs({
        avgDurationMs,
        queuePending: pendingJobs.length,
        running: runningJobs.length > 0,
        progressPercent,
      });

      // Strip internal fields from jobs
      const cleanJob = (j) => {
        if (!j) return null;
        const { _nodeLabels, ...rest } = j;
        return rest;
      };

      this.error = null;
      return {
        available: true,
        port: this.port,
        version: system.comfyui_version != null ? String(system.comfyui_version) : null,
        pytorchVersion: system.pytorch_version != null ? String(system.pytorch_version) : null,
        deviceType,
        queueRunning: runningJobs.length,
        queuePending: pendingJobs.length,
        activeJob: cleanJob(activeJob),
        pendingJobs: pendingJobs.slice(0, 5).map(cleanJob),
        progress,
        lastJob: this._historyCache?.lastJob ?? null,
        modelsInstalled: this._modelsCache
          ? {
              checkpoints: this._modelsCache.checkpoints,
              loras: this._modelsCache.loras,
            }
          : null,
        queueEtaMs: busy ? queueEtaMs : null,
        openUrl: this.openUrl(),
        error: null,
      };
    } catch (err) {
      this.error = err?.message || String(err);
      this._progress.disconnect();
      return this._default();
    }
  }

  _syntheticProgress(activeJob) {
    const avg = this._avgDurationMs();
    const create = activeJob.createTime;
    if (create == null) {
      return {
        promptId: activeJob.id,
        nodeId: null,
        nodeLabel: null,
        value: 0,
        max: 0,
        percent: null,
        updatedAt: Date.now(),
        source: "estimate",
      };
    }
    const ms = create < 1e12 ? create * 1000 : create;
    const elapsed = Math.max(0, Date.now() - ms);
    const percent = Math.min(99, Math.round((elapsed / avg) * 100));
    return {
      promptId: activeJob.id,
      nodeId: null,
      nodeLabel: null,
      value: percent,
      max: 100,
      percent,
      updatedAt: Date.now(),
      source: "estimate",
    };
  }

  _avgDurationMs() {
    const d = this._historyCache?.durationsMs;
    if (!Array.isArray(d) || d.length === 0) return ETA_FALLBACK_MS;
    const sum = d.reduce((a, b) => a + b, 0);
    return Math.max(1000, Math.round(sum / d.length));
  }

  async _refreshHistory(signal) {
    const now = Date.now();
    if (this._historyCache && now - this._historyCache.fetchedAt < HISTORY_TTL_MS) return;
    try {
      const res = await fetch(
        `${this.baseUrl}/api/jobs?status=completed,failed,cancelled&limit=${AVG_SAMPLES}&sort_by=created_at&sort_order=desc`,
        { signal }
      );
      if (res.ok) {
        const data = await res.json().catch(() => null);
        const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
        const normalized = jobs.map(normalizeApiJob).filter(Boolean);
        const durationsMs = normalized
          .map((j) => j.durationMs)
          .filter((n) => n != null && n > 0);
        this._historyCache = {
          lastJob: normalized[0] || null,
          durationsMs,
          fetchedAt: now,
        };
        return;
      }
    } catch {
      /* fallback history */
    }
    try {
      const res = await fetch(`${this.baseUrl}/history?max_items=1`, { signal });
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      if (!data || typeof data !== "object") return;
      const ids = Object.keys(data);
      if (!ids.length) {
        this._historyCache = { lastJob: null, durationsMs: [], fetchedAt: now };
        return;
      }
      const id = ids[ids.length - 1];
      const item = data[id];
      const statusInfo = item?.status || {};
      let start = null;
      let end = null;
      let status = "completed";
      for (const entry of statusInfo.messages || []) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const [ev, payload] = entry;
        if (ev === "execution_start") start = numOrNull(payload?.timestamp);
        if (ev === "execution_success" || ev === "execution_error" || ev === "execution_interrupted") {
          end = numOrNull(payload?.timestamp);
          if (ev === "execution_error") status = "failed";
          if (ev === "execution_interrupted") status = "cancelled";
        }
      }
      const durationMs =
        start != null && end != null && end >= start ? end - start : null;
      this._historyCache = {
        lastJob: {
          id,
          status,
          title: null,
          durationMs,
          endedAt: end,
        },
        durationsMs: durationMs != null ? [durationMs] : [],
        fetchedAt: now,
      };
    } catch {
      /* keep prior cache */
    }
  }

  async _refreshModels(signal) {
    const now = Date.now();
    if (this._modelsCache && now - this._modelsCache.fetchedAt < MODELS_TTL_MS) return;
    try {
      const [ckRes, loraRes] = await Promise.all([
        fetch(`${this.baseUrl}/models/checkpoints`, { signal }),
        fetch(`${this.baseUrl}/models/loras`, { signal }),
      ]);
      /** @param {Response} res */
      const list = async (res) => {
        if (!res.ok) return [];
        const data = await res.json().catch(() => []);
        if (!Array.isArray(data)) return [];
        return data
          .map((x) => (typeof x === "string" ? basename(x) : null))
          .filter(Boolean)
          .slice(0, 30);
      };
      this._modelsCache = {
        checkpoints: await list(ckRes),
        loras: await list(loraRes),
        fetchedAt: now,
      };
    } catch {
      /* keep prior */
    }
  }

  _default() {
    return {
      available: false,
      port: this.port,
      version: null,
      pytorchVersion: null,
      deviceType: null,
      queueRunning: 0,
      queuePending: 0,
      activeJob: null,
      pendingJobs: [],
      progress: null,
      lastJob: null,
      modelsInstalled: null,
      queueEtaMs: null,
      openUrl: this.openUrl(),
      error: this.error,
    };
  }
}
