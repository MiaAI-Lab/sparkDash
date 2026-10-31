import type { HistoryLlmPoint, HistoryPoint, LlmMetrics, SparkSnapshot } from "../../api/types";
import { resolveSparkRole } from "../../api/sparkRole";
import { formatMb } from "../../shared/formatBytes";
import { usableHead } from "../../shared/sparkHead";
import {
  computeVramBreakdown,
  gbNumber,
  legendItems,
  type HeadroomTone,
  type VramBreakdownContext,
  type VramSegmentKey,
} from "../../shared/vramBreakdown";
import { formatCtx } from "../OverviewPage/fleetStats";

/** How the unit grid uses the screen: `shrink` fits every card on one screen, `scroll` gives each a fixed shape and scrolls. */
export type KioskFit = "shrink" | "scroll";
export type KioskTheme = "white" | "light" | "dark" | "oled";

export interface KioskOptions {
  fit: KioskFit;
  /** Fixed column count; 0 picks one from the unit count and the screen's shape. */
  cols: number;
  /** Theme for this screen only (not saved), or null to keep the browser's. */
  theme: KioskTheme | null;
}

const THEMES: readonly KioskTheme[] = ["white", "light", "dark", "oled"];

/** Read `?fit=`, `?cols=` and `?theme=` from a URL query; anything unrecognised keeps the default. */
export function parseKioskOptions(search: string): KioskOptions {
  const q = new URLSearchParams(search);
  const fit = q.get("fit");
  const cols = Number(q.get("cols"));
  const theme = q.get("theme");
  return {
    fit: fit === "scroll" ? "scroll" : "shrink",
    cols: Number.isInteger(cols) && cols >= 1 && cols <= 8 ? cols : 0,
    theme: THEMES.includes(theme as KioskTheme) ? (theme as KioskTheme) : null,
  };
}

/** The shape a kiosk card is designed for (width : height); the column choice aims for cells near it. */
const CARD_ASPECT = 1.5;

/**
 * Columns for `count` cards on a `width` × `height` frame: the count whose cells hold the largest
 * card of `CARD_ASPECT` shape, with at least two rows (six units are 3 × 2, never one long row).
 */
export function kioskColumns(count: number, width: number, height: number): number {
  if (count <= 1 || width <= 0 || height <= 0) return 1;
  let best = 1;
  let bestSize = 0;
  for (let cols = 1; cols <= Math.ceil(count / 2); cols++) {
    const rows = Math.ceil(count / cols);
    const cellW = width / cols;
    const cellH = height / rows;
    // Height of the largest CARD_ASPECT card that fits the cell.
    const size = Math.min(cellH, cellW / CARD_ASPECT);
    if (size > bestSize + 1e-6) {
      best = cols;
      bestSize = size;
    }
  }
  return best;
}

/** An LLM endpoint whose rates this poll can be trusted (an unmeasured poll is not 0 tok/s). */
function measured(llm: LlmMetrics): boolean {
  return llm.available && llm.measurementValid !== false;
}

export interface KioskFleetStats {
  online: number;
  total: number;
  /** Hottest GPU across online units (°C), or null when none reports one. */
  gpuTempMaxC: number | null;
  /** Requests waiting across measured endpoints, or null when no engine reports a queue. */
  queued: number | null;
  running: number | null;
}

/** Header numbers the fleet KPIs do not already compute (pure). */
export function kioskFleetStats(sparks: readonly SparkSnapshot[]): KioskFleetStats {
  const s: KioskFleetStats = { online: 0, total: sparks.length, gpuTempMaxC: null, queued: null, running: null };
  for (const spark of sparks) {
    if (!spark.online) continue;
    s.online += 1;
    const gpu = spark.metrics?.gpu;
    if (gpu && gpu.metricAvailability?.temperature !== false && gpu.temperature > 0) {
      s.gpuTempMaxC = Math.max(s.gpuTempMaxC ?? -Infinity, gpu.temperature);
    }
    for (const llm of spark.metrics?.llm ?? []) {
      if (!measured(llm)) continue;
      if (llm.requestsWaiting != null) s.queued = (s.queued ?? 0) + llm.requestsWaiting;
      const running = llm.requestsRunning ?? llm.slotsActive;
      if (running != null) s.running = (s.running ?? 0) + running;
    }
  }
  return s;
}

