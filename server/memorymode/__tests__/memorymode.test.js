/**
 * Memory-mode switcher tests (server): the settle/plateau state machine ported from
 * spark-dash/main.py, the requireDrop host-invocation refusals, the command builders'
 * allow-lists, and the route surface of the real server (400 / 401 / 409).
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { isolatedConfigEnv } from "../../__tests__/isolatedEnv.js";
import {
  MemoryModeManager,
  memoryModeConfigProblem,
  resolveMemoryInvocation,
} from "../MemoryModeManager.js";
import {
  buildContainerStateCommand,
  buildDockerStartCommand,
  buildDockerStopCommand,
  buildQwenStartCommand,
  buildQwenStopCommand,
} from "../commands.js";

const STACK = ["spark-ollama-engine", "librechat", "chat-mongodb"];

function baseConfig(tmp) {
  return {
    enabled: true,
    qwenDir: "/home/spark/Qwen3.8-Flash-Next-Single-DGX-Spark-TensorFold",
    qwenContainer: "qwen38-flash-next-tf",
    ollamaStack: [...STACK],
    memoryFloorGb: 108,
    logPath: path.join(tmp, "memory-mode.log"),
  };
}

/** A clock that only moves when the manager sleeps — deterministic wait/settle loops. */
function fakeClock() {
  let clock = 0;
  return { now: () => clock, sleep: async (ms) => void (clock += ms) };
}

function makeManager(t, deps) {
  const tmp = t.tmpdir ? t.tmpdir() : fs.mkdtempSync(path.join(os.tmpdir(), "memorymode-"));
  return new MemoryModeManager({ getSpark: () => ({ isLocal: true, ssh: { user: "spark" } }), config: baseConfig(tmp), deps });
}

/** execHost stub answering by exact command match (commands are opaque base64 wraps). */
function execRouter(states, extra = []) {
  const calls = [];
  return {
    calls,
    exec: async (cmd) => {
      calls.push(cmd);
      for (const [match, reply] of extra) if (cmd === match) return reply();
      for (const [name, state] of Object.entries(states)) {
        if (cmd === buildContainerStateCommand(name)) return { rc: 0, out: state };
        if (cmd === buildDockerStartCommand(name) || cmd === buildDockerStopCommand(name)) return { rc: 0, out: name };
      }
      throw new Error(`unexpected host command ${cmd.slice(0, 60)}…`);
    },
  };
}

// ─── settleMemory (port of main.py:218–237) ───────────────────────────────

test("settleMemory returns immediately when the first reading clears the floor", async (t) => {
  let reads = 0;
  const sleeps = [];
  const m = makeManager(t, { readMemAvailable: () => (reads += 1, 120), sleep: async (ms) => void sleeps.push(ms), now: () => 0 });
  assert.equal(await m.settleMemory(108, 30_000), 120);
  assert.equal(reads, 1, "no polling when the floor is already clear");
  assert.equal(sleeps.length, 0);
});

test("settleMemory returns on a plateau (two consecutive readings within 0.3 GB) below the floor", async (t) => {
  const readings = [50, 50.1, 50.2];
  let i = 0;
  let clock = 0;
  const sleeps = [];
  const m = makeManager(t, {
    readMemAvailable: () => readings[Math.min(i, readings.length - 1)],
    sleep: async (ms) => {
      sleeps.push(ms);
      i += 1;
      clock += ms;
    },
    now: () => clock,
  });
  // 50 → below floor, prev=null; 50.1 → delta 0.1 (stable=1); 50.2 → delta 0.1 (stable=2) → return.
  assert.equal(await m.settleMemory(108, 30_000), 50.2);
  assert.equal(sleeps.length, 2);
});

