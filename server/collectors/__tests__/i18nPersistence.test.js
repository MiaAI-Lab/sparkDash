import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DecodeBenchManager } from "../DecodeBench.js";
import { PrefillBenchManager } from "../PrefillBench.js";
import { QualityBenchManager } from "../QualityBench.js";
import { ShowcaseManager } from "../ShowcaseManager.js";

function tempFiles(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sparkdash-${name}-`));
  return { dir, history: path.join(dir, "history.json"), active: path.join(dir, "active.json") };
}

function job(status = "running") {
  return {
    benchId: "b1", sparkId: "s1", status, startedAt: 1, completedAt: status === "running" ? null : 2,
    config: { port: 8000 }, progress: { message: "Running concurrency 1…" }, results: { rows: [{ error: "raw model output" }] },
    error: status === "running" ? null : "Cancelled by user", owner: null,
  };
}

test("new benchmark checkpoints and histories omit derived i18n while getters project it", () => {
  const managers = [DecodeBenchManager, PrefillBenchManager, QualityBenchManager];
  for (const Manager of managers) {
    const files = tempFiles(Manager.name);
    const manager = new Manager(files.history, files.active);
    const running = job();
    manager.jobs.set(running.benchId, running);
    manager._checkpointActive();
    assert.doesNotMatch(fs.readFileSync(files.active, "utf8"), /"i18n"/, Manager.name);

    const complete = job("cancelled");
    manager._pushHistory(complete);
    assert.doesNotMatch(fs.readFileSync(files.history, "utf8"), /"i18n"/, Manager.name);
    manager.jobs.clear();
    assert.equal(manager.getJob(complete.benchId).i18n.error.key, "server.error.cancelled", Manager.name);
    fs.rmSync(files.dir, { recursive: true, force: true });
  }
});

test("port-scoped history clearing preserves raw records without persisting display descriptors", () => {
  for (const Manager of [DecodeBenchManager, PrefillBenchManager, QualityBenchManager]) {
    const files = tempFiles(`${Manager.name}-clear`);
    const manager = new Manager(files.history, files.active);
    manager._pushHistory({ ...job("cancelled"), benchId: "removed" });
    manager._pushHistory({ ...job("cancelled"), benchId: "retained", config: { port: 9000 } });
    assert.equal(manager.getJob("retained").i18n.error.key, "server.error.cancelled");
    manager.clearHistory("s1", 8000);
    const saved = JSON.parse(fs.readFileSync(files.history, "utf8")).s1;
    assert.equal(saved.length, 1, Manager.name);
    assert.equal(saved[0].benchId, "retained", Manager.name);
    assert.equal(saved[0].i18n, undefined, Manager.name);
    assert.equal(saved[0].progress.i18n, undefined, Manager.name);
    assert.deepEqual(saved[0].results, job().results, Manager.name);
    assert.equal(manager.getJob("retained").i18n.error.key, "server.error.cancelled");
    fs.rmSync(files.dir, { recursive: true, force: true });
  }
});

test("legacy benchmark descriptors remain readable without rewriting the file on load", () => {
  const files = tempFiles("legacy-bench");
  const stored = { s1: [{ ...job("failed"), i18n: { error: { key: "legacy.error" } }, progress: { message: "old", i18n: { message: { key: "legacy.progress" } } } }] };
  fs.writeFileSync(files.history, JSON.stringify(stored));
  const before = fs.readFileSync(files.history, "utf8");
  const manager = new DecodeBenchManager(files.history, files.active);
  assert.equal(manager.getJob("b1").i18n.error.key, "legacy.error");
  assert.equal(manager.getJob("b1").progress.i18n.message.key, "legacy.progress");
  assert.equal(fs.readFileSync(files.history, "utf8"), before);
  fs.rmSync(files.dir, { recursive: true, force: true });
});

test("legacy active snapshots are rebuilt without descriptors and tolerate missing progress", () => {
  const files = tempFiles("legacy-active");
  const legacyActive = { ...job(), i18n: { error: { key: "legacy.error" } }, progress: { i18n: { message: { key: "legacy.progress" } } } };
  fs.writeFileSync(files.history, JSON.stringify({ s1: [{ ...job("failed"), benchId: "b0", i18n: { error: { key: "legacy.history" } } }] }));
  fs.writeFileSync(files.active, JSON.stringify({ jobs: [legacyActive] }));
  const manager = new DecodeBenchManager(files.history, files.active);
  const recovered = JSON.parse(fs.readFileSync(files.history, "utf8")).s1;
  assert.equal(recovered.find((entry) => entry.benchId === "b0").i18n.error.key, "legacy.history");
  assert.equal(recovered.find((entry) => entry.benchId === "b1").i18n, undefined);
  assert.equal(recovered.find((entry) => entry.benchId === "b1").progress.i18n, undefined);
  assert.doesNotThrow(() => manager.getJob("b1"));

  const missingProgress = { ...job("failed"), benchId: "b2" };
  delete missingProgress.progress;
  manager._pushHistory(missingProgress);
  const saved = JSON.parse(fs.readFileSync(files.history, "utf8")).s1.find((entry) => entry.benchId === "b2");
  assert.equal(saved.i18n, undefined);
  assert.equal(saved.progress.i18n, undefined);
  assert.equal(manager.getJob("b2").progress.i18n.message.key, "server.progress.running");
  fs.rmSync(files.dir, { recursive: true, force: true });
});

test("new showcase archives omit derived i18n and project it when retrieved", () => {
  const files = tempFiles("showcase");
  const manager = new ShowcaseManager(files.history);
  manager._archiveSession({
    sessionId: "showcase-1", sparkId: "s1", status: "error", port: 8000, streams: [
      { streamId: "stream-1", label: "One", prompt: "p", status: "error", error: "Cancelled by user", i18n: { error: { key: "legacy.stream" } } },
    ], error: "Cancelled by user", i18n: { error: { key: "legacy.session" } },
  });
  assert.doesNotMatch(fs.readFileSync(files.history, "utf8"), /"i18n"/);
  const record = manager.getHistorySession("s1", "showcase-1");
  assert.equal(record.i18n.error.key, "server.error.cancelled");
  assert.equal(record.streams[0].i18n.error.key, "server.error.cancelled");
  fs.rmSync(files.dir, { recursive: true, force: true });
});
