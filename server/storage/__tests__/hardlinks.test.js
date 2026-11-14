import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProgram, parseScanOutput } from "../commands.js";
import { StorageManager } from "../StorageManager.js";

const hasPerl = (() => { try { execFileSync("perl", ["-e", "1"]); return true; } catch { return false; } })();
const skip = !hasPerl && "needs perl";
const MiB = 1024 * 1024;

const tree = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hardlinks-"));
  return { root, p: (...x) => path.join(root, ...x), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
};
const file = (f, bytes, fill = "a") => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.alloc(bytes, fill)); };
const scan = (root, depth = 3, par = 4) => {
  const out = execFileSync("sh", ["-c", buildProgram("scan", { args: [root, depth, 60, 4000, par] })], { encoding: "utf8", maxBuffer: 64 << 20 });
  const r = parseScanOutput(out, root, 4000);
  const by = new Map(r.rows.map((x) => [x.path, x]));
  return { r, by, row: (...x) => by.get(path.join(root, ...x)) };
};
const du = (p) => Number(spawnSync("du", ["-sB1", "-x", p], { encoding: "utf8" }).stdout.split("\t")[0]);
const frees = (x) => x.bytes - x.sharedBytes;

test("a file hard-linked into a second folder is counted once, shown as shared in each, and frees nothing", { skip }, () => {
  const t = tree();
  try {
    file(t.p("one/big.bin"), 64 * MiB);
    fs.mkdirSync(t.p("two"));
    fs.linkSync(t.p("one/big.bin"), t.p("two/big.bin"));
    const { r, row } = scan(t.root);
    assert.equal(r.mode, "parallel");
    assert.equal(r.hardlinks, "exact");
    const total = du(t.root);
    // The top-level total matches `du -s` of the same folder (well inside 1%), not 2x the file.
    assert.ok(Math.abs(row().bytes - total) / total < 0.001, `${row().bytes} vs du ${total}`);
    assert.ok(row().bytes < 70 * MiB, "one copy, not two");
    // Each folder shows the file as shared, and deleting it frees nothing.
    for (const d of ["one", "two"]) {
      assert.ok(row(d).bytes >= 64 * MiB);
      assert.equal(row(d).sharedBytes, 64 * MiB, `${d} is all shared`);
      assert.ok(frees(row(d)) < 0.1 * MiB, `${d} frees about nothing`);
    }
    assert.equal(row().sharedBytes, 0, "nothing is shared with anything outside the scanned folder");

    // Delete one link: the other folder now owns the data outright, and deleting it frees all of it.
    fs.rmSync(t.p("one/big.bin"));
    const after = scan(t.root);
    assert.equal(after.row("two").sharedBytes, 0);
    assert.ok(frees(after.row("two")) >= 64 * MiB);
    assert.ok(Math.abs(after.row().bytes - du(t.root)) / du(t.root) < 0.001);
  } finally {
    t.cleanup();
  }
});

test("the layout from the bug report: a folder made only of links to another folder's files", { skip }, () => {
  const t = tree();
  try {
    for (const [n, mib] of [["a", 30], ["b", 20], ["c", 5]]) file(t.p("hub/blobs", n), mib * MiB, n);
    for (const n of ["a", "b"]) { fs.mkdirSync(t.p("native"), { recursive: true }); fs.linkSync(t.p("hub/blobs", n), t.p("native", n)); }
    file(t.p("other/own"), 15 * MiB, "z");
    const { row } = scan(t.root);
    const total = du(t.root);
    assert.ok(Math.abs(row().bytes - total) / total < 0.01, "top-level total matches du -s within 1%");
    assert.ok(row("hub").bytes + row("native").bytes + row("other").bytes > row().bytes, "the folders overlap, so they add up to more than the whole");
    assert.equal(row("native").sharedBytes, row("native").bytes - (row("native").bytes - 50 * MiB), "native is entirely shared");
    assert.ok(frees(row("native")) < 0.1 * MiB, "deleting native frees about nothing");
    assert.equal(row("hub").sharedBytes, 50 * MiB);
    assert.ok(Math.abs(frees(row("hub")) - 5 * MiB) < 0.2 * MiB, "deleting hub frees only the file nothing else links to");
    assert.equal(row("other").sharedBytes, 0);
    assert.ok(frees(row("other")) >= 15 * MiB);
  } finally {
    t.cleanup();
  }
});

