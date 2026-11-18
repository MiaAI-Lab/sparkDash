/**
 * Fleet health findings: small, explainable rules over metrics sparkDash
 * already collects. One evaluator per Spark keeps the few bits of state the
 * rules need (sample streaks, the last kernel-error counters).
 *
 * A finding is { id, severity: "warn" | "critical", title, detail, hint }.
 * Rules never throw and never guess: a missing metric simply raises nothing.
 */

/**
 * Samples the low-power condition must hold for. A stall that clears within a
 * couple of minutes is normal sync/pipeline overhead, not a stuck GPU, so the
 * streak is long enough to ignore it (30 samples: ~30 s at a 1 s poll, ~60 s at
 * the 2 s default) while still catching a sustained wedge.
 */
export const LOW_POWER_STREAK = 30;
/**
 * How long measured inference progress keeps the low-power warning suppressed.
 * Bound the evidence so an old successful poll cannot hide a sustained stall.
 */
export const LOW_POWER_PROGRESS_MS = 60 * 1000;
/** Kernel-error findings stay visible this long after the counter last rose. */
export const KERNEL_FINDING_TTL_MS = 60 * 60 * 1000;

/**
 * How far back the cold-prefill rule looks. Ten minutes holds a handful of
 * turns of one conversation, which is the unit the rule judges: a session that
 * misses the cache on every turn, not one slow request.
 */
export const COLD_PREFILL_WINDOW_MS = 10 * 60 * 1000;
/**
 * Uncached prompt tokens inside the window before the rule fires.
 *
 * Measured on a three-Spark TensorFold cluster: a client session of ~255k
 * tokens missed the server prompt cache on every turn (`prompt=255715 cached=0`),
 * so each turn prefilled the whole prompt again at ~1.1k tok/s and stopped
 * decode for every other session for 45 s. Two such turns inside five minutes
 * is ~510k uncached tokens with a cached share near zero.
 *
 * A single cold first request of a new session is normal. The long conversations
 * we see start at 30-120k tokens, so 300k sits above the largest single cold
 * prompt and below two 255k misses.
 */
export const COLD_PREFILL_MIN_UNCACHED_TOKENS = 300_000;
/**
 * Cached share of submitted prompt tokens below which the cache is judged not to
 * be serving the session. A healthy agent session re-sends a growing
 * conversation and is 80-98 % cached; under half means the prompt is being
 * recomputed rather than restored.
 */
export const COLD_PREFILL_MAX_CACHED_SHARE = 0.5;

/**
 * Swap traffic, in pages per second, that counts as sustained swapping. A page
 * is 4 KiB on the Linux platforms sparkDash runs on, so this is ~400 KiB/s.
 * Idle units read 0; a unit under memory pressure reads thousands.
 */
export const SWAP_RATE_PAGES_PER_SEC = 100;
/**
 * Memory samples the swap rate must stay above the threshold for. Mirrors
 * LOW_POWER_STREAK: long enough to ignore one process being paged out once,
 * short enough to catch a unit thrashing for half a minute.
 */
export const SWAP_STREAK = 15;

const DEFAULT_TEMP_THRESHOLDS = Object.freeze({ warnC: 85, criticalC: 90 });
const MEM_AVAIL_WARN_MB = 3072;
const MEM_AVAIL_CRITICAL_MB = 1536;
const LOW_POWER_UTIL = 90;
/**
 * The draw below which "busy" is not credible. Anchored to idle draw rather
 * than a fixed guess: on a discrete card idle is ~10-20 W so 15 W sits well
 * under load, but on an integrated part like the GB10 the GPU draws ~10 W at
 * idle, so 15 W also caught ordinary memory-bound decode and barrier waits that
 * report ~96 % kernel residency at ~14 W. 11 W means "at or about idle draw",
 * which is the state this rule is looking for.
 */
