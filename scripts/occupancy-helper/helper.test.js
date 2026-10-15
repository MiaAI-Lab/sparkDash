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
