import type { SparkSnapshot } from "../../api/types";

export interface FleetTotals {
  total: number;
  online: number;
  /** Sum of generation tok/s across every available LLM endpoint. */
  decodeTps: number;
  /** Estimated whole-node draw (W) across online units; see `estimateNodeWatts`. */
  powerW: number;
  /** Unified memory / VRAM in use (MB) across online units. */
  memUsedMb: number;
  /** Unified memory / VRAM capacity (MB) across all units that report it. */
  memTotalMb: number;
}

/**
 * Everything on a unit that is neither the GPU nor the CPU rail (SSD, NIC, fans,
 * conversion loss), in watts. Same figure as `estimateNodeWatts` in
 * server/energy/FleetEnergyTracker.js. On a GB10 the two estimates are the
 * same formula; the tracker additionally assumes a 65 W CPU and caps a unit
 * at 240 W, so they differ on other hosts.
 */
export const NODE_OVERHEAD_W = 23;

const isWatts = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * Estimated whole-node draw (W): measured GPU rail + the server's CPU estimate +
 * platform overhead. Null when the unit reports neither rail, so a unit without
 * power telemetry is left out instead of counted as overhead alone.
 */
export function estimateNodeWatts(s: SparkSnapshot): number | null {
  const gpu = s.metrics?.gpu?.power?.draw;
  const cpu = s.metrics?.cpu?.draw;
  if (!isWatts(gpu) && !isWatts(cpu)) return null;
  return (isWatts(gpu) ? gpu : 0) + (isWatts(cpu) ? cpu : 0) + NODE_OVERHEAD_W;
}

/** Aggregate live fleet numbers from one snapshot list (pure). */
export function computeFleetTotals(sparks: readonly SparkSnapshot[]): FleetTotals {
  const t: FleetTotals = { total: sparks.length, online: 0, decodeTps: 0, powerW: 0, memUsedMb: 0, memTotalMb: 0 };
  for (const s of sparks) {
    const total = s.metrics?.gpu?.vram?.total || s.metrics?.unifiedMemory?.total || 0;
    t.memTotalMb += total;
    if (!s.online) continue;
    t.online += 1;
    t.powerW += estimateNodeWatts(s) ?? 0;
    t.memUsedMb += s.metrics?.gpu?.vram?.used ?? s.metrics?.unifiedMemory?.used ?? 0;
    if (Array.isArray(s.metrics?.llm)) {
      for (const llm of s.metrics.llm) if (llm.available) t.decodeTps += llm.generationTps || 0;
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
export function shutdownWarnings(sparks: readonly SparkSnapshot[]): string[] {
  const out: string[] = [];
  for (const s of sparks) {
    if (!s.online) continue;
    const llmBusy = Array.isArray(s.metrics?.llm)
      ? s.metrics.llm.reduce((n, l) => n + Math.max(l.slotsActive || 0, l.requestsRunning || 0), 0)
      : 0;
    if (llmBusy > 0) out.push(`${s.name}: ${llmBusy} in-flight LLM request${llmBusy === 1 ? "" : "s"}`);
    if ((s.metrics?.comfy?.queueRunning ?? 0) > 0) out.push(`${s.name}: ComfyUI job running`);
    if (s.hermes?.status === "running") out.push(`${s.name}: Hermes update in progress`);
  }
  return out;
}

export function formatCtx(n: number | null | undefined): string | null {
  if (!n || n <= 0) return null;
  return n >= 1000 ? `${Math.round(n / 1024)}k ctx` : `${n} ctx`;
}
