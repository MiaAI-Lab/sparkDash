import type { SparkSnapshot } from "../../api/types";

export interface FleetTotals {
  total: number;
  online: number;
  /** Sum of generation tok/s across every available LLM endpoint. */
  decodeTps: number;
  /** Sum of GPU power draw (W) across online units. */
  powerW: number;
  /** Unified memory / VRAM in use (MB) across online units. */
  memUsedMb: number;
  /** Unified memory / VRAM capacity (MB) across all units that report it. */
  memTotalMb: number;
}

/** Aggregate live fleet numbers from one snapshot list (pure). */
export function computeFleetTotals(sparks: readonly SparkSnapshot[]): FleetTotals {
  const t: FleetTotals = { total: sparks.length, online: 0, decodeTps: 0, powerW: 0, memUsedMb: 0, memTotalMb: 0 };
  for (const s of sparks) {
    const total = s.metrics?.gpu?.vram?.total || s.metrics?.unifiedMemory?.total || 0;
    t.memTotalMb += total;
    if (!s.online) continue;
    t.online += 1;
    t.powerW += s.metrics?.gpu?.power?.draw ?? 0;
    t.memUsedMb += s.metrics?.gpu?.vram?.used ?? s.metrics?.unifiedMemory?.used ?? 0;
    if (Array.isArray(s.metrics?.llm)) {
      for (const llm of s.metrics.llm) if (llm.available && llm.measurementValid !== false) t.decodeTps += llm.generationTps || 0;
    }
  }
  return t;
}

/** Append to a rolling window, keeping the newest `max` samples (returns a new array). */
export function pushRolling(buf: readonly number[], value: number, max = 30): number[] {
  const next = buf.length >= max ? buf.slice(buf.length - max + 1) : buf.slice();
  next.push(Number.isFinite(value) ? value : 0);
  return next;
}

/** Percent change between the first and last sample, or null when the window is too short / baseline is zero. */
export function trendDeltaPct(series: readonly number[], minSamples = 8): number | null {
  if (series.length < minSamples) return null;
  const head = series.slice(0, Math.max(1, Math.floor(series.length / 4)));
  const tail = series.slice(-Math.max(1, Math.floor(series.length / 4)));
  const avg = (a: readonly number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const base = avg(head);
  if (base <= 0) return null;
  return ((avg(tail) - base) / base) * 100;
}

/** Work that a fleet shutdown would interrupt, from signals already in the snapshot. */
export interface ShutdownWarningCopy {
  inFlight: (sparkName: string, count: number) => string;
  comfyJob: (sparkName: string) => string;
  hermesUpdate: (sparkName: string) => string;
}

const defaultShutdownWarningCopy: ShutdownWarningCopy = {
  inFlight: (sparkName, count) => `${sparkName}: ${count} in-flight LLM request${count === 1 ? "" : "s"}`,
  comfyJob: (sparkName) => `${sparkName}: ComfyUI job running`,
  hermesUpdate: (sparkName) => `${sparkName}: Hermes update in progress`,
};

/**
 * Work that a fleet shutdown would interrupt. Callers may provide presentation
 * copy, while this function remains the sole source of the underlying signals.
 */
export function shutdownWarnings(sparks: readonly SparkSnapshot[], copy: ShutdownWarningCopy = defaultShutdownWarningCopy): string[] {
  const out: string[] = [];
  for (const s of sparks) {
    if (!s.online) continue;
    const llmBusy = Array.isArray(s.metrics?.llm)
      ? s.metrics.llm.reduce((n, l) => n + Math.max(l.slotsActive || 0, l.requestsRunning || 0), 0)
      : 0;
    if (llmBusy > 0) out.push(copy.inFlight(s.name, llmBusy));
    if ((s.metrics?.comfy?.queueRunning ?? 0) > 0) out.push(copy.comfyJob(s.name));
    if (s.hermes?.status === "running") out.push(copy.hermesUpdate(s.name));
  }
  return out;
}

export function formatCtx(n: number | null | undefined): string | null {
  if (!n || n <= 0) return null;
  return n >= 1000 ? `${Math.round(n / 1024)}k ctx` : `${n} ctx`;
}
