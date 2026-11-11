import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProgram, parseScanOutput, totalsFromAtoms } from "../commands.js";
import { StorageManager } from "../StorageManager.js";

const hasPerl = (() => { try { execFileSync("perl", ["-e", "1"]); return true; } catch { return false; } })();
const isRoot = process.getuid?.() === 0;
const MiB = 1024 * 1024;

const scan = (root, depth, par = 4) =>
  parseScanOutput(execFileSync("sh", ["-c", buildProgram("scan", { args: [root, depth, 60, 4000, par] })], { encoding: "utf8", maxBuffer: 64 << 20 }), root, 4000);
/** What `find` says: the newest modification time of anything at or under `p`, whole seconds, or null. */
const findNewest = (p) => {
  const out = execFileSync("sh", ["-c", `find "$1" -xdev -printf '%T@\\n' 2>/dev/null | sort -n | tail -1`, "find-newest", p], { encoding: "utf8" }).trim();
  return out === "" ? null : Math.trunc(Number(out));
};

// Times far apart, with fractions (only the whole seconds count).
const T = { dirs: 1_400_000_000.5, old: 1_500_000_000.25, small1: 1_550_000_000.9, small2: 1_560_000_000.1, link: 1_570_000_000, target: 1_690_000_000, hard: 1_600_000_000.6, deep: 1_650_000_000.99, locked: 1_680_000_000 };

/**
 * A tree whose dates say where the newest thing is. Every folder is given an old time after everything was
 * created (creating an entry would make its folder newest), so each folder's date comes from what is inside.
 */
function datedTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scan-dates-"));
  const p = (...x) => path.join(root, ...x);
  const put = (f, bytes, time) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.alloc(bytes, "d"));
    fs.utimesSync(f, time, time);
  };
  put(p("a/b/c/deep/newest.txt"), 10, T.deep); // deep below the depth limit: decides a, a/b, ... and the root
  put(p("a/old.bin"), 2 * MiB, T.old); // a big file: its own row, its own date
  put(p("s/x1"), 100, T.small1); // small files: summed into their folder, the newest counts
  put(p("s/x2"), 100, T.small2);
  put(p("h1/f"), 300_000, T.hard); // hard-linked into a second folder: the same time in both
  fs.mkdirSync(p("h2"));
  fs.linkSync(p("h1/f"), p("h2/f"));
  // A symlink's own time counts, not its target's (the target, much newer, is outside the tree).
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "scan-dates-target-"));
  put(path.join(outside, "file"), 10, T.target);
  fs.mkdirSync(p("ls"));
  fs.symlinkSync(path.join(outside, "file"), p("ls/link"));
  fs.lutimesSync(p("ls/link"), T.link, T.link);
  put(p("u/locked/secret"), 10, T.locked + 1000); // unreadable: nobody can see inside, find neither
  for (const d of ["a/b/c/deep", "a/b/c", "a/b", "a", "s", "h1", "h2", "ls", "u/locked", "u", "."]) fs.utimesSync(p(d), T.dirs, T.dirs);
  fs.utimesSync(p("u/locked"), T.locked, T.locked);
  fs.chmodSync(p("u/locked"), 0o000);
  return {
    root,
    p,
    cleanup: () => {
      fs.chmodSync(p("u/locked"), 0o700);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    },
  };
}

const sec = (t) => Math.trunc(t);

test("each folder's date is the newest time of anything inside it, exactly what find says, at every depth", { skip: !hasPerl && "needs perl" }, () => {
  const t = datedTree();
  try {
    for (const depth of [1, 2, 3, 4]) {
      const r = scan(t.root, depth);
      assert.equal(r.mode, "parallel");
      assert.equal(r.dated, true);
      const by = new Map(r.rows.map((x) => [x.path, x]));
      // Every row, against find run on that row.
      for (const row of r.rows) assert.equal(row.modifiedAt ?? null, findNewest(row.path), `depth ${depth}: ${row.path}`);
      // And what that means.
      assert.equal(by.get(t.root).modifiedAt, isRoot ? sec(T.locked + 1000) : sec(T.locked), `depth ${depth}: the newest thing is the unreadable folder's own time`);
      assert.equal(by.get(t.p("a")).modifiedAt, sec(T.deep), `depth ${depth}: a deep file decides its ancestors`);
      if (depth >= 2) assert.equal(by.get(t.p("a/b")).modifiedAt, sec(T.deep));
      if (depth >= 2) assert.equal(by.get(t.p("a/old.bin")).modifiedAt, sec(T.old), "a big file has its own time");
      assert.equal(by.get(t.p("s")).modifiedAt, sec(T.small2), `depth ${depth}: the newest small file counts`);
      assert.equal(by.get(t.p("h1")).modifiedAt, sec(T.hard));
      assert.equal(by.get(t.p("h2")).modifiedAt, sec(T.hard), "a hard link carries the file's time");
      assert.equal(by.get(t.p("ls")).modifiedAt, sec(T.link), `depth ${depth}: a symlink's own time, not its target's`);
      if (!isRoot) assert.equal(by.get(t.p("u")).modifiedAt, sec(T.locked), "what could be read: the unreadable folder's own time");
    }
  } finally {
    t.cleanup();
  }
});

