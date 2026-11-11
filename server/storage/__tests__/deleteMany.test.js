/**
 * Bulk delete (POST /storage/delete-many): validation of every path before anything runs, dedupe of repeats and
 * nested paths, one item after another under one busy lock, which answers stop the run, the session kept in line
 * after each item, the Activity summary and the limiter. The last test runs the real delete program on real files
 * in a temporary folder with a temporary home.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ElevatedDeleteAcks } from "../ackStore.js";
import { bulkDeleteSummary, registerStorageRoutes } from "../routes.js";
import { MAX_BULK_DELETE_PATHS, StorageManager, parseDeletePaths } from "../StorageManager.js";
import { SudoVault } from "../sudoVault.js";

const spark = { id: "s1", name: "Spark One", kind: "spark", platform: "linux", ssh: { user: "me", host: "10.0.0.5" } };
const ACCOUNT = "me@10.0.0.5:22";
const QID = "0b6f1c2e-6a0e-4c1f-9d55-4a1e7a3c2b10";

const scanAnswer = (rows) => ["RESULT=ok\n" + rows.map(([b, t, p]) => `${b}\t${t}\t${p}`).join("\0"), "@@RC=0", "@@UNREADABLE=0", ""].join("\0");
const ROWS = [
  [1000, "d", "/"],
  [900, "d", "/home"],
  [900, "d", "/home/me"],
  [300, "d", "/home/me/a"],
  [200, "d", "/home/me/b"],
  [100, "f", "/home/me/c.bin"],
  [50, "f", "/home/me/a/inner.bin"],
];

/**
 * A manager whose unit answers each delete by path: `answers[path]` (a string, an Error to throw, or a function).
 * Everything else (the scan) gets ROWS. `calls` lists each delete as it started.
 */
function make({ answers = {}, gate = null, ...opts } = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const m = new StorageManager({
    run: async (_s, program, o) => {
      if (o.name !== "delete") return scanAnswer(ROWS);
      const p = o.args[0];
      calls.push({ path: p, input: o.input, program, args: o.args });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (gate) await gate(p);
        const a = typeof answers[p] === "function" ? answers[p]() : answers[p] ?? "RESULT=ok\nSTAGED=home\n";
        if (a instanceof Error) throw a;
        return a;
      } finally {
        inFlight -= 1;
      }
    },
    holdMs: 0,
    acks: new ElevatedDeleteAcks({ file: null }),
    ...opts,
  });
  return { m, calls, maxInFlight: () => maxInFlight };
}

async function finished(m, body) {
  const started = m.startDeleteMany(spark, body);
  assert.equal(started.state, "running");
  await m.settled("s1");
  return m.deleteManyJob(spark, started.id);
}

test("every path is checked first: one bad path refuses the whole request and nothing runs", async () => {
  const { m, calls } = make();
  const bad = [
    [["/home/me/a", "/etc/passwd"], 403, "protected", "/etc/passwd"],
    [["/home/me/a", "/home/me/.ssh"], 403, "protected", "/home/me/.ssh"],
    [["/home/me/a", "relative"], 400, "bad-path", "relative"],
    [["/home/me/a", "/home/me/../x"], 400, "bad-path", "/home/me/../x"],
    [["/home/me/a", "/"], 403, "protected", "/"],
    [["/home/me/a", "/home"], 403, "protected", "/home"],
    [["/home/me/a", 7], 400, "bad-path", null],
  ];
  for (const [paths, status, code, offending] of bad) {
    assert.throws(() => m.startDeleteMany(spark, { paths }), (e) => {
      assert.equal(e.status, status, String(paths));
      assert.equal(e.code, code, String(paths));
      assert.equal(e.path ?? null, offending, String(paths));
      if (offending) assert.ok(e.message.startsWith(`${offending}: `), e.message);
      return true;
    });
  }
  for (const paths of [undefined, [], "/home/me/a", Array.from({ length: MAX_BULK_DELETE_PATHS + 1 }, (_, i) => `/home/me/f${i}`)]) {
    assert.throws(() => m.startDeleteMany(spark, { paths }), (e) => e.status === 400 && e.code === "bad-paths", String(paths?.length));
  }
  assert.throws(() => m.startDeleteMany(spark, { paths: ["/home/me/a"], sudoPassword: "pw" }), (e) => e.status === 400, "a password needs sudo: true");
  assert.throws(() => m.startDeleteMany({ id: "h", kind: "host" }, { paths: ["/home/me/a"] }), (e) => e.status === 400);
  assert.equal(calls.length, 0, "nothing ran");
  assert.equal(m.deleteManyJob(spark), null, "no job was created");
  // The Spark is free: a refused request held nothing.
  await m.delete(spark, { path: "/home/me/x" });
});

