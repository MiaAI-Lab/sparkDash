/**
 * Pico publishes no counters, so other clients' decode can only come from the
 * front end's own request log on the unit. These tests pin what that reader
 * may and may not do: count only what it saw appended, place finished requests
 * in time from the engine's own figures, and yield nothing — rather than a
 * guess — whenever the log cannot be followed.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PICO_LOG_MIN_INTERVAL_MS,
  PICO_LOG_WINDOW_MS,
  PicoFrontLog,
  parsePicoFrontLog,
  parsePicoLogRemote,
  picoFrontListensOn,
  picoLogRemoteProgram,
  picoWindowDecodeTps,
  readPicoLogLocal,
} from "../picoFrontLog.js";

// Lines captured from a live dsfront (pico-dgx-ds4, DeepSeek V4.1 Flash on four DGX Sparks).
const PLAN = "req 630 plan: session 1881682407850016, a fork of 1881682407850012: it shares 45497 of 219404 bytes, 10445 ids in common";
const DONE = "req 630 session 1881682407850016: prompt 55675 (cached 0), completion 1421, tool_calls; ttft 5.692 s, 128.8 tok/s";
const DONE_2 = "req 631 session 1881682407850016: prompt 57200 (cached 57096), completion 300, stop; ttft 0.400 s, 150.0 tok/s";
const LOOP = "req 41: repetition loop after 10730 tokens; keeping 10613";

test("only finished-request lines are read, and a cut last line waits for its end", () => {
  const first = parsePicoFrontLog(`serving on http://127.0.0.1:18893/v1\n${PLAN}\n${DONE}\n${LOOP}\n${DONE_2.slice(0, 40)}`);
  assert.deepEqual(first.requests, [
    { reqId: 630, promptTokens: 55675, cachedTokens: 0, completionTokens: 1421, ttftSeconds: 5.692, decodeTps: 128.8 },
  ]);
  assert.equal(first.rest, DONE_2.slice(0, 40));
  const second = parsePicoFrontLog(`${DONE_2.slice(40)}\n`, first.rest);
  assert.equal(second.requests.length, 1);
  assert.equal(second.requests[0].completionTokens, 300);
  assert.equal(second.rest, "");
  // Not a request line, however long: never carried forever.
  assert.equal(parsePicoFrontLog("x".repeat(10_000)).rest, "");
});

test("the window rate spreads a request over its own decode time", () => {
  const now = 1_000_000;
  const W = 15_000;
  // 1500 tokens at 150 tok/s = 10 s of decode ending now: all of it inside a 15 s window.
  assert.equal(picoWindowDecodeTps([{ endMs: now, completionTokens: 1500, decodeTps: 150 }], now, W), 100);
  // 30 s of decode ending now: only the last 15 s (half the tokens) is in the window, at the request's own speed.
  assert.equal(picoWindowDecodeTps([{ endMs: now, completionTokens: 4500, decodeTps: 150 }], now, W), 150);
  // Two requests that decoded side by side add up.
  const pair = [
    { endMs: now, completionTokens: 4500, decodeTps: 150 },
    { endMs: now, completionTokens: 3000, decodeTps: 100 },
  ];
  assert.equal(picoWindowDecodeTps(pair, now, W), 250);
  // A request that ended before the window began contributes nothing.
  assert.equal(picoWindowDecodeTps([{ endMs: now - W, completionTokens: 900, decodeTps: 90 }], now, W), 0);
  // No decode speed recorded (the front end prints 0.0 for an instant reply): the tokens count where the request ended.
  assert.equal(picoWindowDecodeTps([{ endMs: now - 1_000, completionTokens: 30, decodeTps: 0 }], now, W), 2);
  assert.equal(picoWindowDecodeTps([], now, W), 0);
  // The default window is long enough that back-to-back requests never read as idle between two ends.
  assert.ok(PICO_LOG_WINDOW_MS >= 60_000);
  const backToBack = [0, 1, 2].map((k) => ({ endMs: now - k * 25_000, completionTokens: 2500, decodeTps: 100 }));
  assert.ok(picoWindowDecodeTps(backToBack, now) > 90);
});

test("the front end is matched by its serve command and listen port", () => {
  const argv = ["/home/u/dsgb10/service/bin/dsfront", "serve", "--listen", "127.0.0.1:18893", "--engine-socket", "/x"];
  assert.equal(picoFrontListensOn(argv, 18893), true);
  assert.equal(picoFrontListensOn(argv, 8893), false);
  assert.equal(picoFrontListensOn(argv, 18890), false);
  assert.equal(picoFrontListensOn(["dsfront", "serve"], 18890), true); // dsfront's default
  assert.equal(picoFrontListensOn(["dsfront", "serve"], 18893), false);
  assert.equal(picoFrontListensOn(["dsfront", "admin", "--socket", "/x"], 18890), false);
  assert.equal(picoFrontListensOn(["dsfront", "serve", "--listen", "[::1]:18893", "--listen", "10.0.0.1:9000"], 9000), true);
});

/** A /proc look-alike: one dsfront whose stderr is `logFile`, plus unrelated processes. */
function fakeProc(t, { port = 18893, pid = 4242 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-pico-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const procRoot = path.join(dir, "proc");
  const logFile = path.join(dir, "front.log");
  fs.writeFileSync(logFile, "");
  const add = (id, comm, argv, stderr) => {
    fs.mkdirSync(path.join(procRoot, String(id), "fd"), { recursive: true });
    fs.writeFileSync(path.join(procRoot, String(id), "comm"), `${comm}\n`);
    fs.writeFileSync(path.join(procRoot, String(id), "cmdline"), `${argv.join("\0")}\0`);
    if (stderr) fs.symlinkSync(stderr, path.join(procRoot, String(id), "fd", "2"));
  };
  add(1, "systemd", ["/sbin/init"], null);
  add(77, "dsfront", ["dsfront", "admin", "--socket", "/x"], logFile);
  add(pid, "dsfront", ["dsfront", "serve", "--listen", `127.0.0.1:${port}`], logFile);
  fs.mkdirSync(path.join(procRoot, "self"), { recursive: true });
  return { dir, procRoot, logFile, add };
}

test("a local read follows the stderr file of the dsfront on that port", (t) => {
  const { procRoot, logFile } = fakeProc(t);
  fs.writeFileSync(logFile, `${DONE}\n`);
  const first = readPicoLogLocal({ port: 18893, pid: -1, inode: -1, offset: 0, procRoot });
  assert.equal(first.pid, 4242);
  assert.equal(first.text, ""); // a file not followed before: its history is never read
  assert.equal(first.offset, fs.statSync(logFile).size);
  fs.appendFileSync(logFile, `${DONE_2}\n`);
  const second = readPicoLogLocal({ port: 18893, pid: first.pid, inode: first.inode, offset: first.offset, procRoot });
  assert.equal(second.text, `${DONE_2}\n`);
  // Truncated in place (the recipe's live rotation): read what was written since, from the start.
  fs.writeFileSync(logFile, `${DONE}\n`);
  const third = readPicoLogLocal({ port: 18893, pid: 4242, inode: second.inode, offset: second.offset, procRoot });
  assert.equal(third.text, `${DONE}\n`);
  // Nothing on another port; nothing when stderr is not a regular file.
  assert.equal(readPicoLogLocal({ port: 9999, pid: -1, inode: -1, offset: 0, procRoot }), null);
  fs.rmSync(path.join(procRoot, "4242", "fd", "2"));
  fs.symlinkSync("/dev/null", path.join(procRoot, "4242", "fd", "2"));
  assert.equal(readPicoLogLocal({ port: 18893, pid: -1, inode: -1, offset: 0, procRoot }), null);
  assert.equal(readPicoLogLocal({ port: 18893, pid: -1, inode: -1, offset: 0, procRoot: path.join(procRoot, "missing") }), null);
});

test("a read is capped and the backlog is drained by the next ones", (t) => {
  const { procRoot, logFile } = fakeProc(t);
  const start = readPicoLogLocal({ port: 18893, pid: -1, inode: -1, offset: 0, procRoot });
  fs.appendFileSync(logFile, `${DONE}\n${DONE_2}\n`);
  const a = readPicoLogLocal({ port: 18893, pid: start.pid, inode: start.inode, offset: start.offset, procRoot, maxBytes: 50 });
  assert.equal(a.text.length, 50);
  const b = readPicoLogLocal({ port: 18893, pid: a.pid, inode: a.inode, offset: a.offset, procRoot });
  assert.equal(a.text + b.text, `${DONE}\n${DONE_2}\n`);
});

test("the remote program is one read-only shell program with digits only interpolated", () => {
  const program = picoLogRemoteProgram({ port: 18893, pid: "12; rm -rf /", inode: "$(id)", offset: -5 });
  assert.ok(!program.includes("rm -rf"));
  assert.ok(!program.includes("$(id)"));
  assert.ok(!/\b(rm|mv|cp|tee|dd|kill|sudo)\b|>[^&]/.test(program.replace(/2>\/dev\/null/g, "")));
  for (const port of [18893, 18890]) {
    const syntax = spawnSync("sh", ["-n", "-c", picoLogRemoteProgram({ port, pid: 1, inode: 2, offset: 3 })]);
    if (syntax.error) continue; // no sh on this host
    assert.equal(syntax.status, 0, String(syntax.stderr));
  }
});

test("the remote program reads a real front-end log, byte for byte", (t) => {
  if (process.platform !== "linux") return t.skip("needs Linux /proc");
  // Stand in for dsfront: a process of that name (a script's comm is its file name) whose stderr is a file.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-pico-sh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "dsfront");
  const logFile = path.join(dir, "front.log");
  const port = 61893; // not a port a real front end would be on
  fs.writeFileSync(bin, "#!/bin/sh\nwhile :; do sleep 1; done\n", { mode: 0o755 });
  fs.writeFileSync(logFile, `${DONE}\n`);
  const err = fs.openSync(logFile, "a");
  const started = spawnSync("sh", ["-c", `"${bin}" serve --listen 127.0.0.1:${port} >/dev/null </dev/null & echo $!`], {
    encoding: "utf8", stdio: ["ignore", "pipe", err],
  });
  fs.closeSync(err);
  const pid = Number(String(started.stdout || "").trim());
  if (!Number.isInteger(pid) || pid <= 0) return t.skip("cannot start a stand-in process");
  t.after(() => { try { process.kill(pid); } catch { /* already gone */ } });
  const run = (args) => {
    const out = spawnSync("sh", ["-c", picoLogRemoteProgram({ port, ...args })], { encoding: "utf8" });
    return parsePicoLogRemote(String(out.stdout || "").trim()); // sshExec hands back trimmed stdout
  };
  let first = null;
  for (let i = 0; i < 30 && !first; i++) {
    first = run({ pid: -1, inode: -1, offset: 0 });
    if (!first) spawnSync("sh", ["-c", "sleep 0.1"]);
  }
  if (!first) return t.skip("the stand-in process is not visible to pgrep here");
  assert.equal(first.pid, pid);
  assert.equal(first.text, ""); // history is not read
  fs.appendFileSync(logFile, `${DONE_2}\n${PLAN.slice(0, 20)}`);
  const second = run({ pid: first.pid, inode: first.inode, offset: first.offset });
  assert.equal(second.text, `${DONE_2}\n${PLAN.slice(0, 20)}`);
  assert.equal(second.offset, fs.statSync(logFile).size);
  assert.equal(run({ pid: second.pid, inode: second.inode, offset: second.offset }).text, "");
  // The same process read locally through /proc gives the same bytes.
  const local = readPicoLogLocal({ port, pid: first.pid, inode: Number(first.inode), offset: first.offset, procRoot: "/proc" });
  assert.equal(local.text, second.text);
  // Another port: nothing found, and the program says so rather than failing.
  const other = spawnSync("sh", ["-c", picoLogRemoteProgram({ port: 9, pid: 0, inode: 0, offset: 0 })], { encoding: "utf8" });
  assert.equal(other.status, 0);
  assert.equal(parsePicoLogRemote(String(other.stdout || "").trim()), null);
});

test("a remote answer that is cut short or foreign is not used", () => {
  const ok = "SPARKDASH_PICO_LOG ok 4242 99 500 100 12\nabc\ndef\nxyz\n\nSPARKDASH_PICO_LOG end";
  assert.deepEqual(parsePicoLogRemote(ok), { pid: 4242, inode: "99", size: 500, offset: 112, text: "abc\ndef\nxyz\n" });
  assert.equal(parsePicoLogRemote("SPARKDASH_PICO_LOG ok 4242 99 500 100 12\nabc"), null);
  assert.equal(parsePicoLogRemote("SPARKDASH_PICO_LOG none"), null);
  assert.equal(parsePicoLogRemote("Last login: today\nSPARKDASH_PICO_LOG ok 1 2 3 4 5\n\nSPARKDASH_PICO_LOG end"), null);
  assert.equal(parsePicoLogRemote("SPARKDASH_PICO_LOG ok 1 2 3 x 5\n\nSPARKDASH_PICO_LOG end"), null);
  assert.equal(parsePicoLogRemote(""), null);
  assert.equal(parsePicoLogRemote(null), null);
});

/** A follower over a scripted sequence of reads, on a clock the test moves. */
function scripted(spark, reads) {
  let now = 10_000_000;
  const seen = [];
  const follower = new PicoFrontLog(spark, 18893, {
    now: () => now,
    readLocal: (args) => { seen.push(args); const next = reads.shift(); if (next instanceof Error) throw next; return next ?? null; },
    exec: async (_spark, program) => { seen.push(program); const next = reads.shift(); if (next instanceof Error) throw next; return next ?? "SPARKDASH_PICO_LOG none"; },
  });
  return { follower, seen, tick: (ms = PICO_LOG_MIN_INTERVAL_MS) => { now += ms; } };
}
const at = (offset, text = "") => ({ pid: 4242, inode: 7, size: offset, offset, text });

test("following starts at the end of the log and counts only what is appended", async () => {
  const { follower, seen, tick } = scripted({ isLocal: true }, [
    at(1000),
    at(1000 + DONE.length + 1, `${DONE}\n`),
    at(1000 + DONE.length + 1),
  ]);
  const start = await follower.poll();
  assert.deepEqual(start, { generationTps: 0, totalOutputTokens: 0, totalPromptTokens: 0, totalCachedTokens: 0 });
  assert.equal(seen[0].pid, -1);
  // Polled again at once: no second read inside the minimum interval.
  await follower.poll();
  assert.equal(seen.length, 1);
  tick();
  const active = await follower.poll();
  assert.equal(seen[1].pid, 4242);
  assert.equal(seen[1].offset, 1000);
  // 1421 tokens at 128.8 tok/s is 11.03 s of decode, all inside the window.
  assert.ok(Math.abs(active.generationTps - 1421 / (PICO_LOG_WINDOW_MS / 1000)) < 1e-9);
  assert.equal(active.totalOutputTokens, 1421);
  assert.equal(active.totalPromptTokens, 55675);
  assert.equal(active.totalCachedTokens, 0);
  // The rate leaves the window; the totals stay.
  tick(PICO_LOG_WINDOW_MS + 1);
  const idle = await follower.poll();
  assert.equal(idle.generationTps, 0);
  assert.equal(idle.totalOutputTokens, 1421);
});

test("a restarted engine starts a new file at its end; nothing is counted twice", async () => {
  const { follower, tick } = scripted({ isLocal: true }, [
    at(0),
    at(DONE.length + 1, `${DONE}\n`),
    { pid: 5000, inode: 8, size: 300, offset: 300, text: "" },
    { pid: 5000, inode: 8, size: 300 + DONE_2.length + 1, offset: 300 + DONE_2.length + 1, text: `${DONE_2}\n` },
  ]);
  await follower.poll();
  tick();
  assert.equal((await follower.poll()).totalOutputTokens, 1421);
  tick();
  const moved = await follower.poll();
  assert.equal(moved.generationTps, 0); // the old process's requests are not this one's
  assert.equal(moved.totalOutputTokens, 1421);
  tick();
  const after = await follower.poll();
  assert.equal(after.totalOutputTokens, 1721);
  assert.ok(after.generationTps > 0);
});

test("a log that cannot be read yields nothing, then resumes without losing or inventing tokens", async () => {
  const { follower, seen, tick } = scripted({ isLocal: true }, [
    at(0),
    at(DONE.length + 1, `${DONE}\n`),
    new Error("EACCES"),
    at(DONE.length + 1 + DONE_2.length + 1, `${DONE_2}\n`),
  ]);
  await follower.poll();
  tick();
  await follower.poll();
  tick();
  assert.equal(await follower.poll(), null);
  // Not retried on every poll.
  tick();
  assert.equal(await follower.poll(), null);
  assert.equal(seen.length, 3);
  tick(60_000);
  const resumed = await follower.poll();
  assert.equal(seen[3].offset, DONE.length + 1); // the same process and file: read on from where it stopped
  assert.equal(resumed.totalOutputTokens, 1721);
  // Appended at an unknown time during the gap: tokens, but no rate.
  assert.equal(resumed.generationTps, 0);
  follower.reset();
  assert.equal(await follower.poll(), null);
});

test("remote units are read over the SSH transport, and unreadable ones stay unavailable", async () => {
  const body = `${DONE}\n`;
  const { follower, seen, tick } = scripted({ lanIp: "10.0.0.2" }, [
    "SPARKDASH_PICO_LOG ok 4242 7 1000 1000 0\n\nSPARKDASH_PICO_LOG end",
    `SPARKDASH_PICO_LOG ok 4242 7 ${1000 + body.length} 1000 ${body.length}\n${body}\nSPARKDASH_PICO_LOG end`,
    "SPARKDASH_PICO_LOG none",
  ]);
  assert.equal((await follower.poll()).totalOutputTokens, 0);
  tick();
  assert.equal((await follower.poll()).totalOutputTokens, 1421);
  assert.match(seen[1], /"4242"/);
  tick();
  assert.equal(await follower.poll(), null);
});

test("units the log cannot belong to are never read", async () => {
  for (const spark of [
    { isLocal: true, kind: "mac" },
    { lanIp: "10.0.0.3", platform: "windows" },
    { lanIp: "10.0.0.3", platform: "darwin" },
    { lanIp: "10.0.0.3", llmHost: "10.0.0.9" }, // the engine is on another machine than SSH reaches
    null,
  ]) {
    const { follower, seen } = scripted(spark, [at(0)]);
    assert.equal(await follower.poll(), null);
    assert.equal(seen.length, 0);
  }
});