test("the one-at-a-time scan records no dates, and says so", () => {
  const t = datedTree();
  try {
    const r = scan(t.root, 3, 1);
    assert.equal(r.mode, "serial");
    assert.equal(r.dated, false);
    assert.ok(r.rows.length > 3);
    assert.ok(r.rows.every((x) => !("modifiedAt" in x)));
  } finally {
    t.cleanup();
  }
});

test("the scan program does its date work in the existing passes and keeps its records apart", () => {
  const body = buildProgram("scan", { args: ["/x", 3, 60, 10, 4] });
  const script = Buffer.from(/BODY=\$\(dec '([^']+)'\)/.exec(body)[1], "base64").toString("utf8");
  // The newest time per folder comes from the walk that already looks for hard links: no extra walk, no sort.
  assert.equal((script.match(/find "\$@"/g) ?? []).length, 1, "one walk per worker");
  assert.match(script, /-xdev \\\( -type f -links \+1 -fprintf "\$o\.l" [^\n]+, -printf "%T@\\t%H\\0"/);
  assert.match(script, /\| perl "\$W\/newest\.pl" > "\$o\.n"/, "each worker writes its own file");
  assert.match(script, /-printf '%d\\t%y\\t%D\\t%i\\t%n\\t%b\\t%T@\\t%p\\0'/);
});

// ─── Reading the records ───

const answer = (records, trailer = ["@@MODE=parallel", "@@HARDLINKS=exact", "@@RC=0", "@@UNREADABLE=0"]) => "RESULT=ok\n" + [...records, ...trailer, ""].join("\0");

test("dated records are read, including a path with a tab in it, an unknown time and old-format records", () => {
  const r = parseScanOutput(answer([
    "A\td\t4096\t100\t/r",
    "A\td\t4096\t200\t/r/a",
    "A\tf\t3000000\t300\t/r/a/x\ty.bin", // a tab in the name
    "A\td\t4096\t-\t/r/odd", // a time the unit could not read
    "A\tf\t2000000\t/r/old.bin", // a record from before dates: no time field
    "S\t900\t250\t/r/a", // small files in /r/a, the newest at 250
    "S\t50\t/r", // old-format small files
    "T\t7000\t/r/a/unit",
    "N\t500\t/r/a/unit",
    "N\t999\t/elsewhere", // outside the folder: ignored
    "A\tf\t9\tnope\t/r/bad", // a damaged time: the record is dropped
  ]), "/r");
  assert.equal(r.dated, true);
  const by = new Map(r.rows.map((x) => [x.path, x]));
  assert.equal(by.get("/r/a/x\ty.bin").bytes, 3_000_000);
  assert.equal(by.get("/r/a/x\ty.bin").modifiedAt, 300);
  assert.equal(by.get("/r/a/unit").modifiedAt, 500);
  assert.equal(by.get("/r/a").modifiedAt, 500, "the newest of its own time, its files, its small files and the folder below");
  assert.equal(by.get("/r").modifiedAt, 500);
  assert.equal(by.get("/r/odd").modifiedAt, undefined, "unknown stays unknown");
  assert.equal(by.get("/r/old.bin").modifiedAt, undefined);
  assert.equal(by.get("/r/old.bin").bytes, 2_000_000, "an old-format record still counts");
  assert.equal(by.get("/r").bytes, 4096 + 4096 + 3_000_000 + 4096 + 2_000_000 + 900 + 50 + 7000);
  assert.ok(!by.has("/r/bad") && !by.has("/elsewhere"));
});

test("output from before dates were added still parses, with no dates anywhere", () => {
  const r = parseScanOutput(answer(["A\td\t4096\t/data", "A\tf\t3000000\t/data/a\tb.bin", "T\t7000\t/data/sub", "S\t900\t/data"]), "/data");
  assert.equal(r.dated, false);
  const by = new Map(r.rows.map((x) => [x.path, x]));
  assert.equal(by.get("/data").bytes, 4096 + 3_000_000 + 7000 + 900);
  assert.equal(by.get("/data/a\tb.bin").bytes, 3_000_000);
  assert.ok(r.rows.every((x) => !("modifiedAt" in x)));
});

test("a folder measured whole whose newest time did not come back leaves it and every folder above it undated", () => {
  const r = parseScanOutput(answer([
    "A\td\t4096\t100\t/r", "A\td\t4096\t100\t/r/a", "A\td\t4096\t100\t/r/b",
    "T\t5000\t/r/a/u1", "N\t400\t/r/a/u1",
    "T\t5000\t/r/a/u2", // its worker's walk was cut short: no N
    "T\t5000\t/r/b/u3", "N\t300\t/r/b/u3",
  ]), "/r");
  const by = new Map(r.rows.map((x) => [x.path, x]));
  assert.equal(by.get("/r/a/u1").modifiedAt, 400);
  assert.equal(by.get("/r/a/u2").modifiedAt, undefined);
  assert.equal(by.get("/r/a").modifiedAt, undefined, "only a lower bound: not shown");
  assert.equal(by.get("/r").modifiedAt, undefined);
  assert.equal(by.get("/r/b").modifiedAt, 300, "a sibling that came back whole keeps its date");
});

test("a scan stopped by its time limit keeps file dates but no folder dates", () => {
  const r = parseScanOutput(answer(
    ["A\td\t4096\t100\t/r", "A\tf\t2000000\t150\t/r/f.bin", "T\t5000\t/r/u", "N\t400\t/r/u"],
    ["@@MODE=parallel", "@@HARDLINKS=exact", "@@RC=124", "@@UNREADABLE=0"],
  ), "/r");
  assert.equal(r.timedOut, true);
  const by = new Map(r.rows.map((x) => [x.path, x]));
  assert.equal(by.get("/r/f.bin").modifiedAt, 150);
  assert.equal(by.get("/r").modifiedAt, undefined);
  assert.equal(by.get("/r/u").modifiedAt, undefined);
});

test("totalsFromAtoms carries the newest time up every folder, like sizes", () => {
  const atoms = [
    { path: "/r", bytes: 4096, type: "dir" },
    { path: "/r/a", bytes: 4096, type: "dir" },
    { path: "/r/a/b", bytes: 1000, type: "dir" },
    { path: "/r/z", bytes: 2000, type: "dir" },
  ];
  const stamps = [
    { path: "/r", mtime: 10 }, { path: "/r/a", mtime: 20 }, { path: "/r/a/b", mtime: 90 }, { path: "/r/a", mtime: 50 }, { path: "/r/z", mtime: 70 },
  ];
  const by = new Map(totalsFromAtoms(atoms, "/r", 100, null, { stamps }).map((x) => [x.path, x]));
  assert.deepEqual([by.get("/r").modifiedAt, by.get("/r/a").modifiedAt, by.get("/r/a/b").modifiedAt, by.get("/r/z").modifiedAt], [90, 90, 90, 70]);
  // Without dates nothing gets one.
  assert.ok(totalsFromAtoms(atoms, "/r", 100).every((x) => !("modifiedAt" in x)));
});

// ─── The dashboard side: kept, saved, merged ───

const spark = { id: "s1", name: "Spark One", kind: "spark", platform: "linux", ssh: { user: "me", host: "10.0.0.5" } };
const FIRST = answer([
  "A\td\t4096\t100\t/r", "A\td\t4096\t100\t/r/a", "A\td\t4096\t100\t/r/b",
  "T\t5000\t/r/a/u", "N\t400\t/r/a/u", "T\t5000\t/r/b/v", "N\t300\t/r/b/v",
]);

function manager(answers, scansFile = null) {
  let n = 0;
  return new StorageManager({ run: async () => answers[Math.min(n++, answers.length - 1)], holdMs: 0, scansFile });
}
const entries = (m) => new Map(m.snapshot(spark).session.entries.map((e) => [e.path, e]));

test("dates reach the page, are saved, and an analysis saved before them loads without any", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scans-dates-"));
  const scansFile = path.join(dir, "scans.json");
  try {
    const m = manager([FIRST], scansFile);
    m.startScan(spark, { path: "/r", depth: 2 });
    await m.settled("s1");
    assert.equal(m.snapshot(spark).session.dated, true);
    assert.equal(entries(m).get("/r").modifiedAt, 400);
    assert.equal(entries(m).get("/r/b/v").modifiedAt, 300);
    // A restart keeps them.
    const again = manager(["RESULT=ok\n"], scansFile);
    assert.equal(again.snapshot(spark).session.dated, true);
    assert.equal(entries(again).get("/r/a").modifiedAt, 400);
    // A file written before dates existed (no `dated`, no `modifiedAt`), and hand-edited rubbish: no dates.
    fs.writeFileSync(scansFile, JSON.stringify({
      version: 1, revision: 3,
      sessions: { s1: { revision: 3, root: "/r", scannedAt: 1, analysedAt: 1, elevated: false, unreadable: 0, timedOut: false, hardlinks: "exact", entries: [
        { path: "/r", bytes: 10, type: "dir", expanded: true },
        { path: "/r/a", bytes: 5, type: "dir", expanded: false, modifiedAt: -5 },
        { path: "/r/b", bytes: 5, type: "dir", expanded: false, modifiedAt: "1700000000" },
        { path: "/r/c", bytes: 5, type: "dir", expanded: false, modifiedAt: 1.5 },
        { path: "/r/d", bytes: 5, type: "dir", expanded: false, modifiedAt: 1_700_000_000 },
      ] } },
    }));
    const old = manager(["RESULT=ok\n"], scansFile);
    assert.equal(old.snapshot(spark).session.dated, false);
    const e = entries(old);
    assert.deepEqual(["/r", "/r/a", "/r/b", "/r/c"].map((p) => e.get(p).modifiedAt), [undefined, undefined, undefined, undefined]);
    assert.equal(e.get("/r/d").modifiedAt, 1_700_000_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("looking inside a folder: its parents' dates only move forward, and a delete leaves them", async () => {
  const newer = answer(["A\td\t4096\t100\t/r/a/u", "A\tf\t2000000\t900\t/r/a/u/new.bin"]);
  const older = answer(["A\td\t4096\t100\t/r/b/v", "A\tf\t2000000\t200\t/r/b/v/kept.bin"]);
  const m = manager([FIRST, newer, older, "RESULT=ok\n"]);
  m.startScan(spark, { path: "/r", depth: 2 });
  await m.settled("s1");
  m.startScan(spark, { path: "/r/a/u", depth: 2, mode: "drill" });
  await m.settled("s1");
  let e = entries(m);
  assert.equal(e.get("/r/a/u").modifiedAt, 900, "the folder looked inside has its new date");
  assert.equal(e.get("/r/a").modifiedAt, 900, "something in it is newer: its parents are too");
  assert.equal(e.get("/r").modifiedAt, 900);
  m.startScan(spark, { path: "/r/b/v", depth: 2, mode: "drill" });
  await m.settled("s1");
  e = entries(m);
  assert.equal(e.get("/r/b/v").modifiedAt, 200, "the folder itself: exactly what was measured now");
  assert.equal(e.get("/r/b").modifiedAt, 300, "older than before: the parent keeps its date, it is never lowered without measuring");
  assert.equal(m.snapshot(spark).session.dated, true);
  await m.delete(spark, { path: "/r/a/u/new.bin" });
  e = entries(m);
  assert.equal(e.has("/r/a/u/new.bin"), false);
  assert.equal(e.get("/r/a/u").modifiedAt, 900, "a delete does not work dates out again");
});

test("a parent without a date does not get one from a folder looked into later", async () => {
  const serial = "RESULT=ok\n" + ["10000\td\t/r", "5000\td\t/r/a", "5000\td\t/r/b", "@@MODE=serial", "@@RC=0", "@@UNREADABLE=0", ""].join("\0");
  const m = manager([serial, answer(["A\td\t4096\t100\t/r/a", "A\tf\t2000000\t900\t/r/a/f.bin"])]);
  m.startScan(spark, { path: "/r", depth: 1 });
  await m.settled("s1");
  assert.equal(m.snapshot(spark).session.dated, false);
  m.startScan(spark, { path: "/r/a", depth: 1, mode: "drill" });
  await m.settled("s1");
  const e = entries(m);
  assert.equal(e.get("/r/a").modifiedAt, 900);
  assert.equal(e.get("/r").modifiedAt, undefined, "it would only be a lower bound");
  assert.equal(m.snapshot(spark).session.dated, false, "the analysis as a whole still has no dates");
});
