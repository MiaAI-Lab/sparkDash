// Copyright 2026 Maxrio9. SPDX-License-Identifier: Apache-2.0
export const FRESH_MS = 30_000;
export const RETENTION_MS = 60 * 60_000;
export const FUTURE_TOLERANCE_MS = 5_000;
export const MAX_REPORTS = 64;
export const MAX_SOURCES = 32;
export const MAX_BYTES = 1024 * 1024;
export const GROUPS = ["data", "training", "evaluation"];
const STATES = new Set(["running", "waiting", "complete", "stopped", "failed", "unknown"]);
const controls = /[\u0000-\u001f\u007f-\u009f]/;

export function validId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(value);
}

function text(value, max) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !controls.test(value);
}

function count(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function stages(value = []) {
  if (!Array.isArray(value) || value.length > 16) throw new Error("Invalid stages");
  const ids = new Set();
  return value.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row) || !validId(row.id) || ids.has(row.id) ||
        !text(row.label, 120) || !STATES.has(row.state)) throw new Error("Invalid stage");
    ids.add(row.id);
    for (const field of ["completed", "total"]) {
      if (row[field] != null && !count(row[field])) throw new Error("Invalid progress");
    }
    if (row.unit != null && !text(row.unit, 32)) throw new Error("Invalid progress unit");
    if (row.etaSeconds !== undefined && (!count(row.etaSeconds) || row.etaSeconds > 31_536_000)) throw new Error("Invalid reported ETA");
    const result = { id: row.id, label: row.label, state: row.state,
      completed: row.completed ?? null, total: row.total ?? null, unit: row.unit ?? null };
    if (row.etaSeconds !== undefined) result.etaSeconds = row.etaSeconds;
    if (row.metrics !== undefined) {
      if (!Array.isArray(row.metrics) || row.metrics.length > 8) throw new Error("Invalid metrics");
      result.metrics = row.metrics.map((metric) => {
        if (!metric || !text(metric.label, 80) ||
            !(metric.value == null || Number.isFinite(metric.value) || text(metric.value, 120)) ||
            (metric.unit !== undefined && !text(metric.unit, 32))) throw new Error("Invalid metric");
        return { label: metric.label, value: metric.value ?? null,
          ...(metric.unit === undefined ? {} : { unit: metric.unit }) };
      });
    }
    return result;
  });
}

/** Allowlisted worker fields only. Successful reads never substitute for a worker timestamp. */
export function normalizeProgressDocument(value, now) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema_version !== 1 ||
      !validId(value.id) || !text(value.campaign, 160) ||
      (value.source_id !== undefined && !validId(value.source_id)) ||
      (value.label !== undefined && !text(value.label, 160)) ||
      (value.model != null && !text(value.model, 160)) ||
      !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0 || value.updatedAt > now + FUTURE_TOLERANCE_MS ||
      !value.stages || typeof value.stages !== "object" || Array.isArray(value.stages)) throw new Error("Invalid progress document");
  if (now - value.updatedAt > RETENTION_MS) return null;
  const result = { id: value.id, campaign: value.campaign, model: value.model ?? null,
    sourceId: value.source_id ?? null, sourceLabel: value.label ?? null,
    reportedAt: value.updatedAt,
    stages: Object.fromEntries(GROUPS.map((group) => [group, stages(value.stages[group])])) };
  if (Buffer.byteLength(JSON.stringify(result)) > 32 * 1024) throw new Error("Progress document is too large");
  return result;
}

export function progressConfig(env) {
  const roots = (value) => {
    if (!Array.isArray(value) || value.length > 16 || value.some((root) => !text(root, 1024) ||
        !(root.startsWith("/") || root.startsWith("~/")))) throw new Error("Invalid training progress configuration");
    return [...new Set(value)];
  };
  const common = roots(JSON.parse(env.TRAINING_PROGRESS_ROOTS || "[]"));
  const overrides = JSON.parse(env.TRAINING_PROGRESS_ROOTS_BY_UNIT || "{}");
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides) || Object.keys(overrides).length > 32) {
    throw new Error("Invalid training progress configuration");
  }
  const byUnit = new Map(Object.entries(overrides).map(([id, paths]) => {
    if (!validId(id)) throw new Error("Invalid training progress configuration");
    return [id, roots(paths)];
  }));
  return { rootsFor: (unit) => byUnit.has(unit.id) ? byUnit.get(unit.id) : common };
}
