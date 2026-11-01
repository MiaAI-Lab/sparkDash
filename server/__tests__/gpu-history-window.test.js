/**
 * The gpu-history endpoint serves windows up to a week: windows of 8 h or less come from
 * the dense ~2 s store, longer windows (Temps day/week) from the minute-resolution
 * long-retention store, which is persisted in its own file and loaded on start.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("gpu-history serves the week window from the long store and the 8 h window from the dense store", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-gpuhist-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const now = Date.now();
  const denseAt = now - 2 * 3600_000;
  const longOldAt = now - 2 * 24 * 3600_000;
  await writeFile(
    path.join(tmp, "gpu-history.json"),
    JSON.stringify({ version: 1, sparks: { seeded: { t: [denseAt], u: [5], c: [11], p: [1] } } })
  );
  await writeFile(
    path.join(tmp, "gpu-history-long.json"),
    JSON.stringify({
      version: 1,
      sparks: { seeded: { t: [longOldAt, denseAt], u: [3, 5], c: [22, 33], p: [null, 1] } },
    })
  );

  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      BIND_HOST: "127.0.0.1",
      PORT: String(port),
      SPARKDASH_TOKEN: "",
      SPARKS_JSON_PATH: path.join(tmp, "sparks.json"),
      SPARKS_SECRETS_PATH: path.join(tmp, "sparks-secrets.json"),
      SECRETS_KEY_PATH: path.join(tmp, ".secrets-key"),
      LLM_DAILY_JSON_PATH: path.join(tmp, "llm-daily.json"),
      FLEET_ENERGY_JSON_PATH: path.join(tmp, "fleet-energy.json"),
      EVENTS_JSON_PATH: path.join(tmp, "events.json"),
      GPU_HISTORY_JSON_PATH: path.join(tmp, "gpu-history.json"),
      GPU_HISTORY_LONG_JSON_PATH: path.join(tmp, "gpu-history-long.json"),
      LLM_TELEMETRY_JSON_PATH: path.join(tmp, "llm-telemetry.json"),
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
    new Promise((_, reject) => setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 4_000)),
  ]);

  const created = await fetch(`http://127.0.0.1:${port}/api/sparks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "seeded", name: "seeded", lanIp: "127.0.0.1", isLocal: true, ssh: { host: "127.0.0.1", user: "spark", auth: "key" } }),
  });
  assert.equal(created.status, 200);

  // 8 h (dense store): only the recent sample, with the dense value.
  const dense = await (await fetch(`http://127.0.0.1:${port}/api/sparks/seeded/gpu-history?windowMs=${8 * 3600_000}`)).json();
  assert.deepEqual(dense.c, [11]);
  // A week (long store): both samples survive, including the 2-day-old one.
  const week = await (await fetch(`http://127.0.0.1:${port}/api/sparks/seeded/gpu-history?windowMs=${7 * 24 * 3600_000}`)).json();
  assert.deepEqual(week.c, [22, 33]);
  assert.deepEqual(week.t, [longOldAt, denseAt]);
});