const LOW_POWER_WATTS = 11;
const LINK_MIN_MBPS = 1000;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Token counters and live positions that prove work between two polls.
 * Rates are deliberately absent: a probe can keep a positive rate across a
 * failed /metrics read or a counterless busy health check, so only counters
 * that actually rose are evidence.
 */
const PROGRESS_COUNTERS = Object.freeze([
  "totalOutputTokens",
  "totalPromptTokens",
  "prefillProgressTokens",
  "generationProgressTokens",
]);

/** Stable identity for one probed endpoint: port, backend and served model. */
function endpointKey(entry) {
  const port = num(entry?.port);
  const backend = typeof entry?.backend === "string" ? entry.backend : "";
  const modelId = typeof entry?.modelId === "string" ? entry.modelId : "";
  return `${port}|${backend}|${modelId}`;
}

/** Token counters and live positions, with unusable values as null. */
function progressCounters(entry) {
  const out = {};
  for (const key of PROGRESS_COUNTERS) {
    const value = num(entry?.[key]);
    out[key] = value != null && value >= 0 ? value : null;
  }
  return out;
}

/** True when any counter rose. A reset (lower value) is a new baseline, not progress. */
function countersAdvanced(prev, next) {
  for (const key of PROGRESS_COUNTERS) {
    const before = prev[key];
    const after = next[key];
    if (before != null && after != null && after > before) return true;
  }
  return false;
}

/** A timestamp is recent only when it is a real past instant inside the window. */
function isRecentProgress(at, now) {
  return at != null && at <= now && now - at < LOW_POWER_PROGRESS_MS;
}

/**
 * Cumulative prompt counters for one endpoint, or null when the engine reports
 * no cache split. `totalPromptTokens` is every prompt token submitted (cached
 * and computed); `totalCachedTokens` is the subset the prompt cache served.
 */
function promptCounters(entry) {
  const submitted = num(entry?.totalPromptTokens);
  const cached = num(entry?.totalCachedTokens);
  if (submitted == null || submitted < 0 || cached == null || cached < 0) return null;
  return { submitted, cached: Math.min(cached, submitted) };
}

/** Thousands-separated token count, so a detail line reads as a number. */
const tokens = (n) => Math.round(n).toLocaleString("en-US");

/** "model on port 8888", or the port alone when the model is unknown. */
function endpointLabel(entry) {
  const port = num(entry?.port);
  const model = typeof entry?.modelId === "string" && entry.modelId ? entry.modelId : null;
  if (model && port != null) return `${model} on port ${port}`;
  if (model) return model;
  if (port != null) return `port ${port}`;
  return "an engine";
}

/**
 * The GPU thresholds below are tuned for NVIDIA cards. Other vendors (Intel Arc
 * today) stay in the displayed panel and the power totals but are not judged
 * here: their temperature, utilisation and power-cap behaviour differ, so the
 * rules are fed from the NVIDIA devices only. A host with no per-device list
 * (older snapshot shape) or only NVIDIA cards gets the aggregate unchanged.
 * Returns null when the host has GPUs but none are NVIDIA.
 */
function nvidiaView(gpu) {
  const devices = Array.isArray(gpu?.gpus) ? gpu.gpus : null;
  if (!devices || devices.every((d) => (d?.vendor ?? "nvidia") === "nvidia")) return gpu;
  const nv = devices.filter((d) => (d?.vendor ?? "nvidia") === "nvidia");
  if (!nv.length) return gpu?.kernelErrors ? { kernelErrors: gpu.kernelErrors } : null;
  const max = (key) => Math.max(...nv.map((d) => num(d[key]) ?? 0));
  const draw = nv.reduce((sum, d) => sum + (num(d.power?.draw) ?? 0), 0);
  return {
    ...gpu,
    temperature: max("temperature"),
    usage: max("usage"),
    power: { ...gpu.power, draw: Math.round(draw * 100) / 100 },
  };
}