test("settleMemory stops at the deadline while memory keeps climbing", async (t) => {
  let i = 0;
  let clock = 0;
  const sleeps = [];
  const m = makeManager(t, {
    readMemAvailable: () => 50 + i, // +1 GB per read — never a plateau, never clears 108
    sleep: async (ms) => {
      sleeps.push(ms);
      i += 1;
      clock += 5000;
    },
    now: () => clock,
  });
  const avail = await m.settleMemory(108, 30_000);
  assert.ok(avail < 108, "the last reading stays below the floor");
  assert.ok(sleeps.length >= 6, `polled every step until the cap (${sleeps.length} sleeps)`);
});

test("a below-floor settle result refuses the launch and names what happened to each stack", async (t) => {
  const spawned = [];
  const router = execRouter(Object.fromEntries(STACK.map((n) => [n, "exited"])));
  const m = makeManager(t, {
    execHost: router.exec,
    spawnDetached: () => (spawned.push(1), 1),
    readMemAvailable: () => 50,
    ...fakeClock(),
  });
  const out = await m.switchTo("qwen");
  assert.equal(out.status, "error");
  assert.match(out.message, /Memory floor breach: 50GB available/);
  assert.match(out.message, /< 108GB floor/);
  assert.match(out.message, /Qwen NOT launched/);
  assert.equal(spawned.length, 0, "start.sh must never run when the floor was breached");
});

// ─── The two flows, end to end with fakes ─────────────────────────────────

test("qwen launch: success only when the container itself reaches running", async (t) => {
  const spawned = [];
  const router = execRouter({ ...Object.fromEntries(STACK.map((n) => [n, "exited"])), "qwen38-flash-next-tf": "running" });
  const m = makeManager(t, {
    execHost: router.exec,
    spawnDetached: (cmd) => (spawned.push(cmd), 4242),
    readMemAvailable: () => 120,
    ...fakeClock(),
  });
  const out = await m.switchTo("qwen");
  assert.equal(out.status, "success");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0], buildQwenStartCommand({ dir: baseConfig("/").qwenDir }));
  assert.match(out.message, /pid 4242/);
  assert.match(out.message, /120GB avail/);
});

test("qwen launch: start.sh exiting 0 is not success when the container never runs", async (t) => {
  const router = execRouter({ ...Object.fromEntries(STACK.map((n) => [n, "exited"])), "qwen38-flash-next-tf": "exited" });
  const m = makeManager(t, {
    execHost: router.exec,
    spawnDetached: () => 99,
    readMemAvailable: () => 120,
    ...fakeClock(),
  });
  const out = await m.switchTo("qwen");
  assert.equal(out.status, "error");
  assert.match(out.message, /never reached running state/);
});

test("qwen flow: a container that never stops aborts before the memory check", async (t) => {
  let memReads = 0;
  const router = execRouter({ ...Object.fromEntries(STACK.map((n) => [n, "exited"])), librechat: "running" });
  const m = makeManager(t, {
    execHost: router.exec,
    spawnDetached: () => 1,
    readMemAvailable: () => ((memReads += 1), 120),
    ...fakeClock(),
  });
  const out = await m.switchTo("qwen");
  assert.equal(out.status, "error");
  assert.match(out.message, /librechat did not stop \(state: running\)\. Qwen NOT launched\./);
  assert.equal(memReads, 0);
});

test("ollama flow: stop.sh exit code gates everything", async (t) => {
  const router = execRouter(Object.fromEntries(STACK.map((n) => [n, "running"])), [
    [buildQwenStopCommand({ dir: baseConfig("/").qwenDir }), () => ({ rc: 3, out: "Permission denied" })],
  ]);
  const m = makeManager(t, { execHost: router.exec, readMemAvailable: () => 120, sleep: async () => {}, now: () => 0 });
  const out = await m.switchTo("ollama");
  assert.equal(out.status, "error");
  assert.match(out.message, /stop\.sh failed \(exit 3\): Permission denied Qwen left running; Ollama NOT started\./);
});

