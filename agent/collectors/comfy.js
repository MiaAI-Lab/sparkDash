/**
 * comfy.js — probe a local ComfyUI HTTP server.
 *
 * ComfyMetrics (Batch 1A working type; attached to the snapshot as the extra
 * `comfy` property and mapped into VersionInfo[]). Endpoints (same as
 * sparkDash ComfyProbe, no WS): /system_stats, /queue, /api/jobs,
 * /models/checkpoints, /models/loras.
 */

const TIMEOUT_MS = 1500;

/** @param {unknown} n */
function numOrNull(n) {
  const v = typeof n === "string" ? Number(n) : n;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Normalize one ComfyUI queue entry ([count, promptId, prompt, extra]).
 * @param {unknown} item
 * @returns {{id:string, title:string|null, nodeCount:number} | null}
 */
function normalizeJob(item) {
  if (!Array.isArray(item) || item.length < 2) return null;
  const promptId = item[1] != null ? String(item[1]) : null;
  if (!promptId) return null;
  const prompt = item[2];
  const extra = item[3] && typeof item[3] === "object" ? item[3] : {};
  const nodeCount =
    prompt && typeof prompt === "object" && !Array.isArray(prompt)
      ? Object.keys(prompt).length
      : 0;
  let title = null;
  try {
    const wf = extra?.extra_pnginfo?.workflow;
    if (wf?.title != null && String(wf.title).trim()) title = String(wf.title).trim();
    else if (wf?.name != null && String(wf.name).trim()) title = String(wf.name).trim();
  } catch {
    /* ignore */
  }
  return { id: promptId, title, nodeCount };
}

/**
 * @param {(url: string, opts?: object) => Promise<any>} fetchFn
 * @param {string} base
 * @returns {Promise<{id:string, status:string, durationMs:number|null} | null>}
 */
async function fetchLastJob(fetchFn, base) {
  try {
    const res = await fetchFn(
      `${base}/api/jobs?status=completed,failed&limit=1&sort_by=created_at&sort_order=desc`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) }
    );
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
      const job = jobs[0];
      if (job && typeof job === "object" && job.id != null) {
        const start = numOrNull(job.execution_start_time);
        const end = numOrNull(job.execution_end_time);
        return {
          id: String(job.id),
          status: String(job.status || "completed"),
          durationMs: start != null && end != null && end >= start ? end - start : null,
        };
      }
      return null;
    }
  } catch {
    /* fallback below */
  }
  try {
    const res = await fetchFn(`${base}/history?max_items=1`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== "object") return null;
    const ids = Object.keys(data);
    if (ids.length === 0) return null;
    return { id: ids[ids.length - 1], status: "completed", durationMs: null };
  } catch {
    return null;
  }
}

/**
 * @param {(url: string, opts?: object) => Promise<any>} fetchFn
 * @param {string} base
 * @returns {Promise<{checkpoints:string[], loras:string[]} | null>}
 */
async function fetchModels(fetchFn, base) {
  const list = async (p) => {
    try {
      const res = await fetchFn(`${base}${p}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return [];
      const data = await res.json().catch(() => []);
      if (!Array.isArray(data)) return [];
      return data
        .map((x) => (typeof x === "string" ? x.split("/").pop() : null))
        .filter(Boolean)
        .slice(0, 30);
    } catch {
      return [];
    }
  };
  const [checkpoints, loras] = await Promise.all([
    list("/models/checkpoints"),
    list("/models/loras"),
  ]);
  if (checkpoints.length === 0 && loras.length === 0) return null;
  return { checkpoints, loras };
}

/**
 * Probe ComfyUI on one port.
 * @param {number | string | null | undefined} port
 * @param {{ fetch?: (url: string, opts?: object) => Promise<any> }} [opts]
 * @returns {Promise<{port:number, version:string|null, pytorchVersion:string|null, deviceType:string|null, queueRunning:number, queuePending:number, activeJob:object|null, pendingJobs:object[], lastJob:object|null, modelsInstalled:object|null} | null>}
 */
export async function collectComfy(port, { fetch: fetchFn = fetch } = {}) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
  const base = `http://127.0.0.1:${p}`;

  try {
    const statsRes = await fetchFn(`${base}/system_stats`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!statsRes.ok) return null;
    const stats = await statsRes.json().catch(() => null);
    if (!stats || typeof stats !== "object") return null;

    const system = stats.system && typeof stats.system === "object" ? stats.system : {};
    const devices = Array.isArray(stats.devices) ? stats.devices : [];
    const deviceType =
      devices[0] && typeof devices[0] === "object" && devices[0].type != null
        ? String(devices[0].type)
        : null;

    let queueRunning = 0;
    let queuePending = 0;
    let activeJob = null;
    /** @type {object[]} */
    let pendingJobs = [];
    try {
      const qRes = await fetchFn(`${base}/queue`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (qRes.ok) {
        const q = await qRes.json().catch(() => null);
        const running = Array.isArray(q?.queue_running) ? q.queue_running : [];
        const pending = Array.isArray(q?.queue_pending) ? q.queue_pending : [];
        queueRunning = running.length;
        queuePending = pending.length;
        activeJob = normalizeJob(running[0]) || null;
        pendingJobs = pending.slice(0, 5).map(normalizeJob).filter(Boolean);
      }
    } catch {
      /* queue optional */
    }

    const lastJob = await fetchLastJob(fetchFn, base);
    const modelsInstalled = await fetchModels(fetchFn, base);

    return {
      port: p,
      version: system.comfyui_version != null ? String(system.comfyui_version) : null,
      pytorchVersion:
        system.pytorch_version != null ? String(system.pytorch_version) : null,
      deviceType,
      queueRunning,
      queuePending,
      activeJob,
      pendingJobs,
      lastJob,
      modelsInstalled,
    };
  } catch {
    return null;
  }
}