export class HealthEvaluator {
  /**
   * @param {{ now?: () => number, thresholds?: () => { warnC: number, criticalC: number } }} [opts]
   *   `thresholds` is read on every evaluation, so a settings change applies
   *   on the next sample without rebuilding the evaluator.
   */
  constructor({ now = Date.now, thresholds = () => DEFAULT_TEMP_THRESHOLDS } = {}) {
    this._now = now;
    this._thresholds = thresholds;
    this._lowPowerStreak = 0;
    this._kernel = { xid: null, oom: null };
    this._kernelAt = { xid: 0, oom: 0 };
    this._kernelLast = { xid: null, oom: null };
    /** Per-endpoint cumulative counters and the last time they advanced. */
    this._llmProgress = new Map();
    /** Per-endpoint prompt-cache window: cumulative counters plus the recent deltas. */
    this._prefill = new Map();
    /** Consecutive memory samples with sustained swap traffic. */
    this._swapStreak = 0;
    /** Latest measured progress across the endpoints available right now, or null. */
    this.llmProgressAt = null;
    /** Whether local or head progress is recent enough to explain a busy low-power GPU. */
    this.lowPowerProgressing = false;
    /** Events produced by the latest evaluate() (kernel counters rising). */
    this.pendingEvents = [];
  }

  /**
   * @param {{ gpu?: any, unifiedMemory?: any, network?: any, llm?: any[], headLlmProgressAt?: number|null }} metrics
   * @param {"gpu"|"llm"|"memory"|"other"} [domain] "gpu" advances the per-sample
   *   streaks, "llm" advances the per-endpoint inference-progress counters and
   *   the prompt-cache window, "memory" advances the swap streak.
   * @returns {Array<{id:string,severity:string,title:string,detail:string,hint:string}>}
   */
  evaluate(metrics, domain = "other") {
    this.pendingEvents = [];
    const out = [];
    try {
      const gpu = nvidiaView(metrics?.gpu ?? null);
      const mem = metrics?.unifiedMemory ?? null;
      const net = metrics?.network ?? null;
      const llm = Array.isArray(metrics?.llm) ? metrics.llm : [];
      this._trackLlmProgress(llm, domain, metrics?.headLlmProgressAt);
      this._trackPrefill(llm, domain);
      this._thermal(gpu, out);
      this._lowPower(gpu, domain, out);
      this._memory(mem, out);
      this._swap(mem, domain, out);
      this._kernelErrors(gpu, out);
      this._concurrency(llm, mem, out);
      this._coldPrefill(out);
      this._link(net, out);
      this._roce(metrics?.roce ?? null, out);
    } catch {
      /* a rule bug must never break the poll loop */
    }
    return out;
  }

  _thermal(gpu, out) {
    const t = num(gpu?.temperature);
    let { warnC, criticalC } = this._thresholds() ?? {};
    if (num(warnC) == null || num(criticalC) == null || warnC >= criticalC) ({ warnC, criticalC } = DEFAULT_TEMP_THRESHOLDS);
    if (t == null || t < warnC) return;
    const critical = t >= criticalC;
    out.push({
      id: "thermal",
      severity: critical ? "critical" : "warn",
      title: critical ? "GPU is close to its shutdown temperature" : "GPU is running hot",
      detail: `${Math.round(t)}°C (warns at ${warnC}°C, critical at ${criticalC}°C).`,
      hint: "Check airflow and the room temperature, and that nothing blocks the vents. Lower the power limit or the load if it keeps climbing.",
    });
  }