test("ollama flow: a stack container that will not start names the ones up so far", async (t) => {
  const router = execRouter(
    { "qwen38-flash-next-tf": "exited", "spark-ollama-engine": "running", librechat: "exited", "chat-mongodb": "exited" },
    [[buildQwenStopCommand({ dir: baseConfig("/").qwenDir }), () => ({ rc: 0, out: "" })]]
  );
  const m = makeManager(t, {
    execHost: async (cmd, timeout) => (cmd === buildDockerStartCommand("librechat") ? { rc: 1, out: "nope" } : router.exec(cmd, timeout)),
    readMemAvailable: () => 120,
    ...fakeClock(),
  });
  const out = await m.switchTo("ollama");
  assert.equal(out.status, "error");
  assert.match(out.message, /Qwen verified stopped, but librechat failed to start\. Up so far: spark-ollama-engine\./);
});

test("one switch at a time: a second request is refused with 409", async (t) => {
  const m = makeManager(t, { readMemAvailable: () => 120, sleep: async () => {}, now: () => 0 });
  m.busy = true;
  await assert.rejects(() => m.switchTo("qwen"), (err) => err.status === 409 && /already running/.test(err.message));
});

test("unknown mode never succeeds silently", async (t) => {
  const m = makeManager(t, {});
  await assert.rejects(() => m.switchTo("both"), (err) => err.status === 400);
});

test("a disabled switcher refuses with 409", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memorymode-"));
  const m = new MemoryModeManager({ config: { ...baseConfig(tmp), enabled: false } });
  await assert.rejects(() => m.switchTo("qwen"), (err) => err.status === 409 && /disabled/.test(err.message));
});

// ─── Host invocation: requireDrop, never root ─────────────────────────────

const PASSWD = "root:x:0:0:root:/root:/bin/sh\nspark:x:1000:1000:Spark:/home/spark:/bin/bash\n";

test("host commands run via nsenter + setpriv as the SSH user, never as root", () => {
  const inv = resolveMemoryInvocation({
    spark: { isLocal: true, ssh: { user: "spark" } },
    cmd: "true",
    passwdText: PASSWD,
    mntNs: "/host/proc/1/ns/mnt",
    currentUid: 0,
  });
  assert.equal(inv.file, "nsenter");
  assert.equal(inv.args[0], "--mount=/host/proc/1/ns/mnt");
  assert.deepEqual(inv.args.slice(1, 6), ["--", "setpriv", "--reuid=1000", "--regid=1000", "--init-groups"]);
});

test("requireDrop refuses when the SSH user is missing or uid 0", () => {
  const base = { cmd: "true", passwdText: PASSWD, mntNs: "/host/proc/1/ns/mnt", currentUid: 0 };
  assert.throws(
    () => resolveMemoryInvocation({ ...base, spark: { ssh: { user: "ghost" } } }),
    /Refusing to run as the dashboard user/
  );
  assert.throws(() => resolveMemoryInvocation({ ...base, spark: { ssh: { user: "root" } } }), /as root/);
  assert.throws(() => resolveMemoryInvocation({ ...base, spark: {} }), /Refusing to run as the dashboard user/);
});

// ─── Command builders reject anything outside the allow-lists ─────────────

test("a container name with shell metacharacters fails before any string is built", () => {
  for (const bad of ["bad;name", 'a"b', "a$b", "a`b`", "UPPER", "a b", "", "-lead", "a".repeat(65)]) {
    assert.throws(() => buildContainerStateCommand(bad), /Container name must start/);
    assert.throws(() => buildDockerStartCommand(bad), /Container name must start/);
    assert.throws(() => buildDockerStopCommand(bad), /Container name must start/);
  }
  // A valid name embeds only inside the base64 wrap — the visible string is inert.
  const cmd = buildContainerStateCommand("spark-ollama-engine");
  assert.match(cmd, /^bash -c "\$\(printf %s '[A-Za-z0-9+/=]+' \| base64 -d\)"$/);
});

