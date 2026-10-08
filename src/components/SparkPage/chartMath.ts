/** Pure helpers for the Spark-detail charts and memory breakdown (no React, no I/O). */

export interface Pt {
  at: number;
  value: number;
}

/**
 * Average samples into equal-width time buckets across [startAt, endAt].
 * Keeps long windows (8 h at a 2 s poll) cheap to draw. Empty buckets are
 * skipped, so gaps stay gaps. Each output point sits at the mean timestamp of
 * its bucket.
 */
export function bucketByTime(
  samples: readonly Pt[],
  startAt: number,
  endAt: number,
  buckets: number
): Pt[] {
  if (buckets < 1 || endAt <= startAt) return [];
  const width = (endAt - startAt) / buckets;
  const sum = new Array<number>(buckets).fill(0);
  const atSum = new Array<number>(buckets).fill(0);
  const count = new Array<number>(buckets).fill(0);
  for (const s of samples) {
    if (s.at < startAt || s.at > endAt || !Number.isFinite(s.value)) continue;
    const i = Math.min(buckets - 1, Math.floor((s.at - startAt) / width));
    sum[i] += s.value;
    atSum[i] += s.at;
    count[i] += 1;
  }
  const out: Pt[] = [];
  for (let i = 0; i < buckets; i++) {
    if (count[i] > 0) out.push({ at: atSum[i] / count[i], value: sum[i] / count[i] });
  }
  return out;
}

/** Split a point list wherever consecutive points are further apart than maxGapMs. */
export function splitSegments(points: readonly Pt[], maxGapMs: number): Pt[][] {
  const segments: Pt[][] = [];
  let cur: Pt[] = [];
  for (const p of points) {
    if (cur.length > 0 && p.at - cur[cur.length - 1].at > maxGapMs) {
      segments.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length > 0) segments.push(cur);
  return segments;
}

/** Window → bucket → gap-split in one step. */
export function seriesSegments(
  samples: readonly Pt[],
  windowMs: number,
  endAt: number,
  maxPoints = 240,
  gapMs = 20_000
): Pt[][] {
  const startAt = endAt - windowMs;
  const bucketMs = windowMs / maxPoints;
  const pts = bucketByTime(samples, startAt, endAt, maxPoints);
  return splitSegments(pts, Math.max(gapMs, bucketMs * 2.5));
}

export interface MemSegment {
  key: "weights" | "gpu" | "kv" | "system" | "free";
  label: string;
  mb: number;
}

export interface MemBreakdownInput {
  totalMb: number;
  gpuUsedMb: number;
  cpuUsedMb: number;
  /** Sum of the engines' allocated KV-cache pools, in bytes (null/0 when unknown). */
  kvBytes?: number | null;
  /** True when an LLM engine is serving on this unit (names the GPU slice "Model weights"). */
  hasModel?: boolean;
}

/**
 * Split the unified pool into weights / KV cache / system / free. The KV pool is
 * carved out of the GPU-allocated memory (never more than it), so the segments
 * sum to the pool. Without a KV reading the GPU slice stays whole.
 */
export function memoryBreakdown(input: MemBreakdownInput): MemSegment[] {
  const total = Math.max(0, input.totalMb);
  const gpu = Math.max(0, input.gpuUsedMb);
  const sys = Math.max(0, input.cpuUsedMb);
  const kvMb = input.kvBytes && input.kvBytes > 0 ? input.kvBytes / 1024 ** 2 : 0;
  const kv = Math.min(gpu, kvMb);
  const rest = gpu - kv;
  const used = gpu + sys;
  const free = Math.max(0, total - used);
  const segs: MemSegment[] = [];
  if (rest > 0) segs.push({ key: kv > 0 || input.hasModel ? "weights" : "gpu", label: kv > 0 || input.hasModel ? "Model weights" : "GPU processes", mb: rest });
  if (kv > 0) segs.push({ key: "kv", label: "KV cache", mb: kv });
  if (sys > 0) segs.push({ key: "system", label: "System", mb: sys });
  segs.push({ key: "free", label: "Free", mb: free });
  return segs;
}

/** "1:23" style axis labels for a window: [start, mid, end]. */
export function windowAxisLabels(windowMs: number): [string, string, string] {
  const fmt = (ms: number) => {
    const min = Math.round(ms / 60_000);
    return min >= 60 && min % 60 === 0 ? `−${min / 60} h` : `−${min} min`;
  };
  return [fmt(windowMs), fmt(windowMs / 2), "now"];
}