  /**
   * Remember which endpoints are doing real work. Only a fresh LLM poll may
   * advance the counters; every evaluation prunes endpoints that disappeared,
   * went unavailable or errored, so a disabled probe cannot keep a stale
   * "progressing" verdict alive.
   */
  _trackLlmProgress(llm, domain, headAt) {
    const now = this._now();
    const current = new Map();
    for (const entry of llm) {
      if (!entry || entry.available !== true || entry.measurementValid === false || entry.error) continue;
      current.set(endpointKey(entry), entry);
    }
    for (const key of this._llmProgress.keys()) {
      if (!current.has(key)) this._llmProgress.delete(key);
    }
    if (domain === "llm") {
      for (const [key, entry] of current) {
        const counters = progressCounters(entry);
        const prev = this._llmProgress.get(key);
        const at = prev && countersAdvanced(prev.counters, counters) ? now : prev?.at ?? null;
        this._llmProgress.set(key, { counters, at });
      }
    }
    let latest = null;
    for (const key of current.keys()) {
      const at = this._llmProgress.get(key)?.at ?? null;
      if (at != null && (latest == null || at > latest)) latest = at;
    }
    this.llmProgressAt = latest;
    this.lowPowerProgressing = isRecentProgress(latest, now) || isRecentProgress(num(headAt), now);
  }

  _lowPower(gpu, domain, out) {
    const util = num(gpu?.usage);
    const draw = num(gpu?.power?.draw);
    if (util == null || draw == null) {
      if (domain === "gpu") this._lowPowerStreak = 0;
      return;
    }
    const suspicious = util >= LOW_POWER_UTIL && draw < LOW_POWER_WATTS;
    if (domain === "gpu") this._lowPowerStreak = suspicious ? this._lowPowerStreak + 1 : 0;
    if (this._lowPowerStreak < LOW_POWER_STREAK) return;
    // Measured inference progress explains a busy GPU at idle draw; the streak
    // keeps counting so the warning returns as soon as the evidence ages out.
    if (this.lowPowerProgressing) return;
    out.push({
      id: "low-power",
      severity: "warn",
      title: "GPU has high utilisation with low power draw",
      detail: `${Math.round(util)}% utilisation but only ${draw.toFixed(1)} W for ${this._lowPowerStreak} samples in a row.`,
      hint: "This can be normal during memory-bound decode. Check workload progress and token throughput first; if progress has stopped, inspect driver logs and power-management settings.",
    });
  }

  _memory(mem, out) {
    const avail = num(mem?.available);
    const total = num(mem?.total);
    if (avail == null || total == null || total <= 0) return;
    if (avail >= MEM_AVAIL_WARN_MB) return;
    const critical = avail < MEM_AVAIL_CRITICAL_MB;
    out.push({
      id: "memory",
      severity: critical ? "critical" : "warn",
      title: critical ? "Unified memory is almost exhausted" : "Unified memory is running low",
      detail: `${(avail / 1024).toFixed(1)} GB available of ${(total / 1024).toFixed(0)} GB.`,
      hint: "The kernel may start killing processes. Stop a model you are not using, lower the context length or the GPU memory utilisation.",
    });
  }

  /**
   * Sustained swap traffic. Only the rate matters: swap that is merely occupied
   * by cold pages reads 0 pages/s and must not fire. A unit that reports no swap
   * counters (macOS, Windows, an unreadable /proc/vmstat) resets the streak and
   * raises nothing.
   */
  _swap(mem, domain, out) {
    const swap = mem?.swap;
    const inRate = num(swap?.inPagesPerSec);
    const outRate = num(swap?.outPagesPerSec);
    if (inRate == null || outRate == null) {
      if (domain === "memory") this._swapStreak = 0;
      return;
    }
    const busy = inRate >= SWAP_RATE_PAGES_PER_SEC || outRate >= SWAP_RATE_PAGES_PER_SEC;
    if (domain === "memory") this._swapStreak = busy ? this._swapStreak + 1 : 0;
    if (this._swapStreak < SWAP_STREAK) return;
    out.push({
      id: "swap-traffic",
      severity: "warn",
      title: "The unit is swapping",
      detail: `Swap-in ${Math.round(inRate)} pages/s and swap-out ${Math.round(outRate)} pages/s for ${this._swapStreak} samples in a row.`,
      hint: "Sustained swapping on a unified-memory Spark moves pages over the same memory the GPU uses, so everything slows down. Free memory: stop a model you are not using, lower the context length or the GPU memory utilization.",
    });
  }

