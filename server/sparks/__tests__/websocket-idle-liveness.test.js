/**
 * The dashboard treats snapshot arrival as its liveness signal: a connected
 * client must get one every tick even when no metric changed.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { WebSocket } from "ws";
import { isolatedConfigEnv } from "../../__tests__/isolatedEnv.js";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function nextSnapshot(ws, timeoutMs) {
  let timer;
  return Promise.race([
    once(ws, "message").then(([data]) => JSON.parse(String(data))),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no snapshot within ${timeoutMs} ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

test("an idle fleet still sends a connected client a snapshot every tick", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-idle-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const env = isolatedConfigEnv(tmp);
  // No units, so consecutive snapshots are identical apart from their timestamp.
  await writeFile(env.SPARKS_JSON_PATH, "[]\n");
  await writeFile(env.SETTINGS_JSON_PATH, '{"pollIntervalMs":500}\n');
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../../.."),
    env: { ...process.env, ...env, BIND_HOST: "127.0.0.1", PORT: String(port), SPARKDASH_TOKEN: "" },
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
    new Promise((_, reject) => setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 4_000)),
  ]);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  t.after(() => ws.close());
  const first = await nextSnapshot(ws, 2_000);
  const second = await nextSnapshot(ws, 2_000);
  const third = await nextSnapshot(ws, 2_000);
  assert.equal(first.type, "snapshot");
  assert.deepEqual(second.sparks, []);
  assert.ok(third.generatedAt > second.generatedAt, "each tick carries a newer timestamp");
});
