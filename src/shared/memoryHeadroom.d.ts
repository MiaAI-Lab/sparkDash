/** GB10 shares one pool between CPU and GPU; a discrete card has its own VRAM. */
export type MemoryModel = "unified" | "discrete";

export type HeadroomTone = "ok" | "low" | "critical";

export interface HeadroomThresholds {
  readonly low: number;
  readonly critical: number;
}

export const HEADROOM_THRESHOLDS_MB: Readonly<Record<MemoryModel, HeadroomThresholds>>;

export function memoryModelFor(kind: string | null | undefined): MemoryModel;

export function headroomTone(
  freeMB: number,
  model: MemoryModel,
  thresholds?: HeadroomThresholds,
): HeadroomTone;

export function headroomFreeMB(
  model: MemoryModel,
  unified:
    | { total?: number; gpuUsed?: number; cpuUsed?: number; available?: number }
    | null
    | undefined,
  vram: { total?: number; used?: number; available?: number } | null | undefined,
): number | null;