  /**
   * Remember how much prompt each endpoint submitted and how much of it the
   * prompt cache served. Only a fresh LLM poll may advance the window; every
   * evaluation prunes endpoints that disappeared, went unavailable or errored.
   * A counter that went backwards is an engine restart, so it reseeds the
   * baseline instead of producing a negative delta.
   */
  _trackPrefill(llm, domain) {
    const now = this._now();
    const current = new Map();
    for (const entry of llm) {
      if (!entry || entry.available !== true || entry.measurementValid === false || entry.error) continue;
      current.set(endpointKey(entry), entry);
    }
    for (const key of this._prefill.keys()) {
      if (!current.has(key)) this._prefill.delete(key);
    }
    if (domain !== "llm") return;
    for (const [key, entry] of current) {
      const counters = promptCounters(entry);
      const prev = this._prefill.get(key);
      // An engine that stops reporting the split has no window to judge.
      if (!counters) {
        this._prefill.delete(key);
        continue;
      }
      const label = endpointLabel(entry);
      if (!prev || counters.submitted < prev.submitted || counters.cached < prev.cached) {
        this._prefill.set(key, { submitted: counters.submitted, cached: counters.cached, samples: [], label });
        continue;
      }
      const samples = prev.samples.filter((s) => now - s.at < COLD_PREFILL_WINDOW_MS);
      const dSubmitted = counters.submitted - prev.submitted;
      if (dSubmitted > 0) {
        const dCached = Math.min(counters.cached - prev.cached, dSubmitted);
        samples.push({ at: now, submitted: dSubmitted, cached: dCached });
      }
      this._prefill.set(key, { submitted: counters.submitted, cached: counters.cached, samples, label });
    }
  }

  /** A large amount of prompt prefilled uncached while the cache served little of it. */
  _coldPrefill(out) {
    const now = this._now();
    let worst = null;
    for (const state of this._prefill.values()) {
      const samples = state.samples.filter((s) => now - s.at < COLD_PREFILL_WINDOW_MS);
      if (samples.length === 0) continue;
      const submitted = samples.reduce((n, s) => n + s.submitted, 0);
      if (submitted <= 0) continue;
      const cached = samples.reduce((n, s) => n + s.cached, 0);
      const uncached = submitted - cached;
      const share = cached / submitted;
      if (uncached < COLD_PREFILL_MIN_UNCACHED_TOKENS || share >= COLD_PREFILL_MAX_CACHED_SHARE) continue;
      if (!worst || uncached > worst.uncached) worst = { submitted, cached, uncached, share, label: state.label };
    }
    if (!worst) return;
    const minutes = Math.round(COLD_PREFILL_WINDOW_MS / 60_000);
    out.push({
      id: "cold-prefill",
      severity: "warn",
      title: "Large prompts keep missing the engine cache",
      detail: `${tokens(worst.uncached)} uncached prompt tokens in the last ${minutes} minutes on ${worst.label}: the cache served ${Math.round(worst.share * 100)}% of ${tokens(worst.submitted)} submitted.`,
      hint: "The client session is too large to stay in the prompt cache, or the engine's prompt cache is too small. Compact or restart the session, or raise the engine's prompt-cache size.",
    });
  }

