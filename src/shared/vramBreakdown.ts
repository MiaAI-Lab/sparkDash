import { resolveSparkRole } from "../api/sparkRole";
import type { LlmMetrics, SparkRole } from "../api/types";
import { backendLabel } from "./llmBackends.js";

/**
 * GPU memory broken down by what holds it, and judged by how much is left.
 *
 * The VRAM bar used to be a single fill coloured by percentage, which is wrong
 * both ways on a serving unit: an LLM engine pre-allocates its KV cache pool at
 * start-up, so an idle GPU looks full, while on a GB10 (unified memory) the bar
 * showed only the GPU's share and hid what the CPU side was using from the same
 * pool. Here the bar is split by category — engine, system/CPU, other GPU, free
 * — and the only severity is the absolute headroom, because that is what decides
 * whether the next allocation fails or the OOM killer runs.
 */

/** GB10 shares one pool between CPU and GPU; a discrete card has its own VRAM. */
export type MemoryModel = "unified" | "discrete";

export type HeadroomTone = "ok" | "low" | "critical";

/**
 * Free memory below which the headroom turns amber (`low`) or red (`critical`),
 * in MB. A unified pool also feeds the OS and every CPU process, so it needs a
 * larger cushion than dedicated VRAM, which only a new GPU allocation can use.
 */
export const HEADROOM_THRESHOLDS_MB: Readonly<
  Record<MemoryModel, { readonly low: number; readonly critical: number }>
> = Object.freeze({
  unified: Object.freeze({ low: 8 * 1024, critical: 4 * 1024 }),
  discrete: Object.freeze({ low: 2 * 1024, critical: 1 * 1024 }),
});

/** The engine's own KV pool is nearly full at this fill: requests queue or get preempted. */
export const KV_NEARLY_FULL = 0.9;

export function memoryModelFor(kind: string | null | undefined): MemoryModel {
  return kind === "host" ? "discrete" : "unified";
}

/** Classify free memory (MB) against the thresholds for this memory model. */
export function headroomTone(freeMB: number, model: MemoryModel): HeadroomTone {
  const t = HEADROOM_THRESHOLDS_MB[model];
  if (!Number.isFinite(freeMB) || freeMB < t.critical) return "critical";
  if (freeMB < t.low) return "low";
  return "ok";
}

/**
 * MiniStat tone for an "Available" figure judged by `headroomTone`. Plenty of
 * room reads neutral, like the bar's header: the accent is amber, and an
 * amber "fine" next to an amber "low" says nothing.
 */
export function headroomMiniStatTone(tone: HeadroomTone): "default" | "warning" | "danger" {
  return tone === "critical" ? "danger" : tone === "low" ? "warning" : "default";
}

/** Text colour class for a headroom figure (neutral while there is room). */
export function headroomTextClass(tone: HeadroomTone): string {
  return tone === "critical" ? "text-danger" : tone === "low" ? "text-warning" : "text-text";
}

// ─── Is the GPU serving an LLM? ──────────────────────────

/** The snapshot fields that decide whether a unit's GPU is serving an LLM. */
export interface ServingUnitLike {
  id: string;
  kind?: string | null;
  online?: boolean | null;
  role?: SparkRole | string | null;
  workerNode?: boolean | null;
  workerHeadId?: string | null;
  metrics?: {
    llm?: ReadonlyArray<Partial<LlmMetrics> & { available: boolean }> | null;
  } | null;
}

type Endpoint = Partial<LlmMetrics> & { available: boolean };

function availableEndpoints(unit: ServingUnitLike | undefined): Endpoint[] {
  const llm = unit?.metrics?.llm;
  return Array.isArray(llm) ? llm.filter((l) => l?.available) : [];
}

/** The unit whose LLM API speaks for this unit's GPU: itself, or a worker's head. */
function servingSource(
  unit: ServingUnitLike,
  fleet: readonly ServingUnitLike[] | null | undefined,
): ServingUnitLike | null {
  if (resolveSparkRole(unit) !== "worker") return unit;
  const headId = unit.workerHeadId;
  if (!headId || !Array.isArray(fleet)) return null;
  const head = fleet.find((s) => s.id === headId);
  return head && head.online !== false ? head : null;
}

/**
 * Whether this unit's GPU is holding an LLM engine right now. A head or
 * standalone unit serves when one of its own LLM endpoints is available. A
 * worker has no API of its own (it is never probed), so it serves when its
 * head (`workerHeadId`) is online with an available endpoint. A worker whose
 * head is unknown, missing from `fleet`, or offline does not count.
 */
