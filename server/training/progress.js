// Copyright 2026 Maxrio9. SPDX-License-Identifier: Apache-2.0
import { TrainingProgressCollector, progressLocationKey } from "../collectors/TrainingProgressCollector.js";
import { FRESH_MS, RETENTION_MS, FUTURE_TOLERANCE_MS, MAX_REPORTS, MAX_SOURCES, MAX_BYTES, GROUPS, progressConfig } from "./schema.js";

export function trainingProgressEnabled(env = process.env) {
  return env.TRAINING_PROGRESS_ENABLED === "1";
}

/** The initial provider supports only worker-written JSON; no provider registry or job controls. */
export function registerTrainingProgressRoutes(app, {
  env = process.env, enabled = trainingProgressEnabled(env), getSparks = () => [],
  createCollector = (unit) => new TrainingProgressCollector(unit), now = Date.now, start = true,
} = {}) {
  const cache = new Map();
  const units = new Map();
  let config;
  let error = null;
  let truncated = false;
  let polling = false;
  if (enabled) {
    try { config = progressConfig(env); }
    catch { error = "Training progress configuration is invalid"; }
  }

  const selectedUnits = () => getSparks().filter((unit) => config.rootsFor(unit).length > 0);
  const labelOf = (unit) => String(unit.name || unit.id).replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 160);
  const fresh = (entry) => entry.status === "live" && now() - entry.document.reportedAt <= FRESH_MS && now() - entry.observedAt <= FRESH_MS;
  const pending = (entry) => GROUPS.some((group) => entry.document.stages[group].some((stage) => stage.state === "running" || stage.state === "waiting"));
  const ordered = () => [...cache.entries()].sort((a, b) =>
    Number(fresh(b[1]) && pending(b[1])) - Number(fresh(a[1]) && pending(a[1])) ||
    b[1].document.reportedAt - a[1].document.reportedAt || a[0].localeCompare(b[0]));

  function prune() {
    const time = now();
    const current = new Set(selectedUnits().slice(0, 32).map((unit) => unit.id));
    for (const [key, entry] of cache) {
      if (!current.has(entry.sparkId) || time - entry.document.reportedAt > RETENTION_MS ||
          entry.document.reportedAt > time + FUTURE_TOLERANCE_MS) cache.delete(key);
    }
    for (const key of units.keys()) if (!current.has(key)) units.delete(key);
    // Copies of the same declared reporter are one logical source. Pick its
    // newest worker timestamp before prioritizing pending work at the bounds.
    const reporters = new Map();
    for (const [key, entry] of cache) {
      const logical = JSON.stringify([entry.sparkId, entry.document.id, entry.document.sourceId ?? key]);
      const previous = reporters.get(logical);
      if (previous && previous.entry.document.reportedAt >= entry.document.reportedAt) cache.delete(key);
      else {
        if (previous) cache.delete(previous.key);
        reporters.set(logical, { key, entry });
      }
    }
    let count = 0;
    let bytes = 0;
    for (const [key, entry] of ordered()) {
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (++count > MAX_REPORTS || bytes + size > MAX_BYTES - 64 * 1024) {
        cache.delete(key);
        truncated = true;
      } else bytes += size;
    }
  }

  async function pollUnit(unit) {
    const sparkId = unit.id;
    const label = labelOf(unit);
    if (unit.platform === "windows" || (unit.kind === "mac" && unit.agent)) {
      units.set(sparkId, { sparkId, label, status: "unsupported", detail: "JSON progress collection requires a local or SSH Unix host" });
      for (const entry of cache.values()) if (entry.sparkId === sparkId) entry.status = "unavailable";
      return;
    }
    try {
      const result = await createCollector(unit).collect(config.rootsFor(unit), now);
      const seen = new Set();
      for (const record of result.records) {
        const previous = cache.get(record.key);
        if (!record.document || (previous && previous.document.reportedAt > record.document.reportedAt)) continue;
        cache.set(record.key, { sparkId, unitLabel: label, document: record.document, observedAt: now(), status: "live" });
        seen.add(record.key);
        prune();
      }
      for (const [key, entry] of cache) if (entry.sparkId === sparkId && !seen.has(key)) entry.status = "stale";
      units.set(sparkId, { sparkId, label, status: "live",
        ...(result.partial ? { detail: "Some progress documents could not be read" } : {}) });
      truncated ||= result.truncated;
    } catch {
      units.set(sparkId, { sparkId, label, status: "unavailable", detail: "Progress collection is unavailable" });
      for (const entry of cache.values()) if (entry.sparkId === sparkId) entry.status = "unavailable";
    } finally { prune(); }
  }

  async function poll() {
    if (!enabled || !config || polling) return;
    polling = true;
    try {
      const selected = selectedUnits();
      truncated = selected.length > 32;
      prune();
      await Promise.all(selected.slice(0, 32).map(pollUnit));
      prune();
    } finally { polling = false; }
  }

  function snapshot() {
    if (!enabled || !config) return { enabled, runs: [], units: [], truncated: false, error };
    prune();
    const runs = new Map();
    const time = now();
    const response = { enabled, runs: [], units: [...units.values()], truncated, error };
    for (const [key, entry] of ordered()) {
      const doc = entry.document;
      const id = `json:${doc.id}`;
      let run = runs.get(id);
      if (!run) {
        run = { id, campaign: doc.campaign, model: doc.model, sources: [] };
        runs.set(id, run);
      }
      const sourceId = progressLocationKey(`${entry.sparkId}\0${doc.sourceId ?? key}`);
      if (run.sources.some((source) => source.id === sourceId)) continue;
      if (run.sources.length >= MAX_SOURCES) { response.truncated = true; continue; }
      const isFresh = time - doc.reportedAt <= FRESH_MS && time - entry.observedAt <= FRESH_MS;
      const source = { id: sourceId, sparkId: entry.sparkId, label: doc.sourceLabel ?? entry.unitLabel,
        status: entry.status === "live" && !isFresh ? "stale" : entry.status,
        reportedAt: doc.reportedAt, stages: doc.stages };
      run.sources.push(source);
      response.runs = [...runs.values()];
      if (Buffer.byteLength(JSON.stringify(response)) > MAX_BYTES) {
        run.sources.pop();
        if (!run.sources.length) runs.delete(id);
        response.truncated = true;
      }
    }
    response.runs = [...runs.values()];
    return response;
  }

  app.get("/api/training-progress", (_req, res) => {
    res.set("Cache-Control", "no-store");
    if (!enabled) return res.status(404).json({ error: "Not found" });
    return res.json(snapshot());
  });
  let timer;
  if (enabled && config && start) {
    void poll().catch(() => {});
    timer = setInterval(() => { void poll().catch(() => {}); }, 10_000);
    timer.unref();
  }
  return { enabled, poll, snapshot, dispose: () => clearInterval(timer) };
}
