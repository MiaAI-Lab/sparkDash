import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";

import { FakeChild } from "./fixtures/fakeChild.js";
import { NvidiaSmiStream, dmonAssembler, gpuQueryAssembler, staleAfterMs } from "../nvidiaSmiStream.js";

const shape = { fieldCount: 3, indexField: 1 };

function harness({ intervalMs = 1000, assembler = gpuQueryAssembler(shape), onExit, maxQuickFailures } = {}) {
  const clock = { now: 1_000_000 };
  const children = [];
  const stream = new NvidiaSmiStream({
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    assembler,
    intervalMs,
    onExit,
    maxQuickFailures,
    now: () => clock.now,
  });
  return { stream, children, clock };
}

test("staleAfterMs: three intervals, never under 3 s", () => {
  assert.equal(staleAfterMs(1000), 3000);
  assert.equal(staleAfterMs(250), 3000);
  assert.equal(staleAfterMs(2000), 6000);
});

test("gpuQueryAssembler: one GPU, a tick is complete once the count is known", () => {
  const a = gpuQueryAssembler(shape);
  assert.equal(a.onLine("50, 0, x"), null, "the first tick waits until the next one shows its end");
  assert.equal(a.onLine("51, 0, x"), "51, 0, x");
  assert.equal(a.onLine("52, 0, x"), "52, 0, x");
});

test("gpuQueryAssembler: several GPUs are grouped per tick by index", () => {
  const a = gpuQueryAssembler(shape);
  assert.equal(a.onLine("50, 0, a"), null);
  assert.equal(a.onLine("60, 1, b"), null);
  assert.equal(a.onLine("51, 0, a"), "50, 0, a\n60, 1, b", "the previous tick ends when the index drops");
  assert.equal(a.onLine("61, 1, b"), "51, 0, a\n61, 1, b", "then each tick is published when it has every card");
  assert.equal(a.onLine("52, 0, a"), null, "a half-printed tick is not a sample");
});

test("gpuQueryAssembler: error text and short lines are ignored", () => {
  const a = gpuQueryAssembler(shape);
  a.onLine("50, 0, a");
  assert.equal(a.onLine("Unable to determine the device handle for GPU0000:01:00.0: Unknown Error"), null);
  assert.equal(a.onLine("50, , a"), null);
  assert.equal(a.onLine("51, 0, a"), "51, 0, a");
});

test("dmonAssembler: headers and error text are skipped, each data line is a sample", () => {
  const a = dmonAssembler();
  assert.equal(a.onLine("# gpu  rxpci  txpci"), null);
  assert.equal(a.onLine("Invalid combination of input arguments. Please run 'nvidia-smi -h' for help."), null);
  assert.equal(a.onLine(""), null);
  assert.equal(a.onLine("    0    120    340"), "    0    120    340");
});

test("partial lines wait for the rest of the line", async () => {
  const { stream, children } = harness();
  assert.equal(await stream.read(), null);
  const [child] = children;
  child.write("50, 0, a\n51,");
  assert.equal(await stream.read(), null);
  child.write(" 0, a");
  assert.equal(await stream.read(), null, "no newline yet");
  child.write("\r\n52, 0");
  assert.equal(await stream.read(), "51, 0, a", "CRLF is stripped; the tail stays buffered");
  stream.dispose();
});

test("a sample older than three intervals is not served", async () => {
  const { stream, children, clock } = harness({ intervalMs: 1000 });
  await stream.read();
  children[0].write("50, 0, a\n51, 0, a\n");
  assert.equal(await stream.read(), "51, 0, a");
  clock.now += 3000;
  assert.equal(await stream.read(), "51, 0, a");
  clock.now += 1;
  assert.equal(await stream.read(), null, "stale: unavailable, not the last good value");
  children[0].write("52, 0, a\n");
  assert.equal(await stream.read(), "52, 0, a");
  stream.dispose();
});

test("read waits for the first sample of a fresh process, then gives up", async () => {
  const { stream, children } = harness();
  const pending = stream.read({ waitMs: 1000 });
  children[0].write("50, 0, a\n51, 0, a\n");
  assert.equal(await pending, "51, 0, a");

  const second = harness();
  assert.equal(await second.stream.read({ waitMs: 20 }), null, "no output in time: unavailable");
  second.stream.dispose();
  stream.dispose();
});

