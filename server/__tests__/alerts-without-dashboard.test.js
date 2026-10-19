/**
 * Alerts are evaluated on the broadcast tick, which skips its snapshot work
 * while no dashboard is connected. The skip must not reach the alerts: an
 * operator who closed the tab still needs the "unit offline" notification.
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

test("an unreachable unit raises its offline alert with no dashboard connected", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-alerts-nodash-"));
  const env = isolatedConfigEnv(tmp);
  const sshPort = await freePort(); // nothing listens here, so liveness fails fast
  await writeFile(
    env.SPARKS_JSON_PATH,
    JSON.stringify({
      sparks: [{ id: "gone", name: "gone", lanIp: "127.0.0.1", isLocal: false, ssh: { host: "127.0.0.1", port: sshPort, user: "spark", auth: "key" } }],
    })
  );
  await writeFile(env.SETTINGS_JSON_PATH, JSON.stringify({ pollIntervalMs: 500, alertsEnabled: true }));
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: { ...process.env, ...env, BIND_HOST: "127.0.0.1", PORT: String(port), SPARKDASH_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "close");
    }
    await rm(tmp, { recursive: true, force: true });
  });

  let until = Date.now() + 5_000;
  while (!output.includes("server listening")) {
    assert.ok(Date.now() < until, `server did not start:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const base = `http://127.0.0.1:${port}`;
  const saved = await fetch(`${base}/api/alerts/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rules: { offline: { forSec: 0 } } }),
  });
  assert.equal(saved.status, 200, await saved.text());

  // No WebSocket is ever opened in this test.
  let status = null;
  until = Date.now() + 20_000;
  while (Date.now() < until) {
    status = await (await fetch(`${base}/api/alerts`)).json();
    if (status.active.some((a) => a.unitId === "gone" && a.ruleId === "offline")) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(
    status.active.some((a) => a.unitId === "gone" && a.ruleId === "offline"),
    `no offline alert after 20 s: ${JSON.stringify(status)}\n${output.slice(-2000)}`
  );
});