export interface KioskCardMemory {
  /** "Unified memory" on a Spark or Mac, "VRAM" on a discrete card. */
  label: string;
  /** Headroom, as the Overview words it ("25.9 GB free"), or null when the total is unknown. */
  free: string | null;
  tone: HeadroomTone;
  /** Bar segments as a share of the total (0–100), in the Overview's order and colours. */
  segments: Array<{ key: VramSegmentKey; pct: number }>;
  /** Legend: what holds the memory, in GB ("Model 41.4", "System 54.3"). */
  legend: Array<{ key: VramSegmentKey; label: string; gb: string }>;
  /** System RAM on a host with a discrete card ("41.4 / 123.2 GB"); null otherwise. */
  ram: string | null;
}

export interface KioskCard {
  name: string;
  role: "head" | "worker" | "standalone";
  ip: string | null;
  online: boolean;
  offlineReason: string | null;
  memory: KioskCardMemory | null;
  gpuPct: number | null;
  gpuTempC: number | null;
  gpuW: number | null;
  cpuPct: number | null;
  cpuTempC: number | null;
  /** Free space on the root disk (MB), the disk the Overview card reports. */
  diskFreeMb: number | null;
  /** Live rates of the unit's first answering endpoint, as the Overview shows them; null without one. */
  rates: { decode: string; prefill: string; decodeLive: boolean } | null;
  /** For a worker: the head it serves (shown in its role badge), or null when none is set. */
  workerOf: { name: string } | null;
  /** Model row: the served model (a worker's head's), or the reason there is none. */
  model: { text: string; ctx: string | null; muted: boolean } | null;
}

export type KioskLabels = (key: string, values?: Record<string, unknown>) => string;

/** Pure-model callers do not mount i18n; preserve the historic English contract. */
const defaultKioskLabels: KioskLabels = (key, values) => {
  const copy: Record<string, string> = {
    "kiosk.unifiedMemory": "Unified memory", "kiosk.vram": "VRAM", "kiosk.inUse": "In use",
    "kiosk.headOffline": "Head offline", "kiosk.headApiNotReady": "Head API not ready", "kiosk.noHeadPort": "No LLM port watched on the head",
    "kiosk.unknown": "unknown", "kiosk.noLlmGpu": "No LLM answering · GPU in use", "kiosk.noLlm": "No LLM answering", "kiosk.prefilling": "prefilling",
  };
  if (key === "kiosk.free") return `${values?.value ?? ""} free`;
  return copy[key] ?? key;
};

function availabilityOk(flag: boolean | undefined): boolean {
  return flag !== false;
}

/**
 * Everything a kiosk card shows, derived with the Overview card's rules: the memory split comes from
 * the same breakdown, a worker shows its live head's model, an unmeasured rate is "—", and a unit
 * whose GPU is in use while no endpoint answers is not reported as having no model.
 */