test("repeats are dropped and paths inside another selected path are covered, not run on their own", () => {
  assert.deepEqual(parseDeletePaths(["/d/a", "/d/b", "/d/a", "/d/a/x", "/d/b/y/z", "/d/ab"]), { run: ["/d/a", "/d/b", "/d/ab"], covered: ["/d/a/x", "/d/b/y/z"] });
  // The order given is kept, whichever comes first.
  assert.deepEqual(parseDeletePaths(["/d/a/x", "/d/c", "/d/a"]), { run: ["/d/c", "/d/a"], covered: ["/d/a/x"] });
  assert.equal(parseDeletePaths(Array.from({ length: MAX_BULK_DELETE_PATHS }, () => "/d/a")).run.length, 1);
});

test("items run one after another in the order given, each as a full single delete", async () => {
  const { m, calls, maxInFlight } = make({ gate: () => new Promise((r) => setTimeout(r, 5)) });
  const job = await finished(m, { paths: ["/home/me/c.bin", "/home/me/a", "/home/me/a/inner.bin", "/home/me/b"] });
  assert.deepEqual(calls.map((c) => c.path), ["/home/me/c.bin", "/home/me/a", "/home/me/b"]);
  assert.equal(maxInFlight(), 1, "never two at once");
  // Each call is the ordinary delete program with its own operation id, the acknowledgement flag and the protected list.
  const ids = new Set(calls.map((c) => c.args[1]));
  assert.equal(ids.size, 3);
  for (const c of calls) {
    assert.match(c.args[1], /^[0-9a-f-]{36}$/);
    assert.equal(c.args[2], "0");
    assert.ok(c.args[3].includes("/var/lib/docker"));
    assert.ok(c.program.includes("sparkdash-storage"));
  }
  assert.deepEqual(job.deleted, ["/home/me/c.bin", "/home/me/a", "/home/me/b"]);
  assert.deepEqual(job.covered, ["/home/me/a/inner.bin"]);
  assert.deepEqual(job.failed, []);
  assert.deepEqual(job.skipped, []);
  assert.equal(job.total, 3);
  assert.equal(job.done, 3);
  assert.equal(job.current, null);
  assert.equal(job.state, "done");
  assert.equal(job.success, true);
});

test("progress is visible while it runs: done, total and the item being deleted", async () => {
  const waiting = [];
  const { m } = make({ gate: () => new Promise((r) => waiting.push(r)) });
  const started = m.startDeleteMany(spark, { paths: ["/home/me/a", "/home/me/b", "/home/me/c.bin"] });
  assert.deepEqual({ done: started.done, total: started.total, state: started.state }, { done: 0, total: 3, state: "running" });
  await new Promise((r) => setImmediate(r));
  let now = m.deleteManyJob(spark, started.id);
  assert.equal(now.current, "/home/me/a");
  waiting.shift()();
  await new Promise((r) => setImmediate(r));
  now = m.deleteManyJob(spark);
  assert.equal(now.done, 1);
  assert.equal(now.current, "/home/me/b");
  assert.deepEqual(now.deleted, ["/home/me/a"]);
  waiting.shift()();
  await new Promise((r) => setImmediate(r));
  waiting.shift()();
  await m.settled("s1");
  assert.equal(m.deleteManyJob(spark, started.id).done, 3);
  assert.equal(m.deleteManyJob(spark, "another-id"), null);
});

test("a failed item does not stop the rest; its code, message, partial flag and Needs-attention id are reported", async () => {
  const { m, calls } = make({
    answers: {
      "/home/me/a": "RESULT=error\nCODE=permission\nMSG=Permission denied\nREMAINS=1\n",
      "/home/me/b": `RESULT=error\nCODE=protected-descendant\nMSG=It contains .ssh; it is kept under Needs attention.\nREMAINS=0\nQID=${QID}\n`,
      "/home/me/d": "RESULT=error\nCODE=not-found\nMSG=That item is already gone from the Spark\n",
      "/home/me/e": "garbage",
    },
  });
  const job = await finished(m, { paths: ["/home/me/a", "/home/me/b", "/home/me/c.bin", "/home/me/d", "/home/me/e"] });
  assert.equal(calls.length, 5);
  assert.deepEqual(job.deleted, ["/home/me/c.bin"]);
  assert.deepEqual(job.failed, [
    { path: "/home/me/a", code: "permission", message: "Permission denied", partial: true },
    { path: "/home/me/b", code: "protected-descendant", message: "It contains .ssh; it is kept under Needs attention.", partial: false, quarantineId: QID },
    { path: "/home/me/d", code: "not-found", message: "That item is already gone from the Spark", partial: false },
    { path: "/home/me/e", code: "bad-output", message: "The Spark returned an unexpected answer", partial: false },
  ]);
  assert.deepEqual(job.skipped, []);
  assert.equal(job.stopped, null);
  assert.equal(job.success, false);
  assert.equal(job.done, 5);
});

