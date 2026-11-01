import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isolatedConfigEnv } from "./isolatedEnv.js";

test("telemetry route uses dashboard auth and configured unit/port boundaries", { timeout: 20000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sd-telemetry-route-"));
  const env = isolatedConfigEnv(dir);
  await writeFile(env.SPARKS_JSON_PATH, JSON.stringify({ sparks: [{ id: "fixture", name: "Fixture", lanIp: "127.0.0.1", isLocal: true, llmPorts: [18888], llmMonitoring: false, comfyMonitoring: false, hermesMonitoring: false, storagePollDisabled: true }] }));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: { ...process.env, ...env, PORT: String(port), BIND_HOST: "0.0.0.0", SPARKDASH_TOKEN: "synthetic-test-token" },
    stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("isolated server startup deadline")), 10000);
      child.once("exit", () => { clearTimeout(timer); reject(new Error("isolated server exited")); });
      child.stdout.on("data", (d) => { if (String(d).includes("server listening")) { clearTimeout(timer); resolve(); } });
    });
    const base = `http://127.0.0.1:${port}/api/sparks`;
    const headers = { Authorization: "Bearer synthetic-test-token" };
    assert.equal((await fetch(`${base}/fixture/llm/telemetry?port=18888`)).status, 401);
    assert.equal((await fetch(`${base}/fixture/llm/telemetry?port=18888`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await fetch(`${base}/missing/llm/telemetry?port=18888`, { headers })).status, 404);
    assert.equal((await fetch(`${base}/fixture/llm/telemetry?port=99999`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/fixture/llm/telemetry?port=18889`, { headers })).status, 400);
    const response = await fetch(`${base}/fixture/llm/telemetry?port=18888&hours=999`, { headers });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.sparkId, "fixture");
    assert.equal(result.port, 18888);
    assert.equal(result.retentionHours, 168);
    assert.deepEqual(result.points, []);
  } finally {
    if (child.exitCode == null) {
      const exited = once(child, "exit");
      process.kill(-child.pid, "SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000).unref())]);
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    await rm(dir, { recursive: true, force: true });
  }
});
