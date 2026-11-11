import { test } from "node:test";
import { strict as assert } from "node:assert";
import { StorageManager, assertSupported, parseElevation } from "../StorageManager.js";

const spark = { id: "s1", name: "Spark One", kind: "spark", platform: "linux", ssh: { user: "me", host: "10.0.0.5" } };

/** The NUL-separated answer a scan program gives. */
const scanAnswer = (rows, { unreadable = 0, rc = 0 } = {}) =>
  ["RESULT=ok\n" + rows.map(([b, t, p]) => `${b}\t${t}\t${p}`).join("\0"), `@@RC=${rc}`, `@@UNREADABLE=${unreadable}`, ""].join("\0");

const ROOT_ROWS = [
  [1000, "d", "/"], [600, "d", "/home"], [500, "d", "/home/me"], [300, "d", "/home/me/models"], [250, "f", "/home/me/big.bin"],
  [300, "d", "/var"], [200, "d", "/var/lib"], [50, "d", "/etc"],
];

function make({ run, ...opts } = {}) {
  const calls = [];
  const m = new StorageManager({
    run: async (s, program, o) => {
      calls.push({ program, ...o });
      return run ? run(s, program, o, calls.length) : scanAnswer(ROOT_ROWS);
    },
    holdMs: 0,
    ...opts,
  });
  return { m, calls };
}

test("only Spark units are supported", () => {
  assert.doesNotThrow(() => assertSupported(spark));
  assert.throws(() => assertSupported({ id: "h", kind: "host" }), (e) => e.status === 400 && /DGX Spark/.test(e.message));
  assert.throws(() => assertSupported({ id: "m", kind: "spark", platform: "darwin" }), (e) => e.status === 400);
  assert.throws(() => assertSupported(undefined), (e) => e.status === 404);
});

test("parseElevation: a password needs sudo: true", () => {
  assert.deepEqual(parseElevation({}), { elevate: false, password: null, remember: false });
  assert.deepEqual(parseElevation({ sudo: true, sudoPassword: "pw" }), { elevate: true, password: "pw", remember: false });
  assert.deepEqual(parseElevation({ sudo: true, sudoPassword: "pw", remember: true }), { elevate: true, password: "pw", remember: true });
  // Nothing to remember without a typed password.
  assert.deepEqual(parseElevation({ sudo: true, remember: true }), { elevate: true, password: null, remember: false });
  assert.throws(() => parseElevation({ sudo: true, sudoPassword: "pw", remember: "yes" }), (e) => e.status === 400);
  assert.throws(() => parseElevation({ sudoPassword: "pw" }), (e) => e.status === 400);
  assert.throws(() => parseElevation({ sudo: "yes" }), (e) => e.status === 400);
});

test("a scan runs in the background and its result is kept for the page", async () => {
  const { m, calls } = make();
  const job = m.startScan(spark, { path: "/", depth: 3 });
  assert.equal(job.state, "running");
  assert.equal(m.snapshot(spark).job.state, "running");
  assert.equal(m.snapshot(spark).session, null);
  await m.settled("s1");

  const snap = m.snapshot(spark);
  assert.equal(snap.job.state, "done");
  assert.equal(snap.session.root, "/");
  assert.equal(snap.session.elevated, false);
  assert.equal(snap.session.entries.length, ROOT_ROWS.length);
  const sizes = snap.session.entries.map((e) => e.bytes);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a), "biggest first");
  const home = snap.session.entries.find((e) => e.path === "/home");
  assert.equal(home.expanded, true, "inside the scanned depth, so its children are known");
  const models = snap.session.entries.find((e) => e.path === "/home/me/models");
  assert.equal(models.expanded, false, "at the depth limit, so its children are not known");
  assert.match(snap.session.entries.find((e) => e.path === "/etc").locked, /system/i);
  assert.equal(snap.session.entries.find((e) => e.path === "/home/me/models").locked, null);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].program.includes("/home"), "the path travels encoded, not as script text");

  // Unchanged since the page's last copy: no need to send it again.
  assert.equal(m.snapshot(spark, snap.revision).session, null);
  assert.equal(m.snapshot(spark, snap.revision - 1).session.entries.length, 8);
});

