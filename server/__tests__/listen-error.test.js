/**
 * A server that cannot bind its port must exit non-zero so its supervisor
 * restarts it, not stay alive without serving.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { isolatedConfigEnv } from "./isolatedEnv.js";

test("a listen failure exits non-zero instead of idling without a server", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-listen-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  // Hold the port the server is about to ask for.
  const holder = createServer();
  holder.listen(0, "127.0.0.1");
  await once(holder, "listening");
  t.after(() => holder.close());
  const { port } = holder.address();

  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: { ...process.env, ...isolatedConfigEnv(tmp), BIND_HOST: "127.0.0.1", PORT: String(port), SPARKDASH_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  let timer;
  const code = await Promise.race([
    once(child, "exit").then(([exitCode]) => exitCode),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`still running 5 s after a failed listen:\n${output}`)), 5_000);
    }),
  ]).finally(() => clearTimeout(timer));

  assert.equal(code, 1);
  assert.match(output, /cannot listen on 127\.0\.0\.1/);
});
