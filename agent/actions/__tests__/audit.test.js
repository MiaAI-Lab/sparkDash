/**
 * audit.test.js — tests for the append-only JSONL audit log (Batch 2A).
 *
 * All I/O happens in per-test tmp dirs (mkdtemp) — the default
 * agent/config/audit.log is never touched by tests.
 *
 * Run: node --test agent/actions/__tests__/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendAudit,
  readAudit,
  DEFAULT_AUDIT_PATH,
  DEFAULT_READ_LIMIT,
} from "../audit.js";

/**
 * A well-formed AuditEntry (shared/types.ts).
 * @param {object} [over] field overrides
 */
function entry(over = {}) {
  return {
    ts: 1758620000000,
    action: "start",
    serviceName: "llm-tp1",
    port: 8080,
    modelId: null,
    engine: null,
    status: "success",
    message: "docker start qwen38-sglang → exit 0",
    durationMs: 42,
    ...over,
  };
}

/**
 * Run fn inside a fresh tmp dir; dir is removed after the test.
 * @param {import("node:test").TestContext} t
 * @param {(dir: string, auditPath: string) => Promise<void>} fn
 */
async function withTmp(t, fn) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "audit-test-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  await fn(dir, path.join(dir, "audit.log"));
}

/** @param {string} p @returns {string[]} raw lines (no trailing-empty) */
function rawLines(p) {
  const lines = fs.readFileSync(p, "utf-8").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** @param {(msg: string) => void} [spy] replaces console.log; returns captured messages */
function captureConsoleLog() {
  const orig = console.log;
  /** @type {string[]} */
  const captured = [];
  console.log = (...a) => {
    captured.push(a.join(" "));
  };
  return {
    stop() {
      console.log = orig;
      return captured;
    },
  };
}

test("appendAudit: appends after sentinel entries (append-not-overwrite)", async (t) => {
  await withTmp(t, async (dir, p) => {
    fs.writeFileSync(p, JSON.stringify(entry({ action: "stop" })) + "\n");
    fs.writeFileSync(p, JSON.stringify(entry({ action: "restart" })) + "\n", { flag: "a" });
    await appendAudit(entry({ action: "start" }), { path: p });
    const lines = rawLines(p);
    assert.equal(lines.length, 3);
    assert.deepEqual(JSON.parse(lines[0]), entry({ action: "stop" }), "sentinel 1 intact");
    assert.deepEqual(JSON.parse(lines[1]), entry({ action: "restart" }), "sentinel 2 intact");
    assert.deepEqual(JSON.parse(lines[2]), entry({ action: "start" }), "new entry appended");
  });
});

test("appendAudit idempotent write: same entry twice → two lines, not one", async (t) => {
  await withTmp(t, async (dir, p) => {
    const e = entry({ action: "stop" });
    await appendAudit(e, { path: p });
    await appendAudit(e, { path: p });
    const lines = rawLines(p);
    assert.equal(lines.length, 2);
    assert.equal(lines[0], lines[1], "both lines identical");
    assert.deepEqual(JSON.parse(lines[0]), e);
  });
});

test("readAudit: default limit 50 → last 50 of 60 seeded entries, in order", async (t) => {
  await withTmp(t, async (dir, p) => {
    const seeded = [];
    for (let i = 0; i < 60; i++) seeded.push(entry({ ts: 1000 + i, message: `entry-${i}` }));
    fs.writeFileSync(p, seeded.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const got = await readAudit(undefined, { path: p });
    assert.equal(got.length, 50);
    assert.deepEqual(got, seeded.slice(10), "window = last 50, oldest-first");
    assert.equal(got[0].message, "entry-10");
    assert.equal(got[49].message, "entry-59");
  });
});

test("readAudit: limit 10 → array of exactly 10 AuditEntry", async (t) => {
  await withTmp(t, async (dir, p) => {
    const seeded = [];
    for (let i = 0; i < 60; i++) seeded.push(entry({ ts: 1000 + i, message: `entry-${i}` }));
    fs.writeFileSync(p, seeded.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const got = await readAudit(10, { path: p });
    assert.equal(got.length, 10);
    assert.deepEqual(got, seeded.slice(50));
    for (const e of got) {
      assert.equal(typeof e.ts, "number");
      assert.equal(typeof e.action, "string");
      assert.equal(typeof e.serviceName, "string");
      assert.equal(typeof e.status, "string");
    }
  });
});

test("content preservation: pre-existing bytes unchanged after append", async (t) => {
  await withTmp(t, async (dir, p) => {
    const original =
      JSON.stringify(entry({ action: "stop" })) +
      "\n" +
      JSON.stringify(entry({ action: "restart" })) +
      "\n";
    fs.writeFileSync(p, original);
    await appendAudit(entry({ action: "start" }), { path: p });
    const after = fs.readFileSync(p, "utf-8");
    assert.ok(after.startsWith(original), "original content is a byte-prefix of the file");
    const lines = rawLines(p);
    assert.equal(lines.length, 3);
    assert.deepEqual(JSON.parse(lines[0]), entry({ action: "stop" }));
    assert.deepEqual(JSON.parse(lines[1]), entry({ action: "restart" }));
  });
});

test("graceful degradation: unwritable path → no throw, console.log called", async (t) => {
  await withTmp(t, async (dir) => {
    const badPath = path.join(dir, "no-such-dir", "audit.log");
    const cap = captureConsoleLog();
    let threw = false;
    try {
      await appendAudit(entry(), { path: badPath });
    } catch {
      threw = true;
    }
    const captured = cap.stop();
    assert.equal(threw, false, "appendAudit must not throw on unwritable path");
    assert.ok(
      captured.some((m) => m.includes("append failed")),
      `console.log must report the failure, got: ${JSON.stringify(captured)}`
    );
  });
});

test("readAudit: missing file → [] (no throw)", async (t) => {
  await withTmp(t, async (dir) => {
    const got = await readAudit(10, { path: path.join(dir, "absent.log") });
    assert.deepEqual(got, []);
  });
});

test("readAudit: malformed lines skipped, valid lines still returned", async (t) => {
  await withTmp(t, async (dir, p) => {
    const good1 = JSON.stringify(entry({ message: "good-1" }));
    const good2 = JSON.stringify(entry({ message: "good-2" }));
    fs.writeFileSync(p, `${good1}\n{not json at all\n${good2}\n\n`);
    const got = await readAudit(50, { path: p });
    assert.equal(got.length, 2);
    assert.equal(got[0].message, "good-1");
    assert.equal(got[1].message, "good-2");
  });
});

test("appendAudit: invalid entries (null / array / string) → no line written, no throw", async (t) => {
  await withTmp(t, async (dir, p) => {
    const cap = captureConsoleLog();
    for (const bad of [null, ["a"], "a-string"]) {
      let threw = false;
      try {
        await appendAudit(/** @type {any} */ (bad), { path: p });
      } catch {
        threw = true;
      }
      assert.equal(threw, false, `entry ${JSON.stringify(bad)} must not throw`);
    }
    const captured = cap.stop();
    assert.ok(captured.length >= 3, "each invalid entry logged");
    assert.equal(fs.existsSync(p), false, "no audit file created for invalid entries");
  });
});

test("appendAudit: entry without ts gets current epoch", async (t) => {
  await withTmp(t, async (dir, p) => {
    const { ts: _drop, ...noTs } = entry();
    const before = Date.now();
    await appendAudit(noTs, { path: p });
    const got = await readAudit(10, { path: p });
    assert.equal(got.length, 1);
    assert.ok(got[0].ts >= before - 5 && got[0].ts <= Date.now() + 5, "ts defaults to ~now");
    assert.equal(got[0].message, noTs.message);
  });
});

test("readAudit out-of-bounds limits: 0 → []; negative/non-integer → default 50", async (t) => {
  await withTmp(t, async (dir, p) => {
    const seeded = [];
    for (let i = 0; i < 60; i++) seeded.push(entry({ ts: 1000 + i }));
    fs.writeFileSync(p, seeded.map((e) => JSON.stringify(e)).join("\n") + "\n");
    assert.deepEqual(await readAudit(0, { path: p }), []);
    assert.equal((await readAudit(-3, { path: p })).length, DEFAULT_READ_LIMIT);
    assert.equal((await readAudit("ten", { path: p })).length, DEFAULT_READ_LIMIT);
  });
});

test("DEFAULT_AUDIT_PATH points at agent/config/audit.log", () => {
  assert.ok(
    DEFAULT_AUDIT_PATH.endsWith(path.join("agent", "config", "audit.log")),
    `default path: ${DEFAULT_AUDIT_PATH}`
  );
});
