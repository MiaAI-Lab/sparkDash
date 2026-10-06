/**
 * GET /metrics is opt-in: 404 until Settings → Prometheus metrics is on, then
 * Prometheus text — never the SPA fallback's index.html / "Frontend not built".
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

test("GET /metrics answers 404 while off and Prometheus text once enabled", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-metrics-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const sparksPath = path.join(tmp, "sparks.json");
  await writeFile(sparksPath, '{"sparks":[]}\n');
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      BIND_HOST: "127.0.0.1",
      PORT: String(port),
      SPARKDASH_TOKEN: "",
      SPARKS_JSON_PATH: sparksPath,
      SETTINGS_JSON_PATH: path.join(tmp, "settings.json"),
      SPARKS_SECRETS_PATH: path.join(tmp, "sparks-secrets.json"),
      SECRETS_KEY_PATH: path.join(tmp, ".secrets-key"),
      LLM_DAILY_JSON_PATH: path.join(tmp, "llm-daily.json"),
      LLM_TOKEN_JSON_PATH: path.join(tmp, "llm-token-totals.json"),
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
      setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 3_000)
    ),
  ]);
  const base = `http://127.0.0.1:${port}`;

  const off = await fetch(`${base}/metrics`);
  assert.equal(off.status, 404);
  assert.match(off.headers.get("content-type"), /^text\/plain/);
  assert.match(await off.text(), /Prometheus export is off/);

  const put = await fetch(`${base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prometheusExport: true }),
  });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).prometheusExport, true);

  const on = await fetch(`${base}/metrics`);
  assert.equal(on.status, 200);
  assert.equal(on.headers.get("content-type"), "text/plain; version=0.0.4; charset=utf-8");
  assert.equal(on.headers.get("cache-control"), "no-store");
  const body = await on.text();
  assert.match(body, /^# HELP sparkdash_up /);
  assert.match(body, /\n# TYPE sparkdash_up gauge\n$/);
});