test("only one scan per unit at a time; a stopped scan's late answer is ignored", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { m } = make({
    run: async (_s, _p, o) => {
      if (o.name === "job") return "RESULT=ok\nOUTCOME=terminated\nREASON=term\nLOCK=free\n";
      await gate;
      return scanAnswer(ROOT_ROWS);
    },
  });
  m.startScan(spark, {});
  assert.throws(() => m.startScan(spark, {}), (e) => e.status === 409 && e.code === "scan-running");
  // Stopping is a request to the unit: the Spark stays busy until the unit confirms.
  assert.equal(m.cancelScan(spark).state, "stopping");
  release();
  await m.settled("s1");
  assert.equal(m.snapshot(spark).job.state, "cancelled");
  assert.equal(m.snapshot(spark).job.holdsSpark, false);
  assert.equal(m.snapshot(spark).session, null, "a stopped scan leaves nothing behind");
  // A new scan can start right away.
  const again = m.startScan(spark, {});
  assert.equal(again.state, "running");
  await m.settled("s1");
});

test("drilling into a folder swaps that folder's rows in and keeps the rest", async () => {
  const answers = [
    scanAnswer(ROOT_ROWS),
    scanAnswer([[320, "d", "/home/me/models"], [200, "d", "/home/me/models/llama"], [100, "f", "/home/me/models/x.gguf"]]),
  ];
  const { m } = make({ run: async (_s, _p, _o, n) => answers[n - 1] });
  m.startScan(spark, { path: "/", depth: 2 });
  await m.settled("s1");
  m.startScan(spark, { path: "/home/me/models", depth: 2, mode: "drill" });
  await m.settled("s1");

  const { session } = m.snapshot(spark);
  const by = new Map(session.entries.map((e) => [e.path, e]));
  assert.equal(session.root, "/", "the first scan stays the root of the page");
  assert.equal(by.get("/home/me/models/llama").bytes, 200);
  assert.equal(by.get("/home/me/models").expanded, true);
  assert.equal(by.get("/home/me/models").bytes, 320);
  assert.equal(by.get("/home/me").bytes, 520, "parents follow the folder's new size");
  assert.equal(by.get("/home").bytes, 620);
  assert.equal(by.get("/").bytes, 1020);
  assert.ok(by.has("/var/lib"), "the rest is kept");
});

test("a failed scan reports why and keeps the earlier result", async () => {
  const answers = [scanAnswer(ROOT_ROWS), "RESULT=error\nCODE=no-sudo\nMSG=This needs administrator rights, and sudo on this Spark asks for a password\n"];
  const { m } = make({ run: async (_s, _p, _o, n) => answers[n - 1] });
  m.startScan(spark, {});
  await m.settled("s1");
  m.startScan(spark, { sudo: true });
  await m.settled("s1");
  const snap = m.snapshot(spark);
  assert.equal(snap.job.state, "error");
  assert.equal(snap.job.error.code, "no-sudo");
  assert.equal(snap.session.entries.length, 8);
});

test("an unreachable unit is a clear error and does not leak the password", async () => {
  const { m } = make({ run: async () => { throw new Error("ssh: connect to host 10.0.0.5 port 22: Connection refused (pw hunter22)"); } });
  m.startScan(spark, { sudo: true, sudoPassword: "hunter22" });
  await m.settled("s1");
  const { job } = m.snapshot(spark);
  assert.equal(job.state, "error");
  assert.equal(job.error.code, "unreachable");
  assert.ok(!JSON.stringify(job).includes("hunter22"));
});