export function isLlmServing(
  unit: ServingUnitLike,
  fleet: readonly ServingUnitLike[] | null | undefined,
): boolean {
  return availableEndpoints(servingSource(unit, fleet) ?? undefined).length > 0;
}

/**
 * The endpoint describing the engine on this unit's GPU, or null. Only when
 * exactly one endpoint is available: with two engines on one unit there is no
 * telling which one the largest GPU process belongs to, and quoting the wrong
 * engine's KV fill is worse than quoting none.
 */
export function servingEndpoint(
  unit: ServingUnitLike,
  fleet: readonly ServingUnitLike[] | null | undefined,
): Endpoint | null {
  const live = availableEndpoints(servingSource(unit, fleet) ?? undefined);
  return live.length === 1 ? live[0] : null;
}

// ─── Breakdown ───────────────────────────────────────────

export type VramSegmentKey = "engine" | "system" | "other" | "gpu";

export interface VramSegment {
  key: VramSegmentKey;
  mb: number;
}

export interface GpuProcessLike {
  pid: number;
  name: string;
  vramMB: number;
}

export interface UnifiedMemoryLike {
  total: number;
  gpuUsed: number;
  cpuUsed: number;
  available: number;
}

export interface VramLike {
  used: number;
  total: number;
  available: number;
}

/** What a breakdown needs beyond the GPU numbers: computed once per unit. */
export interface VramBreakdownContext {
  model: MemoryModel;
  /** `metrics.unifiedMemory` on a GB10; ignored for a discrete card. */
  unified: UnifiedMemoryLike | null;
  serving: boolean;
  /** See `servingEndpoint`. Not used for per-card rows. */
  endpoint: Endpoint | null;
}

export function vramContextFor(
  unit: ServingUnitLike & { metrics?: { unifiedMemory?: UnifiedMemoryLike | null } | null },
  fleet: readonly ServingUnitLike[] | null | undefined,
): VramBreakdownContext {
  const model = memoryModelFor(unit.kind);
  return {
    model,
    unified: model === "unified" ? unit.metrics?.unifiedMemory ?? null : null,
    serving: isLlmServing(unit, fleet),
    endpoint: servingEndpoint(unit, fleet),
  };
}

export interface VramEngineInfo {
  name: string;
  pid: number;
  mb: number;
}

export interface VramKvInfo {
  /** 0–1, or null when the backend does not report it. */
  usage: number | null;
  poolGb: number | null;
  weightsGb: number | null;
  /** Display name of the backend, for "not reported by …". */
  backend: string | null;
}

export interface VramBreakdown {
  model: MemoryModel;
  totalMB: number;
  usedMB: number;
  /** Left to right, zero-sized ones dropped. Free is the bar's track. */
  segments: VramSegment[];
  /** Headroom: what a new allocation can still get. */
  freeMB: number;
  tone: HeadroomTone;
  engine: VramEngineInfo | null;
  /** CPU-side use of a unified pool; null on a discrete card. */
  systemMB: number | null;
  /** GPU use outside the engine — or all GPU use when no engine is identified. */
  otherMB: number;
  /** Only alongside an engine and an endpoint that speaks for it. */
  kv: VramKvInfo | null;
}

const finite = (n: unknown): number | null =>
  typeof n === "number" && Number.isFinite(n) ? n : null;

function largestProcess(processes: readonly GpuProcessLike[] | null | undefined) {
  if (!Array.isArray(processes)) return null;
  let best: GpuProcessLike | null = null;
  for (const p of processes) {
    const mb = finite(p?.vramMB);
    if (mb != null && mb > 0 && (best == null || mb > best.vramMB)) best = p;
  }
  return best;
}

/**
 * Split a GPU's memory into engine / system / other / free.
 *
 * - Unified (GB10): the bar is the whole pool (`unifiedMemory.total`); GPU use
 *   is `unifiedMemory.gpuUsed`, the CPU side `cpuUsed`, headroom `available`
 *   (MemAvailable). Without `unifiedMemory` it falls back to `vram`.
 * - Discrete: the bar is the card's VRAM; headroom is total − used (the host
 *   collector fills `available` with system RAM while no GPU process runs).
 * - Serving with a process list: the largest GPU process is the engine.
 *   Otherwise all GPU use is one "gpu" segment.
 *
 * Returns null when there is no total to draw against.
 */