test("links all inside one folder are not shared, and are counted once", { skip }, () => {
  const t = tree();
  try {
    file(t.p("pkg/store/x.bin"), 16 * MiB);
    fs.mkdirSync(t.p("pkg/app"), { recursive: true });
    fs.linkSync(t.p("pkg/store/x.bin"), t.p("pkg/app/x.bin"));
    fs.linkSync(t.p("pkg/store/x.bin"), t.p("pkg/app/y.bin"));
    const { row } = scan(t.root);
    assert.ok(Math.abs(row("pkg").bytes - du(t.p("pkg"))) / du(t.p("pkg")) < 0.001);
    assert.equal(row("pkg").sharedBytes, 0, "every link is inside pkg");
    assert.ok(frees(row("pkg")) >= 16 * MiB);
    // Its two halves each hold only some of the links.
    assert.equal(row("pkg/store").sharedBytes, 16 * MiB);
    assert.equal(row("pkg/app").sharedBytes, 16 * MiB);
  } finally {
    t.cleanup();
  }
});

test("three links: deleting two folders frees nothing until the last link goes", { skip }, () => {
  const t = tree();
  try {
    file(t.p("a/f"), 12 * MiB);
    for (const d of ["b", "c"]) { fs.mkdirSync(t.p(d)); fs.linkSync(t.p("a/f"), t.p(d, "f")); }
    let s = scan(t.root);
    for (const d of ["a", "b", "c"]) assert.equal(s.row(d).sharedBytes, 12 * MiB);
    fs.rmSync(t.p("a/f"));
    s = scan(t.root);
    assert.equal(s.row("b").sharedBytes, 12 * MiB, "b still shares with c");
    fs.rmSync(t.p("b/f"));
    s = scan(t.root);
    assert.equal(s.row("c").sharedBytes, 0);
    assert.ok(frees(s.row("c")) >= 12 * MiB);
  } finally {
    t.cleanup();
  }
});

test("links deeper than the depth limit, and small linked files, are still accounted for", { skip }, () => {
  const t = tree();
  try {
    // Deep links (beyond depth 2) and many small hard-linked files (under 1 MiB, which are summed, not listed).
    file(t.p("left/a/b/c/d/big"), 10 * MiB);
    fs.mkdirSync(t.p("right/x/y/z"), { recursive: true });
    fs.linkSync(t.p("left/a/b/c/d/big"), t.p("right/x/y/z/big"));
    for (let i = 0; i < 40; i++) {
      file(t.p("left/small", `s${i}`), 200_000, "s");
      fs.mkdirSync(t.p("right/small"), { recursive: true });
      fs.linkSync(t.p("left/small", `s${i}`), t.p("right/small", `s${i}`));
    }
    const { row } = scan(t.root, 2);
    for (const d of ["left", "right"]) {
      const ref = du(t.p(d));
      assert.ok(Math.abs(row(d).bytes - ref) / ref < 0.001, `${d}: ${row(d).bytes} vs du ${ref}`);
      assert.ok(row(d).sharedBytes >= 10 * MiB + 40 * 200_000 * 0.9, `${d} shares the big file and the small ones`);
      assert.ok(frees(row(d)) < 0.5 * MiB);
    }
    assert.ok(Math.abs(row().bytes - du(t.root)) / du(t.root) < 0.001);
  } finally {
    t.cleanup();
  }
});

test("sparse files are measured by what they occupy on disk", { skip }, () => {
  const t = tree();
  try {
    fs.mkdirSync(t.p("s"));
    fs.closeSync(fs.openSync(t.p("s/sparse"), "w"));
    fs.truncateSync(t.p("s/sparse"), 2 * 1024 * MiB); // 2 GiB apparent, almost nothing allocated
    file(t.p("s/real"), 4 * MiB);
    const { row } = scan(t.root);
    assert.ok(row("s").bytes < 10 * MiB, `allocated size, not the 2 GiB the file claims: ${row("s").bytes}`);
    assert.ok(Math.abs(row().bytes - du(t.root)) / du(t.root) < 0.01);
  } finally {
    t.cleanup();
  }
});

test("many folders measured at once never garble each other's records", { skip }, () => {
  const t = tree();
  try {
    // Hundreds of units, each with a hard-linked file pair, so many workers write at the same time.
    for (let i = 0; i < 300; i++) {
      file(t.p(`g${i % 6}/h${i}/data`), 150_000 + i, "q");
      fs.mkdirSync(t.p(`links/l${i}`), { recursive: true });
      fs.linkSync(t.p(`g${i % 6}/h${i}/data`), t.p(`links/l${i}/data`));
    }
    const { r, row } = scan(t.root, 2, 8);
    assert.equal(r.mode, "parallel");
    assert.equal(r.hardlinks, "exact");
    const total = du(t.root);
    assert.ok(Math.abs(row().bytes - total) / total < 0.001, `${row().bytes} vs du ${total}`);
    for (let g = 0; g < 6; g++) assert.ok(Math.abs(row(`g${g}`).bytes - du(t.p(`g${g}`))) / du(t.p(`g${g}`)) < 0.001);
  } finally {
    t.cleanup();
  }
});