test("a scan that times out on the unit still shows what it found, flagged", async () => {
  const { m } = make({ run: async () => scanAnswer(ROOT_ROWS, { rc: 124, unreadable: 3 }) });
  m.startScan(spark, {});
  await m.settled("s1");
  const { session } = m.snapshot(spark);
  assert.equal(session.timedOut, true);
  assert.equal(session.unreadable, 3);
});

test("scan requests are validated before anything runs", () => {
  const { m, calls } = make();
  for (const body of [{ path: "etc" }, { path: "/a/../b" }, { depth: 0 }, { sudoPassword: "x" }]) {
    assert.throws(() => m.startScan(spark, body), (e) => e.status === 400, JSON.stringify(body));
  }
  assert.equal(calls.length, 0);
});

test("delete refuses protected and malformed paths without contacting the unit", async () => {
  const { m, calls } = make();
  for (const path of ["/", "/home", "/etc/ssh", "/var/lib/docker/overlay2", "/home/me/.ssh", "relative", "/a/../etc", "/home/me/x\ny", undefined]) {
    await assert.rejects(m.delete(spark, { path }), (e) => e.status === 400 || e.status === 403, String(path));
  }
  assert.equal(calls.length, 0);
});

test("delete removes the item from the page's result and shrinks its parents", async () => {
  const { m, calls } = make({ run: async (_s, program) => (program.includes("sparkdash-storage") && calls.length > 1 ? "RESULT=ok\n" : scanAnswer(ROOT_ROWS)) });
  m.startScan(spark, {});
  await m.settled("s1");
  const before = m.snapshot(spark).revision;
  const out = await m.delete(spark, { path: "/home/me/models" });
  assert.deepEqual(out, { path: "/home/me/models" });
  const { session, revision } = m.snapshot(spark);
  assert.ok(revision > before);
  const by = new Map(session.entries.map((e) => [e.path, e]));
  assert.equal(by.has("/home/me/models"), false);
  assert.equal(by.get("/home/me").bytes, 200);
  assert.equal(by.get("/home").bytes, 300);
  assert.equal(by.get("/").bytes, 700);
});

test("delete is refused while a scan runs and while another change is in flight", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { m } = make({ run: async () => { await gate; return "RESULT=ok\n"; } });
  const first = m.delete(spark, { path: "/home/me/a" });
  await assert.rejects(m.delete(spark, { path: "/home/me/b" }), (e) => e.status === 409 && e.code === "busy");
  release();
  await first;

  const slow = make({ run: async () => { await gate; return scanAnswer(ROOT_ROWS); } });
  slow.m.startScan(spark, {});
  await assert.rejects(slow.m.delete(spark, { path: "/home/me/a" }), (e) => e.status === 409 && e.code === "scan-running");
  await slow.m.settled("s1");
});

test("delete maps the unit's answers to statuses the page can act on", async () => {
  const cases = [
    ["RESULT=error\nCODE=permission\nMSG=Permission denied\nREMAINS=1\n", 403, "permission", true],
    ["RESULT=error\nCODE=not-found\nMSG=That item is already gone from the Spark\n", 404, "not-found", false],
    ["RESULT=error\nCODE=symlinked-path\nMSG=link\n", 409, "symlinked-path", false],
    ["RESULT=error\nCODE=no-sudo\nMSG=needs sudo\n", 409, "no-sudo", false],
    ["RESULT=error\nCODE=bad-password\nMSG=nope\n", 403, "bad-password", false],
    ["garbage", 502, "bad-output", false],
  ];
  for (const [answer, status, code, partial] of cases) {
    const { m } = make({ run: async () => answer });
    await assert.rejects(m.delete(spark, { path: "/home/me/x" }), (e) => e.status === status && e.code === code && Boolean(e.partial) === partial, code);
  }
});

test("still refused as administrator is reported as a failure, not as a reason to ask for sudo again", async () => {
  const { m } = make({ run: async () => "RESULT=error\nCODE=permission\nMSG=Operation not permitted\nREMAINS=0\n" });
  await assert.rejects(m.delete(spark, { path: "/home/me/x", sudo: true }), (e) => e.code === "rm-failed" && /administrator/.test(e.message));
});