test("as administrator: still refused is a failure, and a refusal that can be done by hand carries the command", async () => {
  const { m } = make({
    answers: {
      "/home/me/a": "RESULT=error\nCODE=permission\nMSG=Operation not permitted\nREMAINS=0\n",
      "/home/me/it's": "RESULT=error\nCODE=tree-writable-by-others\nMSG=drop can be changed by other accounts\nREMAINS=0\n",
    },
  });
  const job = await finished(m, { paths: ["/home/me/a", "/home/me/it's"], sudo: true });
  assert.equal(job.elevated, true);
  assert.equal(job.failed[0].code, "rm-failed");
  assert.match(job.failed[0].message, /administrator/);
  assert.equal(job.failed[1].command, "sudo rm -rf --one-file-system -- '/home/me/it'\\''s'");
});

for (const [code, answer] of [
  ["bad-password", "RESULT=error\nCODE=bad-password\nMSG=The sudo password was not accepted\n"],
  ["no-ack", "RESULT=error\nCODE=no-ack\nMSG=Deleting folders as administrator is not turned on for this Spark. Confirm it first.\n"],
  ["unit-busy", "RESULT=error\nCODE=unit-busy\nMSG=Another dashboard is using this Spark's storage.\n"],
  ["no-sudo", "RESULT=error\nCODE=no-sudo\nMSG=sudo is not installed on this Spark\n"],
]) {
  test(`${code} stops the run at once: the rest is skipped, not tried`, async () => {
    const { m, calls } = make({ answers: { "/home/me/b": answer } });
    const job = await finished(m, { paths: ["/home/me/a", "/home/me/b", "/home/me/c.bin", "/home/me/d"], sudo: true, sudoPassword: "pw" });
    assert.deepEqual(calls.map((c) => c.path), ["/home/me/a", "/home/me/b"]);
    assert.deepEqual(job.deleted, ["/home/me/a"]);
    assert.equal(job.failed.length, 1);
    assert.equal(job.failed[0].code, code);
    assert.deepEqual(job.skipped.map((s) => s.path), ["/home/me/c.bin", "/home/me/d"]);
    assert.match(job.skipped[0].reason, /^Not tried/);
    assert.equal(job.stopped.code, code);
    assert.equal(job.done, 2);
    assert.equal(job.success, false);
  });
}

test("lost contact stops the run, says the outcome is unknown, and keeps the Spark busy for a while", async () => {
  let now = 1000;
  const { m, calls } = make({ answers: { "/home/me/b": new Error("ssh: connect timed out") }, holdMs: 60_000, now: () => now });
  const job = await finished(m, { paths: ["/home/me/a", "/home/me/b", "/home/me/c.bin"] });
  assert.deepEqual(calls.map((c) => c.path), ["/home/me/a", "/home/me/b"]);
  assert.equal(job.failed[0].code, "unreachable");
  assert.match(job.failed[0].message, /not known/);
  assert.deepEqual(job.skipped, [{ path: "/home/me/c.bin", reason: "Not tried: the dashboard lost contact with the Spark." }]);
  // The unit may still be running the last delete: nothing else may start for now.
  await assert.rejects(m.delete(spark, { path: "/home/me/x" }), (e) => e.status === 409 && e.code === "busy" && /lost contact/.test(e.message));
  assert.throws(() => m.startDeleteMany(spark, { paths: ["/home/me/x"] }), (e) => e.code === "busy");
});