test("an exited process drops its sample and restarts with backoff", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const exits = [];
  const { stream, children } = harness({ onExit: (info) => exits.push(info) });
  await stream.read();
  children[0].write("50, 0, a\n51, 0, a\n");
  assert.equal(await stream.read(), "51, 0, a");

  children[0].stderr.emit("data", "boom");
  children[0].exit(1);
  assert.equal(exits.length, 1);
  assert.deepEqual({ ...exits[0], error: undefined }, { code: 1, signal: null, stderr: "boom", hadSample: true, gaveUp: false, error: undefined });
  assert.equal(await stream.read(), null, "a dead reader's last sample is not current");
  assert.equal(children.length, 1, "no restart before the backoff");
  t.mock.timers.tick(1000);
  assert.equal(children.length, 2);

  // Failing again without output doubles the delay.
  children[1].exit(1);
  t.mock.timers.tick(1999);
  assert.equal(children.length, 2);
  t.mock.timers.tick(1);
  assert.equal(children.length, 3);

  // A sample resets the backoff.
  children[2].write("50, 0, a\n51, 0, a\n");
  children[2].exit(null, "SIGSEGV");
  t.mock.timers.tick(1000);
  assert.equal(children.length, 4);
  stream.dispose();
});

test("a spawn that throws is retried like an exit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const stream = new NvidiaSmiStream({
    spawn: () => {
      calls += 1;
      throw new Error("ENOENT");
    },
    assembler: dmonAssembler(),
    intervalMs: 1000,
  });
  assert.equal(await stream.read(), null);
  assert.equal(calls, 1);
  assert.equal(await stream.read(), null, "reads during the backoff do not respawn");
  assert.equal(calls, 1);
  t.mock.timers.tick(1000);
  assert.equal(calls, 2);
  stream.dispose();
  t.mock.timers.tick(60_000);
  assert.equal(calls, 2, "disposed: no more restarts");
});

test("a process that stops printing is killed and restarted", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { stream, children, clock } = harness({ intervalMs: 1000 });
  await stream.read();
  children[0].write("50, 0, a\n51, 0, a\n");
  clock.now += 15_001;
  assert.equal(await stream.read(), null);
  assert.deepEqual(children[0].signals, ["SIGTERM"]);
  assert.equal(await stream.read(), null);
  assert.deepEqual(children[0].signals, ["SIGTERM"], "signalled once");
  children[0].exit(null, "SIGTERM");
  t.mock.timers.tick(1000);
  assert.equal(children.length, 2);
  stream.dispose();
});

test("dispose kills the child, escalates to SIGKILL, and never restarts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { stream, children } = harness();
  const pending = stream.read({ waitMs: 10_000 });
  stream.dispose();
  assert.equal(await pending, null, "a waiting read is released");
  assert.deepEqual(children[0].signals, ["SIGTERM"]);
  t.mock.timers.tick(2000);
  assert.deepEqual(children[0].signals, ["SIGTERM", "SIGKILL"]);
  children[0].exit(null, "SIGKILL");
  t.mock.timers.tick(60_000);
  assert.equal(children.length, 1);
  assert.equal(await stream.read(), null);
  assert.equal(children.length, 1);
});

test("dispose does not escalate when the child exits on SIGTERM", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { stream, children } = harness();
  await stream.read();
  stream.dispose();
  children[0].exit(null, "SIGTERM");
  t.mock.timers.tick(5000);
  assert.deepEqual(children[0].signals, ["SIGTERM"]);
});

test("a real child is stopped by dispose (no orphan, no zombie)", async () => {
  const stream = new NvidiaSmiStream({
    spawn: () =>
      childProcess.spawn("sh", ["-c", 'exec sh -c \'while :; do echo "50, 0, a"; sleep 0.05; done\''], {
        stdio: ["ignore", "pipe", "pipe"],
      }),
    assembler: gpuQueryAssembler(shape),
    intervalMs: 50,
  });
  assert.equal(await stream.read({ waitMs: 5000 }), "50, 0, a");
  const child = stream._child;
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve(signal)));
  stream.dispose();
  assert.equal(await closed, "SIGTERM");
  assert.equal(stream.running, false);
});

