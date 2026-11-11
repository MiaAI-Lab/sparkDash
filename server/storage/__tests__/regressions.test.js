import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProgram, parseDockerRemoveOutput, parseScanOutput } from "../commands.js";
import { StorageManager } from "../StorageManager.js";
import { SudoVault } from "../sudoVault.js";

const isRoot = process.getuid?.() === 0;
const sh = (program, env = {}) => execFileSync("sh", ["-c", program], { encoding: "utf8", maxBuffer: 64 << 20, env: { ...process.env, ...env } });
const spark = { id: "s1", name: "Spark One", kind: "spark", platform: "linux", ssh: { user: "me", host: "10.0.0.5" } };

test("a remote answer larger than 10 MB is accepted when the caller asks for more room", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fakessh-"));
  // A stand-in for `ssh` that prints 12 MB, whatever it is asked.
  fs.writeFileSync(path.join(bin, "ssh"), '#!/bin/sh\nhead -c 12000000 /dev/zero | tr "\\0" "x"\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.SSH_MULTIPLEX = "0";
  try {
    const { sshExec } = await import(`../../collectors/ssh.js?big=${Date.now()}`);
    const { runProgram } = await import("../../gpuclock/GpuClockManager.js");
    await assert.rejects(sshExec(spark, "x", { timeoutMs: 20_000 }), /maxBuffer/i, "the default stays 10 MB");
    assert.equal((await sshExec(spark, "x", { timeoutMs: 20_000, maxBuffer: 32 << 20 })).length, 12_000_000);
    // runProgram forwards what the caller asked for (this was dropped for remote units).
    assert.equal((await runProgram(spark, "x", { timeoutMs: 20_000, maxBuffer: 32 << 20 })).length, 12_000_000);
  } finally {
    process.env.PATH = oldPath;
    delete process.env.SSH_MULTIPLEX;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("docker-remove leaves an image alone when it cannot check whether a container uses it", () => {
  const ID = `sha256:${"a".repeat(64)}`;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fakedocker-"));
  const log = path.join(bin, "calls");
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh
echo "docker $*" >> ${log}
case "$1" in
  ps) echo "Cannot connect to the Docker daemon" >&2; exit 1 ;;
  image) echo "Deleted: $4" ;;
esac
`,
    { mode: 0o755 }
  );
  try {
    const r = parseDockerRemoveOutput(sh(buildProgram("dockerRemove", { args: [ID] }), { PATH: `${bin}:${process.env.PATH}` }));
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.skipped, [{ id: ID, reason: "check-failed" }]);
    assert.ok(!fs.readFileSync(log, "utf8").includes("image rm"), "nothing was removed");
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

const make = (run, extra = {}) => new StorageManager({ run, holdMs: 0, ...extra });
const memVault = () => new SudoVault({ file: null, encrypt: (p) => `e:${p}`, decrypt: (b) => b.slice(2) });

test("an empty or noisy answer neither clears the wrong-password count nor remembers a password", async () => {
  const vault = memVault();
  const answers = ["RESULT=error\nCODE=bad-password\nMSG=x\n", "RESULT=error\nCODE=bad-password\nMSG=x\n", "", "Welcome to Ubuntu\n", "RESULT=error\nCODE=bad-password\nMSG=x\n"];
  let n = 0;
  const m = make(async () => answers[n++], { vault });
  const del = (pw) => m.delete(spark, { path: "/home/me/a", sudo: true, sudoPassword: pw, remember: true });
  await assert.rejects(del("w1"), (e) => e.code === "bad-password");
  await assert.rejects(del("w2"), (e) => e.code === "bad-password");
  await assert.rejects(del("garbled"), (e) => e.code === "bad-output");
  await assert.rejects(del("noise"), (e) => e.code === "bad-output");
  assert.equal(vault.has("me@10.0.0.5:22"), false, "nothing unvalidated is remembered");
  // The third wrong guess still counts: the two garbled answers did not reset the budget.
  await assert.rejects(del("w3"), (e) => e.code === "bad-password");
  await assert.rejects(del("w4"), (e) => e.status === 429 && e.code === "password-locked");
});

test("a password sudo accepted is remembered even when the action itself then failed", async () => {
  const vault = memVault();
  const m = make(async () => "RESULT=error\nCODE=not-found\nMSG=gone\n", { vault });
  await assert.rejects(m.delete(spark, { path: "/home/me/a", sudo: true, sudoPassword: "right", remember: true }), (e) => e.code === "not-found");
  assert.equal(vault.get("me@10.0.0.5:22"), "right");
});

test("looking inside a folder keeps the whole analysis's incomplete and elevated flags", async () => {
  const rows = (list, unreadable, rc) => ["RESULT=ok\n" + list.map(([b, t, p]) => `${b}\t${t}\t${p}`).join("\0"), `@@RC=${rc}`, `@@UNREADABLE=${unreadable}`, ""].join("\0");
  const answers = [
    rows([[1000, "d", "/"], [600, "d", "/home"], [300, "d", "/var"]], 12, 124),
    rows([[600, "d", "/home"], [500, "d", "/home/me"]], 0, 0),
  ];
  let n = 0;
  const m = make(async () => answers[n++]);
  m.startScan(spark, { path: "/", depth: 1 });
  await m.settled("s1");
  m.startScan(spark, { path: "/home", depth: 1, mode: "drill" });
  await m.settled("s1");
  const { session } = m.snapshot(spark);
  assert.equal(session.unreadable, 12, "the 12 unreadable folders are still reported");
  assert.equal(session.timedOut, true, "the analysis is still marked incomplete");
});

test("the scan page can be polled faster than the read limit allows", async () => {
  const { default: express } = await import("express");
  const { registerStorageRoutes } = await import("../routes.js");
  const app = express();
  app.use(express.json());
  const manager = make(async () => "RESULT=ok\n");
  registerStorageRoutes(app, { manager, registry: { getSpark: () => spark }, recordEvent: () => {}, allowRead: () => false, allowChange: () => false, rejectLimited: (res) => res.status(429).json({}) });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/sparks/s1/storage`;
  try {
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`${base}/scan`)).status, 200);
    assert.equal((await fetch(base)).status, 429, "other reads are still limited");
    assert.equal((await fetch(`${base}/sudo-password`, { method: "DELETE" })).status, 429, "forgetting a password is a change, so it uses the change limit");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

const hasPerl = (() => { try { execFileSync("perl", ["-e", "1"]); return true; } catch { return false; } })();

test("a listing cut off by the time limit is not reported as a complete parallel scan", { skip: (!hasPerl || isRoot) && "needs perl, and a non-root user" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slowfind-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fakefind-"));
  try {
    fs.mkdirSync(path.join(root, "a/b/c"), { recursive: true });
    fs.writeFileSync(path.join(root, "a/b/c/f"), Buffer.alloc(2_000_000));
    // `find` prints a few records and then hangs past the 1 s limit.
    fs.writeFileSync(path.join(bin, "find"), `#!/bin/sh\nprintf '0\\td\\t1\\t8\\t${root}\\0'\nsleep 5\n`, { mode: 0o755 });
    const out = sh(buildProgram("scan", { args: [root, 3, 1, 100, 4] }), { PATH: `${bin}:${process.env.PATH}` });
    const r = parseScanOutput(out, root);
    assert.equal(r.mode, "serial", "fell back to the one-at-a-time scan instead of trusting a partial listing");
    assert.ok(r.rows.find((x) => x.path === root).bytes >= 2_000_000, "and the totals are the real ones");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
