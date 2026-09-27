import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { WebSocket } from "ws";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer(t) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-lifecycle-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../../.."),
    env: {
      ...process.env,
      BIND_HOST: "127.0.0.1",
      PORT: String(port),
      SPARKS_JSON_PATH: path.join(tmp, "sparks.json"),
      SPARKS_SECRETS_PATH: path.join(tmp, "sparks-secrets.json"),
      SECRETS_KEY_PATH: path.join(tmp, ".secrets-key"),
      LLM_DAILY_JSON_PATH: path.join(tmp, "llm-daily.json"),
      FLEET_ENERGY_JSON_PATH: path.join(tmp, "fleet-energy.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  await Promise.race([
    new Promise((resolve) => {
      const check = () => (output.includes("server listening") ? resolve() : setTimeout(check, 10));
      check();
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 4_000)
    ),
  ]);
  return { port, tmp };
}

async function json(port, pathname, init) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function sparkPayload(id, lanIp) {
  return {
    id,
    name: id,
    lanIp,
    isLocal: true,
    ssh: { host: lanIp, user: "spark", auth: "key" },
  };
}

test("registry mutation starts a monitor, invalidates energy, and appears on the WebSocket", async (t) => {
  const { port } = await startServer(t);
  const listed = await json(port, "/api/sparks");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.sparks, []);

  const created = await json(port, "/api/sparks", {
    method: "POST",
    body: JSON.stringify(sparkPayload("alpha", "127.0.0.1")),
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.success, true);
  assert.equal(created.body.spark.id, "alpha");

  const energy = await json(port, "/api/fleet-energy");
  assert.equal(energy.status, 200);
  assert.equal(energy.body.membershipChanged, true);
  assert.equal(energy.body.restartRequired, true);
  assert.equal(energy.body.currentWatts30s, null);
  assert.ok(energy.body.currentNodeIds.includes("alpha"));

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  t.after(() => ws.close());
  await once(ws, "open");
  const snapshot = JSON.parse(await once(ws, "message").then(([data]) => String(data)));
  assert.equal(snapshot.type, "snapshot");
  assert.equal(Number.isFinite(snapshot.generatedAt), true);
  assert.ok(snapshot.sparks.some((spark) => spark.id === "alpha"));

  const metrics = await json(port, "/api/sparks/alpha/metrics");
  assert.equal(metrics.status, 200);
  assert.equal(metrics.body.id, "alpha");

  const removed = await json(port, "/api/sparks/alpha", { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.success, true);
  const after = await json(port, "/api/sparks");
  assert.equal(after.body.sparks.length, 0);
});
