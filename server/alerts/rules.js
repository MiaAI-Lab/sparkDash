/**
 * Built-in alert rules.
 *
 * Each rule looks at one unit's snapshot and says what is wrong with it right
 * now. Timing (`for`, hysteresis, firing/resolved) is the engine's job — a rule
 * is a pure function of the snapshot, the rule's settings and a little context.
 *
 * `evaluate()` returns either:
 *   - `null` — the rule cannot judge this unit right now (offline, collector not
 *     answered yet, feature off). The engine then leaves any existing alert for
 *     this rule + unit exactly as it is: a unit going offline must not "resolve"
 *     its temperature alert and page everyone that things are fine.
 *   - an array of conditions that are currently true, each
 *     `{ sub, severity, value, summary }`. `sub` tells instances on one unit
 *     apart (a disk, an LLM port, a GPU card); "" for unit-level rules. A rule
 *     that can judge and finds nothing returns [].
 */
import { DGX_SPARK } from "../config.js";
import {
  HEADROOM_THRESHOLDS_MB,
  headroomFreeMB,
  headroomTone,
  memoryModelFor,
} from "../../src/shared/memoryHeadroom.js";

export const SEVERITIES = Object.freeze(["warning", "critical"]);

/** warning < critical. Unknown values rank as warning. */
export function severityRank(severity) {
  return severity === "critical" ? 2 : 1;
}

const finite = (n) => (typeof n === "number" && Number.isFinite(n) ? n : null);

function role(unit) {
  return unit?.role || (unit?.workerNode ? "worker" : "standalone");
}

function gb(mb) {
  return (mb / 1024).toFixed(1);
}

/** The GPU block is a collector default (all zeros) — the read failed, not a cold idle GPU. */
function gpuLooksEmpty(gpu) {
  return !gpu || (gpu.temperature === 0 && gpu.usage === 0 && (gpu.vram?.total ?? 0) === 0);
}

const J = DGX_SPARK.THERMAL_THRESHOLDS.junction;

/**
 * Rule catalogue. `defaults` is what a fresh install runs with; `fields`
 * describes the tunable thresholds (min/max for validation, unit for the UI).
 */