test("the plain one-at-a-time scan says its sizes are approximate", () => {
  const t = tree();
  try {
    file(t.p("a/f"), 4 * MiB);
    const r = parseScanOutput(execFileSync("sh", ["-c", buildProgram("scan", { args: [t.root, 3, 60, 100, 1] })], { encoding: "utf8" }), t.root);
    assert.equal(r.mode, "serial");
    assert.equal(r.hardlinks, "approx");
    assert.ok(r.rows.every((x) => x.sharedBytes === 0));
  } finally {
    t.cleanup();
  }
});

test("hard-link records are read back, including an empty 'shared' field", () => {
  const out = "RESULT=ok\n" + [
    "A\td\t4096\t/r", "A\td\t4096\t/r/one", "A\td\t4096\t/r/two", "A\tf\t8000000\t/r/one/big", "A\tf\t8000000\t/r/two/big",
    "X\t/r/one/big", "X\t/r/two/big",
    // Only the hard-linked file's bytes: per link, once, and shared with the outside (an empty field means none).
    "M\t16000000\t8000000\t\t/r",
    "M\t8000000\t8000000\t8000000\t/r/one", "M\t8000000\t8000000\t8000000\t/r/two",
    "@@MODE=parallel", "@@HARDLINKS=exact", "@@RC=0", "@@UNREADABLE=0", "",
  ].join("\0");
  const r = parseScanOutput(out, "/r");
  assert.equal(r.hardlinks, "exact");
  const by = new Map(r.rows.map((x) => [x.path, x]));
  assert.equal(by.get("/r").bytes, 8_000_000 + 3 * 4096, "the file once, plus the three directories");
  assert.equal(by.get("/r").sharedBytes, 0);
  assert.equal(by.get("/r/one").sharedBytes, 8_000_000);
  assert.equal(by.get("/r/one/big").sharedBytes, 8_000_000, "a big file with other links is shared in full");
  // If the hard-link step failed the sizes are reported as approximate and left as counted per link.
  const bad = parseScanOutput(out.replace("@@HARDLINKS=exact", "@@HARDLINKS=failed"), "/r");
  assert.equal(bad.hardlinks, "approx");
  assert.equal(new Map(bad.rows.map((x) => [x.path, x])).get("/r").bytes, 16_000_000 + 3 * 4096, "left as counted per link");
});

// ─── The dashboard side: shared bytes in the result, on disk, and after a delete ───

const spark = { id: "s1", name: "Spark One", kind: "spark", platform: "linux", ssh: { user: "me", host: "10.0.0.5" } };
const answer = (records) => "RESULT=ok\n" + [...records, "@@MODE=parallel", "@@HARDLINKS=exact", "@@RC=0", "@@UNREADABLE=0", ""].join("\0");
const ANSWER = answer([
  "A\td\t4096\t/r", "A\td\t4096\t/r/hub", "A\td\t4096\t/r/native", "A\tf\t90000000\t/r/hub/b1", "A\tf\t90000000\t/r/native/b1", "A\tf\t10000000\t/r/hub/only",
  "X\t/r/hub/b1", "X\t/r/native/b1",
  "M\t180000000\t90000000\t\t/r", "M\t90000000\t90000000\t90000000\t/r/hub", "M\t90000000\t90000000\t90000000\t/r/native",
]);

test("the result keeps shared bytes per entry, saves them, and a delete subtracts only what was freed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scans-hl-"));
  const scansFile = path.join(dir, "scans.json");
  try {
    let n = 0;
    const m = new StorageManager({ run: async () => (n++ === 0 ? ANSWER : "RESULT=ok\n"), holdMs: 0, scansFile });
    m.startScan(spark, { path: "/r", depth: 2 });
    await m.settled("s1");
    let { session } = m.snapshot(spark);
    assert.equal(session.hardlinks, "exact");
    const by = () => new Map(m.snapshot(spark).session.entries.map((e) => [e.path, e]));
    assert.equal(by().get("/r/native").sharedBytes, 90_000_000);
    assert.equal(by().get("/r/hub").sharedBytes, 90_000_000);
    assert.equal(by().get("/r").sharedBytes, undefined, "none shared at the top: the field is left out");

    // A restart keeps them.
    const again = new StorageManager({ run: async () => "RESULT=ok\n", holdMs: 0, scansFile }).snapshot(spark).session;
    assert.equal(new Map(again.entries.map((e) => [e.path, e])).get("/r/native").sharedBytes, 90_000_000);
    assert.equal(again.hardlinks, "exact");

    // Deleting `native` frees only its own 4 KB directory entry (its 90 MB of files are shared), so the folder
    // above shrinks by that and not by the 90 MB.
    const before = by().get("/r").bytes;
    await m.delete(spark, { path: "/r/native" });
    assert.equal(by().get("/r").bytes, before - 4096);
    assert.equal(by().has("/r/native"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
