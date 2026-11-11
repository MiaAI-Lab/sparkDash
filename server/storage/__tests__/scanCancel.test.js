// Real process trees: a scan started the way the dashboard starts it (own session, recorded identity, tagged
// processes, unit lock) and stopped with the real `job` program. Every run uses its own HOME in a temp folder.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProgram, programResult } from "../commands.js";
import { parseJobOutput } from "../scanJob.js";

const has = (tool) => {
  try {
    execFileSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const grepZ = (() => {
  try {
    execFileSync("sh", ["-c", "printf 'A=1\\0' | grep -qzxF A=1"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const SKIP =
  process.platform !== "linux" || !fs.existsSync("/proc/self/environ") || !["setsid", "flock", "bash"].every(has) || !grepZ
    ? "needs Linux /proc, setsid, flock, bash and GNU grep -z"
    : false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pids of this account's processes whose environment carries the job's tag (as the unit checks it). */
function tagged(id) {
  const want = Buffer.from(`SPARKDASH_JOB=${id}`);
  const pids = [];
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let env;
    try {
      env = fs.readFileSync(`/proc/${name}/environ`);
    } catch {
      continue;
    }
    for (let i = 0; i < env.length; ) {
      let j = env.indexOf(0, i);
      if (j < 0) j = env.length;
      if (j - i === want.length && env.subarray(i, j).equals(want)) {
        pids.push(Number(name));
        break;
      }
      i = j + 1;
    }
  }
  return pids;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Field 22 of /proc/<pid>/stat: start time in clock ticks. */
const startTime = (pid) => fs.readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[19];

async function waitFor(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(40);
  }
}

/**
 * A sandbox with its own HOME and a `du` that behaves like a slow one: it starts helpers, one of them in a new
 * session (out of the scan's group and session) and one that ignores TERM (it needs KILL).
 */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-cancel-"));
  const home = path.join(dir, "home");
  const bin = path.join(dir, "bin");
  const tree = path.join(dir, "tree");
  for (const d of [home, bin, path.join(tree, "a")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "du"),
    "#!/bin/sh\nsleep 300 &\nsh -c 'sleep 301' &\nsetsid sleep 302 &\nsh -c 'trap \"\" TERM; exec sleep 303' &\nexec sleep 304\n",
    { mode: 0o755 }
  );
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  const ids = [];
  return {
    dir,
    home,
    tree,
    env,
    ids,
    jobDir: (id) => path.join(home, ".local/state/sparkdash/jobs", id),
    cleanup() {
      for (const id of ids) for (const pid of tagged(id)) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Start a scan as the dashboard does, and wait until it has recorded itself and its helpers run. */
async function startScan(sb, { helpers = 6 } = {}) {
  const id = randomUUID();
  sb.ids.push(id);
  const program = buildProgram("scan", { args: [sb.tree, 2, 60, 100, 1, 120], unitLock: true, job: id, lockWaitSeconds: 0 });
  const child = spawn("sh", ["-c", program], { env: sb.env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.resume();
  const exited = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal, out })));
  const stateFile = path.join(sb.jobDir(id), "state");
  await waitFor(() => fs.existsSync(stateFile), "the job record");
  await waitFor(() => tagged(id).length >= helpers, "the scan's helpers");
  const record = Object.fromEntries(fs.readFileSync(stateFile, "utf8").trim().split("\n").map((l) => l.split("=")));
  return { id, child, exited, stateFile, record };
}

const job = (sb, action, id, ...extra) => parseJobOutput(action, execFileSync("bash", ["-c", buildProgram("job", { args: [action, id, ...extra] })], { env: sb.env, encoding: "utf8" }));

test("Stop scan ends every process of the scan, even ones that left its group or ignore TERM, and frees the unit lock", { skip: SKIP }, async () => {
  const sb = sandbox();
  try {
    const s = await startScan(sb);
    // The record names the session leader of its own group, this boot and this account.
    assert.equal(s.record.PID, s.record.PGID);
    assert.equal(s.record.OWNER, String(process.getuid()));
    assert.equal(s.record.BOOT, fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim());
    assert.equal(s.record.NS, "same");
    assert.equal(s.record.START, startTime(Number(s.record.PID)));
    const before = tagged(s.id);
    assert.ok(before.some((p) => fs.readFileSync(`/proc/${p}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[3] !== s.record.PID), "a helper runs in another session");

    let st = job(sb, "status", s.id);
    assert.deepEqual([st.state, st.lock], ["running", "held"]);

    const res = job(sb, "cancel", s.id, 400, 2000);
    assert.equal(res.outcome, "terminated");
    assert.equal(res.reason, "kill", "the helper that ignores TERM needed KILL");
    assert.deepEqual(tagged(s.id), [], "nothing of the scan is left");
    for (const pid of before) assert.equal(alive(pid) && tagged(s.id).includes(pid), false);

    const end = await s.exited;
    assert.notEqual(end.code, 0, "the program reports it was stopped");
    st = job(sb, "status", s.id);
    assert.deepEqual([st.state, st.lock], ["gone", "free"]);
    // Asking again is harmless.
    assert.equal(job(sb, "cancel", s.id, 400, 400).outcome, "already-gone");
  } finally {
    sb.cleanup();
  }
});

test("a record that does not match is never acted on", { skip: SKIP }, async () => {
  const sb = sandbox();
  try {
    const s = await startScan(sb);
    const original = fs.readFileSync(s.stateFile, "utf8");
    const count = tagged(s.id).length;
    const edit = (from, to) => fs.writeFileSync(s.stateFile, original.replace(from, to));

    edit(`OWNER=${s.record.OWNER}`, `OWNER=${Number(s.record.OWNER) + 1}`);
    let r = job(sb, "cancel", s.id, 400, 400);
    assert.deepEqual([r.outcome, r.reason], ["unknown", "owner"]);

    edit(`BOOT=${s.record.BOOT}`, "BOOT=00000000-0000-0000-0000-000000000000");
    r = job(sb, "cancel", s.id, 400, 400);
    assert.deepEqual([r.outcome, r.reason], ["unknown", "boot"]);

    // /proc numbering processes differently from kill (a container without the host's PID namespace).
    edit("NS=same", "NS=foreign");
    r = job(sb, "cancel", s.id, 400, 400);
    assert.deepEqual([r.outcome, r.reason], ["unknown", "pid-namespace"]);

    // The leader's start time matches but its group does not: not the recorded process group.
    edit(`PGID=${s.record.PGID}`, `PGID=${Number(s.record.PGID) + 1}`);
    r = job(sb, "cancel", s.id, 400, 400);
    assert.deepEqual([r.outcome, r.reason], ["unknown", "identity"]);

    fs.rmSync(s.stateFile);
    r = job(sb, "cancel", s.id, 400, 400);
    assert.deepEqual([r.outcome, r.reason], ["unknown", "no-record"]);

    assert.equal(tagged(s.id).length, count, "nothing was signalled");
    // A symbolic link in place of the record is not followed.
    fs.writeFileSync(path.join(sb.dir, "elsewhere"), original);
    fs.symlinkSync(path.join(sb.dir, "elsewhere"), s.stateFile);
    assert.deepEqual(job(sb, "cancel", s.id, 400, 400).outcome, "unknown");
    fs.rmSync(s.stateFile);

    fs.writeFileSync(s.stateFile, original);
    assert.equal(job(sb, "cancel", s.id, 400, 2000).outcome, "terminated");
    await s.exited;
  } finally {
    sb.cleanup();
  }
});

test("a reused pid (another start time) is never signalled: only the scan's own tagged processes are", { skip: SKIP }, async () => {
  const sb = sandbox();
  // An unrelated process in its own session, without the tag: it stands for a process that got the old pid.
  const other = spawn("sleep", ["300"], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH } });
  try {
    const s = await startScan(sb);
    const original = fs.readFileSync(s.stateFile, "utf8");
    const wrongStart = String(Number(startTime(other.pid)) + 12345);
    fs.writeFileSync(
      s.stateFile,
      original.replace(`PID=${s.record.PID}`, `PID=${other.pid}`).replace(`PGID=${s.record.PGID}`, `PGID=${other.pid}`).replace(`START=${s.record.START}`, `START=${wrongStart}`)
    );
    const r = job(sb, "cancel", s.id, 400, 2000);
    assert.equal(r.outcome, "terminated");
    assert.deepEqual(tagged(s.id), []);
    assert.equal(alive(other.pid), true, "the process that reused the pid is untouched");
    await s.exited;
  } finally {
    try { process.kill(-other.pid, "SIGKILL"); } catch { /* gone */ }
    sb.cleanup();
  }
});

test("processes left behind by a leader that died are still found and stopped", { skip: SKIP }, async () => {
  const sb = sandbox();
  try {
    const s = await startScan(sb);
    process.kill(Number(s.record.PID), "SIGKILL");
    await s.exited;
    await waitFor(() => !alive(Number(s.record.PID)) || !tagged(s.id).includes(Number(s.record.PID)), "the leader to go");
    assert.ok(tagged(s.id).length > 0, "its helpers outlive it");
    assert.equal(job(sb, "status", s.id).state, "running");
    // The leader is gone, so its group is not signalled as a whole; each tagged process is.
    const r = job(sb, "cancel", s.id, 400, 2000);
    assert.equal(r.outcome, "terminated");
    assert.deepEqual(tagged(s.id), []);
    assert.equal(job(sb, "status", s.id).state, "gone");
  } finally {
    sb.cleanup();
  }
});

test("the unit lock keeps a second scan out while any process of the first lives", { skip: SKIP }, async () => {
  const sb = sandbox();
  try {
    const s = await startScan(sb);
    const second = programResult(execFileSync("sh", ["-c", buildProgram("scan", { args: [sb.tree, 2, 60, 100], unitLock: true, job: randomUUID(), lockWaitSeconds: 0 })], { env: sb.env, encoding: "utf8" }));
    assert.equal(second.code, "unit-busy");
    // The leader alone dies: its helpers still hold the lock.
    process.kill(Number(s.record.PID), "SIGKILL");
    await s.exited;
    await sleep(100);
    assert.equal(job(sb, "status", s.id).lock, "held");
    job(sb, "cancel", s.id, 400, 2000);
    assert.equal(job(sb, "status", s.id).lock, "free");
    // A finished job's folder is cleared away when the next scan starts.
    const third = startScan(sb, { helpers: 1 });
    const t = await third;
    assert.equal(fs.existsSync(sb.jobDir(s.id)), false);
    assert.equal(job(sb, "cancel", t.id, 400, 2000).outcome, "terminated");
    await t.exited;
  } finally {
    sb.cleanup();
  }
});

test("a scan that ends by itself leaves an end record and frees the lock", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    fs.rmSync(path.join(sb.dir, "bin", "du")); // the real du: a quick scan
    const id = randomUUID();
    sb.ids.push(id);
    const out = execFileSync("sh", ["-c", buildProgram("scan", { args: [sb.tree, 2, 60, 100], unitLock: true, job: id, lockWaitSeconds: 0 })], { env: sb.env, encoding: "utf8" });
    assert.match(out, /^RESULT=ok/);
    assert.equal(fs.readFileSync(path.join(sb.jobDir(id), "end"), "utf8").trim(), "RC=0");
    const st = job(sb, "status", id);
    assert.deepEqual([st.state, st.lock], ["gone", "free"]);
    const mode = fs.statSync(path.join(sb.home, ".local/state/sparkdash")).mode & 0o777;
    assert.equal(mode, 0o700);
    assert.equal(fs.statSync(sb.jobDir(id)).mode & 0o777, 0o700);
  } finally {
    sb.cleanup();
  }
});

test("a state folder that is a symbolic link is refused before anything runs", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(path.join(sb.home, ".local/state"), { recursive: true });
    fs.mkdirSync(path.join(sb.dir, "elsewhere"));
    fs.symlinkSync(path.join(sb.dir, "elsewhere"), path.join(sb.home, ".local/state/sparkdash"));
    const id = randomUUID();
    const r = programResult(execFileSync("sh", ["-c", buildProgram("scan", { args: [sb.tree, 2, 60, 100], unitLock: true, job: id, lockWaitSeconds: 0 })], { env: sb.env, encoding: "utf8" }));
    assert.equal(r.code, "no-state");
    assert.deepEqual(fs.readdirSync(path.join(sb.dir, "elsewhere")), [], "nothing written through the link");
    // The job program refuses too (an error answer, so no state at all).
    const st = job(sb, "status", id);
    assert.deepEqual([st.ok, st.code], [false, "no-state"]);
  } finally {
    sb.cleanup();
  }
});

test("a scan through sudo is not recorded (it cannot be signalled) and ends by the unit's own deadline", { skip: SKIP || (process.getuid() === 0 && "root never calls sudo") }, () => {
  const sb = sandbox();
  try {
    // A stand-in sudo that runs the command as is, and a du that would run for minutes.
    const bin = path.join(sb.dir, "bin");
    fs.writeFileSync(path.join(bin, "sudo"), `#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -n|-k|-S) shift ;; -p) shift 2 ;; *) break ;; esac; done\necho ran-with-sudo >> "${sb.dir}/sudo.log"\nexec "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "du"), "#!/bin/sh\nexec sleep 300\n", { mode: 0o755 });
    const id = randomUUID();
    sb.ids.push(id);
    const program = buildProgram("scan", { args: [sb.tree, 2, 1, 100, 1, 1], elevate: true, unitLock: true, job: id, hardLimitSeconds: 20, lockWaitSeconds: 0 });
    assert.match(program, /\$SUDO timeout -k 10 20 bash -c/);
    const t0 = Date.now();
    const out = execFileSync("sh", ["-c", program], { env: sb.env, encoding: "utf8" });
    assert.ok(Date.now() - t0 < 10_000, "the 1-second deadline ended the slow step");
    assert.match(out, /^RESULT=ok/);
    assert.match(out, /@@RC=124/, "reported as stopped early, not as complete");
    assert.match(fs.readFileSync(path.join(sb.dir, "sudo.log"), "utf8"), /ran-with-sudo/);
    assert.equal(fs.existsSync(path.join(sb.jobDir(id), "state")), false, "nothing recorded: the dashboard does not offer to stop it");
    assert.equal(job(sb, "status", id).lock, "free");
  } finally {
    sb.cleanup();
  }
});

test("job ids and actions are checked before anything else", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const run = (args) => programResult(execFileSync("bash", ["-c", buildProgram("job", { args })], { env: sb.env, encoding: "utf8" }));
    assert.equal(run(["cancel", "../../etc"]).code, "bad-job");
    assert.equal(run(["cancel", "x; rm -rf ~"]).code, "bad-job");
    assert.equal(run(["explode", randomUUID()]).code, "bad-job");
    assert.throws(() => buildProgram("scan", { args: ["/"], job: "not-a-uuid" }), /job id/);
  } finally {
    sb.cleanup();
  }
});