export const RULES = Object.freeze([
  {
    id: "unit_offline",
    name: "Unit offline",
    description: "The unit stopped answering liveness checks (SSH or local).",
    defaults: { enabled: true, forSec: 60 },
    fields: [],
    evaluate(unit) {
      if (unit.online) return [];
      return [
        {
          sub: "",
          severity: "critical",
          value: null,
          summary: unit.offlineReason ? `Unreachable: ${unit.offlineReason}` : "Unreachable",
        },
      ];
    },
  },
  {
    id: "gpu_temperature",
    name: "GPU temperature",
    description: "Hottest GPU at or above the warning / critical temperature.",
    defaults: { enabled: true, forSec: 120, warningC: J.warning, criticalC: J.critical },
    fields: [
      { key: "warningC", label: "Warning", unit: "°C", min: 30, max: 120 },
      { key: "criticalC", label: "Critical", unit: "°C", min: 30, max: 120 },
    ],
    evaluate(unit, cfg) {
      const gpu = unit.metrics?.gpu;
      if (!unit.online || gpuLooksEmpty(gpu)) return null;
      const t = finite(gpu.temperature);
      if (t == null || t <= 0) return null;
      if (t >= cfg.criticalC)
        return [{ sub: "", severity: "critical", value: t, summary: `GPU at ${t} °C (critical ≥ ${cfg.criticalC} °C)` }];
      if (t >= cfg.warningC)
        return [{ sub: "", severity: "warning", value: t, summary: `GPU at ${t} °C (warning ≥ ${cfg.warningC} °C)` }];
      return [];
    },
  },
  {
    id: "gpu_throttle",
    name: "GPU throttling",
    description: "Clocks held down by a thermal, hardware or power-cap slowdown.",
    defaults: { enabled: true, forSec: 60 },
    fields: [],
    evaluate(unit) {
      const gpu = unit.metrics?.gpu;
      if (!unit.online || gpuLooksEmpty(gpu)) return null;
      const th = gpu.throttle;
      if (!th) return null;
      if (!th.active) return [];
      // A power cap holding clocks under sustained load is the GPU doing its
      // job; thermal / hardware slowdown is the box telling you it is in trouble.
      const severity = th.reason === "power" ? "warning" : "critical";
      const pct = finite(th.smClockPct);
      return [
        {
          sub: "",
          severity,
          value: pct,
          summary: `GPU throttled: ${th.detail || th.reason}${pct != null ? ` (SM clock ${pct}%)` : ""}`,
        },
      ];
    },
  },
  {
    id: "memory_headroom",
    name: "Memory headroom",
    description:
      "Free memory the next allocation can use — GB10 unified pool (MemAvailable) or discrete VRAM (total − used). Same thresholds as the VRAM bar.",
    defaults: {
      enabled: true,
      forSec: 120,
      unifiedLowGb: HEADROOM_THRESHOLDS_MB.unified.low / 1024,
      unifiedCriticalGb: HEADROOM_THRESHOLDS_MB.unified.critical / 1024,
      discreteLowGb: HEADROOM_THRESHOLDS_MB.discrete.low / 1024,
      discreteCriticalGb: HEADROOM_THRESHOLDS_MB.discrete.critical / 1024,
    },
    fields: [
      { key: "unifiedLowGb", label: "GB10 low", unit: "GB", min: 0, max: 1024 },
      { key: "unifiedCriticalGb", label: "GB10 critical", unit: "GB", min: 0, max: 1024 },
      { key: "discreteLowGb", label: "Discrete low", unit: "GB", min: 0, max: 1024 },
      { key: "discreteCriticalGb", label: "Discrete critical", unit: "GB", min: 0, max: 1024 },
    ],
    evaluate(unit, cfg) {
      const gpu = unit.metrics?.gpu;
      if (!unit.online || gpuLooksEmpty(gpu)) return null;
      const model = memoryModelFor(unit.kind);
      const thresholds =
        model === "unified"
          ? { low: cfg.unifiedLowGb * 1024, critical: cfg.unifiedCriticalGb * 1024 }
          : { low: cfg.discreteLowGb * 1024, critical: cfg.discreteCriticalGb * 1024 };
      // A multi-card host is judged per card, like its VRAM bars: one full
      // card is a failed allocation even when the sum looks roomy.
      const cards =
        model === "discrete" && Array.isArray(gpu.gpus) && gpu.gpus.length > 1
          ? gpu.gpus.map((card, i) => ({ sub: `gpu${card?.index ?? i}`, vram: card?.vram, label: `GPU ${card?.index ?? i}` }))
          : [{ sub: "", vram: gpu.vram, label: null }];
      const unified = model === "unified" ? unit.metrics?.unifiedMemory : null;
      const out = [];
      let judged = false;
      for (const card of cards) {
        const freeMB = headroomFreeMB(model, unified, card.vram);
        if (freeMB == null) continue;
        judged = true;
        const tone = headroomTone(freeMB, model, thresholds);
        if (tone === "ok") continue;
        const where = card.label ? `${card.label}: ` : "";
        const pool = model === "unified" ? "unified memory" : "VRAM";
        out.push({
          sub: card.sub,
          severity: tone === "critical" ? "critical" : "warning",
          value: Math.round(freeMB),
          summary: `${where}${gb(freeMB)} GB ${pool} free (${tone === "critical" ? "critical" : "low"} < ${gb(tone === "critical" ? thresholds.critical : thresholds.low)} GB)`,
        });
      }
      return judged ? out : null;
    },
  },
  {
    id: "disk_usage",
    name: "Disk usage",
    description: "A monitored filesystem at or above the warning / critical fill.",
    defaults: { enabled: true, forSec: 300, warningPct: 90, criticalPct: 95 },
    fields: [
      { key: "warningPct", label: "Warning", unit: "%", min: 1, max: 100 },
      { key: "criticalPct", label: "Critical", unit: "%", min: 1, max: 100 },
    ],
    evaluate(unit, cfg) {
      const disks = unit.metrics?.storage;
      if (!unit.online || !Array.isArray(disks) || disks.length === 0) return null;
      const out = [];
      for (const disk of disks) {
        if (!disk || disk.disabled) continue;
        const pct = finite(disk.percentage);
        if (pct == null || !(finite(disk.total) > 0)) continue;
        const severity = pct >= cfg.criticalPct ? "critical" : pct >= cfg.warningPct ? "warning" : null;
        if (!severity) continue;
        const name = disk.label || disk.device || "disk";
        out.push({
          sub: String(disk.device || disk.label || ""),
          severity,
          value: pct,
          summary: `${name} ${Math.round(pct)}% full (${severity} ≥ ${severity === "critical" ? cfg.criticalPct : cfg.warningPct}%)`,
        });
      }
      return out;
    },
  },
  {
    id: "llm_unavailable",
    name: "LLM endpoint unavailable",
    description:
      "An LLM endpoint on a head or standalone unit that sparkDash has seen serving stopped answering.",
    defaults: { enabled: true, forSec: 120 },
    fields: [],
    evaluate(unit, _cfg, ctx) {
      if (!unit.online || role(unit) === "worker" || unit.llmMonitoring === false) return null;
      const llm = unit.metrics?.llm;
      if (!Array.isArray(llm) || llm.length === 0) return null;
      const ports = Array.isArray(unit.llmPorts) ? unit.llmPorts : [];
      const out = [];
      llm.forEach((ep, i) => {
        const port = ports[i] ?? unit.llmPort ?? null;
        const sub = port != null ? String(port) : String(i);
        if (ep?.available) {
          ctx.markSeen(unit.id, sub);
          return;
        }
        // Never seen up since sparkDash started: a port configured for an
        // engine that is not running yet is not an outage.
        if (!ctx.wasSeen(unit.id, sub)) return;
        out.push({
          sub,
          severity: "warning",
          value: null,
          summary: `LLM on port ${sub} not answering${ep?.error ? `: ${ep.error}` : ""}`,
        });
      });
      return out;
    },
  },
  {
    id: "kv_cache",
    name: "KV cache nearly full",
    description:
      "The engine's KV cache pool at or above the threshold — new requests queue or get preempted. Only where the backend reports it.",
    defaults: { enabled: true, forSec: 120, warningPct: 90 },
    fields: [{ key: "warningPct", label: "Warning", unit: "%", min: 1, max: 100 }],
    evaluate(unit, cfg) {
      if (!unit.online || role(unit) === "worker" || unit.llmMonitoring === false) return null;
      const llm = unit.metrics?.llm;
      if (!Array.isArray(llm)) return null;
      const ports = Array.isArray(unit.llmPorts) ? unit.llmPorts : [];
      const out = [];
      llm.forEach((ep, i) => {
        const usage = finite(ep?.kvCacheUsage);
        if (!ep?.available || usage == null) return;
        const pct = Math.round(usage * 1000) / 10;
        if (pct < cfg.warningPct) return;
        const sub = String(ports[i] ?? i);
        out.push({
          sub,
          severity: "warning",
          value: pct,
          summary: `KV cache ${pct}% full on port ${sub}${ep.modelId ? ` (${ep.modelId})` : ""}`,
        });
      });
      return out;
    },
  },
]);

export const RULE_IDS = Object.freeze(RULES.map((r) => r.id));

export function ruleById(id) {
  return RULES.find((r) => r.id === id) || null;
}

/** Defaults merged with a user's overrides (unknown keys dropped). */
export function effectiveRuleConfig(rule, overrides) {
  const out = { ...rule.defaults };
  if (overrides && typeof overrides === "object") {
    for (const key of Object.keys(rule.defaults)) {
      if (overrides[key] !== undefined) out[key] = overrides[key];
    }
  }
  return out;
}