test("a wrong password is not guessed again for every item, and a locked-out password refuses before anything runs", async () => {
  const { m, calls } = make({ answers: { "/home/me/a": "RESULT=error\nCODE=bad-password\nMSG=The sudo password was not accepted\n" } });
  for (let i = 0; i < 3; i++) {
    const job = await finished(m, { paths: ["/home/me/a", "/home/me/b"], sudo: true, sudoPassword: `wrong${i}` });
    assert.equal(job.stopped.code, "bad-password");
  }
  assert.equal(calls.length, 3, "one guess per request");
  assert.throws(() => m.startDeleteMany(spark, { paths: ["/home/me/b"], sudo: true, sudoPassword: "wrong4" }), (e) => e.status === 429 && e.code === "password-locked");
  assert.equal(calls.length, 3);
  // The refused request did not keep the Spark busy.
  await m.delete(spark, { path: "/home/me/x" });
});

test("the typed password is used for every item of the request, never put in the program, and remembered once when asked", async () => {
  const vault = new SudoVault({ file: null, encrypt: (p) => `e:${p}`, decrypt: (b) => b.slice(2) });
  let sets = 0;
  const set = vault.set.bind(vault);
  vault.set = (...a) => {
    sets += 1;
    return set(...a);
  };
  const { m, calls } = make({ vault });
  await finished(m, { paths: ["/home/me/a", "/home/me/b", "/home/me/c.bin"], sudo: true, sudoPassword: "s3cret-pw" });
  assert.deepEqual(calls.map((c) => c.input), ["s3cret-pw", "s3cret-pw", "s3cret-pw"]);
  assert.ok(calls.every((c) => !c.program.includes("s3cret-pw")));
  assert.equal(vault.has(ACCOUNT), false, "not asked to remember");
  await finished(m, { paths: ["/home/me/a", "/home/me/b"], sudo: true, sudoPassword: "pw-2", remember: true });
  assert.equal(vault.get(ACCOUNT), "pw-2");
  assert.equal(sets, 1, "stored once, after sudo accepted it");
  assert.equal(JSON.stringify(m.deleteManyJob(spark)).includes("pw-2"), false, "the job never carries the password");
});

test("the session is kept in line after each item: deleted rows go, their folders shrink", async () => {
  const seen = [];
  let m;
  ({ m } = make({
    gate: async () => {
      const by = new Map(m.snapshot(spark).session.entries.map((e) => [e.path, e]));
      seen.push({ a: by.has("/home/me/a"), me: by.get("/home/me").bytes });
    },
  }));
  m.startScan(spark, {});
  await m.settled("s1");
  const before = m.snapshot(spark).revision;
  await finished(m, { paths: ["/home/me/a", "/home/me/c.bin"] });
  // While the second item ran, the first was already gone from the result.
  assert.deepEqual(seen, [
    { a: true, me: 900 },
    { a: false, me: 600 },
  ]);
  const { session, revision } = m.snapshot(spark);
  assert.ok(revision >= before + 2);
  const by = new Map(session.entries.map((e) => [e.path, e]));
  assert.equal(by.has("/home/me/a/inner.bin"), false);
  assert.equal(by.get("/home/me").bytes, 500);
  assert.equal(by.get("/home").bytes, 500);
  assert.equal(by.get("/").bytes, 600);
});

test("one busy lock for the whole run: other changes and scans are refused until it ends", async () => {
  const waiting = [];
  const { m } = make({ gate: (p) => (p === "/home/me/x" ? null : new Promise((r) => waiting.push(r))) });
  m.startDeleteMany(spark, { paths: ["/home/me/a", "/home/me/b"] });
  await new Promise((r) => setImmediate(r));
  await assert.rejects(m.delete(spark, { path: "/home/me/x" }), (e) => e.status === 409 && e.code === "busy" && /bulk delete is running.*0 of 2/.test(e.message));
  assert.throws(() => m.startScan(spark, {}), (e) => e.status === 409);
  assert.throws(() => m.startDeleteMany(spark, { paths: ["/home/me/x"] }), (e) => e.status === 409);
  waiting.shift()();
  await new Promise((r) => setImmediate(r));
  // Between two items the lock is still held.
  await assert.rejects(m.delete(spark, { path: "/home/me/x" }), (e) => e.code === "busy" && /1 of 2/.test(e.message));
  waiting.shift()();
  await m.settled("s1");
  await m.delete(spark, { path: "/home/me/x" });

  // And a running scan refuses a bulk delete before anything runs.
  let release;
  const scanGate = new Promise((r) => (release = r));
  const scanning = new StorageManager({
    run: async () => {
      await scanGate;
      return scanAnswer(ROWS);
    },
    holdMs: 0,
  });
  scanning.startScan(spark, {});
  assert.throws(() => scanning.startDeleteMany(spark, { paths: ["/home/me/a"] }), (e) => e.status === 409 && e.code === "scan-running");
  release();
  await scanning.settled("s1");
  assert.equal(scanning.deleteManyJob(spark), null);
});