test("three wrong sudo passwords lock further attempts for a while", async () => {
  const { m, calls } = make({ run: async () => "RESULT=error\nCODE=bad-password\nMSG=The sudo password was not accepted\n" });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(m.delete(spark, { path: "/home/me/x", sudo: true, sudoPassword: `wrong${i}` }), (e) => e.code === "bad-password");
  }
  await assert.rejects(m.delete(spark, { path: "/home/me/x", sudo: true, sudoPassword: "wrong4" }), (e) => e.status === 429 && e.code === "password-locked");
  assert.equal(calls.length, 3);
  // A scan with a password is locked too, before a job exists.
  assert.throws(() => m.startScan(spark, { sudo: true, sudoPassword: "wrong5" }), (e) => e.status === 429);
});

test("the password goes to the runner as input and never into the program text", async () => {
  const seen = [];
  const { m } = make({ run: async (_s, program, o) => { seen.push({ program, input: o.input }); return "RESULT=ok\n"; } });
  await m.delete(spark, { path: "/home/me/x", sudo: true, sudoPassword: "s3cret-pw" });
  assert.equal(seen[0].input, "s3cret-pw");
  assert.ok(!seen[0].program.includes("s3cret-pw"));
  await m.delete(spark, { path: "/home/me/y", sudo: true });
  assert.equal(seen[1].input, null);
});

test("docker overview and image removal", async () => {
  const A = `sha256:${"a".repeat(64)}`;
  const answers = [
    `RESULT=ok\nROOT=/var/lib/docker\nDF=Images|1|0|1.5GB|1.5GB (100%)\nIMG=${A}|1500000000|2026-10-01T00:00:00Z|x:1\nIMAGES=ok\nCONTAINERS=ok\n`,
    `REMOVED=${A}\nRESULT=ok\n`,
  ];
  const { m, calls } = make({ run: async (_s, _p, _o, n) => answers[n - 1] });
  const overview = await m.docker(spark, {});
  assert.equal(overview.images[0].status, "unused");
  const out = await m.removeImages(spark, { ids: [A, A] });
  assert.deepEqual(out, { removed: [A], skipped: [], failed: [] });
  assert.equal(calls.length, 2);
  for (const ids of [[], "x", [A, "latest"], [`${A};ls`], Array.from({ length: 201 }, () => A)]) {
    await assert.rejects(m.removeImages(spark, { ids }), (e) => e.status === 400, JSON.stringify(ids).slice(0, 30));
  }
});

test("docker errors keep their reason", async () => {
  for (const [code, status] of [["docker-denied", 403], ["docker-down", 409], ["no-docker", 409]]) {
    const { m } = make({ run: async () => `RESULT=error\nCODE=${code}\nMSG=reason\n` });
    await assert.rejects(m.docker(spark, {}), (e) => e.status === status && e.code === code);
  }
});

test("status reports disks, sudo and docker", async () => {
  const { m } = make({ run: async () => "RESULT=ok\nUSER=me\nSUDO=no\nFS=/dev/nvme0n1p2 ext4 1000 400 600 40% /\nDOCKER=ok\nDOCKER_ROOT=/var/lib/docker\n" });
  const s = await m.status(spark);
  assert.equal(s.sudo, "no");
  assert.equal(s.user, "me");
  assert.equal(s.filesystems[0].availBytes, 600);
  assert.deepEqual(s.docker, { state: "ok", rootDir: "/var/lib/docker" });
});

