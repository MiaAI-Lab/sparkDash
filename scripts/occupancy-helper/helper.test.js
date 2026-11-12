import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createOccupancyHelper } from "./index.js";

function acpProcess() {
  const handlers = [];
  return {
    killed: false,
    stdout: { on(event, fn) { if (event === "data") handlers.push(fn); } },
    stderr: { on() {} },
    stdin: {
      write(chunk) {
        for (const line of String(chunk).split("\n")) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          let result = {};
          if (msg.method === "initialize") {
            result = { agentCapabilities: { sessionCapabilities: { list: {} } } };
          }
          if (msg.method === "session/list") result = { sessions: [{ sessionId: "s", title: "Visible" }] };
          for (const fn of handlers) {
            fn(Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`));
          }
        }
        return true;
      },
    },
    once() {},
    kill() { this.killed = true; },
  };
}

function get(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : {} });
      });
    });
    req.on("error", reject);
  });
}

test("loopback may run without a token and reads do not spawn another bridge", async () => {
  let spawns = 0;
  const helper = createOccupancyHelper({
    host: "127.0.0.1",
    port: 0,
    token: "",
    adapters: "opencode",
    refreshMs: 60_000,
    openProcess: (_id, argv) => {
      spawns += 1;
      assert.deepEqual(argv, ["opencode", "acp"]);
      return acpProcess();
    },
  });
  const server = await helper.start();
  const port = server.address().port;
  await helper.refresh();
  const [one, two] = await Promise.all([get(port, "/occupancy"), get(port, "/health")]);
  assert.equal(one.status, 200);
  assert.equal(one.body.rows[0].sessionId, "s");
  assert.equal(two.status, 200);
  assert.equal(two.body.adapters.opencode.rows, 1);
  assert.equal(two.body.rows, undefined);
  assert.equal(spawns, 1);
  const missing = await get(port, "/rpc");
  assert.equal(missing.status, 404);
  await helper.close();
});

test("a wrong bearer is denied and the body is not served", async () => {
  const helper = createOccupancyHelper({
    host: "127.0.0.1",
    port: 0,
    token: "expected",
    adapters: "omp",
    refreshMs: 60_000,
    commands: { omp: "omp acp" },
    openProcess: () => acpProcess(),
  });
  const server = await helper.start();
  const port = server.address().port;
  const denied = await get(port, "/occupancy", { authorization: "Bearer wrong" });
  assert.equal(denied.status, 401);
  assert.equal(JSON.stringify(denied.body).includes("Visible"), false);
  const allowed = await get(port, "/occupancy", { authorization: "Bearer expected" });
  assert.equal(allowed.status, 200);
  await helper.close();
});

test("all-interface and unauthenticated reachable binds are refused before any spawn", () => {
  assert.throws(
    () => createOccupancyHelper({ host: "0.0.0.0", token: "t", adapters: "opencode", openProcess: () => { throw new Error("spawned"); } }).start(),
    /all interfaces/
  );
  assert.throws(
    () => createOccupancyHelper({ host: "::", token: "t", adapters: "opencode", openProcess: () => { throw new Error("spawned"); } }).start(),
    /all interfaces/
  );
  assert.throws(
    () => createOccupancyHelper({ host: "10.1.1.1", token: "", adapters: "opencode", openProcess: () => { throw new Error("spawned"); } }).start(),
    /OCCUPANCY_TOKEN/
  );
});

test("a stalled DSH slot cannot block later ACP refreshes and close aborts its request", { timeout: 1500 }, async () => {
  let signal;
  let lists = 0;
  const helper = createOccupancyHelper({ adapters: "opencode,dsh", readProfiles: false,
    fetchFn: async (_url, opts) => { signal = opts.signal; return new Promise(() => {}); },
    openProcess: () => {
      const proc = acpProcess();
      const write = proc.stdin.write;
      proc.stdin.write = chunk => { if (String(chunk).includes('session/list')) lists++; return write(chunk); };
      return proc;
    },
  });
  try {
    void helper.refresh();
    await new Promise(resolve => setTimeout(resolve, 20));
    void helper.refresh();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(lists >= 2, "healthy ACP must refresh beside hung DSH");
    await helper.close();
    assert.equal(signal.aborted, true);
  } finally { await helper.close(); }
});

test("DSH timeout preserves stale rows and a later successful refresh replaces them", async () => {
  let mode = 'good';
  const helper = createOccupancyHelper({ adapters: 'dsh', dshTimeoutMs: 25, readProfiles: false,
    fetchFn: async (url) => {
      if (mode === 'stall') return new Promise(() => {});
      return new Response(JSON.stringify({ result: { ok: true, value: url.endsWith('session/list') ? { items: mode === 'empty' ? [] : [{ sessionId: 'one' }] } : {} } }));
    },
  });
  try {
    await helper.refresh();
    assert.equal(helper.payload().rows.length, 1);
    mode = 'stall';
    await helper.refresh();
    assert.equal(helper.payload().adapters.dsh.stale, true);
    assert.equal(helper.payload().rows.length, 1);
    mode = 'empty';
    await helper.refresh();
    assert.equal(helper.payload().adapters.dsh.stale, false);
    assert.equal(helper.payload().rows.length, 0);
  } finally { await helper.close(); }
});
