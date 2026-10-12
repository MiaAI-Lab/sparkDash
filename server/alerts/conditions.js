/**
 * What the alert notifications watch. There is no second rule set here: every
 * condition is either
 *
 *   - a Health finding, exactly as `server/health/HealthEvaluator.js` raised it
 *     (same ids, severities and thresholds; SparkMonitor already holds a finding
 *     for HEALTH_CLEAR_HOLD_MS after it clears and puts the list on
 *     `snapshot.health`), or
 *   - an Overview strip exception from `src/shared/fleetExceptions.js` — the
 *     very function FleetAlertStrip uses: unit offline, thermal / hardware
 *     throttle (never the software power cap), storage ≥ 90 %, LLM unavailable,
 *     tailnet unavailable.
 *
 * A change to either source changes what notifies, with nothing to keep in step.
 * The per-rule settings below are only on/off and the `for` duration; thresholds
 * belong to the sources.
 */
import { fleetExceptions } from "../../src/shared/fleetExceptions.js";
import { MAX_NAME_CHARS, capText } from "./text.js";

export const SEVERITIES = Object.freeze(["warning", "critical"]);

/** warning < critical. Unknown values rank as warning. */
export function severityRank(severity) {
  return severity === "critical" ? 2 : 1;
}

/** Longest `for` a rule may wait (one day). */
export const MAX_FOR_SEC = 24 * 60 * 60;

/**
 * The catalogue the Alerts dialog shows. `source` says where the condition
 * comes from; `defaults` is what a fresh install runs with.
 */
export const RULES = Object.freeze([
  { id: "offline", source: "strip", name: "Unit offline", description: "The unit stopped answering liveness checks (Overview strip: Host unreachable).", defaults: { enabled: true, forSec: 60 } },
  { id: "throttle", source: "strip", name: "GPU throttling", description: "Thermal or hardware slowdown, as on the Overview strip. A software power cap is never an alert.", defaults: { enabled: true, forSec: 60 } },
  { id: "disk", source: "strip", name: "Storage", description: "A monitored filesystem at or above 90 % (Overview strip).", defaults: { enabled: true, forSec: 300 } },
  { id: "llm", source: "strip", name: "LLM unavailable", description: "Every monitored LLM port on the unit stopped answering (Overview strip).", defaults: { enabled: true, forSec: 120 } },
  { id: "tailnet", source: "strip", name: "Tailnet unavailable", description: "Tailnet monitoring is on and the node is not connected (Overview strip).", defaults: { enabled: true, forSec: 120 } },
  { id: "thermal", source: "health", name: "GPU temperature", description: "Health finding: the GPU is running hot, or close to its shutdown temperature.", defaults: { enabled: true, forSec: 60 } },
  { id: "memory", source: "health", name: "Unified memory low", description: "Health finding: little unified memory left before the kernel starts killing processes.", defaults: { enabled: true, forSec: 60 } },
  { id: "low-power", source: "health", name: "GPU stuck in low power", description: "Health finding: high utilisation at a few watts for several samples in a row.", defaults: { enabled: true, forSec: 0 } },
  { id: "xid", source: "health", name: "NVIDIA Xid error", description: "Health finding: the kernel logged a GPU or driver error within the last hour.", defaults: { enabled: true, forSec: 0 } },
  { id: "oom", source: "health", name: "Out-of-memory kill", description: "Health finding: the kernel's OOM killer ended a process within the last hour.", defaults: { enabled: true, forSec: 0 } },
  { id: "roce-link", source: "health", name: "RoCE link down", description: "Health finding: a RoCE port that was up went down.", defaults: { enabled: true, forSec: 60 } },
  { id: "roce-loss", source: "health", name: "RoCE packet loss", description: "Health finding: RoCE loss counters keep rising.", defaults: { enabled: true, forSec: 120 } },
  { id: "link-speed", source: "health", name: "Slow network link", description: "Health finding: the primary interface negotiated less than 1 Gb/s.", defaults: { enabled: true, forSec: 300 } },
  // Advice rather than a fault, so it does not notify unless asked to.
  { id: "concurrency", source: "health", name: "Several models loaded", description: "Health finding: more than one model serving while memory is above 70 %.", defaults: { enabled: false, forSec: 300 } },
]);

const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));

/** A Health finding the catalogue does not know yet still notifies, with these settings. */
const UNKNOWN_HEALTH_DEFAULTS = Object.freeze({ enabled: true, forSec: 60 });

export function ruleById(id) {
  return RULE_BY_ID.get(id) || null;
}

/** Defaults merged with a user's overrides (unknown keys dropped). */
export function effectiveRuleConfig(ruleId, overrides) {
  const out = { ...(ruleById(ruleId)?.defaults ?? UNKNOWN_HEALTH_DEFAULTS) };
  if (overrides && typeof overrides === "object") {
    if (typeof overrides.enabled === "boolean") out.enabled = overrides.enabled;
    if (Number.isFinite(overrides.forSec)) out.forSec = overrides.forSec;
  }
  return out;
}

/** Display name for a rule id, including Health findings the catalogue does not list. */
export function ruleName(ruleId, fallbackTitle) {
  return ruleById(ruleId)?.name ?? capText(fallbackTitle || ruleId, MAX_NAME_CHARS);
}

/**
 * The conditions true on one unit right now.
 *
 * `judged(ruleId)` says whether a rule could be evaluated at all. An offline
 * unit's metrics and findings are stale, so only `offline` is judged then; and
 * before the first liveness check (offline with no reason yet) nothing is. The
 * engine leaves the alerts of a rule it cannot judge exactly as they are — a
 * unit dropping off the network must not "resolve" its temperature alert.
 *
 * @param {any} unit SparkMonitor snapshot
 * @returns {{ judged: (ruleId: string) => boolean, conditions: Array<{ ruleId: string, ruleName: string, severity: "warning"|"critical", label: string, summary: string }> }}
 */
export function collectConditions(unit) {
  const conditions = [];
  if (!unit || typeof unit !== "object") return { judged: () => false, conditions };
  const checked = unit.online || unit.offlineReason != null;
  if (!checked) return { judged: () => false, conditions };

  for (const ex of fleetExceptions(unit)) {
    if (!unit.online && ex.id !== "offline") continue;
    const reason = ex.id === "offline" && unit.offlineReason ? `Unreachable: ${unit.offlineReason}` : null;
    conditions.push({
      ruleId: ex.id,
      ruleName: ruleName(ex.id),
      severity: ex.severity === "critical" ? "critical" : "warning",
      label: capText(ex.label),
      summary: capText(reason || ex.detail || ex.label),
    });
  }
  if (unit.online) {
    const findings = Array.isArray(unit.health) ? unit.health : [];
    const seen = new Set();
    for (const f of findings) {
      const id = typeof f?.id === "string" && /^[a-z0-9-]{1,40}$/.test(f.id) ? f.id : null;
      if (!id || seen.has(id) || ruleById(id)?.source === "strip") continue;
      seen.add(id);
      conditions.push({
        ruleId: id,
        ruleName: ruleName(id, f.title),
        severity: f.severity === "critical" ? "critical" : "warning",
        label: capText(f.title || id),
        summary: capText(f.detail || f.title || id),
      });
    }
  }
  return { judged: (ruleId) => unit.online || ruleId === "offline", conditions };
}
