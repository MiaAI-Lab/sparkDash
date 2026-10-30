/**
 * Quality bench: deleting one saved run. The route is covered separately by
 * server/__tests__/quality-bench-delete-run-route.test.js; this file pins the manager
 * semantics — one run leaves the history (and the file), the rest stays, a run still
 * in flight is refused.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QualityBenchManager } from "../QualityBench.js";

const job = (benchId, port, status = "completed") => ({
  benchId,
  sparkId: "alpha",
  status,
  startedAt: 1_780_000_000_000 + port,
  completedAt: 1_780_000_060_000,
  durationMs: 60_000,
  error: null,
  config: { port, modelId: `m${port}`, label: "" },
  progress: { currentCategory: null, categoryDone: 0, categoryTotal: 0, done: 0, total: 0, message: "Done" },
  results: { overallPct: 50, categories: {}, items: [], skippedLongSizes: [] },
});

function managerWith(history) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-quality-delete-"));
  const historyPath = path.join(dir, "quality-bench-history.json");
  fs.writeFileSync(historyPath, JSON.stringify(history));
  const manager = new QualityBenchManager(historyPath, path.join(dir, "quality-bench-active.json"));
  return { manager, historyPath, dir };
}

test("deleteRun removes one run, keeps the others and persists the file", (t) => {
  const { manager, historyPath, dir } = managerWith({
    alpha: [job("a", 8888), job("b", 18891), job("c", 8888)],
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.deepEqual(manager.deleteRun("alpha", "b"), { ok: true });
  // Other ports' runs are untouched: only the named run leaves the list.
  assert.deepEqual(manager.getHistory("alpha").map((j) => j.benchId), ["a", "c"]);
  assert.equal(manager.getJob("b"), null);
  // Written through, so a restart does not bring the run back.
  const saved = JSON.parse(fs.readFileSync(historyPath, "utf8"));
  assert.deepEqual(saved.alpha.map((j) => j.benchId), ["a", "c"]);
});

test("deleteRun refuses a run still in flight and leaves it in place", (t) => {
  const { manager, dir } = managerWith({ alpha: [job("a", 8888)] });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  manager.jobs.set("live", job("live", 8888, "running"));
  manager.activeBySpark.set("alpha", "live");

  assert.deepEqual(manager.deleteRun("alpha", "live"), { ok: false, reason: "running" });
  assert.deepEqual(manager.getHistory("alpha").map((j) => j.benchId), ["a"]);
  assert.equal(manager.getJob("live")?.status, "running");
});

test("deleteRun reports a run that is not there, and the last delete drops the unit", (t) => {
  const { manager, dir } = managerWith({ alpha: [job("a", 8888)] });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.deepEqual(manager.deleteRun("alpha", "nope"), { ok: false, reason: "missing" });
  assert.deepEqual(manager.deleteRun("other", "a"), { ok: false, reason: "missing" });
  assert.deepEqual(manager.deleteRun("alpha", "a"), { ok: true });
  assert.deepEqual(manager.getHistory("alpha"), []);
  assert.deepEqual(manager.getHistorySummaries("alpha"), []);
});
