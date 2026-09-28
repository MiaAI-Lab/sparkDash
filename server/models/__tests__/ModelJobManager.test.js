import test from "node:test";
import assert from "node:assert/strict";
import os from "os";
import fs from "fs";
import path from "path";
import { ModelJobManager } from "../ModelJobManager.js";

// Two Sparks, password auth — the live deployment shape.
const SPARK_A = { id: "sparkA", name: "sparkA.lan", lanIp: "10.0.0.10", isLocal: false, ssh: { host: "10.0.0.10", user: "u", auth: "pass", password: "sekretA" } };
const SPARK_B = { id: "sparkB", name: "sparkB.lan", lanIp: "10.0.0.11", isLocal: false, ssh: { host: "10.0.0.11", user: "u", auth: "pass", password: "sekretB" } };

const QWEN = { id: "qwen", name: "Qwen", dir: "/repos/qwen", startScript: "start.sh", stopScript: "stop.sh", restartScript: null, logsScript: null, startArgs: [], container: "vllm-fn", port: 8000, sparkId: "sparkA" };
const DS = { id: "ds", name: "DeepSeek", dir: "/repos/ds", startScript: "start-ds.sh", stopScript: "stop-ds.sh", restartScript: null, logsScript: "logs-ds.sh", startArgs: [], container: "ds-head", port: 8000, sparkId: "sparkB" };
const ORPHAN = { id: "orphan", name: "Orphan", dir: "/repos/orphan", startScript: "start.sh", stopScript: "stop.sh", startArgs: [], container: "o", port: 8000 }; // no sparkId

/** Manager with the real routing logic and a captured spawn list. */
function makeManager(models, sparks = { sparkA: SPARK_A, sparkB: SPARK_B }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modeljobs-"));
  const m = new ModelJobManager({
    activePath: path.join(dir, "active.json"),
    getModel: (id) => models.find((x) => x.id === id) || null,
    getSpark: (id) => sparks[id] || null,
  });
  const spawned = [];
  m._spawnJob = async (job, chunks, timeoutMs) => {
    spawned.push({ job, chunks, timeoutMs });
  };
  return { m, spawned };
}

// ─── assignment is mandatory before any traffic ────────────
test("start refuses a model with no Spark assigned — nothing spawns", () => {
  const { m, spawned } = makeManager([ORPHAN]);
  assert.throws(() => m.start("orphan", "start"), /has no Spark assigned/);
  assert.equal(spawned.length, 0);
});

test("start refuses a model whose Spark was deleted, naming both", () => {
  const { m } = makeManager([QWEN], {}); // no sparks registered
  assert.throws(() => m.start("qwen", "start"), /Spark "sparkA" assigned to model qwen is not registered/);
});

// ─── single action routes to the model's own Spark ─────────
test("a start spawns exactly one chunk on the assigned Spark's ssh target", () => {
  const { m, spawned } = makeManager([QWEN]);
  m.start("qwen", "start");
  assert.equal(spawned.length, 1);
  const { chunks } = spawned[0];
  assert.match(chunks[0].cmd, /exec bash '\.\/start\.sh'/);
  assert.equal(chunks[0].target.kind, "ssh");
  assert.equal(chunks[0].target.key, "ssh:sparkA");
  assert.match(chunks[0].cmd, /exec bash '\/?\.?\/?start\.sh'|exec bash '\.\/start\.sh'/);
});

test("the docker-logs tail fallback also runs on the model's Spark", () => {
  const { m, spawned } = makeManager([QWEN]);
  m.start("qwen", "logs"); // no logsScript → `docker logs -f <container>` fallback
  assert.equal(spawned[0].chunks[0].target.key, "ssh:sparkA");
  assert.match(spawned[0].chunks[0].cmd, /docker logs -f --tail 500 'vllm-fn'/);
});

// ─── exclusive start: chains stay per-machine ──────────────
test("same-Spark stop+start remain ONE chained command", () => {
  const qwen2 = { ...QWEN, sparkId: "sparkA" };
  const glm = { ...QWEN, id: "glm", sparkId: "sparkA", startScript: "glm-start.sh" };
  const { m, spawned } = makeManager([glm, qwen2]);
  m.startExclusive("glm", ["qwen"]);
  const { chunks } = spawned[0];
  assert.equal(chunks.length, 1, "one machine, one chain");
  assert.equal(chunks[0].target.key, "ssh:sparkA");
  assert.match(chunks[0].cmd, /stop Qwen/);
  assert.match(chunks[0].cmd, /glm-start\.sh/);
});

test("cross-Spark stop+start split into ordered per-machine chunks", () => {
  const { m, spawned } = makeManager([QWEN, DS]);
  m.startExclusive("ds", ["qwen"]); // incumbent on sparkA, target on sparkB
  const { chunks } = spawned[0];
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].target.key, "ssh:sparkA"); // incumbent stopped first
  assert.match(chunks[0].cmd, /stop Qwen/);
  assert.equal(chunks[1].target.key, "ssh:sparkB"); // then the target starts
  assert.match(chunks[1].cmd, /start-ds\.sh/);
});

test("an exclusive start fails if ANY step is unplaced (no silent GPU double-book)", () => {
  const { m, spawned } = makeManager([ORPHAN, DS]);
  assert.throws(() => m.startExclusive("ds", ["orphan"]), /has no Spark assigned/);
  assert.equal(spawned.length, 0);
});

// ─── secrets never leak into the public/checkpointed shape ──
test("SSH passwords reach the transport only — never job payloads or checkpoints", () => {
  const { m, spawned } = makeManager([QWEN]);
  m.start("qwen", "start");
  const { chunks } = spawned[0];
  const publicJson = JSON.stringify(m.getLatest("qwen"));
  const activeJson = fs.readFileSync(m.activePath, "utf8");
  for (const blob of [publicJson, activeJson]) {
    assert.ok(!blob.includes("sekretA"), "password leaked into a public payload");
    assert.ok(!blob.includes("ssh"), "raw ssh invocation leaked into a job record");
  }
  // The target itself (secret-bearing) lives only on the spawn chunk.
  assert.equal(spawned[0].chunks[0].target.spark.ssh.password, "sekretA");
});

// ─── exclusive restart ───────────────────────────────────
test("an exclusive restart chains the incumbent stop before the target's restart.sh", () => {
  const qwen = { ...QWEN, restartScript: "restart.sh" };
  const glm = { ...QWEN, id: "glm", name: "GLM", restartScript: "glm-restart.sh" };
  const { m, spawned } = makeManager([glm, qwen]);
  const r = m.startExclusive("glm", ["qwen"], { action: "restart" });
  assert.equal(r.status, "running");
  const { chunks } = spawned[0];
  assert.equal(chunks.length, 1, "same Spark → one chain");
  assert.match(chunks[0].cmd, /stop Qwen/);
  assert.match(chunks[0].cmd, /glm-restart\.sh/);
  assert.equal(m.getLatest("glm").action, "restart");
});

test("an exclusive start fails the chain when an incumbent has no stop script (fail closed)", () => {
  const nostop = { ...QWEN, id: "nostop", stopScript: null };
  const glm = { ...QWEN, id: "glm", startScript: "g.sh" };
  const { m, spawned } = makeManager([glm, nostop]);
  assert.throws(() => m.startExclusive("glm", ["nostop"]), /no stop script/);
  assert.equal(spawned.length, 0);
});
