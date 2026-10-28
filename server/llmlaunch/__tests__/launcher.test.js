import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { validateDir, validateScriptName, normalizeLauncherInput, slugify } from "../validate.js";
import { LineSplitter, LauncherManager, stripAnsi } from "../LauncherManager.js";
import { LauncherStore } from "../LauncherStore.js";
import { buildStartCommand, LOG_MAX_BYTES } from "../commands.js";

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("validateDir accepts plain absolute and ~/ paths and rejects anything shell-active", () => {
  assert.equal(validateDir("/home/me/llms/glm-5.3"), null);
  assert.equal(validateDir("~/llms/glm"), null);
  for (const bad of ["", "relative/dir", "/a b", "/a/../b", "/a;rm -rf /", "/a$(x)", "/a'b", "/a`x`", "/a\nb", "~", "/a|b"]) {
    assert.notEqual(validateDir(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
  assert.notEqual(validateDir("/" + "a".repeat(400)), null);
});

test("validateScriptName and normalizeLauncherInput apply defaults and reject bad values", () => {
  assert.equal(validateScriptName("start.sh", "x"), null);
  assert.notEqual(validateScriptName("../start.sh", "x"), null);
  assert.notEqual(validateScriptName("a b.sh", "x"), null);
  assert.notEqual(validateScriptName("reboot", "x"), null, "scripts must end in .sh");
  assert.notEqual(validateScriptName("start", "x"), null);
  const ok = normalizeLauncherInput({ name: " GLM ", dir: "/opt/glm", port: "8888" });
  assert.deepEqual(ok.value, { name: "GLM", dir: "/opt/glm", startScript: "start.sh", stopScript: "stop.sh", port: 8888, notes: "" });
  assert.equal(normalizeLauncherInput({ name: "", dir: "/x" }).ok, false);
  assert.equal(normalizeLauncherInput({ name: "a", dir: "/x", port: 70000 }).ok, false);
  assert.equal(slugify("GLM 5.3 (EXL3)!"), "glm-5-3-exl3");
});

test("LineSplitter handles CRLF, progress redraws and ANSI codes", () => {
  const s = new LineSplitter();
  assert.deepEqual(s.feed("one\r\ntwo\n"), ["one", "two"]);
  assert.deepEqual(s.feed("10%\r50%\r100%\ndone"), ["100%"]);
  assert.equal(s.partial, "done");
  assert.deepEqual(s.feed("\x1b[32mgreen\x1b[0m\n"), ["donegreen"]);
  assert.equal(stripAnsi("\x1b[1;31mred\x1b[0m"), "red");
  // a \r at the end of one chunk followed by \n in the next is still one newline
  const t = new LineSplitter();
  assert.deepEqual(t.feed("a\r"), []);
  assert.deepEqual(t.feed("\nb\n"), ["a", "b"]);
});

test("LauncherStore persists, de-duplicates ids, updates and tolerates a corrupt file", () => {
  const dir = tmpDir("sd-store-");
  const file = path.join(dir, "l.json");
  const store = new LauncherStore({ file });
  const a = store.add("spark1", { name: "GLM", dir: "/opt/glm" });
  const b = store.add("spark1", { name: "GLM", dir: "/opt/glm2" });
  assert.equal(a.ok && b.ok, true);
  assert.notEqual(a.launcher.id, b.launcher.id);
  assert.equal(store.update("spark1", a.launcher.id, { name: "GLM 5.3" }).launcher.name, "GLM 5.3");
  assert.equal(store.update("spark1", "nope", { name: "x" }).notFound, true);
  assert.equal(store.add("spark1", { name: "bad", dir: "relative" }).ok, false);
  const again = new LauncherStore({ file });
  assert.equal(again.list("spark1").length, 2);
  assert.equal(again.remove("spark1", a.launcher.id), true);
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(new LauncherStore({ file }).list("spark1"), []);
});

/** A manager that runs the generated programs with real bash against a throwaway $HOME. */
function realManager(home, extraEnv = {}) {
  const events = [];
  const env = { ...process.env, HOME: home, ...extraEnv };
  const store = new LauncherStore({ file: path.join(home, "launchers.json") });
  const mgr = new LauncherManager({
    store,
    spawnProcess: (_spark, cmd) => spawn("bash", ["-c", cmd], { env, stdio: ["ignore", "pipe", "pipe"], detached: true }),
    exec: (_spark, cmd) =>
      new Promise((resolve, reject) =>
        execFile("bash", ["-c", cmd], { env }, (e, out) => (e ? reject(e) : resolve(String(out).trim())))
      ),
    onEvent: (e) => events.push(e),
  });
  return { mgr, events, store };
}

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("timed out");
}

function writeScript(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

const spark = { id: "s1", name: "Spark 1" };

function readPid(home, launcher) {
  return Number(fs.readFileSync(path.join(home, ".cache/sparkdash/llm", `${launcher.id}.pid`), "utf8").split(" ")[0]);
}

test("start streams the script output and reports exit 0 without leaking the exit marker", async () => {
  const home = tmpDir("sd-home-");
  const llm = path.join(home, "llm");
  writeScript(llm, "start.sh", 'echo "loading weights"; echo "ready on 8888"');
  const { mgr, events } = realManager(home);
  const launcher = mgr.store.add("s1", { name: "Demo", dir: llm }).launcher;
  const started = mgr.startJob(spark, launcher, "start");
  assert.equal(started.ok, true);
  await until(() => mgr.latestJob("s1").status !== "running");
  const read = mgr.readJob("s1", started.job.id, 0);
  const texts = read.lines.map((l) => l.text);
  assert.ok(texts.some((t) => t.includes("loading weights")), texts.join("|"));
  assert.ok(texts.includes("ready on 8888"));
  assert.ok(!texts.some((t) => t.includes("__SDEXIT__")));
  assert.equal(read.job.status, "completed");
  assert.equal(read.job.exitCode, 0);
  assert.ok(events.some((e) => e.type === "llm.start.completed"));
  // `since` returns only newer lines
  const last = read.lines.at(-1).seq;
  assert.deepEqual(mgr.readJob("s1", started.job.id, last).lines, []);
});

test("completion drains a delayed follower, including the final unterminated line", async () => {
  const home = tmpDir("sd-home-");
  try {
    const bin = path.join(home, "bin");
    writeScript(bin, "tail", 'sleep 2\nexec /usr/bin/tail "$@"');
    const llm = path.join(home, "llm");
    writeScript(llm, "start.sh", "printf 'ready\\nfinal π'; exit 7");
    const { mgr } = realManager(home, { PATH: `${bin}:${process.env.PATH}` });
    const launcher = mgr.store.add("s1", { name: "Demo", dir: llm }).launcher;
    const { job } = mgr.startJob(spark, launcher, "start");
    await until(() => mgr.latestJob("s1").status !== "running");
    const read = mgr.readJob("s1", job.id, 0);
    assert.equal(read.job.status, "failed");
    assert.equal(read.job.exitCode, 7);
    assert.deepEqual(read.lines.slice(1).map((line) => line.text), ["ready", "final π"]);
    assert.match(
      fs.readFileSync(path.join(home, ".cache/sparkdash/llm", `${launcher.id}.log`), "utf8"),
      /ready\nfinal π$/,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("start works when tail has no --pid option (BSD/macOS tail)", async () => {
  const home = tmpDir("sd-home-");
  try {
    const bin = path.join(home, "bin");
    writeScript(
      bin,
      "tail",
      'for a in "$@"; do case "$a" in --pid*) echo "tail: illegal option -- -" >&2; exit 1 ;; esac; done\nexec /usr/bin/tail "$@"',
    );
    const llm = path.join(home, "llm");
    writeScript(llm, "start.sh", "echo loading; sleep 1; printf 'ready\\nfinal'; exit 5");
    const { mgr } = realManager(home, { PATH: `${bin}:${process.env.PATH}` });
    const launcher = mgr.store.add("s1", { name: "Demo", dir: llm }).launcher;
    const { job } = mgr.startJob(spark, launcher, "start");
    await until(() => mgr.latestJob("s1").status !== "running");
    const read = mgr.readJob("s1", job.id, 0);
    assert.equal(read.job.status, "failed");
    assert.equal(read.job.exitCode, 5);
    const texts = read.lines.map((line) => line.text);
    assert.ok(texts.includes("loading"), texts.join("|"));
    assert.ok(texts.includes("ready"), texts.join("|"));
    assert.ok(!texts.some((t) => t.includes("__SDEXIT__")));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a failing start script is reported with its exit code", async () => {
  const home = tmpDir("sd-home-");
  const llm = path.join(home, "llm");
  writeScript(llm, "start.sh", 'echo "oom"; exit 3');
  const { mgr } = realManager(home);
  const launcher = mgr.store.add("s1", { name: "Demo", dir: llm }).launcher;
  const { job } = mgr.startJob(spark, launcher, "start");
  await until(() => mgr.latestJob("s1").status !== "running");
  const r = mgr.readJob("s1", job.id, 0);
  assert.equal(r.job.status, "failed");
  assert.equal(r.job.exitCode, 3);
});

test("a missing script or directory fails fast with a clear message", async () => {
  const home = tmpDir("sd-home-");
  const { mgr } = realManager(home);
  const a = mgr.store.add("s1", { name: "NoDir", dir: path.join(home, "missing") }).launcher;
  const { job } = mgr.startJob(spark, a, "start");
  await until(() => mgr.latestJob("s1").status !== "running");
  const r = mgr.readJob("s1", job.id, 0);
  assert.equal(r.job.status, "failed");
  assert.equal(r.job.exitCode, 127);
  assert.ok(r.lines.some((l) => l.text.includes("cannot open directory")));
});

test("stop runs the stop script attached and reports its result", async () => {
  const home = tmpDir("sd-home-");
  const llm = path.join(home, "llm");
  writeScript(llm, "stop.sh", 'echo "stopping container"');
  const { mgr } = realManager(home);
  const launcher = mgr.store.add("s1", { name: "Demo", dir: llm }).launcher;
  const { job } = mgr.startJob(spark, launcher, "stop");
  await until(() => mgr.latestJob("s1").status !== "running");
  const r = mgr.readJob("s1", job.id, 0);
  assert.equal(r.job.status, "completed");
  assert.ok(r.lines.some((l) => l.text === "stopping container"));
});

test("a new action detaches a running start watcher instead of being blocked by it", async () => {
  const home = tmpDir("sd-home-");
  const llm = path.join(home, "llm");
  writeScript(llm, "start.sh", 'echo "serving"; sleep 20');
  writeScript(llm, "stop.sh", 'echo "stopped"');
  const { mgr } = realManager(home);
  const launcher = mgr.store.add("s1", { name: "Demo", dir: llm }).launcher;
  const first = mgr.startJob(spark, launcher, "start");
  await until(() => mgr.readJob("s1", first.job.id, 0).lines.some((l) => l.text === "serving"));
  const stop = mgr.startJob(spark, launcher, "stop");
  assert.equal(stop.ok, true, "stop must not be refused while the start output is being watched");
  await until(() => mgr.latestJob("s1").status !== "running");
  assert.equal(mgr.readJob("s1", stop.job.id, 0).job.status, "completed");
  // The start script itself was untouched by detaching its watcher.
  assert.equal((await mgr.statuses(spark, [launcher]))[launcher.id], "running");
  const pid = readPid(home, launcher);
  process.kill(-pid, "SIGTERM");
  await until(() => {
    try {
      process.kill(-pid, 0);
      return false;
    } catch {
      return true;
    }
  });
});

test("only one job runs per Spark at a time", async () => {
  const home = tmpDir("sd-home-");
  const llm = path.join(home, "llm");
  writeScript(llm, "stop.sh", "sleep 1");
  const { mgr } = realManager(home);
  const launcher = mgr.store.add("s1", { name: "Demo", dir: llm }).launcher;
  assert.equal(mgr.startJob(spark, launcher, "stop").ok, true);
  const second = mgr.startJob(spark, launcher, "stop");
  assert.equal(second.ok, false);
  assert.equal(second.reason, "busy");
  await until(() => mgr.latestJob("s1").status !== "running");
});

test("a long-running start survives cancel; status sees it; attach re-opens its output", async () => {
  const home = tmpDir("sd-home-");
  const llm = path.join(home, "llm");
  writeScript(llm, "start.sh", 'echo "serving"; sleep 20');
  const { mgr } = realManager(home);
  const launcher = mgr.store.add("s1", { name: "Demo", dir: llm }).launcher;
  const { job } = mgr.startJob(spark, launcher, "start");
  await until(() => mgr.readJob("s1", job.id, 0).lines.some((l) => l.text === "serving"));
  assert.equal(mgr.cancel("s1"), true);
  await until(() => mgr.latestJob("s1").status !== "running");
  assert.equal(mgr.latestJob("s1").status, "cancelled");

  // The detached script is still alive after the watcher went away.
  assert.equal((await mgr.statuses(spark, [launcher]))[launcher.id], "running");

  const attach = mgr.startJob(spark, launcher, "attach");
  assert.equal(attach.ok, true);
  await until(() => mgr.readJob("s1", attach.job.id, 0).lines.some((l) => l.text === "serving"));
  mgr.cancel("s1");
  await until(() => mgr.latestJob("s1").status !== "running");

  // Clean up the sleeping script (its whole process group).
  const pid = readPid(home, launcher);
  process.kill(-pid, "SIGTERM");
  await until(() => {
    try {
      process.kill(-pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  assert.equal((await mgr.statuses(spark, [launcher]))[launcher.id], "stopped");
});

test("status stays running when only the wrapper is killed but the model process survives", async () => {
  const home = tmpDir("sd-home-");
  const llm = path.join(home, "llm");
  // The model server is a child of the start script; killing the script alone leaves it alive.
  writeScript(llm, "start.sh", 'echo "up"; sleep 25 & wait');
  const { mgr } = realManager(home);
  const launcher = mgr.store.add("s1", { name: "Demo", dir: llm }).launcher;
  const { job } = mgr.startJob(spark, launcher, "start");
  await until(() => mgr.readJob("s1", job.id, 0).lines.some((l) => l.text === "up"));
  const pidFile = path.join(home, ".cache/sparkdash/llm", `${launcher.id}.pid`);
  const pid = Number(fs.readFileSync(pidFile, "utf8").split(" ")[0]);
  process.kill(pid, "SIGKILL"); // the wrapper only; its child keeps running
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await mgr.statuses(spark, [launcher]))[launcher.id], "running");
  // The watcher also keeps following the log, because the group is still alive.
  assert.equal(mgr.latestJob("s1").status, "running");
  process.kill(-pid, "SIGKILL"); // now take the whole group down
  await until(() => mgr.latestJob("s1").status !== "running", 10000);
  assert.equal((await mgr.statuses(spark, [launcher]))[launcher.id], "stopped");
});

test("the start program is valid bash and embeds nothing outside the validated fields", () => {
  const cmd = buildStartCommand({ id: "demo", dir: "~/llms/glm", script: "start.sh", nonce: "abcdef0123456789" });
  assert.ok(cmd.startsWith('bash -c "$(printf %s \''));
  const b64 = /printf %s '([^']+)'/.exec(cmd)[1];
  const program = Buffer.from(b64, "base64").toString("utf8");
  assert.ok(program.includes(`"$HOME"/'llms/glm'`));
  assert.ok(program.includes("setsid"));
  assert.ok(!program.includes("export "));
  const f = path.join(tmpDir("sd-syn-"), "p.sh");
  fs.writeFileSync(f, program);
  const r = spawn("bash", ["-n", f]);
  return new Promise((resolve, reject) => r.on("close", (c) => (c === 0 ? resolve() : reject(new Error("bash -n failed")))));
});

test("startEnv exports ride into the start program in the launch branch only", () => {
  const cmd = buildStartCommand({
    id: "demo",
    dir: "~/llms/glm",
    script: "start.sh",
    nonce: "abcdef0123456789",
    env: { MEM_NEED_GIB: "104" },
  });
  const program = Buffer.from(/printf %s '([^']+)'/.exec(cmd)[1], "base64").toString("utf8");
  assert.ok(program.includes("export MEM_NEED_GIB='104'"));
  // The exports must sit inside the launch branch, right before the detached spawn.
  const i = program.indexOf("export MEM_NEED_GIB='104'");
  const j = program.indexOf("newsid bash -c");
  assert.ok(i > 0 && j > i, "export must precede the newsid launch line");
  const f = path.join(tmpDir("sd-env-"), "p.sh");
  fs.writeFileSync(f, program);
  const r = spawn("bash", ["-n", f]);
  return new Promise((resolve, reject) => r.on("close", (c) => (c === 0 ? resolve() : reject(new Error("bash -n failed")))));
});

test("startEnv rejects anything that is not a plain NAME=value pair", async () => {
  const { sanitizeStartEnv, normalizeLauncherInput } = await import("../validate.js");
  assert.equal(sanitizeStartEnv(null).ok, true);
  assert.deepEqual(sanitizeStartEnv({ A_B2: "x/._+@-9" }).value, { A_B2: "x/._+@-9" });
  assert.equal(sanitizeStartEnv({ lower: "x" }).ok, false);
  assert.equal(sanitizeStartEnv({ "1BAD": "x" }).ok, false);
  assert.equal(sanitizeStartEnv({ A: "no spaces" }).ok, false);
  assert.equal(sanitizeStartEnv({ A: "no'quotes" }).ok, false);
  assert.equal(sanitizeStartEnv({ A: "$(reboot)" }).ok, false);
  assert.equal(sanitizeStartEnv(["A=1"]).ok, false);
  const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`K${i}`, "1"]));
  assert.equal(sanitizeStartEnv(many).ok, false);
  const bad = normalizeLauncherInput({ name: "x", dir: "~/l", startEnv: { A: "`x`" } });
  assert.equal(bad.ok, false);
  const good = normalizeLauncherInput({ name: "x", dir: "~/l", startEnv: { MEM_NEED_GIB: "104" } });
  assert.equal(good.ok, true);
  assert.deepEqual(good.value.startEnv, { MEM_NEED_GIB: "104" });
  const absent = normalizeLauncherInput({ name: "x", dir: "~/l" });
  assert.equal("startEnv" in absent.value, false);
});

test("start refuses a directory outside the user's home and a world-writable script or dir", async () => {
  const home = tmpDir("sd-home-");
  const outside = tmpDir("sd-outside-");
  writeScript(outside, "start.sh", 'echo "should not run"');
  const { mgr } = realManager(home);
  const run = async (dir, action = "start") => {
    const l = mgr.store.add("s1", { name: "X", dir }).launcher;
    const { job } = mgr.startJob(spark, l, action);
    await until(() => mgr.latestJob("s1").status !== "running");
    return mgr.readJob("s1", job.id, 0);
  };
  let r = await run(outside);
  assert.equal(r.job.exitCode, 126);
  assert.ok(r.lines.some((l) => l.text.includes("not inside")));
  assert.ok(!r.lines.some((l) => l.text === "should not run"));
  r = await run(outside, "stop");
  assert.equal(r.job.exitCode, 126);

  const ww = path.join(home, "ww");
  writeScript(ww, "start.sh", 'echo "nope"');
  fs.chmodSync(path.join(ww, "start.sh"), 0o757);
  r = await run(ww);
  assert.equal(r.job.exitCode, 126);
  assert.ok(r.lines.some((l) => l.text.includes("world-writable")));

  const wd = path.join(home, "wd");
  writeScript(wd, "start.sh", 'echo "nope"');
  fs.chmodSync(wd, 0o777);
  r = await run(wd);
  assert.equal(r.job.exitCode, 126);

  const link = path.join(home, "ln");
  fs.mkdirSync(link);
  fs.symlinkSync("/bin/true", path.join(link, "start.sh"));
  r = await run(link);
  assert.equal(r.job.exitCode, 127);
});

test("a second start while the first is alive does not launch another copy", async () => {
  const home = tmpDir("sd-home-");
  const llm = path.join(home, "llm");
  writeScript(llm, "start.sh", 'echo "launch $$" >> "$HOME/launches"; echo serving; sleep 20');
  const { mgr } = realManager(home);
  const launcher = mgr.store.add("s1", { name: "Demo", dir: llm }).launcher;
  const a = mgr.startJob(spark, launcher, "start");
  await until(() => mgr.readJob("s1", a.job.id, 0).lines.some((l) => l.text === "serving"));
  const b = mgr.startJob(spark, launcher, "start");
  await until(() => mgr.readJob("s1", b.job.id, 0).lines.some((l) => l.text.includes("not starting a second copy")));
  assert.equal(fs.readFileSync(path.join(home, "launches"), "utf8").trim().split("\n").length, 1);
  mgr.cancel("s1");
  const pid = readPid(home, launcher);
  process.kill(-pid, "SIGTERM");
});

test("a reused pid is not reported as running; the pid file is cleaned when the script ends", async () => {
  const home = tmpDir("sd-home-");
  const llm = path.join(home, "llm");
  writeScript(llm, "start.sh", "echo hi");
  const { mgr } = realManager(home);
  const launcher = mgr.store.add("s1", { name: "Demo", dir: llm }).launcher;
  const { job } = mgr.startJob(spark, launcher, "start");
  await until(() => mgr.latestJob("s1").status !== "running");
  assert.equal(mgr.readJob("s1", job.id, 0).job.status, "completed");
  const pidFile = path.join(home, ".cache/sparkdash/llm", `${launcher.id}.pid`);
  assert.equal(fs.existsSync(pidFile), false, "pid file removed once the group is gone");
  // A live but unrelated process (this test) with a mismatching start time is not "running".
  fs.writeFileSync(pidFile, `${process.pid} 1\n`);
  assert.equal((await mgr.statuses(spark, [launcher]))[launcher.id], "stopped");
  fs.writeFileSync(pidFile, `${process.pid}\n`);
  assert.equal((await mgr.statuses(spark, [launcher]))[launcher.id], "running", "legacy pid file without start time");
});

test("output cannot forge the exit marker", async () => {
  const home = tmpDir("sd-home-");
  const llm = path.join(home, "llm");
  writeScript(llm, "start.sh", 'echo "__SDEXIT__0"; echo "x__SDEXIT__:0"; sleep 1; echo "after"; exit 4');
  const { mgr } = realManager(home);
  const launcher = mgr.store.add("s1", { name: "Demo", dir: llm }).launcher;
  const { job } = mgr.startJob(spark, launcher, "start");
  await until(() => mgr.latestJob("s1").status !== "running");
  const r = mgr.readJob("s1", job.id, 0);
  assert.equal(r.job.exitCode, 4);
  const texts = r.lines.map((l) => l.text);
  assert.ok(texts.includes("__SDEXIT__0") && texts.includes("after"));
});

test("stop is exclusive: cancel is refused while a stop script runs, and the job count stays at one", async () => {
  const home = tmpDir("sd-home-");
  const llm = path.join(home, "llm");
  writeScript(llm, "stop.sh", "sleep 1; echo done");
  const { mgr } = realManager(home);
  const launcher = mgr.store.add("s1", { name: "Demo", dir: llm }).launcher;
  mgr.startJob(spark, launcher, "stop");
  assert.equal(mgr.cancel("s1"), false);
  assert.equal(mgr.startJob(spark, launcher, "start").ok, false);
  await until(() => mgr.latestJob("s1").status !== "running");
  assert.equal(mgr.latestJob("s1").status, "completed");
});

test("a stop script is killed on the Spark when its controlling process goes away", async () => {
  const home = tmpDir("sd-home-");
  const llm = path.join(home, "llm");
  writeScript(llm, "stop.sh", 'echo $$ > "$HOME/stop.pid"; sleep 60');
  const env = { ...process.env, HOME: home };
  const store = new LauncherStore({ file: path.join(home, "launchers.json") });
  // The program runs under an intermediate shell that stands in for sshd.
  const mgr = new LauncherManager({
    store,
    spawnProcess: (_s, cmd) =>
      spawn("bash", ["-c", 'bash -c "$0" & wait', cmd], { env, stdio: ["ignore", "pipe", "pipe"], detached: true }),
    exec: async () => "",
  });
  const launcher = store.add("s1", { name: "Demo", dir: llm }).launcher;
  mgr.startJob(spark, launcher, "stop");
  const pidFile = path.join(home, "stop.pid");
  await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim());
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  process.kill(mgr.latestJob("s1").child.pid, "SIGKILL"); // the "sshd" goes away
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 15000);
});

test("removing or retargeting a launcher is refused while its script runs", async () => {
  const home = tmpDir("sd-home-");
  const llm = path.join(home, "llm");
  writeScript(llm, "start.sh", "echo up; sleep 20");
  const { mgr } = realManager(home);
  const launcher = mgr.store.add("s1", { name: "Demo", dir: llm }).launcher;
  assert.match(launcher.id, /^demo-[0-9a-f]{6}$/);
  const { job } = mgr.startJob(spark, launcher, "start");
  await until(() => mgr.readJob("s1", job.id, 0).lines.some((l) => l.text === "up"));
  mgr.cancel("s1");
  assert.equal((await mgr.removeLauncher(spark, launcher.id)).conflict, true);
  assert.equal((await mgr.updateLauncher(spark, launcher.id, { dir: home })).conflict, true);
  assert.equal((await mgr.updateLauncher(spark, launcher.id, { notes: "ok" })).ok, true);
  process.kill(-readPid(home, launcher), "SIGTERM");
  for (let i = 0; i < 100 && (await mgr.statuses(spark, [launcher]))[launcher.id] !== "stopped"; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal((await mgr.removeLauncher(spark, launcher.id)).ok, true);
  const again = mgr.store.add("s1", { name: "Demo", dir: llm }).launcher;
  assert.notEqual(again.id, launcher.id);
});

test("the log is truncated at start", async () => {
  const home = tmpDir("sd-home-");
  const llm = path.join(home, "llm");
  writeScript(llm, "start.sh", "echo fresh");
  const { mgr } = realManager(home);
  const launcher = mgr.store.add("s1", { name: "Demo", dir: llm }).launcher;
  const logDir = path.join(home, ".cache/sparkdash/llm");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, `${launcher.id}.log`), "old stuff\n".repeat(50));
  const { job } = mgr.startJob(spark, launcher, "start");
  await until(() => mgr.latestJob("s1").status !== "running");
  const texts = mgr.readJob("s1", job.id, 0).lines.map((l) => l.text);
  assert.ok(!texts.includes("old stuff"));
  assert.ok(texts.includes("fresh"));
});

/** The start time of a live pid, read the way its platform reports it (independent of commands.js). */
function startTimeOf(pid) {
  if (process.platform === "linux") {
    return fs.readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[19];
  }
  return new Promise((resolve, reject) =>
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C" } }, (err, out) => (err ? reject(err) : resolve(out.trim())))
  );
}

test("the pid file records the real start time of the launched script, so a reused pid cannot pass for it", async () => {
  const home = tmpDir("sd-home-");
  const llm = path.join(home, "llm");
  writeScript(llm, "start.sh", 'echo "serving"; sleep 20');
  // A session in another language must not change what is recorded: ps prints dates in the session's locale.
  const { mgr } = realManager(home, { LC_ALL: "de_DE.UTF-8" });
  const launcher = mgr.store.add("s1", { name: "Demo", dir: llm }).launcher;
  const { job } = mgr.startJob(spark, launcher, "start");
  await until(() => mgr.readJob("s1", job.id, 0).lines.some((l) => l.text === "serving"));
  const pid = readPid(home, launcher);
  const recorded = fs.readFileSync(path.join(home, ".cache/sparkdash/llm", `${launcher.id}.pid`), "utf8").trim();
  assert.equal(recorded, `${pid} ${await startTimeOf(pid)}`);
  mgr.cancel("s1");
  await until(() => mgr.latestJob("s1").status !== "running");
  process.kill(-pid, "SIGTERM");
  await until(async () => (await mgr.statuses(spark, [launcher]))[launcher.id] === "stopped");
});

test("the log of a running script is cut back once it passes its size cap", { timeout: 60_000 }, async () => {
  const home = tmpDir("sd-home-");
  const llm = path.join(home, "llm");
  // 1 MiB over the cap in one burst, then stay alive so the janitor (it checks every 15 s) gets a turn.
  writeScript(llm, "start.sh", `yes "${"x".repeat(1000)}" | head -c ${LOG_MAX_BYTES + 1024 * 1024}; echo; echo big; sleep 40`);
  const { mgr } = realManager(home);
  const launcher = mgr.store.add("s1", { name: "Demo", dir: llm }).launcher;
  const { job } = mgr.startJob(spark, launcher, "start");
  await until(() => mgr.readJob("s1", job.id, 0).lines.some((l) => l.text === "big"), 30_000);
  const log = path.join(home, ".cache/sparkdash/llm", `${launcher.id}.log`);
  assert.ok(fs.statSync(log).size > LOG_MAX_BYTES, "burst really exceeded the cap");
  await until(() => fs.statSync(log).size < LOG_MAX_BYTES, 40_000);
  const pid = readPid(home, launcher);
  mgr.cancel("s1");
  await until(() => mgr.latestJob("s1").status !== "running");
  process.kill(-pid, "SIGTERM");
});

/** A `stat` that answers the mode and owner questions with fixed values ("unreadable": the query fails), so the safety checks see what a host reports. */
function statShim(dir, { mode = "755", owner = "$(id -u)" } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const answer = (v) => (v === "unreadable" ? "exit 1" : `echo ${v}`);
  const body = `case "$*" in
  *%a*|*%Lp*) ${answer(mode)} ;;
  *%u*) ${answer(owner)} ;;
  *) exit 1 ;;
esac`;
  fs.writeFileSync(path.join(dir, "stat"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

test("start and stop refuse when the host cannot report a script's mode or owner, or reports another owner (the checks fail closed)", async () => {
  for (const [label, shim, refusal] of [
    ["mode unreadable, owner fine", { mode: "unreadable" }, "world-writable"],
    ["owner unreadable, mode fine", { owner: "unreadable" }, "not owned by"],
    ["both unreadable", { mode: "unreadable", owner: "unreadable" }, "world-writable"],
    ["owned by another user", { owner: "4242" }, "not owned by"],
  ]) {
    const home = tmpDir("sd-home-");
    const llm = path.join(home, "llm");
    writeScript(llm, "start.sh", 'echo "should not run"');
    writeScript(llm, "stop.sh", 'echo "should not run"');
    const shimDir = path.join(home, "shim");
    statShim(shimDir, shim);
    const { mgr } = realManager(home, { PATH: `${shimDir}:${process.env.PATH}` });
    const launcher = mgr.store.add("s1", { name: "X", dir: llm }).launcher;
    for (const action of ["start", "stop"]) {
      const { job } = mgr.startJob(spark, launcher, action);
      await until(() => mgr.latestJob("s1").status !== "running");
      const r = mgr.readJob("s1", job.id, 0);
      assert.equal(r.job.exitCode, 126, `${label}: ${action}`);
      assert.ok(r.lines.some((l) => l.text.includes(refusal)), `${label}: ${action} refused for the wrong reason: ${r.lines.map((l) => l.text).join("|")}`);
      assert.ok(!r.lines.some((l) => l.text === "should not run"), `${label}: ${action} ran the script`);
    }
  }
});