test("the run stops starting new items after its overall limit", async () => {
  let now = 0;
  const { m, calls } = make({ now: () => now, bulkLimitMs: 1000, gate: async () => (now += 600) });
  const job = await finished(m, { paths: ["/home/me/a", "/home/me/b", "/home/me/c.bin"] });
  assert.deepEqual(calls.map((c) => c.path), ["/home/me/a", "/home/me/b"]);
  assert.deepEqual(job.deleted, ["/home/me/a", "/home/me/b"]);
  assert.deepEqual(job.skipped, [{ path: "/home/me/c.bin", reason: "Not tried: the bulk delete reached its 45-minute limit." }]);
  assert.equal(job.stopped.code, "time-limit");
});

test("the Activity line gives plain counts, the first few names and whether it ran as administrator", () => {
  const base = { total: 5, elevated: false, deleted: [], failed: [], skipped: [], covered: [] };
  assert.equal(bulkDeleteSummary({ ...base, deleted: ["/d/a", "/d/b", "/d/c", "/d/e", "/d/f"] }, "S1"), "Deleted 5 items on S1: a, b, c and 2 more.");
  assert.equal(
    bulkDeleteSummary({ ...base, total: 3, elevated: true, deleted: ["/d/a", "/d/b"], failed: [{ path: "/d/c" }] }, "S1"),
    "Deleted 2 of 3 items on S1 (as administrator): a, b. 1 could not be deleted."
  );
  assert.equal(
    bulkDeleteSummary({ ...base, total: 3, failed: [{ path: "/d/a" }], skipped: [{}, {}] }, "S1"),
    "Deleted none of 3 items on S1. 1 could not be deleted: a. 2 were not tried."
  );
  assert.equal(bulkDeleteSummary({ ...base, total: 1, deleted: ["/d/a"] }, "S1"), "Deleted 1 item on S1: a.");
});