test("removing containers validates IDs, passes them on and shares the busy lock", async () => {
  const C = "a".repeat(64);
  const seen = [];
  const { m } = make({ run: async (_s, program, o) => { seen.push(program); return `REMOVED=${C}\nRESULT=ok\n`; } });
  const out = await m.removeContainers(spark, { ids: [C, C], sudo: true });
  assert.deepEqual(out, { removed: [C], skipped: [], failed: [] });
  assert.equal(seen.length, 1);
  for (const ids of [[], "x", ["my-container"], [`${C};ls`], Array.from({ length: 201 }, () => C)]) {
    await assert.rejects(m.removeContainers(spark, { ids }), (e) => e.status === 400 && e.code === "bad-ids", JSON.stringify(ids).slice(0, 30));
  }
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = make({ run: async () => { await gate; return "RESULT=ok\n"; } });
  const first = slow.m.removeContainers(spark, { ids: [C] });
  await assert.rejects(slow.m.removeImages(spark, { ids: [`sha256:${C}`] }), (e) => e.code === "busy");
  release();
  await first;
});

test("the Docker listing can skip the slow disk-use totals", async () => {
  const seen = [];
  const { m } = make({ run: async (_s, program) => { seen.push(program); return "RESULT=ok\nROOT=/var/lib/docker\n"; } });
  await m.docker(spark, {});
  await m.docker(spark, { light: true });
  assert.notEqual(seen[0], seen[1], "the light listing is a different program (it carries the argument)");
});

// ─── Remembered sudo password ───────────────────────────────

import { SudoVault } from "../sudoVault.js";

const memVault = () => new SudoVault({ file: null, encrypt: (p) => `e:${p}`, decrypt: (b) => b.slice(2) });
const ACCOUNT = "me@10.0.0.5:22";

test("a typed password is remembered only when asked, and only once sudo accepted it", async () => {
  const vault = memVault();
  const { m } = make({ vault, run: async () => "RESULT=ok\n" });
  await m.delete(spark, { path: "/home/me/a", sudo: true, sudoPassword: "pw-1" });
  assert.equal(vault.has(ACCOUNT), false, "not asked to remember");
  await m.delete(spark, { path: "/home/me/b", sudo: true, sudoPassword: "pw-2", remember: true });
  assert.equal(vault.get(ACCOUNT), "pw-2");
});

test("a wrong or unusable password is never remembered", async () => {
  for (const code of ["bad-password", "no-sudo"]) {
    const vault = memVault();
    const { m } = make({ vault, run: async () => `RESULT=error\nCODE=${code}\nMSG=x\n` });
    await assert.rejects(m.delete(spark, { path: "/home/me/a", sudo: true, sudoPassword: "pw", remember: true }));
    assert.equal(vault.has(ACCOUNT), false, code);
  }
});

test("a remembered password is used when none is typed, and dropped once sudo stops accepting it", async () => {
  const vault = memVault();
  vault.set(ACCOUNT, "kept-pw");
  const inputs = [];
  let answer = "RESULT=ok\n";
  const { m } = make({ vault, run: async (_s, program, o) => { inputs.push({ input: o.input, program }); return answer; } });
  await m.delete(spark, { path: "/home/me/a", sudo: true });
  assert.equal(inputs[0].input, "kept-pw");
  assert.ok(!inputs[0].program.includes("kept-pw"));
  assert.equal(vault.has(ACCOUNT), true);

  answer = "RESULT=error\nCODE=bad-password\nMSG=The sudo password was not accepted\n";
  await assert.rejects(m.delete(spark, { path: "/home/me/b", sudo: true }), (e) => e.code === "bad-password");
  assert.equal(vault.has(ACCOUNT), false, "a stale remembered password is dropped, so the page asks again");
});

test("without sudo requested the remembered password is not used, and the status says whether one is remembered", async () => {
  const vault = memVault();
  vault.set(ACCOUNT, "kept-pw");
  const inputs = [];
  const { m } = make({ vault, run: async (_s, _p, o) => { inputs.push(o.input); return "RESULT=ok\nUSER=me\nSUDO=no\nDOCKER=ok\n"; } });
  await m.delete(spark, { path: "/home/me/a" });
  assert.equal(inputs[0], null);
  assert.equal((await m.status(spark)).sudoSaved, true);
  assert.deepEqual(m.forgetSudo(spark), { forgotten: true });
  assert.equal((await m.status(spark)).sudoSaved, false);
  assert.deepEqual(m.forgetSudo(spark), { forgotten: false });
});

