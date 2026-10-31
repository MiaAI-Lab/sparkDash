/**
 * Raspberry Pi route guards: an unsupported GPU clock is a normal answer, and
 * power/LLM-port/tool-eval actions are refused before they can touch the board.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { isolatedConfigEnv } from "./isolatedEnv.js";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(base, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode != null) throw new Error("server exited during startup");
    try {
      const res = await fetch(`${base}/api/sparks`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not start");
}

test("Pi units refuse power, LLM-port and tool-eval actions; GPU clock is unsupported", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-pi-api-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const env = isolatedConfigEnv(tmp);
  const pi = {
    id: "luffy-1",
    name: "luffy-1",
    kind: "pi",
    platform: "linux",
    lanIp: "192.0.2.10",
    isLocal: false,
    role: "standalone",
    llmMonitoring: false,
    comfyMonitoring: false,
    llmPorts: [],
    ssh: { host: "192.0.2.10", user: "devopsfortunato", auth: "key", port: 22 },
  };
  await writeFile(env.SPARKS_JSON_PATH, JSON.stringify({ sparks: [pi] }));
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: { ...process.env, ...env, BIND_HOST: "127.0.0.1", PORT: String(port), SPARKDASH_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(base, child);

  const clock = await fetch(`${base}/api/sparks/luffy-1/gpu-clock`);
  assert.equal(clock.status, 200);
  assert.equal((await clock.json()).supported, false);

  const shutdown = await fetch(`${base}/api/sparks/luffy-1/shutdown`, { method: "POST" });
  assert.equal(shutdown.status, 400);
  assert.match((await shutdown.json()).error, /power control/i);

  const llm = await fetch(`${base}/api/sparks/luffy-1/llm-ports`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ llmPorts: [8888] }),
  });
  assert.equal(llm.status, 400);
  assert.match((await llm.json()).error, /no LLM ports/i);

  const tool = await fetch(`${base}/api/sparks/luffy-1/tool-eval/install`, { method: "POST" });
  assert.equal(tool.status, 400);
  assert.match((await tool.json()).error, /not supported/i);

  const localPi = await fetch(`${base}/api/sparks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "local-pi", name: "local-pi", kind: "pi", isLocal: true, lanIp: "", ssh: { user: "u" } }),
  });
  assert.equal(localPi.status, 400);
  assert.match((await localPi.json()).error, /remote-only/i);
});