async function withApp({ run, allowChange = () => true, allowRead = () => true }, fn) {
  const events = [];
  const app = express();
  app.use(express.json());
  const manager = new StorageManager({ run, holdMs: 0, acks: new ElevatedDeleteAcks({ file: null }) });
  registerStorageRoutes(app, {
    manager,
    registry: { getSpark: (id) => (id === "s1" ? spark : null) },
    recordEvent: (e) => events.push(e),
    allowRead,
    allowChange,
    rejectLimited: (res, message) => res.status(429).json({ error: message }),
  });
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  try {
    await fn(`http://127.0.0.1:${server.address().port}/api/sparks/s1/storage`, events, manager);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

test("routes: start answers 202 with the job, polling follows it, one limiter hit and one Activity entry per request", async () => {
  let changes = 0;
  let reads = 0;
  const run = async (_s, _p, o) => (o.args[0] === "/home/me/b" ? "RESULT=error\nCODE=permission\nMSG=Permission denied\nREMAINS=0\n" : "RESULT=ok\n");
  await withApp(
    {
      run,
      allowChange: () => {
        changes += 1;
        return true;
      },
      allowRead: () => {
        reads += 1;
        return true;
      },
    },
    async (base, events, manager) => {
      let res = await fetch(`${base}/delete-many`, json("POST", { paths: ["/home/me/a", "/home/me/b", "/home/me/c", "/home/me/a/x"], sudo: true }));
      assert.equal(res.status, 202);
      const { job } = await res.json();
      assert.equal(job.total, 3);
      assert.deepEqual(job.covered, ["/home/me/a/x"]);
      await manager.settled("s1");
      res = await fetch(`${base}/delete-many/${job.id}`);
      const done = (await res.json()).job;
      assert.equal(done.state, "done");
      assert.deepEqual(done.deleted, ["/home/me/a", "/home/me/c"]);
      assert.deepEqual(done.failed.map((f) => [f.path, f.code]), [["/home/me/b", "rm-failed"]]);
      assert.deepEqual((await (await fetch(`${base}/delete-many`)).json()).job.id, job.id, "the latest job, for a page opened later");
      assert.equal((await fetch(`${base}/delete-many/not-this-one`)).status, 404);
      assert.equal(changes, 1, "one request, one limiter hit, whatever the number of paths");
      assert.equal(reads, 0, "polling is not rate limited");
      assert.equal(events.length, 1);
      assert.deepEqual(events[0], {
        type: "storage.delete-many",
        severity: "warn",
        sparkId: "s1",
        message: "Deleted 2 of 3 items on Spark One (as administrator): a, c. 1 could not be deleted.",
      });

      // A bad path refuses the request with the path, and nothing is logged.
      res = await fetch(`${base}/delete-many`, json("POST", { paths: ["/home/me/a", "/etc/x"] }));
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.code, "protected");
      assert.equal(body.path, "/etc/x");
      assert.equal(events.length, 1);
      assert.equal((await fetch(`${base}/delete-many`, json("POST", { paths: [] }))).status, 400);
    }
  );
  // Rate limited: refused before anything runs.
  let ran = 0;
  await withApp({ run: async () => (ran++, "RESULT=ok\n"), allowChange: () => false }, async (base) => {
    const res = await fetch(`${base}/delete-many`, json("POST", { paths: ["/home/me/a"] }));
    assert.equal(res.status, 429);
    assert.equal(ran, 0);
    assert.equal((await (await fetch(`${base}/delete-many`)).json()).job, null);
  });
});

// ─── The real delete program, on real files in a sandbox ──────────────────────

const REAL_PERL = (() => {
  try {
    return execFileSync("sh", ["-c", "command -v perl"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
})();
const skipReal = !REAL_PERL ? "perl is not installed" : process.getuid?.() === 0 ? "runs as an ordinary account" : false;

test("real program: several files and folders are deleted one by one in a sandbox, the rest reported", { skip: skipReal }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delmany-"));
  try {
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    fs.mkdirSync(home, { mode: 0o755 });
    fs.mkdirSync(path.join(data, "proj/sub"), { recursive: true, mode: 0o755 });
    fs.mkdirSync(path.join(data, "cache"), { mode: 0o755 });
    fs.writeFileSync(path.join(data, "proj/sub/model.bin"), "weights");
    fs.writeFileSync(path.join(data, "cache/blob"), "blob");
    fs.writeFileSync(path.join(data, "notes.txt"), "notes");
    fs.writeFileSync(path.join(data, "keep.txt"), "keep");
    fs.mkdirSync(path.join(data, "ssh-inside/.ssh"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(data, "ssh-inside/.ssh/id"), "key");
    const names = [];
    const m = new StorageManager({
      holdMs: 0,
      run: async (_s, program, o) => {
        names.push(o.args?.[0]);
        // HOME and TMPDIR in the sandbox: staging, records and temporary files never leave it.
        return spawnSync("sh", ["-c", program], { encoding: "utf8", env: { ...process.env, HOME: home, TMPDIR: root } }).stdout;
      },
    });
    const local = { id: "local", name: "Local", kind: "spark", platform: "linux", isLocal: true };
    const p = (n) => path.join(data, n);
    const started = m.startDeleteMany(local, { paths: [p("proj"), p("notes.txt"), p("proj/sub/model.bin"), p("gone"), p("cache"), p("ssh-inside")] });
    await m.settled("local");
    const job = m.deleteManyJob(local, started.id);
    assert.deepEqual(names, [p("proj"), p("notes.txt"), p("gone"), p("cache"), p("ssh-inside")], "one program per item, in order");
    assert.deepEqual(job.deleted, [p("proj"), p("notes.txt"), p("cache")]);
    assert.deepEqual(job.covered, [p("proj/sub/model.bin")]);
    assert.deepEqual(job.failed.map((f) => [f.path, f.code]), [
      [p("gone"), "not-found"],
      [p("ssh-inside"), "protected-descendant"],
    ]);
    for (const n of ["proj", "notes.txt", "cache"]) assert.equal(fs.existsSync(p(n)), false, n);
    assert.equal(fs.readFileSync(p("keep.txt"), "utf8"), "keep", "nothing else was touched");
    assert.equal(fs.readFileSync(p("ssh-inside/.ssh/id"), "utf8"), "key", "a refused folder is left as it was");
    const staging = path.join(home, ".local/state/sparkdash/staging");
    const records = path.join(home, ".local/state/sparkdash/quarantine");
    assert.deepEqual(fs.existsSync(staging) ? fs.readdirSync(staging) : [], [], "nothing left staged");
    assert.deepEqual(fs.existsSync(records) ? fs.readdirSync(records).filter((n) => n.endsWith(".json")) : [], [], "no recovery record left");
  } finally {
    spawnSync("chmod", ["-R", "u+rwx", root]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