// ─── The analysis stays until the next one ──────────────────

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("the latest analysis is kept on disk and found again after a restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scans-"));
  const scansFile = path.join(dir, "storage-scans.json");
  try {
    let t = 1_000;
    const first = make({ scansFile, now: () => t });
    first.m.startScan(spark, { path: "/", depth: 3 });
    await first.m.settled("s1");
    const before = first.m.snapshot(spark);
    assert.equal(before.session.analysedAt, 1_000);

    const second = make({ scansFile }); // a new process
    const after = second.m.snapshot(spark);
    assert.equal(after.job, null, "no job is running or remembered");
    assert.equal(after.session.root, "/");
    assert.equal(after.session.analysedAt, 1_000);
    assert.deepEqual(after.session.entries.map((e) => [e.path, e.bytes, e.expanded]), before.session.entries.map((e) => [e.path, e.bytes, e.expanded]));
    assert.ok(after.revision >= before.revision, "revisions keep counting up, so an open page notices the change");
    // A new analysis after the restart carries on from there.
    second.m.startScan(spark, { path: "/", depth: 3 });
    await second.m.settled("s1");
    assert.ok(second.m.snapshot(spark).revision > after.revision);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("looking inside a folder refreshes that folder but not the analysis date, and is kept too", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scans-"));
  const scansFile = path.join(dir, "storage-scans.json");
  try {
    let t = 1_000;
    const answers = [scanAnswer(ROOT_ROWS), scanAnswer([[320, "d", "/home/me/models"], [200, "d", "/home/me/models/llama"]])];
    const a = make({ scansFile, now: () => t, run: async (_s, _p, _o, n) => answers[n - 1] });
    a.m.startScan(spark, { path: "/", depth: 2 });
    await a.m.settled("s1");
    t = 9_000;
    a.m.startScan(spark, { path: "/home/me/models", depth: 2, mode: "drill" });
    await a.m.settled("s1");
    const s = a.m.snapshot(spark).session;
    assert.equal(s.analysedAt, 1_000);
    assert.equal(s.scannedAt, 9_000);
    const b = make({ scansFile }).m.snapshot(spark).session;
    assert.ok(b.entries.some((e) => e.path === "/home/me/models/llama"));
    assert.equal(b.analysedAt, 1_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a loaded analysis is re-checked: a hand-edited file cannot unlock a protected path or add rubbish", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scans-"));
  const scansFile = path.join(dir, "storage-scans.json");
  try {
    const bad = {
      version: 1,
      revision: 5,
      sessions: {
        s1: {
          revision: 5, root: "/", scannedAt: 1, analysedAt: 1, elevated: false, unreadable: 0, timedOut: false,
          entries: [
            { path: "/", bytes: 10, type: "dir", expanded: true, locked: null },
            { path: "/etc", bytes: 5, type: "dir", expanded: false, locked: null },
            { path: "relative", bytes: 5, type: "dir" },
            { path: "/x", bytes: -1, type: "dir" },
            { path: "/y", bytes: 1, type: "weird" },
          ],
        },
        s2: { revision: 1, root: "/missing", entries: [{ path: "/a", bytes: 1, type: "dir" }] },
      },
    };
    fs.writeFileSync(scansFile, JSON.stringify(bad));
    const { m } = make({ scansFile });
    const { session } = m.snapshot(spark);
    assert.deepEqual(session.entries.map((e) => e.path).sort(), ["/", "/etc"]);
    assert.match(session.entries.find((e) => e.path === "/etc").locked, /system/i);
    assert.equal(m.snapshot({ ...spark, id: "s2" }).session, null, "a session whose root is not in its entries is dropped");
    // A corrupt file is ignored, not fatal.
    fs.writeFileSync(scansFile, "{ nope");
    assert.equal(make({ scansFile }).m.snapshot(spark).session, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