  _kernelErrors(gpu, out) {
    const ke = gpu?.kernelErrors;
    if (!ke) return;
    const now = this._now();
    const rules = [
      ["xid", "xid", "NVIDIA Xid error", "A GPU or driver error was logged by the kernel",
        "Look up the Xid code in NVIDIA's Xid catalog. Repeated driver-class Xids point at hardware or a driver bug."],
      ["oom", "oom", "Kernel killed a process (out of memory)", "The kernel's OOM killer ended a process",
        "Something ran out of memory. Lower the model's memory use or stop other workloads."],
    ];
    for (const [key, id, title, what, hint] of rules) {
      const count = num(key === "xid" ? ke.xid : ke.oomKills);
      if (count == null) continue;
      const prev = this._kernel[key];
      this._kernel[key] = count;
      if (prev != null && count > prev) {
        this._kernelAt[key] = now;
        const last = key === "xid" && typeof ke.lastXid === "string" && ke.lastXid ? ` (${ke.lastXid})` : "";
        this.pendingEvents.push({
          type: `health.${id}`,
          severity: "error",
          message: `${title}: ${count - prev} new since the last check${last}`,
        });
        this._kernelLast[key] = key === "xid" ? ke.lastXid ?? null : null;
      }
      if (this._kernelAt[key] && now - this._kernelAt[key] < KERNEL_FINDING_TTL_MS) {
        const extra = key === "xid" && this._kernelLast.xid ? ` Latest: ${this._kernelLast.xid}.` : "";
        out.push({
          id,
          severity: "critical",
          title,
          detail: `${what} within the last hour (${count} since boot).${extra}`,
          hint,
        });
      }
    }
  }

  _concurrency(llm, mem, out) {
    const serving = llm.filter((l) => l && l.available && l.modelId);
    const ids = new Set(serving.map((l) => l.modelId));
    if (ids.size < 2) return;
    const pct = num(mem?.percentage);
    if (pct == null || pct < 70) return;
    out.push({
      id: "concurrency",
      severity: "warn",
      title: "Several models are loaded on this node",
      detail: `${ids.size} different models are serving while ${Math.round(pct)}% of memory is in use.`,
      hint: "Heavy backends compete for the same unified memory. Stop the ones you are not using to avoid out-of-memory kills.",
    });
  }

  _link(net, out) {
    const mbps = num(net?.linkSpeedMbps);
    if (mbps == null || mbps <= 0 || mbps >= LINK_MIN_MBPS) return;
    out.push({
      id: "link-speed",
      severity: "warn",
      title: "Network link is slower than 1 Gb/s",
      detail: `${net?.primaryInterface ?? "The primary interface"} negotiated ${mbps} Mb/s.`,
      hint: "Check the cable and the switch port. A cluster running over a degraded link slows every tensor-parallel step.",
    });
  }
}


// RoCE rules (see collectors/roce.js). Kept out of the class body above for readability.
const ROCE_LOSS_STREAK = 3;
const ROCE_ETH_LOSS_STREAK = 2;

HealthEvaluator.prototype._roce = function roce(roce, out) {
  const devices = Array.isArray(roce?.devices) ? roce.devices : [];
  // A port that was up and is not any more. Ports that never came up (uncabled) are not a finding.
  const down = devices.filter((d) => d.everActive && !d.active);
  if (down.length > 0) {
    out.push({
      id: "roce-link",
      severity: "critical",
      title: down.length === 1 ? "A RoCE link went down" : `${down.length} RoCE links went down`,
      detail: down.map((d) => `${d.netdev ?? d.name}: ${d.state ?? "unknown"}${d.physState ? ` (${d.physState})` : ""}`).join(", ") + ".",
      hint: "Check the cable, the transceiver and the switch port. Tensor-parallel and NCCL traffic over this port stalls or falls back to another path.",
    });
  }
  // Loss counters that keep rising across several samples in a row.
  const lossy = devices.filter(
    (d) => d.active && ((num(d.loss?.streak) ?? 0) >= ROCE_LOSS_STREAK || (num(d.loss?.ethStreak) ?? 0) >= ROCE_ETH_LOSS_STREAK)
  );
  if (lossy.length > 0) {
    out.push({
      id: "roce-loss",
      severity: "warn",
      title: "RoCE is dropping packets",
      detail: lossy.map((d) => `${d.netdev ?? d.name}: ${(d.loss.rising ?? []).join(", ") || "counters rising"}`).join("; ") + ".",
      hint: "Rising out_of_buffer, sequence or ack-timeout errors point at congestion or a lossless-network (PFC/ECN) misconfiguration. Compare the PFC and trust settings on every Spark and on the switch.",
    });
  }
};

export default HealthEvaluator;