export function computeVramBreakdown(
  vram: VramLike | null | undefined,
  processes: readonly GpuProcessLike[] | null | undefined,
  ctx: Pick<VramBreakdownContext, "model" | "unified" | "serving"> & {
    endpoint?: Endpoint | null;
  },
): VramBreakdown | null {
  const um = ctx.model === "unified" ? ctx.unified : null;
  const umTotal = finite(um?.total);
  let totalMB: number;
  let gpuUsedMB: number;
  let systemMB: number | null;
  let freeMB: number;
  if (um && umTotal != null && umTotal > 0) {
    totalMB = umTotal;
    gpuUsedMB = Math.max(0, finite(um.gpuUsed) ?? 0);
    systemMB = Math.max(0, finite(um.cpuUsed) ?? 0);
    freeMB = Math.max(0, finite(um.available) ?? totalMB - gpuUsedMB - systemMB);
  } else {
    totalMB = finite(vram?.total) ?? 0;
    if (totalMB <= 0) return null;
    gpuUsedMB = Math.max(0, finite(vram?.used) ?? 0);
    systemMB = null;
    freeMB =
      ctx.model === "unified"
        ? Math.max(0, finite(vram?.available) ?? totalMB - gpuUsedMB)
        : Math.max(0, totalMB - gpuUsedMB);
  }

  const largest = ctx.serving && gpuUsedMB > 0 ? largestProcess(processes) : null;
  const engine: VramEngineInfo | null = largest
    ? { name: largest.name, pid: largest.pid, mb: Math.min(largest.vramMB, gpuUsedMB) }
    : null;
  const otherMB = Math.max(0, gpuUsedMB - (engine?.mb ?? 0));

  const segments: VramSegment[] = [];
  if (engine) segments.push({ key: "engine", mb: engine.mb });
  if (systemMB != null) segments.push({ key: "system", mb: systemMB });
  segments.push({ key: engine ? "other" : "gpu", mb: otherMB });

  const ep = engine ? ctx.endpoint ?? null : null;
  const kv: VramKvInfo | null = ep
    ? {
        usage: finite(ep.kvCacheUsage),
        poolGb: finite(ep.kvCacheGb),
        weightsGb: finite(ep.weightsGb),
        backend: backendLabel(ep.backend ?? null),
      }
    : null;

  return {
    model: ctx.model,
    totalMB,
    usedMB: gpuUsedMB + (systemMB ?? 0),
    segments: segments.filter((s) => s.mb > 0),
    freeMB,
    tone: headroomTone(freeMB, ctx.model),
    engine,
    systemMB,
    otherMB,
    kv,
  };
}

export const SEGMENT_LABELS: Readonly<Record<VramSegmentKey, string>> = Object.freeze({
  engine: "Engine",
  system: "System",
  other: "Other",
  gpu: "GPU",
});

/** GB with one decimal, no unit: the legend's number format. */
export function gbNumber(mb: number): string {
  return (mb / 1024).toFixed(1);
}

/** Legend items in bar order, with the free figure last; tiny segments (< 0.05 GB) dropped. */
export function legendItems(b: VramBreakdown): Array<{ key: VramSegmentKey | "free"; label: string; gb: string }> {
  const items: Array<{ key: VramSegmentKey | "free"; label: string; gb: string }> = b.segments
    .filter((s) => gbNumber(s.mb) !== "0.0")
    .map((s) => ({ key: s.key, label: SEGMENT_LABELS[s.key], gb: gbNumber(s.mb) }));
  items.push({ key: "free", label: "Free", gb: gbNumber(b.freeMB) });
  return items;
}

export function kvNearlyFull(b: VramBreakdown): boolean {
  return b.kv?.usage != null && b.kv.usage >= KV_NEARLY_FULL;
}

/** One plain sentence on what the numbers mean. */
export function verdict(b: VramBreakdown): string {
  if (b.tone !== "ok") {
    const lead = b.tone === "critical" ? "Very low headroom" : "Low headroom";
    return b.model === "unified"
      ? `${lead}: CPU-side growth could trigger the OOM killer`
      : `${lead}: a new GPU allocation could fail with out of memory`;
  }
  if (kvNearlyFull(b)) return "Engine KV pool nearly full: new requests queue or get preempted";
  return "Plenty of headroom";
}
