import test from "node:test";
import assert from "node:assert/strict";
import { argvFromEnv, createAcpBridge } from "./acpBridge.js";

function scriptedProcess(onMessage) {
  const dataHandlers = [];
  const proc = {
    killed: false,
    signal: null,
    written: [],
    stdout: {
      on(event, fn) {
        if (event === "data") dataHandlers.push(fn);
      },
    },
    stderr: { on() {} },
    stdin: {
      write(chunk) {
        const text = String(chunk);
        proc.written.push(text);
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          onMessage(msg, (reply) => {
            const raw = typeof reply === "string" ? reply : JSON.stringify(reply);
            for (const fn of dataHandlers) fn(Buffer.from(`${raw}\n`));
          });
        }
        return true;
      },
    },
    once() {},
    kill(signal) {
      proc.killed = true;
      proc.signal = signal;
    },
  };
  return proc;
}

function initResult(list = {}) {
  return { agentCapabilities: { sessionCapabilities: { list } } };
}

test("argv is split without a shell", () => {
  assert.deepEqual(argvFromEnv("opencode acp"), ["opencode", "acp"]);
  assert.deepEqual(argvFromEnv('["omp","acp"]'), ["omp", "acp"]);
  assert.throws(() => argvFromEnv("openclaw\nacp"), /invalid/);
});

test("an empty page, a paged list, and a terminal empty page stay inside session/list", async () => {
  let lists = 0;
  let spawns = 0;
  const bridge = createAcpBridge({
    harness: "opencode",
    argv: ["opencode", "acp"],
    openProcess: () => {
      spawns += 1;
      return scriptedProcess((msg, reply) => {
        if (msg.method === "initialize") reply({ jsonrpc: "2.0", id: msg.id, result: initResult() });
        if (msg.method === "session/list") {
          lists += 1;
          if (lists === 1) reply({ jsonrpc: "2.0", id: msg.id, result: { sessions: [] } });
          else if (lists === 2) {
            reply({
              jsonrpc: "2.0",
              id: msg.id,
              result: { sessions: [{ sessionId: "a", title: "A" }, { sessionId: "b", title: "B" }], nextCursor: "p2" },
            });
          } else if (lists === 3) {
            reply({ jsonrpc: "2.0", id: msg.id, result: { sessions: [{ sessionId: "c", title: "C" }] } });
          } else if (lists === 4) {
            reply({
              jsonrpc: "2.0",
              id: msg.id,
              result: { sessions: [{ sessionId: "d", title: "D" }], nextCursor: "more" },
            });
          } else {
            reply({ jsonrpc: "2.0", id: msg.id, result: { sessions: [], nextCursor: "more" } });
          }
        }
        if (msg.method === "session/prompt" || msg.method === "session/new") {
          throw new Error(`sent ${msg.method}`);
        }
      });
    },
  });

  await bridge.refresh();
  assert.equal(bridge.current().rows.length, 0);
  assert.equal(bridge.current().coverage, "supported");

  await bridge.refresh();
  assert.deepEqual(bridge.current().rows.map((row) => row.sessionId), ["a", "b", "c"]);
  assert.equal(bridge.current().rows[0].activity, "unknown");

  await bridge.refresh();
  assert.deepEqual(bridge.current().rows.map((row) => row.sessionId), ["d"]);
  assert.equal(bridge.current().stale, false);
  assert.deepEqual([...new Set(bridge.sent())], ["initialize", "session/list"]);
  assert.equal(spawns, 1);
});

test("a repeated cursor keeps the last good rows", async () => {
  let lists = 0;
  const bridge = createAcpBridge({
    harness: "omp",
    argv: ["omp", "acp"],
    openProcess: () => scriptedProcess((msg, reply) => {
      if (msg.method === "initialize") reply({ jsonrpc: "2.0", id: msg.id, result: initResult() });
      if (msg.method === "session/list") {
        lists += 1;
        if (lists === 1) {
          reply({ jsonrpc: "2.0", id: msg.id, result: { sessions: [{ sessionId: "kept", title: "Kept" }] } });
        } else {
          reply({ jsonrpc: "2.0", id: msg.id, result: { sessions: [{ sessionId: "x" }], nextCursor: "loop" } });
        }
      }
    }),
  });
  await bridge.refresh();
  await bridge.refresh();
  const current = bridge.current();
  assert.deepEqual(current.rows.map((row) => row.sessionId), ["kept"]);
  assert.equal(current.stale, true);
  assert.equal(current.coverage, "partial");
  assert.match(current.error, /repeated cursor/);
});

test("a harness without session/list is not polled again until stop", async () => {
  let spawns = 0;
  const bridge = createAcpBridge({
    harness: "openclaw",
    argv: ["openclaw", "acp"],
    openProcess: () => {
      spawns += 1;
      return scriptedProcess((msg, reply) => {
        if (msg.method === "initialize") {
          reply({ jsonrpc: "2.0", id: msg.id, result: { agentCapabilities: { sessionCapabilities: {} } } });
        }
      });
    },
  });
  await bridge.refresh();
  assert.equal(bridge.current().coverage, "unsupported");
  assert.equal(bridge.current().rows.length, 0);
  await bridge.refresh();
  assert.equal(spawns, 1);
  bridge.stop();
  await bridge.refresh();
  assert.equal(spawns, 2);
});

test("one refresh is shared and a client RPC is refused", async () => {
  let spawns = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let proc;
  const bridge = createAcpBridge({
    harness: "opencode",
    argv: ["opencode", "acp"],
    openProcess: () => {
      spawns += 1;
      proc = scriptedProcess((msg, reply) => {
        if (msg.method === "initialize") {
          gate.then(() => reply({ jsonrpc: "2.0", id: msg.id, result: initResult() }));
        }
        if (msg.method === "session/list") {
          reply({ jsonrpc: "2.0", id: msg.id, result: { sessions: [] } });
          reply({ jsonrpc: "2.0", id: 99, method: "session/prompt", params: {} });
        }
      });
      return proc;
    },
  });
  const first = bridge.refresh();
  const second = bridge.refresh();
  await Promise.resolve();
  assert.equal(spawns, 1);
  release();
  await first;
  await second;
  assert.equal(spawns, 1);
  assert.match(proc.written.join(""), /-32601/);
  assert.equal(bridge.sent().includes("session/prompt"), false);
});

test("stop drops a late RPC", async () => {
  let replyInit;
  const bridge = createAcpBridge({
    harness: "omp",
    argv: ["omp", "acp"],
    openProcess: () => scriptedProcess((msg, reply) => {
      if (msg.method === "initialize") replyInit = () => reply({ jsonrpc: "2.0", id: msg.id, result: initResult() });
    }),
  });
  const pending = bridge.refresh();
  await Promise.resolve();
  bridge.stop();
  replyInit();
  await pending;
  assert.equal(bridge.current().rows.length, 0);
  assert.equal(bridge.current().coverage, "unavailable");
  assert.equal(bridge.current().observedAt, null);
});