test("a command that keeps failing at startup is given up on: no more restarts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const exits = [];
  const { stream, children } = harness({ maxQuickFailures: 3, onExit: (info) => exits.push(info) });
  await stream.read();
  children[0].write("Invalid combination of input arguments.\n");
  children[0].exit(255);
  t.mock.timers.tick(1000);
  children[1].exit(255);
  t.mock.timers.tick(2000);
  assert.equal(children.length, 3);
  children[2].exit(255);
  assert.equal(stream.gaveUp, true);
  assert.deepEqual(exits.map((e) => e.gaveUp), [false, false, true]);
  t.mock.timers.tick(10 * 60_000);
  assert.equal(await stream.read({ waitMs: 1000 }), null);
  assert.equal(children.length, 3, "never started again");
});

test("slow failures or a sample in between do not count toward giving up", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { stream, children, clock } = harness({ maxQuickFailures: 3 });
  await stream.read();
  children[0].exit(1);
  t.mock.timers.tick(1000);
  children[1].exit(1); // two quick failures
  t.mock.timers.tick(2000);
  children[2].write("50, 0, a\n51, 0, a\n"); // works: count reset
  children[2].exit(null, "SIGSEGV");
  t.mock.timers.tick(1000);
  children[3].exit(1); // quick failure 1 after the reset
  t.mock.timers.tick(2000);
  clock.now += 10_001; // ran for a while before dying: not a startup failure
  children[4].exit(1);
  t.mock.timers.tick(4000);
  assert.equal(stream.gaveUp, false);
  assert.equal(children.length, 6);
  stream.dispose();
});

test("a reader that produced samples keeps restarting after transient crashes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { stream, children } = harness({ maxQuickFailures: 3 });
  await stream.read();
  for (let i = 0; i < 5; i++) {
    children[i].write("50, 0, a\n51, 0, a\n");
    children[i].exit(null, "SIGKILL");
    t.mock.timers.tick(1000);
  }
  assert.equal(stream.gaveUp, false);
  assert.equal(children.length, 6);
  children[5].write("52, 0, a\n53, 0, a\n");
  assert.equal(await stream.read(), "53, 0, a");
  stream.dispose();
});

test("without maxQuickFailures (GPU query) startup failures never give up", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { stream, children } = harness();
  await stream.read();
  for (let i = 0; i < 6; i++) {
    children[i].exit(1);
    t.mock.timers.tick(30_000);
  }
  assert.equal(stream.gaveUp, false);
  assert.equal(children.length, 7);
  stream.dispose();
});

/**
 * Runs `body` as an ES module in a fresh Node with nothing else keeping the
 * event loop alive (the test runner's own handles differ between Node lines),
 * so it shows what the stream itself holds open. Exit code 13 means a promise
 * was left pending when the loop ran dry.
 */
function runAlone(body) {
  const moduleUrl = new URL("../nvidiaSmiStream.js", import.meta.url).href;
  const source = `import { NvidiaSmiStream, gpuQueryAssembler } from ${JSON.stringify(moduleUrl)};\n${body}`;
  return new Promise((resolve) => {
    childProcess.execFile(process.execPath, ["--input-type=module", "-e", source], { timeout: 10_000 }, (error, stdout) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout: stdout.trim() });
    });
  });
}

test("a pending read keeps Node alive until its waitMs runs out", async () => {
  const { code, stdout } = await runAlone(`
    const silent = { stdout: null, stderr: null, on() {}, unref() {}, kill() { return true; } };
    const stream = new NvidiaSmiStream({ spawn: () => silent, assembler: gpuQueryAssembler({ fieldCount: 3, indexField: 1 }), intervalMs: 1000 });
    console.log(String(await stream.read({ waitMs: 50 })));
    stream.dispose();
  `);
  assert.deepEqual({ code, stdout }, { code: 0, stdout: "null" });
});

test("a child being stopped keeps Node alive until it is reaped", async () => {
  const { code, stdout } = await runAlone(`
    import { spawn } from "node:child_process";
    const stream = new NvidiaSmiStream({
      spawn: () => spawn("sh", ["-c", 'exec sh -c \\'while :; do echo "50, 0, a"; sleep 0.05; done\\''], { stdio: ["ignore", "pipe", "pipe"] }),
      assembler: gpuQueryAssembler({ fieldCount: 3, indexField: 1 }),
      intervalMs: 50,
    });
    await stream.read({ waitMs: 5000 });
    const child = stream._child;
    const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve(signal)));
    stream.dispose();
    console.log(await closed);
  `);
  assert.deepEqual({ code, stdout }, { code: 0, stdout: "SIGTERM" });
});