export function kioskCard(
  spark: SparkSnapshot,
  headSpark: SparkSnapshot | null,
  vramContext: VramBreakdownContext | null,
  tr: KioskLabels = defaultKioskLabels
): KioskCard {
  const m = spark.metrics;
  const gpu = m?.gpu ?? null;
  const um = m?.unifiedMemory ?? null;
  const role = resolveSparkRole(spark);
  const llmList = Array.isArray(m?.llm) ? m.llm : [];
  const llm = llmList.find((l) => l.available) ?? null;
  const av = gpu?.metricAvailability;

  // Memory: the Overview's breakdown when it has one, otherwise its plain used/total bar.
  let memory: KioskCardMemory | null = null;
  const vramKnown = gpu != null && availabilityOk(av?.vramUsed) && availabilityOk(av?.vramTotal);
  const discrete = Boolean(gpu?.vram?.total && m?.ram?.total && Math.abs(gpu.vram.total - m.ram.total) > 0.02 * m.ram.total);
  const ram = discrete && m?.ram ? `${(m.ram.used / 1024).toFixed(1)} / ${(m.ram.total / 1024).toFixed(1)} GB` : null;
  // A GPU whose memory total is the system RAM total shares one pool with the CPU (a Spark, a Mac).
  // The breakdown's model comes from the unit kind, which calls every host discrete; a Mac host is
  // not, so its pool is measured as unified: headroom is what the system has available, not
  // total minus GPU use.
  const pooled = Boolean(gpu?.vram?.total) && !discrete;
  const context: VramBreakdownContext | null =
    vramContext && pooled && vramContext.model === "discrete" ? { ...vramContext, model: "unified", unified: null } : vramContext;
  const breakdown = gpu && vramKnown && context ? computeVramBreakdown(gpu.vram, gpu.processes, context) : null;
  if (breakdown && breakdown.totalMB > 0) {
    memory = {
      label: tr(breakdown.model === "unified" ? "kiosk.unifiedMemory" : "kiosk.vram"),
      free: tr("kiosk.free", { value: formatMb(breakdown.freeMB) }),
      tone: breakdown.tone,
      segments: breakdown.segments.map((x) => ({ key: x.key, pct: Math.min(100, (x.mb / breakdown.totalMB) * 100) })),
      legend: legendItems(breakdown).filter((x): x is { key: VramSegmentKey; label: string; gb: string } => x.key !== "free"),
      ram,
    };
    // On a Mac the collector reports the whole pool's use as GPU use (the same figure as RAM in use,
    // with no GPU share of its own), so neither "GPU" nor "Model" is true of it: say what it is.
    if (pooled && um && !um.gpuUsed && gpu && Math.abs(gpu.vram.used - um.used) < 1) {
      memory.segments = [{ key: "gpu", pct: Math.min(100, (um.used / breakdown.totalMB) * 100) }];
      memory.legend = [{ key: "gpu", label: tr("kiosk.inUse"), gb: gbNumber(um.used) }];
    }
  } else if (gpu || um) {
    const total = gpu?.vram?.total ?? um?.total ?? 0;
    const used = gpu?.vram?.used ?? um?.used ?? 0;
    const avail = gpu?.vram?.available ?? um?.available ?? 0;
    memory = {
      label: tr(discrete ? "kiosk.vram" : "kiosk.unifiedMemory"),
      free: vramKnown && total > 0 ? tr("kiosk.free", { value: formatMb(avail) }) : null,
      tone: "ok",
      segments: vramKnown && total > 0 ? [{ key: "gpu", pct: Math.min(100, (used / total) * 100) }] : [],
      legend: [],
      ram,
    };
  }

  const rootDisk = (m?.storage ?? []).find((d) => d.label === "/") ?? (m?.storage ?? []).find((d) => d.device === "nvme0n1p2");

  let rates: KioskCard["rates"] = null;
  if (role !== "worker" && llm) {
    const ok = llm.measurementValid !== false;
    rates = {
      decode: ok ? llm.generationTps.toFixed(1) : "—",
      prefill: !ok ? "—" : llm.prefillActive && llm.prefillTps <= 0 ? tr("kiosk.prefilling") : Math.round(llm.prefillTps).toLocaleString(),
      decodeLive: ok && llm.generationTps > 0,
    };
  }

  let workerOf: KioskCard["workerOf"] = null;
  let model: KioskCard["model"] = null;
  if (role === "worker") {
    // As on the Overview: the live head's model, else the configured label, else why there is none.
    const liveHead = usableHead(headSpark);
    const headLlmList = Array.isArray(liveHead?.metrics.llm) ? liveHead.metrics.llm : [];
    const headLlm = headLlmList.find((l) => l.available) ?? null;
    const headState = !headSpark
      ? null
      : !headSpark.online
        ? tr("kiosk.headOffline")
        : headLlmList.length
          ? tr("kiosk.headApiNotReady")
          : tr("kiosk.noHeadPort");
    const label = headLlm?.modelId || spark.workerLabel?.trim() || spark.workerDerivedLabel?.trim() || null;
    workerOf = headSpark ? { name: headSpark.name } : null;
    const ctx = headLlm ? formatCtx(headLlm.contextLength) : null;
    // With no head and no label there is nothing to name; the role badge already says "worker".
    model = label ? { text: label, ctx, muted: false } : headState ? { text: headState, ctx: null, muted: true } : null;
  } else if (llm) {
    model = { text: llm.modelId ?? tr("kiosk.unknown"), ctx: formatCtx(llm.contextLength), muted: false };
  } else {
    // No endpoint answers. Memory or compute in use most likely means a model is still loading,
    // or a server sparkDash does not watch: say what is seen, not that nothing is loaded (the card
    // shows how much memory and GPU).
    const memUsed = gpu?.vram?.used ?? um?.used ?? 0;
    const busy = memUsed >= 2048 || (gpu?.usage ?? 0) >= 10;
    model = busy
      ? { text: tr("kiosk.noLlmGpu"), ctx: null, muted: true }
      : spark.llmMonitoring === false
        ? null
        : { text: tr("kiosk.noLlm"), ctx: null, muted: true };
  }

  return {
    name: spark.name,
    role,
    ip: spark.lanIp ?? null,
    online: spark.online,
    offlineReason: spark.offlineReason ?? null,
    memory,
    gpuPct: gpu && availabilityOk(av?.usage) ? gpu.usage : null,
    gpuTempC: gpu && availabilityOk(av?.temperature) && gpu.temperature > 0 ? gpu.temperature : null,
    gpuW: gpu && availabilityOk(av?.powerDraw) ? gpu.power.draw : null,
    cpuPct: m?.cpu ? m.cpu.usage : null,
    cpuTempC: m?.cpu && Number.isFinite(m.cpu.temperature) && m.cpu.temperature > 0 ? m.cpu.temperature : null,
    diskFreeMb: rootDisk ? rootDisk.available : null,
    rates,
    workerOf,
    model,
  };
}

