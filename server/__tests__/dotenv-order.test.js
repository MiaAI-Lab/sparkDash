/**
 * Values in .env must be visible to modules that read process.env when they
 * are first imported (config.js, settings.js), and must not override a
 * variable that is already set in the real environment.
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

test(".env is loaded before config modules read the environment", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-dotenv-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const settingsFromDotenv = path.join(tmp, "from-dotenv-settings.json");
  await writeFile(settingsFromDotenv, '{"pollIntervalMs":3000}\n');
  const port = await freePort();
  // SETTINGS_JSON_PATH is read at module scope in settings.js. PORT is also in
  // the real environment below and must win over this file.
  await writeFile(path.join(tmp, ".env"), `SETTINGS_JSON_PATH=${settingsFromDotenv}\nPORT=1\n`);

  const env = { ...process.env, ...isolatedConfigEnv(tmp), BIND_HOST: "127.0.0.1", PORT: String(port), SPARKDASH_TOKEN: "" };
  delete env.SETTINGS_JSON_PATH; // must come from .env
  // dotenv reads .env from the working directory, so start the server from tmp.
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../index.js")], {
    cwd: tmp,
    env,
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

  // Reaching the server on `port` already shows PORT=1 from .env did not win.
  const settings = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json();
  assert.equal(settings.pollIntervalMs, 3000, "settings.js must see SETTINGS_JSON_PATH from .env");
});
