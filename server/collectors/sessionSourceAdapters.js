/**
 * Runtime collect/diagnose adapters for occupancy kinds.
 * Keep this out of sessionSourceRegistry so the registry stays metadata-only
 * and never imports OpenClaw/Hermes/OpenCode (ESM cycle).
 */
import { collectOpenClawSessions, diagnoseOpenClawSessions } from "./OpenClawSessions.js";
import { collectHermesSessions, diagnoseHermesSessions } from "./HermesSessions.js";
import { collectOpenCodeSessions, diagnoseOpenCodeSessions } from "./OpenCodeSessions.js";
import { collectOmpSessions, diagnoseOmpSessions } from "./OmpSessions.js";
import { sessionSourceIds } from "../sessionSourceRegistry.js";

const ADAPTERS = {
  openclaw: { collect: collectOpenClawSessions, diagnose: diagnoseOpenClawSessions },
  hermes: { collect: collectHermesSessions, diagnose: diagnoseHermesSessions },
  opencode: { collect: collectOpenCodeSessions, diagnose: diagnoseOpenCodeSessions },
  omp: { collect: collectOmpSessions, diagnose: diagnoseOmpSessions },
};

function byKind(field) {
  const out = {};
  for (const id of sessionSourceIds()) {
    const fn = ADAPTERS[id]?.[field];
    if (typeof fn === "function") out[id] = fn;
  }
  return out;
}

export function occupancyCollectors() {
  return byKind("collect");
}

export function occupancyDiagnosers() {
  return byKind("diagnose");
}
