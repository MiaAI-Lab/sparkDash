// Copyright 2026 Maxrio9. SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { TrainingProgressCollector, runProgressProbe } from "../TrainingProgressCollector.js";
import { normalizeProgressDocument, progressConfig, RETENTION_MS } from "../../training/schema.js";

const unit = { id: "unit-a", isLocal: true };
const document = (updatedAt, extra = {}) => ({ schema_version: 1, id: "example", campaign: "Synthetic experiment", updatedAt,
  stages: { training: [{ id: "fit", label: "Training", state: "running" }] }, ...extra });
const python = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;

test("schema keeps unknown fields null, reported zero and ETA, and discards extra data", () => {
  const value = normalizeProgressDocument(document(1000, { secret: "not public", label: "Trainer", stages: {
    training: [{ id: "fit", label: "Fit", state: "running", completed: 0, etaSeconds: 0,
      metrics: [{ label: "Loss", value: 0 }, { label: "Unreported" }], secret: "not public" }],
  } }), 1000);
  assert.deepEqual(value.stages.training[0], { id: "fit", label: "Fit", state: "running", completed: 0,
    total: null, unit: null, etaSeconds: 0, metrics: [{ label: "Loss", value: 0 }, { label: "Unreported", value: null }] });
  assert.equal(value.sourceLabel, "Trainer");
  assert.ok(!JSON.stringify(value).includes("secret"));
  assert.equal(normalizeProgressDocument(document(0), RETENTION_MS + 1), null);
  for (const fields of [{ updatedAt: 6001 }, { updatedAt: undefined }, { schema_version: 2 },
    { stages: { training: [{ id: "fit", label: "Fit", state: "running", completed: -1 }] } },
    { stages: { evaluation: [{ id: "e", label: "Eval", state: "complete", etaSeconds: Infinity }] } }]) {
    assert.throws(() => normalizeProgressDocument(document(1000, fields), 1000));
  }
});

test("root configuration is explicit, bounded, and uses own-property unit overrides", () => {
  assert.deepEqual(progressConfig({}).rootsFor(unit), []);
  const config = progressConfig({ TRAINING_PROGRESS_ROOTS: '["~/reports"]',
    TRAINING_PROGRESS_ROOTS_BY_UNIT: '{"unit-a":[],"constructor":["/one"]}' });
  assert.deepEqual(config.rootsFor(unit), []);
  assert.deepEqual(config.rootsFor({ id: "constructor" }), ["/one"]);
  assert.deepEqual(config.rootsFor({ id: "other" }), ["~/reports"]);
  for (const roots of ['["relative"]', '["/bad\\nroot"]', '{}', JSON.stringify(Array.from({ length: 17 }, (_, i) => `/r${i}`))]) {
    assert.throws(() => progressConfig({ TRAINING_PROGRESS_ROOTS: roots }));
  }
});

test("per-file invalid JSON and future evidence are isolated; validation uses the post-probe clock", async () => {
  let time = 1000;
  const collector = new TrainingProgressCollector(unit, { runProbe: async () => {
    time += 7000;
    return JSON.stringify({ files: [
      { index: 0, content: "{" }, { index: 1, content: JSON.stringify(document(time)) },
      { index: 2, content: JSON.stringify(document(time + 6000)) },
    ], truncated: false });
  } });
  const result = await collector.collect(["/a", "/b", "/c"], () => time);
  assert.equal(result.partial, true);
  assert.equal(result.records[0].document, null);
  assert.equal(result.records[1].document.reportedAt, 8000);
  assert.equal(result.records[2].document, null);
  const invalid = new TrainingProgressCollector(unit, { runProbe: async () => JSON.stringify({ files: [], truncated: false }) });
  await assert.rejects(invalid.collect(["/a"], 1000));
});

test("remote roots are shell-quoted as one JSON argument, with a fixed bounded probe", async () => {
  let call;
  const roots = ["/tmp/a'$(touch should-not-run)"];
  const result = await runProgressProbe({ ...unit, isLocal: false }, roots, async (...args) => {
    call = args;
    return "{}";
  });
  assert.equal(result, "{}");
  assert.ok(call[1].startsWith("python3 -I -S - '"));
  assert.ok(call[1].includes("'\\''"));
  assert.ok(call[2].input.includes('"training-progress.json"'));
  assert.equal(call[2].timeoutMs, 8000);
  assert.equal(call[2].maxBuffer, 256 * 1024);
});

test("fixed-file probe never scans children, follows symlinks, blocks on FIFOs or reads oversized files", { skip: !python }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "training-json-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const roots = ["good", "child-only", "link-file", "large", "link-root", "fifo"].map((name) => path.join(dir, name));
  for (const root of roots.filter((_, i) => i !== 4)) await mkdir(root);
  await writeFile(path.join(roots[0], "training-progress.json"), JSON.stringify(document(1000)));
  await mkdir(path.join(roots[1], "nested"));
  await writeFile(path.join(roots[1], "nested/training-progress.json"), JSON.stringify(document(1000)));
  await symlink(path.join(roots[0], "training-progress.json"), path.join(roots[2], "training-progress.json"));
  await writeFile(path.join(roots[3], "training-progress.json"), "x".repeat(65537));
  await symlink(roots[0], roots[4]);
  assert.equal(spawnSync("mkfifo", [path.join(roots[5], "training-progress.json")]).status, 0);
  const started = Date.now();
  const result = await new TrainingProgressCollector(unit).collect(roots, 1000);
  assert.ok(Date.now() - started < 3000, "FIFO must not block a reader");
  assert.equal(result.records.filter((entry) => entry.document).length, 1);
  assert.equal(result.partial, true);
  assert.ok(!JSON.stringify(result).includes(dir), "paths must not leak through results");
});

test("sixteen near-limit roots cannot overflow the aggregate probe output", { skip: !python }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "training-json-limit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const roots = [];
  const content = JSON.stringify({ unused: "\\".repeat(32740) });
  assert.ok(Buffer.byteLength(content) <= 65536);
  for (let i = 0; i < 16; i++) {
    const root = path.join(dir, String(i)); roots.push(root);
    await mkdir(root);
    await writeFile(path.join(root, "training-progress.json"), content);
  }
  const output = await runProgressProbe(unit, roots);
  assert.ok(Buffer.byteLength(output) <= 256 * 1024);
  const result = JSON.parse(output);
  assert.equal(result.files.length, 16);
  assert.equal(result.truncated, true);
});
