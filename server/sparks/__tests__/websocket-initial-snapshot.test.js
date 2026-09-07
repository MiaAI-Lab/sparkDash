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

function nextMessage(ws, timeoutMs = 1_000) {
  return Promise.race([
    once(ws, "message").then(([data]) => String(data)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timed out waiting for WebSocket message")), timeoutMs)
    ),
  ]);
}

function expectNoMessage(ws, timeoutMs = 150) {
  return Promise.race([
    once(ws, "message").then(() => assert.fail("existing client received another initial snapshot")),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

test("a new WebSocket client receives its initial snapshot without rebroadcasting to existing clients", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-ws-"));
  const sparksPath = path.join(tmp, "sparks.json");
  await writeFile(sparksPath, "[]\n");
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../../.."),
    env: {
      ...process.env,
      BIND_HOST: "127.0.0.1",
      PORT: String(port),
      SPARKS_JSON_PATH: sparksPath,
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
      const check = () =>
        output.includes("server listening") ? resolve() : setTimeout(check, 10);
      check();
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 2_000)
    ),
  ]);

  const a = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  t.after(() => a.close());
  await once(a, "open");
  assert.equal(JSON.parse(await nextMessage(a)).type, "snapshot");

  const noExtraForA = expectNoMessage(a);
  const b = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  t.after(() => b.close());
  await once(b, "open");
  assert.equal(JSON.parse(await nextMessage(b)).type, "snapshot");
  await noExtraForA;
});