test("the Qwen directory and script names are allow-listed too", () => {
  assert.throws(() => buildQwenStopCommand({ dir: "/tmp; rm -rf /" }), /Directory/);
  assert.throws(() => buildQwenStartCommand({ dir: "" }), /Directory/);
  assert.throws(() => buildQwenStartCommand({ dir: "/tmp/x", script: "start;sh" }), /\.sh/);
  assert.throws(() => buildQwenStopCommand({ dir: "~/Qwen", script: "../evil.sh" }), /\.sh/);
});

test("a bad MEMORY_MODE_ENABLED config disables the feature instead of running it", () => {
  const good = baseConfig("/");
  assert.equal(memoryModeConfigProblem(good), null);
  assert.match(memoryModeConfigProblem({ ...good, qwenDir: "" }), /QWEN_DIR/);
  assert.match(memoryModeConfigProblem({ ...good, qwenDir: "/tmp/x' ; reboot" }), /QWEN_DIR/);
  assert.match(memoryModeConfigProblem({ ...good, qwenContainer: "bad name" }), /QWEN_CONTAINER/);
  assert.match(memoryModeConfigProblem({ ...good, ollamaStack: [] }), /OLLAMA_STACK is empty/);
  assert.match(memoryModeConfigProblem({ ...good, ollamaStack: ["good", "bad;name"] }), /OLLAMA_STACK/);
  assert.match(memoryModeConfigProblem({ ...good, memoryFloorGb: 0 }), /MEMORY_FLOOR_GB/);
  // Off is off: nothing to validate, nothing to run.
  assert.equal(memoryModeConfigProblem({ ...good, qwenDir: "", enabled: false }), null);
});

// ─── Route surface of the real server ─────────────────────────────────────

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer(t, extraEnv = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-memorymode-"));
  fs.writeFileSync(path.join(tmp, "sparks.json"), "[]\n");
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../../.."),
    env: {
      ...process.env,
      ...isolatedConfigEnv(tmp),
      BIND_HOST: "127.0.0.1",
      PORT: String(port),
      EVENTS_JSON_PATH: path.join(tmp, "events.json"),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  await Promise.race([
    new Promise((resolve) => {
      const check = () => (output.includes("server listening") ? resolve() : setTimeout(check, 10));
      check();
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 8_000)),
  ]);
  return port;
}

async function api(port, pathname, init) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

test("GET /api/memory-mode reports enabled:false while MEMORY_MODE_ENABLED is unset", async (t) => {
  const port = await startServer(t);
  const res = await api(port, "/api/memory-mode");
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, false);
  assert.equal(res.body.busy, false);
});

test("POST with a bogus mode is a 400, and a valid mode while disabled is a 409", async (t) => {
  const port = await startServer(t);
  const bogus = await api(port, "/api/memory-mode", { method: "POST", body: JSON.stringify({ mode: "bogus" }) });
  assert.equal(bogus.status, 400);
  assert.match(bogus.body.error, /qwen|ollama/);
  const disabled = await api(port, "/api/memory-mode", { method: "POST", body: JSON.stringify({ mode: "ollama" }) });
  assert.equal(disabled.status, 409);
  assert.match(disabled.body.error, /MEMORY_MODE_ENABLED/);
});

test("POST requires the bearer token when SPARKDASH_TOKEN is set", async (t) => {
  const port = await startServer(t, { SPARKDASH_TOKEN: "t" });
  const anon = await api(port, "/api/memory-mode", { method: "POST", body: JSON.stringify({ mode: "bogus" }) });
  assert.equal(anon.status, 401);
  const authed = await api(port, "/api/memory-mode", {
    method: "POST",
    body: JSON.stringify({ mode: "bogus" }),
    headers: { Authorization: "Bearer t" },
  });
  assert.equal(authed.status, 400, "with the token, the mode validation still runs");
});