/** A unit's 30-minute traces, one value per minute; null where the unit reported nothing (a gap). */
export interface KioskTraces {
  gpu: Array<number | null>;
  cpu: Array<number | null>;
  gen: Array<number | null>;
  prefill: Array<number | null>;
}

const TRACE_MINUTES = 30;

/**
 * The last `minutes` one-minute buckets of a unit's server history, aligned to the minute
 * that holds `now` so every unit's traces end at the same instant. LLM rates are summed over
 * the unit's endpoints; a minute none of them reported stays a gap.
 */
export function tracesFromHistory(
  points: readonly HistoryPoint[],
  llm: ReadonlyArray<{ points: readonly HistoryLlmPoint[] }>,
  stepMs: number,
  now: number,
  minutes = TRACE_MINUTES
): KioskTraces {
  const step = stepMs > 0 ? stepMs : 60_000;
  const end = Math.floor(now / step) * step;
  const start = end - (minutes - 1) * step;
  const slot = (t: number) => Math.round((t - start) / step);
  const blank = () => Array.from({ length: minutes }, () => null as number | null);
  const out: KioskTraces = { gpu: blank(), cpu: blank(), gen: blank(), prefill: blank() };
  for (const p of points) {
    const i = slot(p.t);
    if (i < 0 || i >= minutes) continue;
    if (p.gpuUtil) out.gpu[i] = p.gpuUtil.avg;
    if (p.cpuUtil) out.cpu[i] = p.cpuUtil.avg;
  }
  for (const endpoint of llm) {
    for (const p of endpoint.points) {
      const i = slot(p.t);
      if (i < 0 || i >= minutes) continue;
      if (p.genTps) out.gen[i] = (out.gen[i] ?? 0) + p.genTps.avg;
      if (p.prefillTps) out.prefill[i] = (out.prefill[i] ?? 0) + p.prefillTps.avg;
    }
  }
  return out;
}

/**
 * An SVG path through `points` as a monotone cubic curve (Fritsch–Carlson): smooth, but it never
 * overshoots between two samples, so a trace cannot dip below 0 or show a peak that was not
 * measured. `null` is a gap: the line stops there and starts again after it.
 */
export function smoothPath(points: ReadonlyArray<readonly [number, number] | null>): string {
  const runs: Array<Array<readonly [number, number]>> = [];
  let run: Array<readonly [number, number]> = [];
  for (const p of points) {
    if (p) run.push(p);
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  const f = (n: number) => n.toFixed(1);
  let d = "";
  for (const r of runs) {
    d += `M${f(r[0][0])} ${f(r[0][1])}`;
    if (r.length === 1) continue;
    const n = r.length;
    const dx = r.slice(1).map((p, i) => p[0] - r[i][0]);
    const slope = r.slice(1).map((p, i) => (p[1] - r[i][1]) / dx[i]);
    // Tangents: the secant at the ends, the mean of neighbouring secants inside, flattened at a
    // turning point and limited so the curve stays monotone between samples.
    const t = r.map((_, i) => (i === 0 ? slope[0] : i === n - 1 ? slope[n - 2] : slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2));
    for (let i = 0; i < n - 1; i++) {
      if (slope[i] === 0) {
        t[i] = 0;
        t[i + 1] = 0;
        continue;
      }
      const a = t[i] / slope[i];
      const b = t[i + 1] / slope[i];
      const h = a * a + b * b;
      if (h > 9) {
        const k = 3 / Math.sqrt(h);
        t[i] = k * a * slope[i];
        t[i + 1] = k * b * slope[i];
      }
    }
    for (let i = 0; i < n - 1; i++) {
      const [x0, y0] = r[i];
      const [x1, y1] = r[i + 1];
      const h = dx[i] / 3;
      d += `C${f(x0 + h)} ${f(y0 + t[i] * h)} ${f(x1 - h)} ${f(y1 - t[i + 1] * h)} ${f(x1)} ${f(y1)}`;
    }
  }
  return d;
}
