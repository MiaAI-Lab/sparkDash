/**
 * /api/update-status is the only surface the dashboard reads for the self-update
 * notice. The opt-out keeps the test off the network while still proving the
 * route is wired, authenticated like every other API route, and shaped for the UI.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { isolatedConfigEnv } from "./isolatedEnv.js";

const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("/api/update-status reports the running version and respects the opt-out", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-update-status-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const env = isolatedConfigEnv(tmp);
  await writeFile(env.SPARKS_JSON_PATH, '{"sparks":[]}\n');
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      ...env,
      BIND_HOST: "127.0.0.1",
      PORT: String(port),
      SPARKDASH_TOKEN: "",
      SPARKDASH_UPDATE_CHECK: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  await Promise.race([
    new Promise((resolve) => {
      const check = () => (output.includes("server listening") ? resolve() : setTimeout(check, 10));
      check();
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 5_000)),
  ]);

  const res = await fetch(`http://127.0.0.1:${port}/api/update-status`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    enabled: false,
    currentVersion: packageJson.version,
    latestVersion: null,
    updateAvailable: null,
    notes: null,
    checkedAt: null,
  });
});
